# agent-service

The AI orchestration layer for the **MailFlow AI Agent Platform**.

`agent-service` accepts natural-language instructions from a Chat UI, classifies intent, routes to the correct domain agent, enforces an approval workflow for risky actions, calls MailFlow capabilities through the MCP server, and returns structured responses — all without ever touching the MailFlow database or backend APIs directly.

---

## Table of contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [API endpoints](#3-api-endpoints)
4. [Environment variables](#4-environment-variables)
5. [MCP integration](#5-mcp-integration)
6. [Session memory and approval workflow](#6-session-memory-and-approval-workflow)
7. [Development and testing](#7-development-and-testing)
8. [Security and operational notes](#8-security-and-operational-notes)
9. [Future roadmap](#9-future-roadmap)

---

## 1. Overview

### What it is

`agent-service` is a Node.js + TypeScript service that sits between a Chat UI and the MailFlow email campaign platform. It provides a conversational interface for managing email campaigns, viewing analytics, reading inbox replies, and configuring SMTP settings.

Users interact with it through plain English. The service classifies intent, selects the right domain agent, calls the correct tools, and returns a response — or, for destructive actions, pauses and asks for explicit confirmation before executing.

### What it is not

- It is **not** a general-purpose AI assistant
- It does **not** contain business logic — MailFlow owns that
- It does **not** call MailFlow REST APIs directly — all MailFlow access flows through `mailflow-mcp-server`
- It does **not** store campaign data, user records, or email content

### How it fits into the platform

```
Chat UI  ──────────────►  agent-service  ──────────────►  mailflow-mcp-server
                          (this service)                   (MCP tool layer)
                                                                  │
                                                                  ▼
                                                         MailFlow Backend APIs
                                                                  │
                                                                  ▼
                                                         PostgreSQL / Workers
                                                         Email infrastructure
```

### Relationship to mailflow-mcp-server

`mailflow-mcp-server` exposes MailFlow capabilities as MCP (Model Context Protocol) tools. It owns:
- Input validation (Zod)
- Auth context resolution from bearer tokens
- MailFlow API calls
- Sensitive field masking (SMTP passwords, API keys)

`agent-service` calls these tools over SSE transport. It does **not** know how the tools are implemented and must never bypass them.

### Relationship to the MailFlow backend

`agent-service` has no direct connection to the MailFlow database or REST APIs. Every MailFlow operation goes through `mailflow-mcp-server`. This separation is a hard architectural rule enforced at code review.

---

## 2. Architecture

### LangGraph orchestration flow

```
START
  │
  ▼
loadMemory          ← restore session context (activeCampaignId, message history)
  │
  ▼
detectIntent        ← keyword-based scoring; returns intent + confidence
  │
  ▼
manager             ← maps intent to agentDomain; sets routing destination
  │
  ├── campaign ──────────────┐
  ├── analytics              │
  └── inbox ─────────────────┤
                             ▼
                          approval
                             │
               requiresApproval?
               ┌─────────────┴──────────────┐
               │ NO                         │ YES
               ▼                            ▼
           executeTool              finalResponse (approval prompt)
               │                            │
               ▼                            │
           finalResponse ◄──────────────────┘
               │
               ▼
           saveMemory       ← persist turn to session (fire-and-forget)
               │
              END
```

Requests for `general_help` or unrecognised input skip the domain agents entirely and flow directly from `manager` to `finalResponse`.

### Agent roles

| Agent | Domain | Intents handled |
|---|---|---|
| **Manager Agent** | — | Routes all intents; never executes tools itself |
| **Campaign Agent** | `campaign` / `settings` | create, update, start, pause, resume campaign; get/update SMTP |
| **Analytics Agent** | `analytics` | get campaign stats |
| **Inbox Agent** | `inbox` | list replies, summarize replies |

The `settings` domain (SMTP intents) is routed to the Campaign Agent because it owns SMTP configuration alongside campaign management.

### Intent detection

Intent is classified deterministically using a keyword-scoring engine with 11 intent categories. Each message is matched against weighted pattern lists; the highest-scoring intent above the confidence threshold (0.25) wins. Below the threshold the system falls back to `general_help`. No LLM call is made during intent detection.

**Supported intents:**

| Intent | Domain | Requires approval |
|---|---|:---:|
| `create_campaign` | campaign | — |
| `update_campaign` | campaign | — |
| `start_campaign` | campaign | ✓ |
| `pause_campaign` | campaign | — |
| `resume_campaign` | campaign | ✓ |
| `get_campaign_stats` | analytics | — |
| `list_replies` | inbox | — |
| `summarize_replies` | inbox | — |
| `check_smtp` | settings | — |
| `update_smtp` | settings | ✓ |
| `general_help` | general | — |

---

## 3. API endpoints

All agent endpoints are under `/api/agent` and require a valid JWT bearer token. The health endpoint is unauthenticated.

### GET /health

Returns service health status. Used by load balancer probes. Not rate-limited.

**Response**

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "agent-service",
    "version": "1.0.0"
  },
  "requestId": "a1b2c3d4-..."
}
```

---

### POST /api/agent/chat

Submit a user message and receive either a direct response or an approval prompt for risky actions.

**Request headers**

```
Authorization: Bearer <jwt>
Content-Type: application/json
```

**Request body**

```json
{
  "message": "Show me the stats for my last campaign",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field | Type | Required | Notes |
|---|---|:---:|---|
| `message` | string | ✓ | 1–4000 characters |
| `sessionId` | UUID | — | Omit to start a new session; the service generates one |

**Response — direct reply**

```json
{
  "success": true,
  "data": {
    "approvalRequired": false,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "response": "Here are the stats for campaign c-42: ...",
    "toolResult": {
      "data": {
        "sent": 5000,
        "delivered": 4912,
        "opened": 1340,
        "clicked": 280,
        "bounced": 88,
        "unsubscribed": 12
      },
      "isToolError": false
    }
  },
  "requestId": "a1b2c3d4-..."
}
```

**Response — approval required**

Returned when the detected intent is `start_campaign`, `resume_campaign`, or `update_smtp`. The tool is **not** executed until the user confirms via `POST /api/agent/confirm`.

```json
{
  "success": true,
  "data": {
    "approvalRequired": true,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "message": "Starting this campaign will send emails to your recipient list immediately. Please confirm to proceed.",
    "pendingAction": {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "intent": "start_campaign",
      "toolName": "start_campaign",
      "expiresAt": "2026-03-25T11:45:00.000Z"
    }
  },
  "requestId": "a1b2c3d4-..."
}
```

The `pendingAction.id` must be passed to `POST /api/agent/confirm` or `POST /api/agent/cancel`. Pending actions expire after 10 minutes (configurable).

---

### POST /api/agent/confirm

Execute a previously staged pending action after the user confirms.

**Request body**

```json
{
  "pendingActionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Response — success**

```json
{
  "success": true,
  "data": {
    "response": "Campaign started successfully.",
    "toolResult": {
      "data": { "status": "active", "campaignId": "c-42" },
      "isToolError": false
    }
  },
  "requestId": "a1b2c3d4-..."
}
```

**Error cases**

| Scenario | HTTP status | Error code |
|---|:---:|---|
| `pendingActionId` not found | 404 | `APPROVAL_NOT_FOUND` |
| Action already confirmed/executed | 409 | `CONFLICT` |
| Action belongs to a different user | 403 | `AUTH_FORBIDDEN` |
| Action TTL has elapsed | 410 | `APPROVAL_EXPIRED` |

---

### POST /api/agent/cancel

Cancel a pending action without executing it.

**Request body**

```json
{
  "pendingActionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479"
}
```

**Response**

```json
{
  "success": true,
  "data": {
    "cancelled": true,
    "message": "Action cancelled successfully."
  },
  "requestId": "a1b2c3d4-..."
}
```

---

### Error envelope

All errors follow the same shape:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "message is required",
    "details": { ... }
  },
  "requestId": "a1b2c3d4-..."
}
```

---

## 4. Environment variables

Copy `.env.example` to `.env` and fill in all required values before starting the service.

```env
# ── Runtime ────────────────────────────────────────────────────────────────────
NODE_ENV=development           # development | production | test
PORT=3000

# ── Authentication ─────────────────────────────────────────────────────────────
# Secret used to verify incoming JWT tokens from the Chat UI.
# Must be at least 32 characters. Use a cryptographically random value in production.
JWT_SECRET=change-me-to-a-long-random-secret-value-here

# ── MCP server ─────────────────────────────────────────────────────────────────
# SSE endpoint of the running mailflow-mcp-server instance.
MCP_SERVER_URL=http://localhost:4000/sse

# Shared secret sent in X-Service-Token on every MCP request.
# Must match MCP_SERVICE_SECRET in mailflow-mcp-server.
# Must be at least 32 characters.
MCP_SERVICE_SECRET=change-me-to-another-long-random-secret

# ── LLM ────────────────────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── Logging ────────────────────────────────────────────────────────────────────
LOG_LEVEL=info                 # trace | debug | info | warn | error | fatal
LOG_PRETTY=false               # true for local development (colourised); false in production

# ── CORS ───────────────────────────────────────────────────────────────────────
# Comma-separated list of allowed request origins.
#   ""    → deny all cross-origin requests (safe production default)
#   "*"   → allow any origin, no credentials (development only — do not use in production)
#   "http://localhost:3001,https://app.example.com"  → explicit allow-list
CORS_ALLOWED_ORIGINS=http://localhost:3001

# ── Body limits ─────────────────────────────────────────────────────────────────
BODY_SIZE_LIMIT=100kb          # Default. Increase only if payloads legitimately exceed this.

# ── Proxy ──────────────────────────────────────────────────────────────────────
# Number of trusted reverse proxy hops in front of this service.
# Set to 1 when behind AWS ALB, nginx, etc. Required for accurate IP-based rate limiting.
TRUST_PROXY=0

# ── Rate limiting ──────────────────────────────────────────────────────────────
RATE_LIMIT_WINDOW_MS=60000     # 1 minute rolling window
RATE_LIMIT_MAX_REQUESTS=100    # Global cap per IP per window (health endpoint is exempt)
CHAT_RATE_LIMIT_MAX=20         # Optional: stricter cap on POST /api/agent/chat
CONFIRM_RATE_LIMIT_MAX=10      # Optional: stricter cap on POST /api/agent/confirm
```

### Variable reference

| Variable | Required | Default | Purpose |
|---|:---:|---|---|
| `NODE_ENV` | — | `development` | Runtime mode |
| `PORT` | — | `3000` | HTTP listen port |
| `JWT_SECRET` | ✓ | — | Verifies user JWTs; min 32 chars |
| `MCP_SERVER_URL` | ✓ | — | SSE endpoint of `mailflow-mcp-server` |
| `MCP_SERVICE_SECRET` | ✓ | — | `X-Service-Token` header value; min 32 chars |
| `ANTHROPIC_API_KEY` | ✓ | — | Claude API key for LLM calls |
| `LOG_LEVEL` | — | `info` | Pino log level |
| `LOG_PRETTY` | — | `false` | Enable colourised pretty-print output |
| `CORS_ALLOWED_ORIGINS` | — | `""` | CORS origin allow-list (see above) |
| `BODY_SIZE_LIMIT` | — | `100kb` | Max JSON request body size |
| `TRUST_PROXY` | — | `0` | Trusted proxy hop count |
| `RATE_LIMIT_WINDOW_MS` | — | `60000` | Rate limit rolling window (ms) |
| `RATE_LIMIT_MAX_REQUESTS` | — | `100` | Global per-IP request cap |
| `CHAT_RATE_LIMIT_MAX` | — | `20` | Per-IP cap for `/api/agent/chat` |
| `CONFIRM_RATE_LIMIT_MAX` | — | `10` | Per-IP cap for `/api/agent/confirm` |

All variables are validated at startup using Zod. The service exits immediately with a descriptive error if any required variable is missing or invalid — there is no partial startup.

---

## 5. MCP integration

### Transport

`agent-service` connects to `mailflow-mcp-server` using the **MCP SSE transport** from `@modelcontextprotocol/sdk`. A new SSE connection is opened for each tool call and closed immediately after the call completes. There are no persistent connections.

```
agent-service                    mailflow-mcp-server
     │                                   │
     │  GET /sse  (SSE connection)        │
     │ ─────────────────────────────────► │
     │  POST /message (tool call JSON)    │
     │ ─────────────────────────────────► │
     │  SSE event (tool result)           │
     │ ◄───────────────────────────────── │
     │  connection closed                 │
```

### Authentication headers

Every MCP request carries two security headers:

| Header | Value | Purpose |
|---|---|---|
| `X-Service-Token` | Value of `MCP_SERVICE_SECRET` | Proves the caller is a trusted service |
| `X-Forwarded-Authorization` | `Bearer <user JWT>` | Forwards the user's identity for MailFlow API calls |

The `mailflow-mcp-server` validates both headers. It uses `X-Forwarded-Authorization` to resolve the user identity for all MailFlow API calls — the MCP server never accepts a `userId` directly from the tool payload.

### Tool call timeout

Individual tool calls time out after 30 seconds (`DEFAULT_MCP_TOOL_TIMEOUT_MS`). A timeout throws `McpError` with code `MCP_TIMEOUT`, which is captured into `state.error` and surfaced as a user-facing message without crashing the graph.

### No direct MailFlow access

`agent-service` has no MailFlow API URL configured and must never make direct HTTP calls to the MailFlow backend. If a future feature requires new MailFlow capabilities, the correct approach is to add a new MCP tool in `mailflow-mcp-server` and call it from here.

---

## 6. Session memory and approval workflow

### Session memory

Session state is stored in memory, keyed by `userId:sessionId`. Each session holds:

- The last detected intent
- The active campaign ID (set when the user interacts with a specific campaign)
- The last agent domain used
- Up to **20 recent messages** (older messages are trimmed automatically)
- Up to **10 recent tool call records** with success/failure status

On each request, `loadMemory` restores up to 10 historical messages into the graph's message list. This gives the LLM continuity across turns without unbounded context growth. `saveMemory` persists the turn result after `finalResponse` — failures are swallowed so a memory error never aborts a request.

**Current implementation:** in-process `Map`. The `ISessionMemoryStore` interface is ready for a Redis or database-backed replacement with no changes to the service layer.

### Pending actions and the approval workflow

Actions that are irreversible or have immediate real-world impact require explicit user confirmation before execution:

| Intent | Reason |
|---|---|
| `start_campaign` | Sends emails to the full recipient list immediately; cannot be undone in bulk |
| `resume_campaign` | Resumes email delivery to recipients who have not yet received the campaign |
| `update_smtp` | Changes the live production mail server; can break all delivery immediately |

**Lifecycle of a pending action:**

```
POST /api/agent/chat
  → graph detects risky intent
  → approval node creates PendingAction (status: pending)
  → response returned with approvalRequired: true + pendingAction.id

POST /api/agent/confirm
  → status transitions pending → confirmed   (atomic; prevents double-execution)
  → tool executed via MCP
  → status transitions confirmed → executed
  → response returned to user

POST /api/agent/cancel
  → status transitions pending → cancelled
  → tool is never executed
```

Pending actions expire after **10 minutes** (configurable via `DEFAULT_APPROVAL_TTL_MS`). Attempting to confirm an expired action returns HTTP 410. Attempting to confirm an action that belongs to a different user returns HTTP 403. Submitting the same `pendingActionId` a second time returns HTTP 409 — the tool is never executed twice.

**Current implementation:** in-process `Map`. The `IPendingActionStore` interface accepts a Redis or database-backed replacement.

---

## 7. Development and testing

### Prerequisites

- Node.js ≥ 20
- `mailflow-mcp-server` running (or mock mode enabled — see below)
- A `.env` file with all required variables set

### Install

```bash
cd agent-service
npm install
```

### Run in development

```bash
npm run dev
```

The service starts with `tsx watch`, which reloads on file changes. Logs are pretty-printed when `LOG_PRETTY=true`.

### Build for production

```bash
npm run build   # compiles TypeScript → dist/
npm start       # runs dist/index.js
```

### Type-check without building

```bash
npm run typecheck
```

### Run tests

```bash
npm test              # run all tests once
npm run test:watch    # watch mode
npm run test:coverage # generate coverage report
```

Tests use **Vitest** and require no running services. All network calls (MCP, LLM) are mocked at the module boundary with `vi.spyOn`. You do not need a live MailFlow backend, a live MCP server, or an Anthropic API key to run the test suite.

### Test coverage

| Area | File(s) |
|---|---|
| Intent detection | `services/__tests__/intentDetection.test.ts` |
| Approval policy | `services/__tests__/approvalPolicy.test.ts` |
| Session memory | `services/__tests__/sessionMemory.test.ts` |
| Pending actions | `services/__tests__/pendingAction.test.ts` |
| MCP tool caller | `services/__tests__/mcpToolCaller.test.ts` |
| MCP client service | `services/__tests__/mcpClient.service.test.ts` |
| Tool execution | `services/__tests__/toolExecution.test.ts` |
| Response formatter | `lib/__tests__/agentResponseFormatter.test.ts` |
| Graph routing | `graph/__tests__/routing.test.ts` |
| Full graph (no MCP) | `graph/__tests__/agent.workflow.test.ts` |

### Running with mock MCP

If `mailflow-mcp-server` is configured with `MOCK_MAILFLOW=true`, it returns synthetic responses without calling the MailFlow backend. This is sufficient for manual end-to-end testing of the full agent flow locally.

---

## 8. Security and operational notes

### No secret leakage

- JWT tokens, SMTP passwords, API keys, and `MCP_SERVICE_SECRET` are never included in API responses or logs
- Pino redacts 15 sensitive field paths including `rawToken`, `smtp.password`, `toolArgs.password`, and all auth header variants
- The `errorHandler` middleware strips internal error `details` from 5xx responses in production
- Stack traces are never included in any API response

### Rate limiting

Three layers of rate limiting protect against abuse and cost overruns:

| Scope | Default | Skip condition |
|---|---|---|
| All routes (global) | 100 req / 60 s per IP | `/health` endpoint, `OPTIONS` preflight |
| `POST /api/agent/chat` | 20 req / 60 s per IP | — |
| `POST /api/agent/confirm` | 10 req / 60 s per IP | Prevents brute-force on pending action IDs |

All limits are configurable via environment variables. When `TRUST_PROXY` is set, rate limiting uses the real client IP from `X-Forwarded-For` rather than the proxy IP.

Rate-limited responses use `RateLimit-*` headers (IETF draft-7 format) so clients can implement backoff.

### Body size limits

JSON request bodies are limited to `BODY_SIZE_LIMIT` (default `100kb`). This is more than sufficient for any valid agent request (maximum message length is 4 000 characters). Requests exceeding this limit are rejected with HTTP 413 before reaching any route handler.

### Security headers

`helmet` is configured for a JSON API service:
- `Content-Security-Policy` disabled (no HTML served)
- `Cross-Origin-Embedder-Policy` disabled (not relevant for APIs)
- `Strict-Transport-Security` enabled in production with a 1-year max-age
- `Referrer-Policy` set to `no-referrer`
- `X-Powered-By` removed

### Graceful shutdown

On `SIGTERM` or `SIGINT`:
1. The server stops accepting new connections
2. `keepAliveTimeout` is shortened to 1 ms to drain idle keep-alive connections quickly
3. In-flight requests are allowed to complete
4. After 10 seconds (`SHUTDOWN_TIMEOUT_MS`), any remaining open sockets are destroyed and the process exits with code 1
5. If all connections close cleanly before the timeout, the process exits with code 0

The server's `keepAliveTimeout` is set to 65 seconds by default — slightly above the AWS ALB 60-second idle timeout — to prevent 502 errors caused by the load balancer reusing a connection that Node.js has already decided to close.

### Production considerations

Before deploying to production:

- Set `NODE_ENV=production`
- Set `TRUST_PROXY=1` if behind a load balancer
- Set `CORS_ALLOWED_ORIGINS` to your exact frontend origin(s) — do **not** use `"*"` in production
- Use a secrets manager (AWS Secrets Manager, Vault) for `JWT_SECRET`, `MCP_SERVICE_SECRET`, and `ANTHROPIC_API_KEY` — do not put real secrets in `.env` files committed to source control
- Configure `CHAT_RATE_LIMIT_MAX` and `CONFIRM_RATE_LIMIT_MAX` based on expected usage and Anthropic API cost limits
- Ensure `LOG_PRETTY=false` (structured JSON logs for log aggregation pipelines)
- Set `LOG_LEVEL=warn` or `LOG_LEVEL=error` in high-traffic environments to reduce log volume

---

## 9. Future roadmap

### LLM-powered intent detection

The current intent detection engine is deterministic and keyword-based. It has no LLM dependency, is sub-millisecond, and requires no API calls. It works well for straightforward requests but may misclassify ambiguous phrasing.

The `detectIntentNode` in the graph is the single injection point for a replacement. A future version will use a Claude call with the prompt builders in `src/prompts/` to classify intent more accurately, with the keyword engine as a fast-path pre-filter or fallback.

### Redis-backed session memory

`SessionMemoryService` is backed by an in-process `Map` (per `InMemorySessionStore`). In a multi-replica deployment, each instance has its own map and sessions do not persist across restarts or replicas.

The `ISessionMemoryStore` interface is already defined. Swapping in a Redis-backed store requires implementing the four interface methods (`get`, `set`, `delete`, `clear`) and replacing the singleton — no changes to `SessionMemoryService` or any graph node.

### Persistent pending actions

`PendingActionService` uses `InMemoryPendingActionStore` for the same reason. A Redis or PostgreSQL-backed store would survive restarts and support multi-replica deployments. The `IPendingActionStore` interface is the swap point.

### Persistent audit logs

`AuditLogService` currently writes to the Pino logger (stdout/file). The `IAuditStore` interface is designed for a database-backed implementation that would persist all 13 audit event types (chat received, tool attempt/success/failure, approval lifecycle, confirmation security events) to a queryable store for compliance and operational reporting.

### Deeper LangChain prompt and model integration

The prompt builders in `src/prompts/` produce plain strings that are currently unused — they are ready for the first LLM-powered agent node. A future phase will:
- Wire the system prompt and domain prompt into a `ChatPromptTemplate`
- Pass the compiled prompt + session history to a `ChatAnthropic` model
- Use the LLM response to extract structured tool arguments (campaign name, subject, IDs) from free-form user input
- Replace the placeholder `toolArgs: {}` stubs in the domain agent nodes with LLM-extracted, schema-validated arguments

### Streaming responses

The current API returns complete responses only. A future version will support Server-Sent Events on `POST /api/agent/chat` so the Chat UI can display tokens as they stream from the LLM, improving perceived latency for longer responses.
