import assert from "node:assert";
import {
  remainingSmtpQuota,
  isDailyQuotaPauseMessage,
  FOLLOW_UP_PAUSE_MSG_SMTP_DAILY,
} from "../src/lib/dailySendQuota.js";

// Every SMTP account is capped at 20/day (F-25), even when 50 is saved.
assert.strictEqual(remainingSmtpQuota(50, 10), 10);
assert.strictEqual(remainingSmtpQuota(50, 50), 0);
assert.strictEqual(remainingSmtpQuota(20, 5), 15);
assert.strictEqual(remainingSmtpQuota(0, 100), 0);
assert.strictEqual(isDailyQuotaPauseMessage(FOLLOW_UP_PAUSE_MSG_SMTP_DAILY), true);
assert.strictEqual(
  isDailyQuotaPauseMessage("Daily send limit reached for this SMTP profile."),
  true
);
assert.strictEqual(isDailyQuotaPauseMessage("SMTP is running campaign foo"), false);
console.log("dailySendQuota tests passed");
