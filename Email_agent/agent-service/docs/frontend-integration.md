# MailFlow Agent — Frontend Integration Guide

> **Audience:** Frontend developer building the chat UI against `agent-service`.
> **Base URL:** `http://localhost:4000` (dev) — set via `AGENT_SERVICE_URL` env var.

---

## Table of Contents

1. [Authentication](#1-authentication)
2. [Endpoints](#2-endpoints)
3. [Session Handling](#3-session-handling)
4. [Normal Chat Flow](#4-normal-chat-flow)
5. [Approval Flow](#5-approval-flow)
6. [Multi-Step Plan Flow](#6-multi-step-plan-flow)
7. [Error Reference](#7-error-reference)
8. [Recommended Frontend State Model](#8-recommended-frontend-state-model)

---

## 1. Authentication

Every `/api/agent/*` endpoint requires a JWT bearer token.

```
Authorization: Bearer <token>
```

| Auth error | HTTP | `error.code` |
|---|---|---|
| Missing header | 401 | `AUTH_MISSING_TOKEN` |
| Invalid token | 401 | `AUTH_INVALID_TOKEN` |
| Expired token | 401 | `AUTH_EXPIRED_TOKEN` |
| Action owned by another user | 403 | `AUTH_FORBIDDEN` |

The server extracts `userId` from the JWT `sub` claim — never send `userId` in request bodies.

---

## 2. Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | none | Liveness probe |
| `GET` | `/health/ready` | none | Readiness probe |
| `POST` | `/api/agent/chat` | JWT | Send a user message |
| `POST` | `/api/agent/confirm` | JWT | Confirm a pending action |
| `POST` | `/api/agent/cancel` | JWT | Cancel a pending action |

### Response envelope

Every response — success or failure — uses this envelope:

```json
// success
{ "success": true,  "data": { ... },              "requestId": "uuid" }

// failure
{ "success": false, "error": { "code": "...", "message": "..." }, "requestId": "uuid" }
```

`requestId` is echoed in the `x-request-id` response header and useful for support/debugging.

---

## 3. Session Handling

`sessionId` is a client-managed UUID that threads a conversation across multiple turns.

**First message** — omit `sessionId`; the server generates one and returns it in every response. Persist it client-side (memory or `sessionStorage`).

**Subsequent messages** — send the same `sessionId` so the agent has conversation context (active campaign, previous tool results).

**Reset** — discard the stored `sessionId` to start a fresh conversation.

```ts
// minimal session manager
let sessionId: string | undefined;

function getHeaders() {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function sendMessage(message: string) {
  const res = await fetch("/api/agent/chat", {
    method: "POST",
    headers: getHeaders(),
    body: JSON.stringify({ message, sessionId }),   // sessionId undefined on first call
  });
  const body = await res.json();
  if (body.success) sessionId = body.data.sessionId; // persist for next turn
  return body;
}
```

---

## 4. Normal Chat Flow

### Request

```
POST /api/agent/chat
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "message": "Show me the stats for campaign test-123",
  "sessionId": "550e8400-e29b-41d4-a716-446655440000"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `message` | string | yes | 1–4000 characters |
| `sessionId` | UUID string | no | Omit on first message |

### Response — no approval needed

```json
{
  "success": true,
  "data": {
    "approvalRequired": false,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "response": "Here are the stats for campaign test-123:\n\n- Sent: 4,200\n- Open rate: 38%\n- Click rate: 12%",
    "toolResult": {
      "data": {
        "campaignId": "test-123",
        "sent": 4200,
        "openRate": 0.38,
        "clickRate": 0.12,
        "calculatedAt": "2026-03-27T11:30:00.000Z"
      },
      "isToolError": false
    }
  },
  "requestId": "req_abc123"
}
```

Display `data.response` as the assistant's message. `data.toolResult.data` is the raw structured payload if you need to render a custom widget.

If `data.toolResult.isToolError` is `true`, the tool ran but returned an error — `data.response` will contain a friendly error message.

### Response — workflow error

When the agent encounters an unrecoverable error the HTTP status is still `200`, but:

```json
{
  "success": true,
  "data": {
    "response": "The operation could not be completed: Campaign not found.",
    "error": true
  },
  "requestId": "req_abc123"
}
```

Check `data.error === true` to distinguish this from a successful response.

---

## 5. Approval Flow

Some actions are "risky" (they send real emails or mutate critical settings). The agent pauses before executing them and returns an approval prompt.

**Actions that require approval:** `start_campaign`, `resume_campaign`, `update_smtp_settings`

### Step 1 — Chat returns `approvalRequired: true`

```json
{
  "success": true,
  "data": {
    "approvalRequired": true,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "message": "Starting a campaign will immediately send emails to all subscribers. Please confirm to proceed.",
    "pendingAction": {
      "id": "7f3e9a1b-4c2d-4e5f-8a6b-1c2d3e4f5a6b",
      "intent": "start_campaign",
      "toolName": "start_campaign",
      "expiresAt": "2026-03-27T11:40:00.000Z"
    }
  },
  "requestId": "req_abc123"
}
```

Show `data.message` as the assistant message and render a **Confirm / Cancel** button pair. Persist `data.pendingAction.id` until the user acts.

`expiresAt` is 10 minutes from now. Show a countdown or warn the user before it expires.

### Step 2a — User confirms

```
POST /api/agent/confirm
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{ "pendingActionId": "7f3e9a1b-4c2d-4e5f-8a6b-1c2d3e4f5a6b" }
```

**Response:**

```json
{
  "success": true,
  "data": {
    "response": "Campaign test-123 is now running. Emails are being sent.",
    "toolResult": {
      "data": { "campaignId": "test-123", "status": "running", "startedAt": "2026-03-27T11:31:00.000Z" },
      "isToolError": false
    }
  },
  "requestId": "req_def456"
}
```

### Step 2b — User cancels

```
POST /api/agent/cancel
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{ "pendingActionId": "7f3e9a1b-4c2d-4e5f-8a6b-1c2d3e4f5a6b" }
```

**Response:**

```json
{
  "success": true,
  "data": {
    "cancelled": true,
    "message": "Action cancelled successfully."
  },
  "requestId": "req_def456"
}
```

### Approval error cases

| Scenario | HTTP | `error.code` |
|---|---|---|
| ID not found | 404 | `APPROVAL_NOT_FOUND` |
| Already confirmed / executed | 409 | `CONFLICT` |
| Expired (>10 min) | 410 | `APPROVAL_EXPIRED` |
| Not owned by this user | 403 | `AUTH_FORBIDDEN` |

On `APPROVAL_EXPIRED`, discard the `pendingActionId` and ask the user to retype their request.

---

## 6. Multi-Step Plan Flow

When the user requests a compound action (e.g., "show stats for test-123 then launch it"), the agent may run multiple tool calls in sequence.

### All steps safe — single response

If every step is safe the agent runs them all and returns a summary in one `/chat` response:

```json
{
  "success": true,
  "data": {
    "approvalRequired": false,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "response": "Done. Here's what happened:\n\nStep 1 — Paused campaign test-123.\nStep 2 — Stats: 4,200 sent, 38% open rate.",
    "toolResult": null
  },
  "requestId": "req_abc123"
}
```

No special handling needed — treat this like any normal chat response.

### Risky step in the plan — paused mid-plan

The agent runs all safe steps up to the first risky one, then pauses:

```json
{
  "success": true,
  "data": {
    "approvalRequired": true,
    "sessionId": "550e8400-e29b-41d4-a716-446655440000",
    "message": "Step 1 complete — retrieved stats (38% open rate, 12% click rate).\n\nStep 2 requires confirmation: starting campaign test-123 will immediately send emails to all subscribers.",
    "pendingAction": {
      "id": "9a8b7c6d-5e4f-3a2b-1c0d-ef1234567890",
      "intent": "start_campaign",
      "toolName": "start_campaign",
      "expiresAt": "2026-03-27T11:40:00.000Z"
    }
  },
  "requestId": "req_abc123"
}
```

The confirm/cancel flow is identical to the single-step case. On `/confirm`, the server resumes from the paused step and returns a summary of all completed steps:

```json
{
  "success": true,
  "data": {
    "response": "All steps complete:\n\nStep 1 — Stats retrieved.\nStep 2 — Campaign test-123 is now running.",
    "toolResult": {
      "data": { "campaignId": "test-123", "status": "running" },
      "isToolError": false
    }
  },
  "requestId": "req_def456"
}
```

---

## 7. Error Reference

### HTTP status → meaning

| HTTP | Meaning | Common `error.code` values |
|---|---|---|
| 400 | Bad request / validation | `VALIDATION_ERROR` |
| 401 | Auth failure | `AUTH_MISSING_TOKEN`, `AUTH_INVALID_TOKEN`, `AUTH_EXPIRED_TOKEN` |
| 403 | Forbidden | `AUTH_FORBIDDEN` |
| 404 | Not found | `NOT_FOUND`, `APPROVAL_NOT_FOUND` |
| 409 | Conflict | `CONFLICT` |
| 410 | Gone / expired | `APPROVAL_EXPIRED` |
| 429 | Rate limited | `RATE_LIMITED` |
| 500 | Server error | `INTERNAL_ERROR` |
| 502 | MCP/tool failure | `MCP_ERROR`, `MCP_TIMEOUT` |

### Validation error (400)

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": { "fieldErrors": { "message": ["message is required"] } }
  },
  "requestId": "req_abc123"
}
```

### Rate limited (429)

```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests — please slow down and try again."
  },
  "requestId": "req_abc123"
}
```

Default limits: 20 requests/window for `/chat`, 10 requests/window for `/confirm`.

### Server error (500)

```json
{
  "success": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "An unexpected error occurred"
  },
  "requestId": "req_abc123"
}
```

`details` is omitted in production. Log `requestId` and report it.

---

## 8. Recommended Frontend State Model

```ts
// Chat UI state machine

type Message =
  | { role: "user";      content: string }
  | { role: "assistant"; content: string }
  | { role: "error";     content: string };

type PendingAction = {
  id: string;
  intent: string;
  toolName: string;
  message: string;       // confirmation prompt shown to user
  expiresAt: string;     // ISO-8601
};

type ChatState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "approval_pending"; pendingAction: PendingAction }
  | { status: "confirmed" }
  | { status: "error"; code: string; message: string };

type ChatStore = {
  state:     ChatState;
  messages:  Message[];
  sessionId: string | undefined;
};
```

### State transitions

```
idle
 │  user submits message
 ▼
loading
 ├─ approvalRequired=false ──► idle          (append assistant message)
 ├─ approvalRequired=true  ──► approval_pending
 └─ HTTP error / data.error ──► error

approval_pending
 ├─ user confirms ──► loading ──► confirmed ──► idle
 ├─ user cancels  ──► idle    (append "Action cancelled.")
 └─ APPROVAL_EXPIRED ──────────► error       (prompt user to retry)

error
 └─ user dismisses / retries ──► idle
```

### React sketch

```tsx
function ChatUI() {
  const { state, messages, sessionId, dispatch } = useChatStore();

  async function handleSend(text: string) {
    dispatch({ type: "SEND_START" });
    const body = await agentChat(text, sessionId);

    if (!body.success) {
      dispatch({ type: "ERROR", code: body.error.code, message: body.error.message });
      return;
    }

    const { data } = body;
    dispatch({ type: "SAVE_SESSION", sessionId: data.sessionId });

    if (data.approvalRequired) {
      dispatch({ type: "APPROVAL_REQUIRED", pendingAction: data.pendingAction, message: data.message });
    } else if (data.error) {
      dispatch({ type: "WORKFLOW_ERROR", message: data.response });
    } else {
      dispatch({ type: "SEND_SUCCESS", response: data.response });
    }
  }

  async function handleConfirm() {
    if (state.status !== "approval_pending") return;
    dispatch({ type: "SEND_START" });
    const body = await agentConfirm(state.pendingAction.id);

    if (!body.success) {
      if (body.error.code === "APPROVAL_EXPIRED") {
        dispatch({ type: "ERROR", code: body.error.code, message: "This action expired — please try again." });
      } else {
        dispatch({ type: "ERROR", code: body.error.code, message: body.error.message });
      }
      return;
    }

    dispatch({ type: "CONFIRMED", response: body.data.response });
  }

  async function handleCancel() {
    if (state.status !== "approval_pending") return;
    await agentCancel(state.pendingAction.id);
    dispatch({ type: "CANCEL" });
  }

  return (
    <div>
      <MessageList messages={messages} />

      {state.status === "approval_pending" && (
        <ApprovalBanner
          message={state.pendingAction.message}
          expiresAt={state.pendingAction.expiresAt}
          onConfirm={handleConfirm}
          onCancel={handleCancel}
        />
      )}

      {state.status === "error" && (
        <ErrorBanner code={state.code} message={state.message} />
      )}

      <MessageInput
        disabled={state.status === "loading" || state.status === "approval_pending"}
        onSend={handleSend}
      />
    </div>
  );
}
```

### Key UI rules

- **Disable the input** while `status === "loading"` or `status === "approval_pending"`. The user must resolve the pending action before sending another message.
- **Show expiry feedback.** If the countdown reaches zero, move to `error` state and tell the user to retype their request.
- **Echo `requestId`** in error messages so support can correlate server logs.
- **Never send `userId`** in request bodies — it is resolved server-side from the JWT.
- **Re-use `sessionId`** across turns within the same conversation. Only clear it when the user explicitly starts a new session.

---

## Quick Reference

```
POST /api/agent/chat
  body:    { message, sessionId? }
  returns: { approvalRequired: false, sessionId, response, toolResult? }
         | { approvalRequired: true,  sessionId, message, pendingAction }
         | { response, error: true }

POST /api/agent/confirm
  body:    { pendingActionId }
  returns: { response, toolResult? }

POST /api/agent/cancel
  body:    { pendingActionId }
  returns: { cancelled: true, message }

All errors:
  { success: false, error: { code, message, details? }, requestId }
```
