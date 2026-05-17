import { setTimeout as delay } from "node:timers/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { BearerToken } from "../Email_agent/mailflow-mcp-server/src/types/auth.js";
import type { ToolContext } from "../Email_agent/mailflow-mcp-server/src/mcp/types/toolContext.js";

const BACKEND = (process.env.MAILFLOW_BACKEND_URL ?? "http://localhost:3000").replace(/\/$/, "");

const simulatedReplies = [
  { label: "meeting", text: "Lets schedule a call next week", expected: "meeting_interest" },
  { label: "pricing objection", text: "Too expensive", expected: "objection_price" },
  { label: "competitor objection", text: "We already use another provider", expected: "objection_competitor" },
  { label: "unsubscribe", text: "Remove me from your list", expected: "unsubscribe_request" },
  { label: "neutral pricing question", text: "Can you share pricing?", expected: "objection_price" },
] as const;

function loadEnvFile(filePath: string) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const equals = trimmed.indexOf("=");
    if (equals === -1) continue;
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fetchJson(url: string, init: RequestInit = {}, expected = [200]) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep text body
  }
  if (!expected.includes(res.status)) {
    throw new Error(`Unexpected ${res.status} from ${url}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body as any;
}

async function signupOrLogin() {
  const stamp = Date.now();
  const email = `phase43.reply.${stamp}@example.com`;
  const password = "Phase43Reply!2026";
  const signup = await fetchJson(`${BACKEND}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Phase 4.3 Reply Tester" }),
  }, [201, 409]);

  if (signup?.token) return { token: signup.token as string, email };

  const login = await fetchJson(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert(login?.token, "Auth response did not include token");
  return { token: login.token as string, email };
}

function authHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function unwrapToolResult(raw: unknown) {
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw as any;
  assert(parsed.success === true, `MCP tool failed: ${raw}`);
  return parsed.data;
}

async function canReachBackend() {
  try {
    const res = await fetch(`${BACKEND}/api/auth/login`, { method: "OPTIONS" });
    return res.status === 204 || res.status === 200;
  } catch {
    return false;
  }
}

async function waitForBackend(timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await canReachBackend()) return;
    await delay(300);
  }
  throw new Error(`Backend did not become reachable at ${BACKEND}`);
}

async function startBackendIfNeeded() {
  if (await canReachBackend()) return null;

  const backendDir = path.resolve("Email_Management-main/backend");
  const logs: string[] = [];
  const child: ChildProcessWithoutNullStreams = process.platform === "win32"
    ? spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/index.ts"], {
        cwd: backendDir,
        env: process.env,
      })
    : spawn("npx", ["tsx", "src/index.ts"], {
        cwd: backendDir,
        env: process.env,
      });

  child.stdout.on("data", (chunk) => logs.push(String(chunk).trim()));
  child.stderr.on("data", (chunk) => logs.push(String(chunk).trim()));

  try {
    await waitForBackend();
  } catch (error) {
    child.kill();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${logs.filter(Boolean).join("\n")}`);
  }

  return child;
}

async function main() {
  loadEnvFile(path.resolve("Email_agent/mailflow-mcp-server/.env"));
  console.log("Phase 4.3 simulated reply validation");
  console.log(`Backend: ${BACKEND}`);

  const backendProcess = await startBackendIfNeeded();
  if (backendProcess) {
    console.log("Started backend from current source for validation.");
  }

  try {
  const { token } = await signupOrLogin();
  const headers = authHeaders(token);

  const campaign = await fetchJson(`${BACKEND}/api/campaigns`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `Phase 4.3 Reply Intelligence Validation ${new Date().toISOString()}`,
      subject: "Phase 4.3 validation",
      emailContent: "<p>Quick question for validation.</p>",
    }),
  }, [200, 201]);
  assert(campaign?.id, "Campaign create response did not include id");
  const campaignId = Number(campaign.id);

  const recipientsPayload = simulatedReplies.map((reply, index) => ({
    email: `phase43.${reply.label.replace(/\s+/g, ".")}.${Date.now()}.${index}@example.com`,
    name: `Reply ${index + 1}`,
    customFields: index === 0 ? { title: "Chief Revenue Officer", leadScore: 92 } : { leadScore: 50 },
  }));

  await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients/bulk`, {
    method: "POST",
    headers,
    body: JSON.stringify({ recipients: recipientsPayload }),
  });

  const recipientsResult = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients?limit=20`, { headers });
  const recipients = recipientsResult?.recipients ?? [];
  assert(recipients.length >= simulatedReplies.length, "Recipients were not created");

  console.log("\nAPI: submitting inbound replies");
  for (let i = 0; i < simulatedReplies.length; i += 1) {
    const reply = simulatedReplies[i]!;
    const recipient = recipients.find((r: any) => r.email === recipientsPayload[i]!.email);
    assert(recipient?.id, `Missing recipient row for ${reply.label}`);
    await fetchJson(`${BACKEND}/api/webhooks/inbound-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: recipient.email,
        to: `reply+${recipient.id}@mailflow.local`,
        subject: "Re: Phase 4.3 validation",
        text: reply.text,
        messageId: `<phase43-${Date.now()}-${i}@example.com>`,
      }),
    }, [200]);
    console.log(`- ${reply.text}`);
  }

  await delay(1500);

  const list = await fetchJson(`${BACKEND}/api/replies?campaignId=${campaignId}&limit=20&kind=replies`, { headers });
  const apiReplies = list?.replies ?? [];
  assert(apiReplies.length >= simulatedReplies.length, "API list did not return simulated replies");

  console.log("\nAPI: detected intents");
  const bySnippet = new Map<string, any>();
  for (const item of apiReplies) {
    if (typeof item.snippet === "string") bySnippet.set(item.snippet, item);
  }
  for (const reply of simulatedReplies) {
    const row = bySnippet.get(reply.text);
    const category = row?.intelligence?.category;
    const temp = row?.intelligence?.leadTemperature;
    const review = row?.intelligence?.reviewStatus;
    console.log(`- "${reply.text}" => ${category} (${temp}, review=${review})`);
    assert(category === reply.expected, `Expected ${reply.expected} for "${reply.text}", got ${category}`);
  }

  const apiSummary = await fetchJson(`${BACKEND}/api/replies/intelligence/summary?campaignId=${campaignId}`, { headers });
  const apiHot = await fetchJson(`${BACKEND}/api/replies/hot-leads?campaignId=${campaignId}&limit=10`, { headers });
  const apiMeeting = await fetchJson(`${BACKEND}/api/replies/meeting-ready?campaignId=${campaignId}&limit=10`, { headers });

  console.log("\nAPI: analytics");
  console.log(`- totalReplies=${apiSummary.totalReplies}`);
  console.log(`- meetingReadyCount=${apiSummary.meetingReadyCount}`);
  console.log(`- objections=${JSON.stringify(apiSummary.objectionBreakdown)}`);
  console.log(`- hotLeads=${apiHot.total}, meetingReadyLeads=${apiMeeting.total}`);

  const pricingRow = bySnippet.get("Too expensive");
  assert(pricingRow?.id, "Pricing reply id not found");
  const apiSuggestion = await fetchJson(`${BACKEND}/api/replies/${pricingRow.id}/suggestion`, { headers });
  console.log("\nAPI: suggestion for \"Too expensive\"");
  console.log(apiSuggestion.suggestedReplyText ?? "(no suggestion)");
  assert(String(apiSuggestion.suggestedReplyText ?? "").includes("start small"), "Pricing suggestion did not include expected safe language");

  const [
    { createMailFlowApiClient },
    { getReplyIntelligenceSummaryTool },
    { showHotLeadsTool },
    { showMeetingReadyLeadsTool },
    { draftReplySuggestionTool },
  ] = await Promise.all([
    import("../Email_agent/mailflow-mcp-server/src/lib/mailflowApiClient.js"),
    import("../Email_agent/mailflow-mcp-server/src/mcp/tools/inbox/getReplyIntelligenceSummary.tool.js"),
    import("../Email_agent/mailflow-mcp-server/src/mcp/tools/inbox/showHotLeads.tool.js"),
    import("../Email_agent/mailflow-mcp-server/src/mcp/tools/inbox/showMeetingReadyLeads.tool.js"),
    import("../Email_agent/mailflow-mcp-server/src/mcp/tools/inbox/draftReplySuggestion.tool.js"),
  ]);

  const mcpContext: ToolContext = {
    auth: { mode: "bearer", bearerToken: token as BearerToken },
    session: { sessionId: "phase43-live-validation", rawAuth: { authorization: `Bearer ${token}` } },
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    } as any,
    mailflow: createMailFlowApiClient(token as BearerToken),
  };

  const mcpSummary = unwrapToolResult(await getReplyIntelligenceSummaryTool.handler({ campaignId: String(campaignId) }, mcpContext));
  const mcpHot = unwrapToolResult(await showHotLeadsTool.handler({ campaignId: String(campaignId), limit: 10 }, mcpContext));
  const mcpMeeting = unwrapToolResult(await showMeetingReadyLeadsTool.handler({ campaignId: String(campaignId), limit: 10 }, mcpContext));
  const mcpSuggestion = unwrapToolResult(await draftReplySuggestionTool.handler({ replyId: String(pricingRow.id) }, mcpContext));

  console.log("\nMCP tool layer:");
  console.log(`- summary.totalReplies=${mcpSummary.totalReplies}`);
  console.log(`- hotLeads.total=${mcpHot.total}`);
  console.log(`- meetingReady.total=${mcpMeeting.total}`);
  console.log(`- draft.category=${mcpSuggestion.category}`);
  console.log(`- draft.preview=${String(mcpSuggestion.suggestedReplyText ?? "").split("\n").filter(Boolean).slice(0, 2).join(" / ")}`);

  assert(mcpSummary.totalReplies >= simulatedReplies.length, "MCP summary did not include simulated replies");
  assert(mcpHot.total >= 1, "MCP hot lead list was empty");
  assert(mcpMeeting.total >= 1, "MCP meeting-ready list was empty");
  assert(mcpSuggestion.category === "objection_price", "MCP suggestion did not target pricing objection");

  console.log("\nPASS: simulated replies validated through API and MCP tool layer.");
  } finally {
    if (backendProcess) backendProcess.kill();
  }
}

main().catch((error) => {
  console.error("\nFAIL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
