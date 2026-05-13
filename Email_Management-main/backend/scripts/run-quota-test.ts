import assert from "node:assert";
import { remainingSmtpQuota } from "../src/lib/dailySendQuota.js";

assert.strictEqual(remainingSmtpQuota(50, 10), 40);
assert.strictEqual(remainingSmtpQuota(50, 50), 0);
assert.strictEqual(remainingSmtpQuota(0, 100), null);
console.log("dailySendQuota tests passed");
