/**
 * Live integration test: backend API → optional email worker → SMTP.
 *
 * Requires:
 * - Backend on MAILFLOW_BACKEND_URL (default http://localhost:3000)
 * - Agent-service on MAILFLOW_AGENT_URL (default http://localhost:3002) — health only
 * - MCP SSE port reachable at MAILFLOW_MCP_URL (default http://localhost:4000) — TCP probe only
 * - MAILFLOW_LOGIN_EMAIL / MAILFLOW_LOGIN_PASSWORD
 * - MAILFLOW_DUMMY_RECIPIENTS — comma-separated, max 2 safe test addresses (Mailtrap / Ethereal / your inbox)
 *
 * After start, recipients stay `pending` until `bun run worker` (backend email worker) processes them.
 */

import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const CAMPAIGN_NAME = "Live Test Campaign - AI SDR";
const CAMPAIGN_SUBJECT = "Test Campaign Email";
const CAMPAIGN_BODY_HTML = "<p>This is a safe test email from MailFlow.</p>";

const BACKEND = (process.env.MAILFLOW_BACKEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
const AGENT_URL = (process.env.MAILFLOW_AGENT_URL ?? "http://localhost:3002").replace(/\/$/, "");
const MCP_URL = process.env.MAILFLOW_MCP_URL ?? "http://localhost:4000";

const LOGIN_EMAIL = process.env.MAILFLOW_LOGIN_EMAIL ?? "";
const LOGIN_PASSWORD = process.env.MAILFLOW_LOGIN_PASSWORD ?? "";

/** Same convention as mailflow-mcp-server: base includes `/api`. */
const MAILFLOW_API_BASE = process.env.MAILFLOW_API_BASE ?? `${BACKEND}/api`;

let failReasons: string[] = [];

function fail(msg: string): never {
  failReasons.push(msg);
  console.error(`\nFAIL:\nReason:\n${failReasons.map((r) => `- ${r}`).join("\n")}\n`);
  process.exit(1);
  throw new Error("unreachable");
}

function note(msg: string): void {
  console.log(`\n→ ${msg}`);
}

async function fetchJsonOptional(url: string, init?: RequestInit): Promise<{ res: Response; body: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    console.error(`Fetch failed for ${url}:`, e);
    return { res: { status: 0 } as Response, body: null };
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { res, body };
}

function classifyFailureBucket(category: string): string {
  if (category === "smtp_missing_config") return "Likely cause: SMTP not fully configured for this user (or empty password in DB).";
  if (category === "smtp_gmail_app_password" || category === "smtp_auth") {
    return "Likely cause: SMTP authentication (wrong password, or Gmail needs an App Password).";
  }
  if (category === "smtp_tls_connection") return "Likely cause: network / TLS / port to SMTP host.";
  if (category === "smtp_sender_mismatch") return "Likely cause: From address does not match the authenticated SMTP account.";
  if (category === "smtp_recipient_rejected") return "Likely cause: recipient address rejected by the SMTP relay (not a MailFlow bug).";
  if (category === "smtp_rate_limit") return "Likely cause: provider rate limit.";
  return "Likely cause: unknown SMTP error — inspect raw message below or backend worker logs.";
}

/** When recipient status is failed: fetch campaign, recipients (last_send_error), SMTP snapshot (no password). */
async function appendSendFailureDiagnostics(
  auth: Record<string, string>,
  campaignId: number,
  dummies: { email: string }[],
): Promise<void> {
  console.log("\n--- Failure diagnostics (SMTP / worker; start_campaign is not implicated) ---");

  const me = await fetchJsonOptional(`${BACKEND}/api/auth/me`, { headers: auth });
  if (me.res.status === 200 && me.body && typeof me.body === "object") {
    const meBody = me.body as { id?: number; email?: string; user?: { id?: number; email?: string } };
    const u = meBody.user ?? meBody;
    console.log(`   Logged-in user: id=${u.id ?? "?"} email=${u.email ?? "?"}`);
    const expectId = process.env.MAILFLOW_EXPECT_USER_ID?.trim();
    if (expectId && String(u.id) !== expectId) {
      console.log(
        `   Note: MAILFLOW_EXPECT_USER_ID=${expectId} but token is user id=${u.id} — SMTP row is per logged-in user, not necessarily user ${expectId}.`,
      );
    }
  }

  const camp = await fetchJsonOptional(`${BACKEND}/api/campaigns/${campaignId}`, { headers: auth });
  if (camp.res.status === 200) {
    console.log("   Campaign:", JSON.stringify(camp.body, null, 2).slice(0, 1200));
  } else {
    console.log("   Campaign fetch failed:", camp.res.status, camp.body);
  }

  const rec = await fetchJsonOptional(`${BACKEND}/api/campaigns/${campaignId}/recipients?limit=50`, { headers: auth });
  const list = (rec.body as {
    recipients?: Array<{
      email: string;
      status: string;
      lastSendError?: string | null;
      last_send_error?: string | null;
    }>;
  })?.recipients ?? [];
  const ours = list.filter((x) => dummies.some((d) => d.email.toLowerCase() === x.email.toLowerCase()));
  for (const row of ours) {
    const apiExposedLastSendError = row.lastSendError ?? row.last_send_error ?? null;
    console.log(`   Recipient ${row.email} status=${row.status}`);
    if (apiExposedLastSendError) {
      console.log(`   last_send_error: ${apiExposedLastSendError}`);
      const m = /^\[([^\]]+)\]/.exec(apiExposedLastSendError);
      const cat = m?.[1] ?? "unknown";
      console.log(`   Parsed category: ${cat}`);
      console.log(`   ${classifyFailureBucket(cat)}`);
      failReasons.push(`SMTP/worker: ${apiExposedLastSendError.slice(0, 500)}`);
    } else {
      console.log(
        "   last_send_error: empty (API did not expose last_send_error / lastSendError for this failed recipient)",
      );
      failReasons.push(
        "Recipient failed but API did not expose last_send_error. The worker may have stored it in DB; restart/update the backend API process and verify the recipients endpoint response.",
      );
    }
  }

  const smtp = await fetchJsonOptional(`${BACKEND}/api/settings/smtp`, { headers: auth });
  if (smtp.res.status === 200 && smtp.body && typeof smtp.body === "object") {
    const s = smtp.body as Record<string, unknown>;
    const safe = {
      configuredInDatabase: s.configuredInDatabase,
      usesEnvironmentFallback: s.usesEnvironmentFallback,
      provider: s.provider,
      host: s.host,
      port: s.port,
      secure: s.secure,
      user: s.user,
      fromEmail: s.fromEmail,
      fromName: s.fromName,
      hasPassword: s.hasPassword,
      trackingBaseUrl: s.trackingBaseUrl,
    };
    console.log("   SMTP settings (sanitized, password never shown):", JSON.stringify(safe, null, 2));
    if (s.configuredInDatabase === false || (String(s.host ?? "").trim() === "" && s.usesEnvironmentFallback === true)) {
      failReasons.push(
        "SMTP settings are not configured for this user in the database — worker may use process.env SMTP_* fallback only.",
      );
    }
    if (s.hasPassword === false && s.configuredInDatabase === true) {
      failReasons.push("SMTP row exists but hasPassword=false — set SMTP password in Settings.");
    }
  } else {
    console.log("   SMTP settings fetch failed:", smtp.res.status, smtp.body);
  }
}

async function fetchJson(
  url: string,
  init: RequestInit & { expectedStatuses?: number[]; expect?: number[] } = {},
): Promise<{ res: Response; body: unknown }> {
  const expectedStatuses = init.expectedStatuses ?? init.expect ?? [200, 201, 202, 204];
  const { expectedStatuses: _expectedStatuses, expect: _expect, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(url, rest);
  } catch (e) {
    console.error(`Fetch failed for ${url}:`, e);
    fail(`network error — is the service running? (${url})`);
  }
  let body: unknown;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!expectedStatuses.includes(res.status)) {
    console.error(`Unexpected ${res.status} from ${url}:`, body);
    fail(`backend endpoint error (${res.status}) at ${url}`);
  }
  return { res, body };
}

function urlHostPort(baseUrl: string): { host: string; port: number } {
  const u = new URL(baseUrl);
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  return { host: u.hostname, port };
}

async function checkBackendReachable(): Promise<void> {
  note("1. Backend running on configured port (TCP + GET /api/health when public)");
  const { host, port } = urlHostPort(BACKEND);
  try {
    await tcpProbe(host, port);
    console.log(`   OK: TCP ${host}:${port} (backend port open)`);
  } catch (e) {
    console.error(e);
    fail("backend not listening — start Email_Management-main/backend (bun run dev)");
  }
  let probe: Response;
  try {
    probe = await fetch(`${BACKEND}/api/health`);
  } catch (e) {
    console.error(e);
    fail("backend HTTP unavailable after TCP succeeded");
  }
  if (probe.status === 200) {
    const t = await probe.text();
    console.log(`   OK: GET /api/health → ${t.slice(0, 80)}`);
    return;
  }
  if (probe.status === 401) {
    console.log(
      "   Note: GET /api/health returned 401 (middleware may protect /api before the health route). Port check already passed.",
    );
    return;
  }
  console.error(`   Unexpected GET /api/health status ${probe.status}`);
  fail("backend health probe failed");
}

async function checkAgentHealth(): Promise<void> {
  note("2. Agent-service health (GET /health)");
  const { res, body } = await fetchJson(`${AGENT_URL}/health`, { expect: [200] });
  console.log(`   OK (${res.status}):`, body);
}

function tcpProbe(host: string, port: number, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const socket = net.connect({ host, port }, () => {
      if (timer) clearTimeout(timer);
      socket.end();
      resolve();
    });
    timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`TCP timeout ${host}:${port}`));
    }, ms);
    socket.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

async function checkMcpPort(): Promise<void> {
  note("3. MCP server TCP (MAILFLOW_MCP_URL port listening)");
  let u: URL;
  try {
    u = new URL(MCP_URL);
  } catch {
    fail("invalid MAILFLOW_MCP_URL");
  }
  const host = u.hostname;
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  try {
    await tcpProbe(host, port);
    console.log(`   OK: port open on ${host}:${port} (matches MCP SSE server)`);
  } catch (e) {
    console.error(e);
    fail("MCP server port not reachable — check MCP_SSE_PORT / MAILFLOW_MCP_URL");
  }
}

/** Best-effort check: backend stores local wall time as `YYYY-MM-DD HH:MM:SS`. */
function isScheduledInFuture(scheduledAt: string | null | undefined): boolean {
  if (scheduledAt == null || String(scheduledAt).trim() === "") return false;
  const normalized = String(scheduledAt).trim().replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() > Date.now();
}

function buildTimestampSuffix(date = new Date()): string {
  return date.toISOString().slice(0, 16).replace(/:/g, "-");
}

function buildTimestampedCampaignName(): string {
  return `${CAMPAIGN_NAME} - ${buildTimestampSuffix()}`;
}

function parseDummyRecipients(): { email: string; name: string }[] {
  const raw = process.env.MAILFLOW_DUMMY_RECIPIENTS?.trim();
  if (!raw) {
    fail(
      "set MAILFLOW_DUMMY_RECIPIENTS to 1–2 comma-separated safe test emails (e.g. Mailtrap inbox)",
    );
  }
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0 || parts.length > 2) {
    fail("MAILFLOW_DUMMY_RECIPIENTS must list 1–2 emails only (safety cap)");
  }
  return parts.map((email, i) => ({ email, name: `Test Recipient ${i + 1}` }));
}

async function main(): Promise<void> {
  console.log("=== MailFlow live campaign send test (backend API) ===\n");

  if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
    fail("missing MAILFLOW_LOGIN_EMAIL or MAILFLOW_LOGIN_PASSWORD");
  }

  const dummies = parseDummyRecipients();

  await checkBackendReachable();
  await checkAgentHealth();
  await checkMcpPort();

  note("4. Login (POST /api/auth/login)");
  const loginRes = await fetch(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  const loginRaw = await loginRes.text();
  let loginBody: unknown;
  try {
    loginBody = loginRaw ? JSON.parse(loginRaw) : null;
  } catch {
    loginBody = loginRaw;
  }
  if (loginRes.status !== 200) {
    console.error("   Login response:", loginBody);
    fail(loginRes.status === 401 ? "invalid MAILFLOW_LOGIN_EMAIL or MAILFLOW_LOGIN_PASSWORD" : "login failed");
  }
  const token = (loginBody as { token?: string }).token;
  if (!token) fail("login did not return token");
  console.log("   OK: JWT received");

  const auth = { Authorization: `Bearer ${token}` } as const;
  const jsonAuth = { ...auth, "Content-Type": "application/json" } as const;

  note("5. Find or create test campaign");
  const { body: campaignsBody } = await fetchJson(`${BACKEND}/api/campaigns`, {
    headers: auth,
    expect: [200],
  });
  const campaigns = campaignsBody as Array<{ id: number; name: string; status: string; subject?: string }>;
  const matches = campaigns.filter((c) => c.name === CAMPAIGN_NAME).sort((a, b) => b.id - a.id);
  let campaignId: number;
  let campaignName = CAMPAIGN_NAME;

  async function createCampaignWithName(name: string): Promise<number> {
    note("   Creating campaign (POST /api/campaigns)");
    const { body: created } = await fetchJson(`${BACKEND}/api/campaigns`, {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name,
        subject: CAMPAIGN_SUBJECT,
        emailContent: CAMPAIGN_BODY_HTML,
      }),
      expectedStatuses: [200, 201],
    });
    const createdPayload = created as { id?: number; status?: string; name?: string };
    const createdCampaignId = createdPayload.id;
    if (!createdCampaignId) fail("create campaign did not return id");
    campaignName = createdPayload.name ?? name;
    console.log(
      `   OK: campaign created id=${createdCampaignId} status=${createdPayload.status ?? "unknown"} name="${campaignName}"`,
    );
    return createdCampaignId;
  }

  if (matches.length > 0) {
    const c = matches[0]!;
    if (["draft", "scheduled"].includes(c.status)) {
      campaignId = c.id;
      campaignName = c.name;
      console.log(`   Reusing campaign id=${campaignId} name="${campaignName}" status=${c.status}`);
    } else {
      const freshCampaignName = buildTimestampedCampaignName();
      console.log(
        `   Existing base campaign id=${c.id} name="${c.name}" status=${c.status} is not reusable; creating fresh draft "${freshCampaignName}"`,
      );
      campaignId = await createCampaignWithName(freshCampaignName);
    }
    if (c.status === "draft" && campaignId === c.id) {
      note("   Updating draft subject/body to match test payload (PUT /api/campaigns/:id)");
      await fetchJson(`${BACKEND}/api/campaigns/${campaignId}`, {
        method: "PUT",
        headers: jsonAuth,
        body: JSON.stringify({
          subject: CAMPAIGN_SUBJECT,
          emailContent: CAMPAIGN_BODY_HTML,
        }),
        expect: [200],
      });
      console.log("   OK: campaign content aligned");
    } else if (c.status === "scheduled" && campaignId === c.id) {
      console.log(
        "   Scheduled campaign — skipping PUT (backend allows edits only in draft). Ensure subject/body match the test.",
      );
    }
  } else {
    campaignId = await createCampaignWithName(CAMPAIGN_NAME);
  }

  const { body: detailBody } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}`, {
    headers: auth,
    expect: [200],
  });
  const detail = detailBody as { name?: string; status?: string; scheduledAt?: string | null };
  campaignName = detail.name ?? campaignName;
  console.log(`   Campaign selected: campaignId=${campaignId} name="${campaignName}" status=${detail.status ?? "unknown"}`);
  if (detail.status === "scheduled" && isScheduledInFuture(detail.scheduledAt ?? null)) {
    fail(
      "campaign has a future scheduledAt — worker will not send until then; use a draft campaign or past schedule",
    );
  }

  note("6. Add dummy recipients (POST /api/campaigns/:id/recipients/bulk)");
  const bulkRes = await fetch(`${BACKEND}/api/campaigns/${campaignId}/recipients/bulk`, {
    method: "POST",
    headers: jsonAuth,
    body: JSON.stringify({
      recipients: dummies.map((d) => ({ email: d.email, name: d.name })),
    }),
  });
  const bulkText = await bulkRes.text();
  let bulkJson: unknown;
  try {
    bulkJson = bulkText ? JSON.parse(bulkText) : null;
  } catch {
    bulkJson = bulkText;
  }
  console.log(`   Response (${bulkRes.status}):`, bulkJson);
  if (bulkRes.status !== 200) {
    fail("recipients bulk save failed");
  }
  const saved = (bulkJson as { saved?: number }).saved ?? 0;
  if (saved === 0) {
    console.log("   (0 new rows — likely duplicates already on campaign; continuing if pending exists)");
  }

  note("7. Verify recipients (GET /api/campaigns/:id/recipients)");
  const { body: recBody } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients?limit=50`, {
    headers: auth,
    expect: [200],
  });
  const recPayload = recBody as { recipients?: unknown[]; total?: number };
  const total = recPayload.total ?? 0;
  console.log(`   total recipients: ${total}`);
  if (total < 1) fail("no recipients");

  const pending = (recPayload.recipients ?? []).filter((r) => {
    const row = r as { status?: string };
    return row.status === "pending";
  }).length;
  console.log(`   pending: ${pending}`);
  if (pending < 1) {
    fail(
      "no pending recipients — remove sent recipients in UI or use a fresh draft campaign",
    );
  }

  note("8. Generate personalized emails (POST /api/campaigns/:id/generate-personalized)");
  const genRes = await fetch(`${BACKEND}/api/campaigns/${campaignId}/generate-personalized`, {
    method: "POST",
    headers: auth,
  });
  const genText = await genRes.text();
  let genJson: unknown;
  try {
    genJson = genText ? JSON.parse(genText) : null;
  } catch {
    genJson = genText;
  }
  console.log(`   Response (${genRes.status}):`, genJson);
  if (genRes.status !== 200) {
    if (genRes.status === 500) fail("personalized email generation failed (check OPENAI_API_KEY on backend)");
    fail("generate-personalized failed");
  }
  const gen = genJson as { generatedCount?: number; failedCount?: number };
  if ((gen.generatedCount ?? 0) < 1 && (gen.failedCount ?? 0) > 0) {
    fail("personalized emails not generated (OpenAI or recipient loop)");
  }

  note("9. Verify personalized rows (GET /api/campaigns/:id/personalized-emails)");
  const { body: persBody } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/personalized-emails`, {
    headers: auth,
    expect: [200],
  });
  const pers = persBody as { total?: number; emails?: unknown[] };
  console.log(`   personalized rows: ${pers.total ?? 0}`);
  if ((pers.total ?? 0) < 1) fail("no personalized emails in DB");

  const startPath = `${MAILFLOW_API_BASE.replace(/\/$/, "")}/campaigns/${campaignId}/start`;
  note("10. Start campaign (POST /api/campaigns/:id/start) — same path MCP start_campaign uses");
  console.log(`   MCP-equivalent: POST ${startPath}`);
  const startRes = await fetch(`${BACKEND}/api/campaigns/${campaignId}/start`, {
    method: "POST",
    headers: auth,
  });
  const startText = await startRes.text();
  let startJson: unknown;
  try {
    startJson = startText ? JSON.parse(startText) : null;
  } catch {
    startJson = startText;
  }
  console.log(`   Response (${startRes.status}):`, startJson);
  if (startRes.status !== 200) {
    if (startRes.status === 400 && String(startText).includes("No pending")) {
      fail("campaign start failed — no pending recipients");
    }
    fail("campaign start failed");
  }
  console.log(
    "   PASS (API layer): start_campaign equivalent succeeded — HTTP 200 with status in_progress (MCP tool uses same POST .../start).",
  );

  note("11. Poll recipient status (worker must be running: cd Email_Management-main/backend && bun run worker)");
  const deadline = Date.now() + 120_000;
  let lastPending = pending;
  while (Date.now() < deadline) {
    const r = await fetch(`${BACKEND}/api/campaigns/${campaignId}/recipients?limit=50`, { headers: auth });
    const j = (await r.json()) as {
      recipients?: Array<{ email: string; status: string; lastSendError?: string | null; last_send_error?: string | null }>;
    };
    const list = j.recipients ?? [];
    const ours = list.filter((x) => dummies.some((d) => d.email.toLowerCase() === x.email.toLowerCase()));
    const statuses = ours.map((x) => x.status);
    lastPending = ours.filter((x) => x.status === "pending" || x.status === "sending").length;
    console.log(`   [poll] dummy recipients: ${statuses.join(", ") || "none"}`);
    if (ours.length > 0 && ours.every((x) => x.status === "sent")) {
      console.log("\nPASS:\nCampaign send pipeline verified.\n");
      console.log("SMTP: messages accepted by server (recipient status sent). Check inbox/Mailtrap.\n");
      process.exit(0);
    }
    if (ours.some((x) => x.status === "failed")) {
      failReasons.push(
        "PASS (API): start_campaign returned 200 — failure is after start, in email worker / SMTP.",
      );
      await appendSendFailureDiagnostics(auth, campaignId, dummies);
      fail("FAIL: SMTP/worker delivery failed (see diagnostics above and reasons below)");
    }
    await delay(3000);
  }

  if (lastPending > 0) {
    fail(
      "recipients still pending/sending after timeout — start backend worker (bun run worker) or wait longer",
    );
  }

  fail("could not confirm sent/failed status");
}

main().catch((e) => {
  console.error(e);
  fail(e instanceof Error ? e.message : String(e));
});
