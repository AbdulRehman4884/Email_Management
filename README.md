# MailFlow AI Platform

A full-stack email campaign management platform with an integrated AI agent layer. Users manage campaigns through both a traditional dashboard and a natural-language chat interface powered by an LLM intent-detection pipeline and a structured MCP (Model Context Protocol) tool layer.

---

## Repository Structure

```
Email_Management/
├── Email_Management-main/       # Core platform (frontend + backend)
│   ├── backend/                 # REST API server (Express + Drizzle ORM + PostgreSQL)
│   └── web/                     # React SPA (Vite + React 19 + React Router)
│
└── Email_agent/                 # AI agent layer
    ├── agent-service/           # LangGraph orchestration (OpenAI + MCP client)
    └── mailflow-mcp-server/     # FastMCP server exposing backend as structured tools
```

---

## Architecture

```
User (Browser)
     │
     ▼
┌──────────────┐
│  web (React) │  :3001
└──────┬───────┘
       │ REST
       ▼
┌──────────────┐
│   backend    │  :3000   ← JWT auth · campaign CRUD · SMTP · PostgreSQL
└──────┬───────┘
       │ REST (internal)
       ▼
┌─────────────────────┐
│  agent-service      │  :3002   ← LangGraph graph · OpenAI intent detection
│  (LangGraph+OpenAI) │           approval workflow · session memory (Redis)
└──────────┬──────────┘
           │ MCP / SSE
           ▼
┌─────────────────────┐
│ mailflow-mcp-server │  :4000   ← FastMCP tools: create_campaign · start_campaign
│  (FastMCP)          │           pause_campaign · list_replies · get_smtp_settings
└─────────────────────┘
```

### Request Flow

1. User sends a natural-language message via the chat UI.
2. `agent-service` classifies intent via **OpenAI** (`gpt-4o-mini`) with a deterministic fallback.
3. The LangGraph graph routes to the correct domain agent (campaign / analytics / inbox).
4. Risky operations (`start_campaign`, `resume_campaign`, `update_smtp`) hit an **approval gate** before execution.
5. Approved or safe calls are dispatched to `mailflow-mcp-server` via MCP/SSE.
6. The MCP server validates parameters (Zod), calls the backend REST API, and returns structured results.
7. `agent-service` optionally enhances the response with OpenAI before returning it.

---

## Services

| Service | Path | Port | Description |
|---------|------|------|-------------|
| **frontend** | `Email_Management-main/web` | 3001 | React 19 SPA — dashboard + AI chat |
| **backend** | `Email_Management-main/backend` | 3000 | Express 5 REST API — auth, campaigns, SMTP, PostgreSQL |
| **agent-service** | `Email_agent/agent-service` | 3002 | LangGraph AI orchestration, OpenAI intent detection, approval workflow |
| **mailflow-mcp-server** | `Email_agent/mailflow-mcp-server` | 4000 | FastMCP server — 10 structured tools over SSE |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, React Router 6, Vite 6, TypeScript, Tailwind CSS |
| Backend | Express 5, TypeScript, Bun, Drizzle ORM, PostgreSQL |
| Agent | LangGraph, OpenAI SDK (`gpt-4o-mini`), Pino, Zod |
| MCP | FastMCP, Zod, PostgreSQL |
| Testing | Vitest (330 tests across agent-service) |
| Optional | Redis (session memory + pending action store) |

---

## Local Setup

### Prerequisites
- Node.js 18+ (agent-service, MCP server) / Bun (backend, frontend)
- PostgreSQL
- OpenAI API key

### 1. Backend
```bash
cd Email_Management-main/backend
cp .env.example .env          # add DATABASE_URL, JWT_SECRET, SMTP settings
bun install && bun run dev    # :3000
```

### 2. Frontend
```bash
cd Email_Management-main/web
cp .env.example .env          # VITE_API_URL=http://localhost:3000
bun install && bun run dev    # :3001
```

### 3. MCP Server
```bash
cd Email_agent/mailflow-mcp-server
cp .env.example .env          # BACKEND_URL, MCP_SERVICE_SECRET
npm install && npm run dev    # :4000
```

### 4. Agent Service
```bash
cd Email_agent/agent-service
cp .env.example .env          # JWT_SECRET, MCP_SERVER_URL, OPENAI_API_KEY
npm install && npm run dev    # :3002
```

### Key Environment Variables

| Variable | Service | Notes |
|----------|---------|-------|
| `DATABASE_URL` | backend | PostgreSQL connection string |
| `JWT_SECRET` | backend + agent-service | Must match across both, ≥ 32 chars |
| `MCP_SERVICE_SECRET` | agent-service + mcp-server | Shared inter-service secret |
| `OPENAI_API_KEY` | agent-service | Required for LLM intent detection |
| `OPENAI_MODEL` | agent-service | Default: `gpt-4o-mini` |
| `REDIS_URL` | agent-service | Optional — in-memory fallback if absent |

---

## AI Features

- **Natural language campaign management** — create, update, start, pause, resume via chat
- **LLM-first intent detection** — OpenAI classifies intent + extracts structured arguments; deterministic fallback when API unavailable
- **Approval workflow** — risky operations require explicit confirmation before execution
- **Multi-step planning** — compound requests executed as ordered MCP tool sequences
- **Security** — user identity always resolved from JWT; no LLM output can influence account actions

---

## Branch

Active development: `feature/full-agent-integration`

---

## License

MIT
