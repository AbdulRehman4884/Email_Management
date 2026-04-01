# mailflow-mcp-server

A standalone TypeScript [FastMCP](https://github.com/punkpeye/fastmcp) server that exposes MailFlow backend capabilities as standardized [Model Context Protocol (MCP)](https://modelcontextprotocol.io) tools.

## Architecture

```
agent-service (LangGraph orchestration)
      │
      │  MCP over SSE (HTTP)
      │  X-Service-Token: <shared secret>
      │  X-Forwarded-Authorization: Bearer <user JWT>
      ▼
mailflow-mcp-server  ←  this project
      │
      │  HTTP + JWT Bearer
      ▼
MailFlow backend APIs
      │
      ▼
PostgreSQL / workers / MailFlow system
```

**Design rules:**
- MailFlow remains the source of truth — no business logic lives here
- agent-service remains the orchestration layer — this is the tool-exposure layer only
- The MCP server is stateless — all state lives in MailFlow
- userId is **never** sourced from tool input — always resolved from the bearer token

---

## Available Tools

| Tool | Category | Description |
|------|----------|-------------|
| `create_campaign` | Campaign | Create a new email campaign |
| `update_campaign` | Campaign | Update fields on an existing campaign |
| `start_campaign` | Campaign | Start sending a campaign |
| `pause_campaign` | Campaign | Pause a running campaign |
| `resume_campaign` | Campaign | Resume a paused campaign |
| `get_campaign_stats` | Analytics | Fetch delivery and engagement statistics |
| `list_replies` | Inbox | List email replies with pagination |
| `summarize_replies` | Inbox | Deterministic keyword/status summary of replies |
| `get_smtp_settings` | Settings | Get SMTP configuration (sensitive fields masked) |
| `update_smtp_settings` | Settings | Update SMTP configuration |

---

## Prerequisites

- Node.js >= 20
- A running MailFlow backend
- npm or compatible package manager

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your values (see Environment Variables below)

# 3. Build
npm run build

# 4. Start
npm start
```

For development with hot reload:

```bash
npm run dev
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MAILFLOW_API_BASE_URL` | ✅ | — | Base URL of the MailFlow backend (no trailing slash) |
| `MAILFLOW_API_TIMEOUT_MS` | — | `10000` | MailFlow API request timeout in ms |
| `MCP_SERVICE_SECRET` | ✅ | — | Shared secret validating that callers are agent-service (min 32 chars) |
| `MAILFLOW_SERVICE_ACCOUNT_TOKEN` | — | — | JWT used when no forwarded user token is present |
| `MCP_TRANSPORT` | — | `sse` | `sse` or `stdio` |
| `MCP_SSE_PORT` | — | `3001` | HTTP port for SSE transport |
| `MCP_SSE_ENDPOINT` | — | `/sse` | SSE endpoint path |
| `LOG_LEVEL` | — | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |
| `LOG_PRETTY` | — | `false` | Set `true` for human-readable logs in development |
| `NODE_ENV` | — | `development` | `development` \| `production` \| `test` |

Generate a service secret:

```bash
openssl rand -hex 32
```

---

## Auth Flow

```
agent-service
  │
  │  SSE handshake:
  │    X-Service-Token: <MCP_SERVICE_SECRET>
  │    X-Forwarded-Authorization: Bearer <user-JWT>
  ▼
MCP server authenticate() hook
  → stores { rawAuth } in FastMCP session
  │
  │  On each tool call:
  ▼
toolRegistry.ts execute() wrapper
  → authContextService.resolve(session.rawAuth)
     1. Validates X-Service-Token (timing-safe comparison)
     2. Extracts bearer token from X-Forwarded-Authorization
        (falls back to MAILFLOW_SERVICE_ACCOUNT_TOKEN)
     3. Decodes userId from JWT payload (for context only)
  → createMailFlowApiClient(bearerToken)
  → toolHandler(input, context)
  → MailFlow API (Authorization: Bearer <token>)
```

**Security guarantees:**
- Service token compared with `crypto.timingSafeEqual` (SHA-256 normalised)
- Bearer tokens never logged
- SMTP password and username masked in all log output and tool responses
- `userId` never accepted from tool input payloads

---

## Project Structure

```
src/
├── index.ts                          Entry point
├── server.ts                         FastMCP start/stop
├── config/
│   ├── env.ts                        Zod-validated environment
│   └── constants.ts                  Tool names, API paths, masking config
├── lib/
│   ├── logger.ts                     Pino structured logger (auto-redacts secrets)
│   ├── mailflowApiClient.ts          Axios HTTP client for MailFlow APIs
│   └── errors.ts                     Typed error hierarchy
├── mcp/
│   ├── bootstrap/createServer.ts     FastMCP server factory + authenticate hook
│   ├── registry/toolRegistry.ts      Tool registration loop
│   ├── tools/
│   │   ├── campaign/                 5 campaign tools
│   │   ├── analytics/                getCampaignStats
│   │   ├── inbox/                    listReplies, summarizeReplies
│   │   └── settings/                 getSmtpSettings, updateSmtpSettings
│   ├── context/requestContext.ts     FastMCP context → McpSession adapter
│   └── types/toolContext.ts          ToolContext interface (DI object for tools)
├── services/
│   ├── authContext.service.ts        Auth resolution pipeline
│   └── toolExecution.service.ts      Timing, logging, error boundary wrapper
├── schemas/                          Zod input schemas (one file per domain)
├── types/                            Shared TypeScript types
├── tests/                            Vitest tests
└── integration/                      agent-service connection notes
```

---

## Running Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage
```

Tests use vitest. No live MailFlow backend required — all external calls are mocked.

Test coverage:
- Schema validation (all 10 tool schemas)
- MailFlow API client (endpoint routing, error mapping, auth header injection)
- Tool execution service (timing, serialization, error boundary)
- Tool handlers: `createCampaign`, `getSmtpSettings`, `updateSmtpSettings`
- SMTP masking: username always `***` in tool responses; password never echoed

---

## Adding a New Tool

1. Add the tool name to `TOOL_NAMES` in `src/config/constants.ts`
2. Add the MailFlow API path to `MAILFLOW_PATHS` in `src/config/constants.ts`
3. Add a typed method to `IMailFlowApiClient` and implement it in `MailFlowApiClient`
4. Create a Zod schema in the appropriate `src/schemas/*.schemas.ts` file
5. Create the tool file in `src/mcp/tools/<category>/<toolName>.tool.ts`
6. Import and add the tool to `ALL_TOOLS` in `src/mcp/registry/toolRegistry.ts`

No other files need to change.

---

## Connecting agent-service

See [`src/integration/agent-service-connection.note.ts`](src/integration/agent-service-connection.note.ts) for the full migration guide including:

- How to connect the existing LangGraph agent-service via `@langchain/mcp-adapters`
- How to replace current direct LangChain tool wrappers with MCP tools
- Minimal migration strategy with rollback path

---

## Deployment

**Container (recommended):**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist/ ./dist/
ENV NODE_ENV=production
ENV MCP_TRANSPORT=sse
EXPOSE 3001
CMD ["node", "dist/index.js"]
```

**Build before containerising:**

```bash
npm run build
```

**Health check (SSE transport):**

The FastMCP SSE server responds to the `/sse` endpoint. For infrastructure health checks, probe TCP connectivity on `MCP_SSE_PORT`.

**Scaling:** This service is stateless — scale horizontally without coordination. Each instance independently connects to MailFlow.

---

## Development Notes

- `npm run typecheck` — type-check without emitting files
- `npm run clean` — remove `dist/`
- Logs are structured JSON in production; add `LOG_PRETTY=true` for development
- All sensitive fields (tokens, passwords) are redacted by pino's `redact` config automatically
