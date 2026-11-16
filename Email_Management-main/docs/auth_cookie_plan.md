# Plan: cookie-based sessions (N-07, N-17)

Status: **implemented locally (batches 1-4 together), not committed, not deployed.** Batch 5 (remove the legacy
upgrade) is still to do, 7+ days after release.

Deploy order: (1) back up, run `npx tsx backend/scripts/run-auth-migration.ts` (creates `auth_refresh_tokens`);
(2) deploy backend + web together; (3) make sure the server env does **not** set `JWT_EXPIRES_IN=7d` (default is now
15m) and that `CORS_ORIGIN` lists the web app origin if it is not the API's own host; (4) tell the agent developer
tokens are now 15 min (no change needed on their side). Rollback: redeploy the previous build (it still works with
Bearer tokens), then optionally `run-auth-migration.ts --rollback`.

Tested locally: 30 API checks (cookie flags, CSRF/origin, rotation, reuse detection, logout, deactivation, legacy
upgrade, Bearer path) and 22 browser checks in Edge (login, reload, deep link, silent refresh after expiry, agent
Bearer + 401 retry, two tabs, logout, legacy localStorage user moved over, public pricing page). Unit tests:
`npm run test:auth`.

Today the login JWT (7 days, `JWT_EXPIRES_IN ?? '7d'`) is stored in `localStorage` and `sessionStorage` (`auth_token`,
`auth_user`) and sent as `Authorization: Bearer`. Any script on the page (XSS) can read it and use it for a week.

Goal: nothing readable by page scripts survives a reload, access tokens live 15 minutes, a refresh token sits in an
httpOnly cookie, is rotated on every use and is revoked on logout. **The AI agent keeps working with no change on
its side.**

---

## 1. Where the token is read or sent today

### Web (`Email_Management-main/web/src`) - ours

| File | What it does with the token |
|---|---|
| `lib/api.ts:42-56` | `getStoredToken()` reads `auth_token` (sessionStorage, then localStorage); request interceptor adds `Authorization: Bearer` to every API call |
| `lib/api.ts:88-110` | on any 401: deletes `auth_token`/`auth_user` from both storages, `clearUserScopedState()`, redirects to `/login?redirect=` (F-12) |
| `lib/api.ts:1212-1226` | `agentHttp` (AI agent service, `VITE_AGENT_API_URL`) adds the **same** token as `Authorization: Bearer` |
| `store/authStore.ts:39-98` | `setAuth()` writes token + user to both storages; `logout()` removes them; `hydrate()` reads them on load; `getToken()` |
| `store/themeStore.ts:48` | reads `auth_token` straight from storage to decide whether to save the theme on the server |
| `components/RequireAuth.tsx:11-28` | `hydrate()`, then "logged in" = `token` present |
| `App.tsx:87-107` | after hydrate, calls `/auth/me` and `setAuth(user, token)` to refresh plan info |
| `pages/Login.tsx:16,46-47` | `authApi.login()` -> `setAuth(user, token)`; F-30 redirect when a token already exists |
| `pages/Signup.tsx:69-74` | `authApi.signup()` -> `setAuth(user, token)` |
| `pages/Packages.tsx:217`, `pages/CheckoutSuccess.tsx:20` | "is logged in" = `!!token && !!user` (CK-01) |
| `lib/sessionReset.ts` | clears user-scoped state; bumps the session generation so stale responses are dropped (does not touch the token itself) |
| `components/Layout.tsx` | Logout button -> `authStore.logout()` (no server call today) |

No raw `fetch`, `EventSource` or WebSocket sends the token; everything goes through `api` or `agentHttp`.

### Backend (`Email_Management-main/backend/src`) - ours

| File | What it does |
|---|---|
| `middleware/authMiddleware.ts` | `authMiddleware`: only `Authorization: Bearer`, `jwt.verify(JWT_SECRET)`, sets `req.user`. `signToken()`: payload `{ userId, email, role }`, `expiresIn: JWT_EXPIRES_IN ?? '7d'`. Does **not** re-check `users.is_active` |
| `controllers/authController.ts:97` | `signup` returns `{ user, token }` |
| `controllers/authController.ts:107-148` | `login` (SEC-02 throttle, `isActive` check) returns `{ user, token }` |
| `controllers/authController.ts` `me`, `updatePreferredTheme` | `/auth/me` GET/PATCH behind `authMiddleware` |
| `controllers/authController.ts` `resetPassword` | sets a new password; old tokens stay valid until they expire |
| `routers/authRouter.ts` | public: signup, login, forgot/verify/reset; protected: `/auth/me` |
| `index.ts:32-45` | CORS: `credentials: true`, origins = 4 hard-coded `localhost` ports **always** + `CORS_ORIGIN` env |
| `index.ts:82-94` | every protected router uses `authMiddleware` (campaigns, settings, user, crm, replies, follow-ups, admin, dev) |
| `controllers/adminController.ts` | super admin can deactivate/delete users; their tokens keep working |
| `lib/crm/webTracking.ts:111` | `clientIp()` (used by the login throttle) - unrelated to the token, but cookies must not change it |

`JWT_SECRET` is also the fallback secret for unsubscribe links, lead codes and IP hashing (`lib/unsubscribeToken.ts`,
`lib/crm/linkCode.ts`, `lib/crm/webTracking.ts`). **Do not rotate `JWT_SECRET` as part of this work.**

### AI agent / MCP server (`Email_agent/`) - **agent developer's files, not to be edited**

| File | What it does |
|---|---|
| `Email_agent/agent-service/src/middleware/auth.ts` | `requireAuth`: reads `Authorization: Bearer`, `jwt.verify(token, env.JWT_SECRET)` (**same secret as the backend**), user id from `sub` / `userId` / `id`; 401 `AUTH_EXPIRED_TOKEN` when expired |
| `Email_agent/agent-service/src/config/env.ts` | `JWT_SECRET` (min 32 chars) |
| `Email_agent/agent-service/src/controllers/agent.controller.ts` | passes `authContext.rawToken` of the current request; comment: "NEVER stored" |
| `Email_agent/agent-service/src/lib/mcpClient.ts` | forwards it to the MCP server as `X-Forwarded-Authorization: Bearer <token>` |
| `Email_agent/agent-service/src/services/mcpToolCaller.ts`, `graph/state/agentGraph.state.ts`, `graph/nodes/bulkWorkflow.node.ts` | carry `rawToken` through one request |
| `Email_agent/mailflow-mcp-server/src/services/authContext.service.ts`, `mcp/bootstrap/createServer.ts`, `config/constants.ts` | read `X-Forwarded-Authorization` |
| `Email_agent/mailflow-mcp-server/src/lib/mailflowApiClient.ts` | calls the MailFlow API with `Authorization: Bearer <token>` |

Consequences for the design:
- The browser must still be able to send a **Bearer JWT** to the agent service (a different origin, port 3002), and
  the MCP server must still be able to call the MailFlow API with **Bearer**. So the backend must keep accepting
  Bearer, and the access token must keep the same format: HS256, `JWT_SECRET`, payload `{ userId, email, role }`.
- The agent never stores tokens: each request uses the token that came with it. A 15-minute token is fine as long as
  the web app sends a fresh one (it refreshes before calling the agent, see 2.4).

---

## 2. Design (backward compatible)

### 2.1 Tokens

| | Access token | Refresh token |
|---|---|---|
| Format | JWT, **unchanged** payload `{ userId, email, role }` (+ optional `sid` claim, ignored by the agent) | 32 random bytes (base64url), opaque, **not** a JWT |
| Lifetime | 15 min (`JWT_EXPIRES_IN=15m`, env only) | 7 days idle (same as today's login), rotated on every use; 30 days absolute per login |
| Where (browser) | memory only (Zustand store), never storage; also as cookie `mf_at` (see 2.2) | cookie `mf_rt` only |
| Stored on server | no | only its SHA-256 hash, in `auth_refresh_tokens` |

### 2.2 Cookies

| Cookie | Attributes | Purpose |
|---|---|---|
| `mf_rt` | `HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=604800` | refresh token; sent only to `/api/auth/*` |
| `mf_at` | `HttpOnly; Secure; SameSite=Lax; Path=/api; Max-Age=900` | access token for MailFlow API calls from the browser |
| `mf_csrf` | **not** HttpOnly; `Secure; SameSite=Strict; Path=/` | CSRF double-submit value (2.5) |

`Secure` works on `http://localhost` in Chrome/Edge/Firefox (localhost counts as a secure context). Web on :3001 and
API on :3000 are the same *site* (ports do not matter for SameSite), so cookies flow in dev with `withCredentials`.

### 2.3 Backend changes

- **`authMiddleware`** accepts, in this order:
  1. `Authorization: Bearer <jwt>` - unchanged path (agent, MCP server, scripts, old web build). No CSRF check
     (a browser never adds this header by itself).
  2. else cookie `mf_at` - then the **CSRF check** (2.5) runs for non-GET/HEAD/OPTIONS.
  Same `jwt.verify`, same `req.user`. Nothing changes for any router.
- **New endpoints** (`routers/authRouter.ts`):
  - `POST /api/auth/refresh` - reads `mf_rt`, checks hash + not revoked + not expired + user `is_active`; **rotates**:
    marks the old row `revoked_at`/`replaced_by`, inserts a new row (same `family_id`), sets new `mf_rt`, `mf_at`,
    `mf_csrf`, returns `{ user, token }` (the in-memory access token, for the agent). CSRF check required.
  - `POST /api/auth/logout` - revokes the row of the presented `mf_rt`, clears all three cookies. Works even when the
    access token has expired. CSRF check required.
  - `POST /api/auth/session` (temporary, migration only) - Bearer-authenticated with an old 7-day token; issues the
    cookies + a refresh row, so a user who is logged in today is moved over without signing in again (section 4).
- **`login` / `signup`**: unchanged JSON body `{ user, token }` (so old web builds and any script keep working) **plus**
  the three cookies and a refresh row.
- **Reuse detection**: a refresh token that is already revoked is presented -> revoke the whole `family_id` (all
  sessions of that login) and answer 401. Grace: if it was replaced less than 30 s ago (two tabs refreshing at once),
  answer 401 *without* revoking the family; the web lock (2.4) makes this rare.
- **Revoke all of a user's refresh tokens** on: password reset (`resetPassword`), admin deactivate / delete
  (`adminController.ts`; `ON DELETE CASCADE` covers delete). Access tokens already issued still work for at most 15 min.
- **New files**: `lib/refreshTokens.ts` (issue / rotate / revoke / purge), `middleware/csrf.ts`, cookie parsing
  (`cookie-parser` dependency, or a 10-line parser to avoid a new package).
- **Purge job**: daily delete of rows expired more than 30 days ago (in the existing worker's interval).

### 2.4 Web changes

- `authStore`: token and user in **memory only**; on logout/401 nothing to delete except memory. Remove all
  `localStorage`/`sessionStorage` writes of `auth_token`/`auth_user`; on first load of the new build delete those keys
  after the migration call (section 4).
- App start (`RequireAuth`/`App.tsx`): `hydrate()` becomes async: `POST /auth/refresh` -> `{ user, token }`, or no
  session -> `/login?redirect=` (F-12 kept). Show the existing spinner meanwhile.
- `api.ts`: `withCredentials: true`; send `X-CSRF-Token` (value of `mf_csrf`) on non-GET requests; on 401 do **one**
  refresh (single-flight promise, shared across tabs with `navigator.locks.request('mf-refresh', ...)`), retry the
  request once, and only then go to login.
- `agentHttp`: `Authorization: Bearer <in-memory token>`; before each agent call refresh if the token expires in
  under 60 s; on agent 401 `AUTH_EXPIRED_TOKEN` refresh once and retry. **No agent-side change.**
- Logout button: `POST /auth/logout`, then clear memory (keep the confirmation added in GEN-70).
- `themeStore.ts:48`, `Packages.tsx:217`, `CheckoutSuccess.tsx:20`, `Login.tsx:16`: use the store's in-memory state
  instead of storage / `token`.

### 2.5 CSRF and CORS

Once a cookie can authenticate a request, a page on another site could make the browser send it. Protection, all three:

1. **SameSite**: `Strict` on `mf_rt`/`mf_csrf`, `Lax` on `mf_at` (cross-site POST/PUT/DELETE never carry them).
2. **Origin check** (in `middleware/csrf.ts`): for cookie-authenticated non-GET requests and for `/auth/refresh`,
   `/auth/logout`: `Origin` (or `Referer` when `Origin` is missing) must be in the allowlist, else 403.
3. **Double-submit token**: `X-CSRF-Token` header must equal the `mf_csrf` cookie (random per session, rotated with the
   refresh token), else 403.

Not affected (they never use the auth cookie): Stripe webhook `/api/payment/webhook`, inbound email webhooks,
`/api/public/*`, `/api/track/*`, `/api/unsubscribe`, `/t.js`, `/f.js`, `/f/*`. Bearer requests skip CSRF.
Audit step before batch 2: list every protected **GET** route that changes data (GET is not CSRF-checked); move any to
POST or add the check.

**CORS** (`index.ts`): `credentials: true` (already); origins = **exact** list from `CORS_ORIGIN` (no `*`, no
regex); the four `localhost` origins only when `NODE_ENV !== 'production'` (today they are always allowed, which with
cookies would let a page on any visitor's local port make credentialed calls). Add `X-CSRF-Token` to allowed headers.
Confirm the production topology first: if web and API are the same origin through nginx (`/api` proxied, see
`deploy/nginx_mailflow_snippet.conf`), CORS is not even involved for the browser; if the API is on another *site*,
cookies would need `SameSite=None` and this plan must be revisited.

---

## 3. Database

New migration `backend/drizzle/0038_auth_refresh_tokens.sql` (+ entry in `drizzle/meta/_journal.json`, table in
`db/schema.ts`):

```sql
CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
  id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,                       -- one login = one family; rotation keeps it
  token_hash   varchar(64) NOT NULL UNIQUE,         -- sha256 hex of the cookie value
  csrf_hash    varchar(64) NOT NULL,                -- sha256 hex of the mf_csrf value
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,                -- idle expiry (7 days from issue)
  family_expires_at timestamptz NOT NULL,           -- absolute expiry (30 days from login)
  revoked_at   timestamptz,
  replaced_by  integer REFERENCES auth_refresh_tokens(id) ON DELETE SET NULL,
  user_agent   varchar(255),
  ip_hash      varchar(64)
);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_user_idx   ON auth_refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_family_idx ON auth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS auth_refresh_tokens_expiry_idx ON auth_refresh_tokens (expires_at);
```

Rollback file `backend/drizzle/0038_auth_refresh_tokens_rollback.sql` (same style as `0037_..._rollback.sql`):

```sql
-- Undo migration 0038 (cookie sessions). Removes only the refresh-token table: every cookie session ends and users
-- sign in again (with the Bearer-only code of batch 1 they are unaffected). No other table is touched.
DROP TABLE IF EXISTS auth_refresh_tokens;
```

All `timestamptz` (not `timestamp`): avoids the PKT/UTC problem found in F-20.

---

## 4. Users who are already logged in

- Batches 1-2 change nothing for them (Bearer still accepted, JSON body unchanged).
- Batch 3 (new web build): on first load, if `auth_token` is still in storage, the web calls
  `POST /api/auth/session` with it as Bearer -> gets cookies + an in-memory token -> deletes `auth_token`/`auth_user`
  from both storages. No re-login. If the old token is expired/invalid -> keys deleted -> normal login page.
- Old 7-day tokens keep working as Bearer until they expire (at most 7 days after batch 3). They cannot be revoked
  (no server record); this is the residual window. Optional, only together with the agent developer: rotate
  `JWT_SECRET` afterwards to end it at once (it would also invalidate unsubscribe links and lead codes unless
  `UNSUBSCRIBE_SECRET` / `TRACKING_SECRET` are set first).
- Batch 5 removes `/api/auth/session` and the storage-migration code.

---

## 5. Testing

Local only (local DB, `STRIPE_SECRET_KEY=sk_test_placeholder`).

**Backend unit tests** (new `src/lib/__tests__/refreshTokens.test.ts`, `csrf.test.ts`, added to an npm script):
issue -> rotate -> old token rejected; reuse of a rotated token revokes the family; reuse within 30 s does not;
idle and absolute expiry; inactive user cannot refresh; logout revokes; password reset revokes all;
middleware: Bearer only / cookie only / both (Bearer wins) / neither; CSRF: missing header, wrong header, wrong
Origin -> 403; Bearer request without CSRF header -> passes.

**curl with a cookie jar** (local): login sets 3 cookies with the right flags; `/api/campaigns` works with only the
cookie; `POST` with the cookie but no `X-CSRF-Token` -> 403; with `Origin: https://evil.example` -> 403; refresh
rotates (old `mf_rt` then fails); logout -> refresh 401; Bearer from the login JSON still works on every route.

**Browser** (Playwright/Edge script as used for the QA batches): login, reload (stays logged in, no token in
`localStorage`/`sessionStorage`), deep link + reload, two tabs refreshing at once (no logout), wait > 15 min (or set
`JWT_EXPIRES_IN=1m` locally) then navigate and use the agent chat (silent refresh, no 401 shown), logout in one tab ->
other tab goes to login on next call, F-12 redirect, F-30, CK-01, Stripe checkout return to `/checkout/success`.

**Agent untouched**: run the agent-service and MCP test suites unchanged; chat with the agent locally with a 15-min
token (and `JWT_EXPIRES_IN=1m` to force the refresh path); confirm a pending action after a refresh.

**Regression**: existing suites (CRM 60, limits 11, `npm test`), type checks against the baselines, web vitest
(46/38 baseline).

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Two tabs refresh at the same time -> reuse detection logs the user out | `navigator.locks` single-flight in the web + 30 s grace on the server |
| Agent call with an expired 15-min token | web refreshes before agent calls and retries once on `AUTH_EXPIRED_TOKEN`; no agent change |
| Long agent request (bulk workflow) outlives the 15-min token mid-request | measure the longest agent request; if near 15 min, use 30 min for `JWT_EXPIRES_IN` (env only) |
| Clock difference between backend and agent servers with short tokens | both on NTP; keep `JWT_EXPIRES_IN` >= 15m |
| CSRF on a cookie-authenticated route that was missed | middleware applies to **all** cookie-auth non-GET requests by default; GET audit before batch 2 |
| Production API on a different site than the web app | check topology before batch 2; plan assumes same site (nginx `/api`) |
| Hard-coded localhost CORS origins in production | only when `NODE_ENV !== 'production'` |
| Old 7-day tokens stay valid for up to 7 days after rollout | accepted residual window; optional coordinated `JWT_SECRET` rotation |
| Revocation is not instant for access tokens | max 15 min; refresh always re-checks `is_active` |
| Extra request on every page load (refresh) | one small POST; acceptable |
| Rollback | every batch can be reverted alone (below); Bearer path never removed |

---

## 7. Rollout (small, separately deployable batches)

| Batch | Contents | User-visible change | Rollback |
|---|---|---|---|
| 1 | Migration 0038 (table only) + `db/schema.ts` | none | run `0038_..._rollback.sql` |
| 2 | Backend: `lib/refreshTokens.ts`, `middleware/csrf.ts`, cookie parsing, `authMiddleware` accepts cookie, login/signup also set cookies, `/auth/refresh`, `/auth/logout`, `/auth/session`, revoke on reset/deactivate, CORS tightening, purge job. `JWT_EXPIRES_IN` still 7d | none (old web ignores the cookies) | revert the commit; tokens in JSON keep working |
| 3 | Web: in-memory store, async hydrate via refresh, `withCredentials` + CSRF header, 401 single-flight refresh, `agentHttp` refresh-before-call, logout calls server, storage migration | users stay logged in; no token in storage | redeploy the previous web build (backend still accepts Bearer and issues JSON tokens) |
| 4 | Env only: `JWT_EXPIRES_IN=15m` (backend) | none if batch 3 works | set back to `7d` and restart |
| 5 | After >= 7 days: remove `/auth/session` and the storage-migration code | none | revert the commit |

Each batch: type checks vs baseline, all backend suites, web vitest baseline, the batch's tests from section 5, then
staging, then production. Agent developer is told before batch 4 (tokens become 15 min) even though no change is
needed on their side.
