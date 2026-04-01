# MailFlow MCP Server — Implementation PRD

## Overview

`mailflow-mcp-server` is a standalone TypeScript service that exposes MailFlow backend
capabilities as standardized Model Context Protocol (MCP) tools. It acts as the tool-exposure
layer between the LangGraph-based `agent-service` and the MailFlow backend APIs.

---

## Goals

- Expose MailFlow operations as typed, validated MCP tools consumable by agent-service
- Provide a clean, auditable boundary between orchestration logic and API integration
- Enforce auth at the transport/context layer, never via raw userId in tool payloads
- Produce deployment-ready, production-grade TypeScript with zero demo-only code
- Enable future expansion of tools without touching orchestration code

## Non-Goals

- Does NOT contain business logic (that lives in MailFlow backend)
- Does NOT merge with agent-service
- Does NOT replace or bypass MailFlow APIs
- Does NOT expose a user-facing REST API

---

## Architecture Position

```
agent-service (LangGraph orchestration)
      ↓  MCP over SSE or stdio
mailflow-mcp-server (FastMCP)
      ↓  HTTP + JWT Bearer
MailFlow backend APIs
      ↓
PostgreSQL / workers / MailFlow system
```

---

## System Components

### 1. FastMCP Server (`src/server.ts`, `src/mcp/bootstrap/`)
- Bootstraps a FastMCP server instance
- Registers all tools via the tool registry
- Supports SSE (primary) and stdio (fallback/testing) transports
- Configured entirely through environment variables

### 2. MailFlow API Client (`src/lib/mailflowApiClient.ts`)
- Single Axios instance — all MailFlow HTTP calls go through here
- Injects Authorization header per request
- Typed request/response contracts
- Structured error mapping to domain errors

### 3. Auth Context (`src/services/authContext.service.ts`, `src/mcp/context/`)
- Extracts bearer token from MCP session or request context
- Never reads userId from tool payload
- Provides typed `AuthContext` to all tool handlers
- Designed so service-to-service auth (shared secret, mTLS) can be added via adapter

### 4. Tool Registry (`src/mcp/registry/toolRegistry.ts`)
- Central registration point for all MCP tools
- Imported once in bootstrap
- Keeps tool definitions decoupled from server bootstrap

### 5. Tool Modules (`src/mcp/tools/**`)
- One file per tool
- Each tool owns: FastMCP tool definition, Zod schema reference, MailFlow client call
- No cross-tool dependencies

### 6. Schemas (`src/schemas/`)
- Zod schemas for all tool inputs, shared across tools and tests
- Single source of truth for input validation

### 7. Tool Execution Service (`src/services/toolExecution.service.ts`)
- Wraps tool handler invocation
- Centralizes error catching, logging, and result normalization

### 8. Logger (`src/lib/logger.ts`)
- Pino structured logger
- Never logs secrets or bearer tokens
- SMTP passwords always masked

### 9. Error Layer (`src/lib/errors.ts`)
- Typed error hierarchy: MailFlowApiError, AuthError, ToolExecutionError, ValidationError
- Consistent serialization for MCP responses

---

## MCP Tools (Phase 1 scope)

| Tool Name            | Category   | MailFlow Endpoint          |
|----------------------|------------|----------------------------|
| create_campaign      | Campaign   | POST /campaigns            |
| update_campaign      | Campaign   | PATCH /campaigns/:id       |
| start_campaign       | Campaign   | POST /campaigns/:id/start  |
| pause_campaign       | Campaign   | POST /campaigns/:id/pause  |
| resume_campaign      | Campaign   | POST /campaigns/:id/resume |
| get_campaign_stats   | Analytics  | GET /campaigns/:id/stats   |
| list_replies         | Inbox      | GET /replies               |
| summarize_replies    | Inbox      | deterministic (Phase 1)    |
| get_smtp_settings    | Settings   | GET /settings/smtp         |
| update_smtp_settings | Settings   | PATCH /settings/smtp       |

---

## Auth Strategy

MailFlow backend requires JWT Bearer auth on all endpoints.

**Transport**: agent-service → MCP server will pass auth via:
- **SSE transport**: Bearer token in `Authorization` header on the SSE handshake request (primary)
- **Shared service secret**: `X-Service-Token` header for service-to-service trust (future)

**Rule**: Tool handlers receive `AuthContext` (typed, validated) injected by
`authContext.service.ts`. Raw `userId` is never accepted in tool input payloads.

**Abstraction**: If FastMCP session-level header extraction is unavailable, the adapter
falls back to an environment-scoped service token, documented clearly.

---

## Security Requirements

- No secrets in logs
- SMTP `password` fields always masked (`***`) in logs and tool responses
- Bearer tokens never logged
- All tool inputs validated with Zod before any API call
- Auth failures return structured errors, not stack traces

---

## Environment Configuration

All configuration via environment variables, validated at startup via Zod.
Missing required vars → process exits with clear error message.

Required vars:
- `MAILFLOW_API_BASE_URL`
- `MAILFLOW_SERVICE_TOKEN` (service-to-service auth, optional phase 1)
- `MCP_TRANSPORT` (sse | stdio)
- `MCP_SSE_PORT` (when SSE)
- `LOG_LEVEL`
- `NODE_ENV`

---

## Observability

- All tool invocations logged: tool name, duration, success/failure
- Errors include structured metadata (tool, input shape, HTTP status)
- No PII or secrets in log output

---

## Testing Strategy

- Vitest unit tests for: schema validation, API client methods, tool execution service, SMTP masking
- Integration test stubs for at least two tools (createCampaign, getSmtpSettings)
- Tests use mocked Axios, not live MailFlow backend

---

## Deployment

- Runs as a standalone Node.js process
- Containerizable: no filesystem state, config via env
- Stateless: all state lives in MailFlow backend
- Health check endpoint (when SSE): `GET /health`

---

## Build Phases

| Phase | Deliverable                        |
|-------|------------------------------------|
| 1     | PRD, scaffold, config, logger, errors |
| 2     | Shared types                       |
| 3     | MailFlow API client                |
| 4     | Auth context strategy              |
| 5     | Tool schemas (Zod)                 |
| 6     | MCP tools (10 tools)               |
| 7     | Registry and bootstrap             |
| 8     | Tool execution service             |
| 9     | Logger and error handling polish   |
| 10    | Tests                              |
| 11    | README                             |
| 12    | LangGraph integration note         |
