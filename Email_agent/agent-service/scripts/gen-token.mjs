/**
 * scripts/gen-token.mjs
 *
 * Generates a signed HS256 JWT for local testing.
 *
 * Usage:
 *   node scripts/gen-token.mjs
 *
 * The secret and userId are hard-coded to match the local .env values.
 * Never use this script in production.
 */

import { createHmac } from "node:crypto";

const SECRET  = "dev-local-secret-at-least-32-characters-long!";
const USER_ID = "test-user-001";
const EMAIL   = "dev@example.com";
const TTL_H   = 24; // hours

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

const header  = b64url({ alg: "HS256", typ: "JWT" });
const payload = b64url({
  sub: USER_ID,
  email: EMAIL,
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + TTL_H * 3600,
});

const sig = createHmac("sha256", SECRET)
  .update(`${header}.${payload}`)
  .digest("base64url");

const token = `${header}.${payload}.${sig}`;

console.log("\n── JWT for local testing ────────────────────────────────");
console.log(token);
console.log("\n── Use in curl / Postman ────────────────────────────────");
console.log(`Authorization: Bearer ${token}`);
console.log(`\nsub (userId): ${USER_ID}`);
console.log(`expires:      ${new Date((Math.floor(Date.now() / 1000) + TTL_H * 3600) * 1000).toISOString()}`);
