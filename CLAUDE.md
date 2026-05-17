# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

MailFlow AI Platform: a full-stack email marketing system with a traditional dashboard and a natural-language AI agent interface. Four services, each in its own subdirectory.

```
Email_Management-main/backend/    Express 5 REST API  — :3000  (Bun runtime)
Email_Management-main/web/        React 19 SPA        — :3001  (Vite, Bun)
Email_agent/agent-service/        LangGraph agent     — :3002  (Node/tsx)
Email_agent/mailflow-mcp-server/  FastMCP tool layer  — :4000  (Node/tsx)
```

The agent layer is documented separately in [Email_agent/CLAUDE.md](Email_agent/CLAUDE.md). This file covers the whole-project picture and the web/backend services.

---

## Commands

### Backend (`Email_Management-main/backend`) — Bun
```bash
bun run dev              # start API server (hot-reload via tsx)
bun run worker           # start email-sending background worker
bun run imap-worker      # start IMAP reply-fetching worker
bun run generate:migrations  # generate Drizzle migration files
bun run apply:migrations     # apply pending migrations to PostgreSQL
```
No test runner in the backend. Validation is done at the controller layer.

### Web (`Email_Management-main/web`) — Bun + Vite
```bash
bun run dev              # Vite dev server
bun run build            # production build to dist/
npx vitest               # unit tests (watch mode)
npx vitest run           # unit tests (single run)
```

### Agent-service (`Email_agent/agent-service`) — Node/npm
```bash
npm run dev              # tsx watch (hot-reload)
npm run typecheck        # tsc --noEmit
npm test                 # vitest run (599 tests)
npm run test:watch       # vitest watch
npx vitest run --reporter=verbose src/lib/__tests__/toolArgResolver.test.ts  # single file
```

### MCP Server (`Email_agent/mailflow-mcp-server`) — Node/npm
```bash
npm run dev              # tsx watch
npm run typecheck        # tsc --noEmit
npm test                 # vitest run (127 tests)
```

---

## Architecture

### Request flow (AI path)
```
Browser chat UI
  → POST /api/agent/chat  (agent-service :3002, JWT-protected)
  → LangGraph graph: loadMemory → detectIntent → planDetection
    → manager → [campaignAgent | analyticsAgent | inboxAgent]
    → approvalCheck → executeTool → finalResponse → saveMemory
  → MCP/SSE call to mailflow-mcp-server :4000
  → HTTP request to backend :3000 with forwarded JWT
  → PostgreSQL
```

### Request flow (web UI path)
```
Browser dashboard
  → REST calls directly to backend :3000 (JWT-protected)
  → PostgreSQL
```

### Inter-service auth
- All four services share the same `JWT_SECRET` — the backend issues JWTs at login; the web, agent-service, and MCP server all validate against the same secret.
- The MCP server forwards the user's bearer token on every backend call; it never generates its own tokens.
- `MCP_SERVICE_SECRET` (or equivalent) is used only for agent-service → MCP server transport authentication.

---

## Backend Domain Knowledge

### Campaign lifecycle
Status machine: `draft → scheduled → in_progress → paused → completed`  
The `POST /api/campaigns/:id/start` endpoint **only changes status** — it does **not** send emails. Actual email sending is done by `backend/src/workers/emailWorker.ts`, which polls every 2 seconds for `in_progress` campaigns and processes recipients in batches of 20.

Prerequisites enforced by `/start`:
1. Campaign must be `draft` or `scheduled`
2. At least one `pending` recipient must exist (returns 422 otherwise)
3. SMTP settings must be configured for the user

### Recipients
Recipients are uploaded separately via `POST /api/campaigns/:id/recipients/upload` (multipart CSV/Excel), **after** campaign creation. The agent has no MCP tool to upload recipients — users must do this through the web UI. The `recieptCount` column on `campaigns` (note the typo — it's in the schema and must be preserved) tracks the total.

### scheduledAt format
The backend stores `scheduledAt` as `varchar(30)` in the format `"YYYY-MM-DD HH:MM:SS"` (local wall clock, no timezone). The MCP server's Zod schema requires ISO 8601 with timezone (`"2025-06-01T09:00:00Z"`). The backend `PUT /api/campaigns/:id` accepts ISO 8601 input and normalizes it via `normalizeLocalScheduleInput()` before storage.

### Known schema typos (preserved intentionally — do not fix)
- `campaigns.recieptCount` / `reciept_count` (should be "receipt")
- `campaign_stats.delieveredCount` / `delivered_count` (column is `delivered_count` in DB, mapped from JS field `delieveredCount`)

### Status normalization (MCP layer)
The backend returns status `"in_progress"`; the MCP normalizer converts it to `"running"` before returning to the agent. When the agent says "running," the backend/web show "in progress."

### SMTP
SMTP settings are per-user, stored in `smtp_settings`. `fromName` and `fromEmail` are derived from the user's SMTP settings at campaign creation — the agent does not need to supply them when creating a campaign.

---

## Database Schema (key tables)

| Table | Primary Key | Notable |
|-------|-------------|---------|
| `users` | `id` integer | role: `user \| admin` |
| `campaigns` | `id` integer | `scheduledAt` is varchar, not timestamp |
| `recipients` | `id` integer | `campaignId` FK; status: `pending\|sent\|delivered\|bounced\|failed\|complained` |
| `campaign_stats` | `id` integer | one row per campaign, all counts start at 0 |
| `smtp_settings` | `id` integer | one row per user; `user` column = SMTP login, `fromEmail` must equal `user` |
| `email_replies` | `id` integer | inbound replies polled by IMAP worker |

Drizzle ORM schema: `Email_Management-main/backend/src/db/schema.ts`  
Migrations: `Email_Management-main/backend/drizzle/`

---

## Key Environment Variables

| Variable | Services | Purpose |
|----------|----------|---------|
| `DATABASE_URL` | backend | PostgreSQL connection string |
| `JWT_SECRET` | backend + agent-service + mcp-server | Shared JWT signing key (≥32 chars) |
| `GEMINI_API_KEY` | agent-service | LLM intent detection (falls back to keyword matching if absent) |
| `GEMINI_MODEL` | agent-service | Default: `gemini-2.0-flash` |
| `MCP_SERVER_URL` | agent-service | URL of mailflow-mcp-server (e.g., `http://localhost:4000`) |
| `MAILFLOW_API_BASE_URL` | mcp-server | Backend base URL including `/api` prefix (e.g., `http://localhost:3000/api`) |
| `REDIS_URL` | agent-service | Optional; falls back to in-memory session store |
| `MOCK_MAILFLOW` | mcp-server | `true` only in `NODE_ENV=development`; uses in-memory mock client |

---

## Frontend State Management

The web SPA uses Zustand stores (`web/src/store/`):
- `authStore` — current user, JWT token
- `campaignStore` — campaign list, current campaign
- `dashboardStore` — aggregated stats
- `themeStore` — dark/light theme preference

React Router pages map 1:1 to features: `CampaignList`, `CreateCampaign`, `EditCampaign`, `CampaignDetail`, `Analytics`, `Inbox`, `Settings`, `AgentChat`.

---

## Testing Approach

The backend has no automated test suite — validation is exercised manually or via integration.

The agent-service and mcp-server use Vitest. Key testing patterns:
- `vi.hoisted()` is required for mocks used inside `vi.mock()` factory functions (LangGraph import ordering constraint)
- `mockExecuteFromState` mocks the entire MCP dispatch layer in workflow tests
- All campaign IDs in test fixtures must be **numeric strings** (e.g., `"1"`, `"42"`) — the backend uses PostgreSQL integer PKs, and `resolveCampaignId()` rejects non-numeric values like `"camp-1"`
