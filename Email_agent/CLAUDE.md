# CLAUDE.md

This document instructs Claude Code how to safely work with this repository.

Claude must treat this file as the **authoritative guide** for architecture, coding rules, and development workflows.

Claude must **never violate the architecture, security rules, or conventions defined here.**

---

# 1. PROJECT OVERVIEW

This repository implements the **MailFlow AI Agent Platform**.

MailFlow is an email campaign management system.

This repository adds an **AI orchestration layer** that allows users to control MailFlow through conversational instructions.

The AI layer does **not replace MailFlow business logic**.

MailFlow remains the **single source of truth**.

The AI layer only **interprets instructions and safely orchestrates actions**.

---

# 2. SYSTEM ARCHITECTURE

```
Frontend / Chat UI
↓
agent-service (Node.js + Express + LangGraph)
↓
MCP Client
↓
mailflow-mcp-server (TypeScript + FastMCP)
↓
MailFlow Backend APIs
↓
PostgreSQL database
Background workers
Email infrastructure
```

---

# 3. SERVICES

The system contains two primary services.

## agent-service

Responsibilities:

- chat request ingestion
- LangGraph orchestration
- intent detection
- routing tasks to specialized agents
- session memory
- approval workflows
- tool invocation through MCP
- structured response formatting

### Agents

The Manager Agent routes requests to domain agents:

```
Manager Agent
├── Campaign Agent
├── Analytics Agent
└── Inbox Agent
```

Each agent handles one domain only.

---

## mailflow-mcp-server

The MCP server exposes MailFlow capabilities as **MCP tools**.

Responsibilities:

- validating tool input
- applying security rules
- resolving authentication context
- calling MailFlow backend APIs
- masking sensitive data
- returning structured results

The MCP server **must never contain business logic**.

---

# 4. MCP TOOLS

The MCP server exposes the following tools.

## Campaign tools

- create_campaign
- update_campaign
- start_campaign
- pause_campaign
- resume_campaign

## Analytics tools

- get_campaign_stats

## Inbox tools

- list_replies
- summarize_replies

## Settings tools

- get_smtp_settings
- update_smtp_settings

Additional tools may be added later.

---

# 5. SECURITY MODEL

Security rules must **never be violated**.

## Identity resolution

User identity must always come from the **JWT bearer token**.

Tool inputs must **never accept**:

```
userId
accountId
tenantId
```

These values must always be derived from the **authentication context**.

---

## Sensitive data handling

Sensitive fields must always be masked.

Examples:

```
smtp.password
api_key
access_token
```

Returned values must be masked:

```
password: "masked"
```

Secrets must never appear in:

- API responses
- logs
- error messages

---

# 6. CODING STANDARDS

All backend code must use:

```
Node.js
TypeScript
```

Strict TypeScript mode must remain enabled.

---

## Input validation

All external inputs must be validated using:

```
Zod
```

No tool, API, or service should process unvalidated input.

---

## MailFlow API access

All MailFlow API calls must go through:

```
src/lib/mailflowApiClient.ts
```

Direct HTTP calls from tools or agents are not allowed.

---

## Logging

Use structured logging.

Allowed log fields:

```
userId
sessionId
toolName
executionTime
status
```

Sensitive data must never be logged:

```
password
tokens
smtp secrets
```

---

# 7. LANGGRAPH DESIGN RULES

LangGraph controls the AI workflow.

Nodes must remain **small and single-purpose**.

Example nodes:

```
detectIntent
routeAgent
executeTool
approvalCheck
formatResponse
```

Nodes must not mix:

- orchestration logic
- HTTP layer
- tool execution

---

# 8. MCP TOOL DESIGN RULES

Each MCP tool must:

1. Validate input using Zod
2. Resolve auth context from token
3. Call MailFlow API through the API client
4. Mask sensitive values
5. Return structured output
6. Log execution safely

Example tool location:

```
src/mcp/tools/campaign/startCampaign.tool.ts
```

---

# 9. PROJECT STRUCTURE

```
agent-service/
mailflow-mcp-server/
```

```
mailflow-mcp-server/
├── src
│   ├── config
│   ├── mcp
│   │   ├── tools
│   │   ├── registry
│   │   └── bootstrap
│   ├── services
│   ├── lib
│   ├── schemas
│   └── types
```

Claude must preserve this structure.

---

# 10. ENVIRONMENT VARIABLES

Typical environment variables:

```
PORT
MAILFLOW_API_URL
JWT_SECRET
NODE_ENV
LOG_LEVEL
```

All environment variables must be validated during startup.

---

# 11. TESTING REQUIREMENTS

Tests should exist for:

- schema validation
- MailFlow API client
- MCP tool execution
- masking of sensitive fields

Testing frameworks:

```
Vitest
Jest
```

---

# 12. DEPLOYMENT

Both services must be deployable independently.

Supported deployment environments include:

```
Docker
Kubernetes
AWS ECS
```

Ports must always be configurable via environment variables.

---

# 13. MIGRATION STRATEGY

The project is migrating from:

```
Direct API tools → MCP tools
```

Migration stages:

1. Deploy MCP server
2. Shadow test MCP tools
3. Update agents to use MCP tools
4. Remove direct API wrappers

Claude must avoid breaking compatibility during migration.

---

# 14. FUTURE ROADMAP

Potential future features:

- LLM-based reply summarization
- streaming agent responses
- service-to-service mTLS authentication
- additional MCP servers
- advanced analytics agents

Code must remain extensible.

---

# 15. CLAUDE DEVELOPMENT RULES

When modifying this repository, Claude must:

- follow the architecture
- respect security rules
- preserve folder structure
- avoid rewriting unrelated files
- maintain strict TypeScript compatibility
- generate production-ready code

Claude must never:

- expose secrets
- bypass validation
- move business logic outside MailFlow
- introduce breaking architectural changes

---

# 16. DEVELOPMENT WORKFLOW

When implementing new functionality:

1. Identify the correct service
2. Follow existing code patterns
3. Add or update schemas
4. implement logic
5. add tests
6. avoid large rewrites

Claude should prefer **small incremental changes**.

---

# 17. CORE PRINCIPLE

The AI layer **orchestrates behavior**.

MailFlow **executes business logic**.

This separation must always be preserved.

---

# 18. IMPLEMENTATION STATUS (as of 2026-03-29)

## What is built and tested

### agent-service

**LangGraph workflow (`src/graph/workflow/agent.workflow.ts`)**
- Full graph compiled and running
- Nodes: `loadMemory`, `detectIntent`, `planDetection`, `manager`, `campaignAgent`, `analyticsAgent`, `inboxAgent`, `settingsAgent`, `approvalCheck`, `executeTool`, `executePlanStep`, `finalResponse`, `saveMemory`
- Single-step and multi-step paths both wired

**Intent detection (`src/graph/nodes/detectIntent.node.ts`)**
- Gemini `classifyIntent` with `responseSchema` for API-level JSON enforcement
- Extracts `campaignId`, `limit`, `query`, `filters` from natural language
- Falls back to keyword matching when Gemini is unavailable

**Multi-step planning (`src/services/planner.service.ts`)**
- `plannerService.detectPlan()` calls Gemini `planSteps`
- Returns `PlannedStep[]` or `null` (null → single-step path)
- Validates all tool names and intents via Zod before accepting the plan
- Threads `campaignId` into every step via `resolveToolArgs()`
- Falls back to `activeCampaignId` from session context when LLM extracts none

**Approval workflow**
- `PendingActionStore` (in-memory; `RedisPendingActionStore` available)
- TTL: 10 minutes; lazy expiry check on `findById()`
- Atomic status transition prevents double-execution (pending → confirmed before tool runs)
- `PlanResumptionContext` stored inside `PendingAction` for mid-plan pauses
- On `/confirm`, `PlanExecutionService.resumePlan()` continues from the paused step

**Gemini service (`src/services/gemini.service.ts`)**
- `classifyIntent(message, candidates)` — with `INTENT_CLASSIFICATION_SCHEMA` responseSchema
- `planSteps(message, tools, intents)` — multi-step plan generation
- `generateJson(prompt, schema?)` — shared JSON generation with optional responseSchema

**HTTP API**
- `POST /api/agent/chat` — main chat endpoint
- `POST /api/agent/confirm` — confirm pending action
- `POST /api/agent/cancel` — cancel pending action
- `GET /health` and `GET /health/ready`
- All `/api/agent/*` routes protected by `requireAuth` JWT middleware

**Session handling**
- `sessionId` client-provided or server-generated UUID
- Persisted by `saveMemory` node (Redis/in-memory, TTL 24h)
- Carries: conversation history, `activeCampaignId`

### mailflow-mcp-server

**MCP tools implemented**
- Campaign: `create_campaign`, `update_campaign`, `start_campaign`, `pause_campaign`, `resume_campaign`
- Analytics: `get_campaign_stats`
- Inbox: `list_replies`, `summarize_replies`
- Settings: `get_smtp_settings`, `update_smtp_settings`

**`MockMailFlowApiClient` (`src/lib/mockMailflowApiClient.ts`)**
- Full in-memory implementation of `IMailFlowApiClient`
- Activated when `MOCK_MAILFLOW=true` (only permitted in `NODE_ENV=development`)
- Prevents all real backend HTTP calls during local development
- Wired in `toolRegistry.ts` — all tools branch on `env.MOCK_MAILFLOW`

**`MOCK_MAILFLOW` guard**
- `src/config/env.ts` Zod `.refine()` blocks `MOCK_MAILFLOW=true` when `NODE_ENV !== "development"`
- `vitest.config.ts` overrides `MOCK_MAILFLOW=false` for test runs to prevent env validation failure

## Test coverage

### agent-service tests

| File | Tests | Status |
|---|---|---|
| `src/graph/__tests__/agent.workflow.test.ts` | 20 | passing |
| `src/services/__tests__/planner.service.test.ts` | 16 | passing |
| `src/services/__tests__/gemini.service.test.ts` | 9 | passing |

**`agent.workflow.test.ts` mocking strategy:**
- Uses `vi.hoisted()` for `mockDetectPlan` and `mockExecuteFromState` — required because `vi.mock` factories run during import resolution (before `const` declarations initialize)
- Mocks: `gemini.service.js` → `undefined` (forces deterministic intent detection), `planner.service.js` → `mockDetectPlan`, `toolExecution.service.js` → `mockExecuteFromState`
- Does NOT mock: graph compilation, domain agent nodes, approval node (real `PendingActionStore`), `finalResponse` node

### mailflow-mcp-server tests (7 test files, 77 tests, all passing)

| File | Coverage |
|---|---|
| `src/tests/lib/mockMailflowApiClient.test.ts` | MockMailFlowApiClient — all methods, lifecycle, MOCK_MAILFLOW contract |

## Key env vars (actual names in use)

```
# agent-service
PORT
JWT_SECRET
GEMINI_API_KEY
GEMINI_MODEL
MCP_SERVER_URL
CORS_ALLOWED_ORIGINS
RATE_LIMIT_WINDOW_MS
RATE_LIMIT_MAX_REQUESTS
CHAT_RATE_LIMIT_MAX       # default 20
CONFIRM_RATE_LIMIT_MAX    # default 10
BODY_SIZE_LIMIT
SESSION_TTL_SECS          # default 86400
LOG_LEVEL
NODE_ENV

# mailflow-mcp-server
MAILFLOW_API_BASE_URL
JWT_SECRET
MOCK_MAILFLOW             # true only in NODE_ENV=development
LOG_LEVEL
NODE_ENV
```

## Docs

- `agent-service/docs/frontend-integration.md` — complete frontend handoff package:
  - all endpoints with request/response shapes
  - approval flow (single-step and mid-plan pause)
  - multi-step plan response examples
  - error code reference
  - recommended frontend state machine (TypeScript + React sketch)

## Approval-required intents

These intents always set `requiresApproval=true` and create a pending action before returning to the client:

- `start_campaign`
- `resume_campaign`
- `update_smtp` (tool: `update_smtp_settings`)

## Known tool → intent mapping

| Tool name | Intent |
|---|---|
| `create_campaign` | `create_campaign` |
| `update_campaign` | `update_campaign` |
| `start_campaign` | `start_campaign` |
| `pause_campaign` | `pause_campaign` |
| `resume_campaign` | `resume_campaign` |
| `get_campaign_stats` | `get_campaign_stats` |
| `list_replies` | `list_replies` |
| `summarize_replies` | `summarize_replies` |
| `get_smtp_settings` | `check_smtp` |
| `update_smtp_settings` | `update_smtp` |
