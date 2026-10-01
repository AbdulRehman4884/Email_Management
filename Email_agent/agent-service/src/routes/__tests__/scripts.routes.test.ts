import { vi, describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

const { mockGenerate } = vi.hoisted(() => ({ mockGenerate: vi.fn() }));

vi.mock("../../services/scriptGeneration.service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/scriptGeneration.service.js")>()),
  generateScript: mockGenerate,
}));

import { app } from "../../app.js";
import { env } from "../../config/env.js";
import { ScriptGenerationError } from "../../services/scriptGeneration.service.js";

const token = jwt.sign({ sub: "42" }, env.JWT_SECRET, { expiresIn: "5m" });
const URL = "/api/agent/scripts/companies/3/generate";

beforeEach(() => vi.clearAllMocks());

describe("POST /api/agent/scripts/companies/:companyId/generate", () => {
  it("requires auth", async () => {
    const res = await request(app).post(URL).send({ type: "linkedin" });
    expect(res.status).toBe(401);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("generates with the caller's own auth context", async () => {
    mockGenerate.mockResolvedValue({ script: { type: "linkedin", script: "Hi there" }, cached: false });

    const res = await request(app).post(URL).set("Authorization", `Bearer ${token}`).send({ type: "linkedin" });

    expect(res.status).toBe(200);
    expect(res.body.data.script.script).toBe("Hi there");
    expect(mockGenerate).toHaveBeenCalledWith(3, "linkedin", expect.objectContaining({ userId: "42", rawToken: token }), { regenerate: false });
  });

  it("passes regenerate through", async () => {
    mockGenerate.mockResolvedValue({ script: {}, cached: false });
    await request(app).post(URL).set("Authorization", `Bearer ${token}`).send({ type: "cold_call", regenerate: true });
    expect(mockGenerate).toHaveBeenCalledWith(3, "cold_call", expect.anything(), { regenerate: true });
  });

  it("rejects an unknown script type", async () => {
    const res = await request(app).post(URL).set("Authorization", `Bearer ${token}`).send({ type: "sms" });
    expect(res.status).toBe(400);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("returns 404 when the company is not the user's", async () => {
    mockGenerate.mockRejectedValue(new ScriptGenerationError("Company not found.", 404));
    const res = await request(app).post(URL).set("Authorization", `Bearer ${token}`).send({ type: "linkedin" });
    expect(res.status).toBe(404);
  });
});
