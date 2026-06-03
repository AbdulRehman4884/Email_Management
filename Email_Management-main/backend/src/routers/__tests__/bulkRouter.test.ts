import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import bulkRouter from "../bulkRouter.js";

let server: Server | undefined;

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((err) => err ? reject(err) : resolve());
  });
  server = undefined;
});

describe("bulkRouter", () => {
  it("mounts POST /api/bulk/campaign-readiness/:campaignId without returning Express 404", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/bulk", bulkRouter);

    server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/bulk/campaign-readiness/38`, {
      method: "POST",
    });
    const text = await response.text();

    expect(response.status).not.toBe(404);
    expect(text).not.toContain("Cannot POST /api/bulk/campaign-readiness/38");
  });
});
