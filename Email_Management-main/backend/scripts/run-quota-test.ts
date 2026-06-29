import assert from "node:assert";
import {
  remainingSmtpQuota,
  isDailyQuotaPauseMessage,
  FOLLOW_UP_PAUSE_MSG_SMTP_DAILY,
} from "../src/lib/dailySendQuota.js";

assert.strictEqual(remainingSmtpQuota(50, 10), 40);
assert.strictEqual(remainingSmtpQuota(50, 50), 0);
assert.strictEqual(remainingSmtpQuota(0, 100), null);
assert.strictEqual(isDailyQuotaPauseMessage(FOLLOW_UP_PAUSE_MSG_SMTP_DAILY), true);
assert.strictEqual(
  isDailyQuotaPauseMessage("Daily send limit reached for this SMTP profile."),
  true
);
assert.strictEqual(isDailyQuotaPauseMessage("SMTP is running campaign foo"), false);
console.log("dailySendQuota tests passed");
