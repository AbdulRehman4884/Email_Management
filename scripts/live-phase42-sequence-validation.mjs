import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const BACKEND = (process.env.MAILFLOW_BACKEND_URL ?? "http://localhost:3000").replace(/\/$/, "");
const LOGIN_EMAIL = process.env.MAILFLOW_LOGIN_EMAIL ?? "";
const LOGIN_PASSWORD = process.env.MAILFLOW_LOGIN_PASSWORD ?? "";
const DUMMY_EMAIL = (process.env.MAILFLOW_DUMMY_RECIPIENTS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)[0] ?? "";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function note(message) {
  console.log(`\n→ ${message}`);
}

function parseEnvFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const entries = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex === -1) continue;
      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (
        (value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      entries[key] = value;
    }
    return entries;
  } catch {
    return {};
  }
}

function getUnsubscribeSecret() {
  const backendEnv = parseEnvFile(path.resolve("Email_Management-main/backend/.env"));
  return process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || backendEnv.UNSUBSCRIBE_SECRET || backendEnv.JWT_SECRET || "mailflow-unsubscribe-secret";
}

function generateUnsubscribeToken({ campaignId, recipientId, email }) {
  const body = JSON.stringify({
    campaignId,
    recipientId,
    email: email.toLowerCase().trim(),
  });
  const encoded = Buffer.from(body, "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", getUnsubscribeSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

async function fetchJson(url, init = {}, expectedStatuses = [200]) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!expectedStatuses.includes(res.status)) {
    throw new Error(`Unexpected ${res.status} from ${url}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return { res, body };
}

async function login() {
  assert(LOGIN_EMAIL && LOGIN_PASSWORD, "Missing MAILFLOW_LOGIN_EMAIL or MAILFLOW_LOGIN_PASSWORD");
  const { body } = await fetchJson(`${BACKEND}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASSWORD }),
  });
  assert(body?.token, "Login response did not include a token");
  return {
    Authorization: `Bearer ${body.token}`,
    "Content-Type": "application/json",
  };
}

async function listCampaigns(headers) {
  const { body } = await fetchJson(`${BACKEND}/api/campaigns`, { headers });
  return Array.isArray(body) ? body : [];
}

async function getRecipients(headers, campaignId) {
  const { body } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients?limit=50`, { headers });
  return body?.recipients ?? [];
}

async function getProgress(headers, campaignId) {
  const { body } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/sequence-progress`, { headers });
  return body;
}

async function getPending(headers, campaignId) {
  const { body } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/pending-follow-ups`, { headers });
  return body;
}

async function getHistory(headers, campaignId, recipientId) {
  const { body } = await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients/${recipientId}/touch-history`, { headers });
  return body;
}

async function markReplied(headers, campaignId, recipientId) {
  await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients/${recipientId}/mark-replied`, {
    method: "POST",
    headers,
  });
}

async function createCampaign(headers, name) {
  const { body } = await fetchJson(`${BACKEND}/api/campaigns`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      subject: "Phase 4.2 stop rule validation",
      emailContent: "<p>Simple validation email.</p>",
    }),
  }, [200, 201]);
  assert(body?.id, "Create campaign did not return an id");
  return body.id;
}

async function addRecipient(headers, campaignId, email) {
  await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/recipients/bulk`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      recipients: [{ email, name: "Sequence Validation Recipient" }],
    }),
  });
}

async function generatePersonalized(headers, campaignId) {
  await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/generate-personalized`, {
    method: "POST",
    headers: { Authorization: headers.Authorization },
  });
}

async function startCampaign(headers, campaignId) {
  await fetchJson(`${BACKEND}/api/campaigns/${campaignId}/start`, {
    method: "POST",
    headers: { Authorization: headers.Authorization },
  });
}

async function waitForRecipientSent(headers, campaignId, email) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const recipients = await getRecipients(headers, campaignId);
    const row = recipients.find((recipient) => String(recipient.email).toLowerCase() === email.toLowerCase());
    if (row?.status === "sent") {
      return row;
    }
    if (row?.status === "failed") {
      throw new Error(`Recipient ${email} failed before stop-rule validation`);
    }
    await delay(3000);
  }
  throw new Error(`Timed out waiting for recipient ${email} to reach sent status`);
}

async function createAndSendValidationCampaign(headers, name) {
  const campaignId = await createCampaign(headers, name);
  await addRecipient(headers, campaignId, DUMMY_EMAIL);
  await generatePersonalized(headers, campaignId);
  await startCampaign(headers, campaignId);
  const recipient = await waitForRecipientSent(headers, campaignId, DUMMY_EMAIL);
  return { campaignId, recipient };
}

function countSentTouches(history) {
  return (history.touches ?? []).filter((touch) => touch.sentAt != null).length;
}

function assertScheduledThreeDays(history) {
  const touches = history.touches ?? [];
  const touch1 = touches.find((touch) => touch.touchNumber === 1);
  const touch2 = touches.find((touch) => touch.touchNumber === 2);
  assert(touch1?.sentAt, "Touch 1 was not marked sent");
  assert(touch2?.scheduledForAt, "Touch 2 was not scheduled");
  const diffMs = new Date(touch2.scheduledForAt).getTime() - new Date(touch1.sentAt).getTime();
  const diffDays = diffMs / (24 * 60 * 60 * 1000);
  assert(diffDays >= 2.95 && diffDays <= 3.05, `Expected touch 2 to be scheduled ~3 days later, got ${diffDays.toFixed(3)} days`);
}

async function validateReplyStopRule(headers) {
  note("1. Validate scheduled follow-up and reply stop rule on a fresh campaign");
  const name = `Live Sequence Reply Validation - ${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}`;
  const { campaignId, recipient } = await createAndSendValidationCampaign(headers, name);

  const progressBefore = await getProgress(headers, campaignId);
  const pendingBefore = await getPending(headers, campaignId);
  const historyBefore = await getHistory(headers, campaignId, recipient.id);

  if (progressBefore.pendingFollowUps < 1 || (pendingBefore.items ?? []).length < 1) {
    console.log("   Debug progress before reply:", JSON.stringify(progressBefore, null, 2));
    console.log("   Debug pending before reply:", JSON.stringify(pendingBefore, null, 2));
    console.log("   Debug history before reply:", JSON.stringify(historyBefore, null, 2));
  }

  assert(progressBefore.pendingFollowUps >= 1, "Expected at least one pending follow-up before reply");
  assert((pendingBefore.items ?? []).length >= 1, "Expected pending follow-up items before reply");
  assert(historyBefore.sequenceState?.sequenceStatus === "active", `Expected active sequence before reply, got ${historyBefore.sequenceState?.sequenceStatus}`);
  assertScheduledThreeDays(historyBefore);
  assert(countSentTouches(historyBefore) === 1, "Expected exactly one sent touch before reply");

  await markReplied(headers, campaignId, recipient.id);
  await delay(1500);

  const progressAfter = await getProgress(headers, campaignId);
  const pendingAfter = await getPending(headers, campaignId);
  const historyAfter = await getHistory(headers, campaignId, recipient.id);
  const skippedTouches = (historyAfter.touches ?? []).filter((touch) => touch.touchNumber > 1 && touch.executionStatus === "skipped");

  assert(historyAfter.sequenceState?.sequenceStatus === "replied", `Expected replied sequence after mark-replied, got ${historyAfter.sequenceState?.sequenceStatus}`);
  assert(historyAfter.sequenceState?.lastReplyAt, "Expected lastReplyAt to be recorded");
  assert(progressAfter.pendingFollowUps === 0, "Expected no pending follow-ups after reply");
  assert((pendingAfter.items ?? []).length === 0, "Expected pending follow-up list to be empty after reply");
  assert(skippedTouches.length >= 1, "Expected future touches to be skipped after reply");
  assert(countSentTouches(historyAfter) === 1, "Expected no duplicate sends after reply stop");

  console.log(`   OK: campaign ${campaignId} scheduled touch 2 correctly and stopped future touches after reply`);
}

async function validateUnsubscribeStopRule(headers) {
  note("2. Validate token unsubscribe stops future touches");
  const name = `Live Sequence Unsubscribe Validation - ${new Date().toISOString().slice(0, 16).replace(/:/g, "-")}`;
  const { campaignId, recipient } = await createAndSendValidationCampaign(headers, name);
  const token = generateUnsubscribeToken({ campaignId, recipientId: recipient.id, email: recipient.email });

  const unsubscribeRes = await fetch(`${BACKEND}/unsubscribe/${token}`);
  const unsubscribeText = await unsubscribeRes.text();
  assert(unsubscribeRes.status === 200, `Expected unsubscribe endpoint to return 200, got ${unsubscribeRes.status}`);
  assert(/unsubscribed/i.test(unsubscribeText), "Expected unsubscribe HTML confirmation");
  await delay(1500);

  const progress = await getProgress(headers, campaignId);
  const pending = await getPending(headers, campaignId);
  const history = await getHistory(headers, campaignId, recipient.id);
  const skippedTouches = (history.touches ?? []).filter((touch) => touch.touchNumber > 1 && touch.executionStatus === "skipped");

  assert(history.sequenceState?.sequenceStatus === "unsubscribed", `Expected unsubscribed sequence after token click, got ${history.sequenceState?.sequenceStatus}`);
  assert(history.sequenceState?.unsubscribedAt, "Expected unsubscribedAt to be recorded");
  assert(progress.pendingFollowUps === 0, "Expected no pending follow-ups after unsubscribe");
  assert((pending.items ?? []).length === 0, "Expected pending follow-up list to be empty after unsubscribe");
  assert(skippedTouches.length >= 1, "Expected future touches to be skipped after unsubscribe");
  assert(countSentTouches(history) === 1, "Expected no duplicate sends after unsubscribe stop");

  console.log(`   OK: campaign ${campaignId} token unsubscribe stopped future touches cleanly`);
}

async function main() {
  assert(DUMMY_EMAIL, "Missing MAILFLOW_DUMMY_RECIPIENTS");
  const headers = await login();
  await validateReplyStopRule(headers);
  await validateUnsubscribeStopRule(headers);
  console.log("\nPASS: Phase 4.2 live sequence validation succeeded.");
}

main().catch((error) => {
  console.error("\nFAIL:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
