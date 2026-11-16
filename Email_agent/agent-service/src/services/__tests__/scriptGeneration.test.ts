/**
 * Script generation — ScriptFileAgent (save upload) and generateScript (on demand).
 * MCP is mocked.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";
import * as XLSX from "xlsx";

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock("../mcpClient.service.js", () => ({
  mcpClientService: { dispatch: mockDispatch },
}));

import { generateScript, ScriptGenerationError } from "../scriptGeneration.service.js";
import { scriptFileAgent } from "../../agents/ScriptFileAgent.js";
import type { AgentGraphStateType } from "../../graph/state/agentGraph.state.js";

const AUTH = { userId: "42" as never, rawToken: "user-token" };
const SITE = "Bright Smile Dental. To book an appointment please call our front desk during office hours. ".repeat(4);

function ok(data: unknown) {
  return { data: { success: true, data }, isToolError: false, rawContent: [] };
}
function fail(code: string) {
  return { data: { success: false, error: { code, message: code } }, isToolError: false, rawContent: [] };
}

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: 3, companyName: "Bright Smile", website: "https://brightsmile.example",
    extraFields: { City: "Austin" }, userInstructions: "focus on booking",
    websiteContent: null, scripts: {}, ...overrides,
  };
}

const GENERATED = {
  scriptType: "linkedin", status: "ok", whatTheySell: "Dental care", problemStatement: "Phone-only booking.",
  painPoints: ["Phone-only booking"], recommendedServices: ["GHL (GoHighLevel)"], subject: "", script: "Hi there…", wordCount: 48,
  angle: "website",
};

beforeEach(() => vi.clearAllMocks());

// ── generateScript ────────────────────────────────────────────────────────────

describe("generateScript", () => {
  it("first script: fetches the website, generates, saves and caches the website text", async () => {
    mockDispatch
      .mockResolvedValueOnce(ok(company()))
      .mockResolvedValueOnce(ok({ success: true, content: SITE }))
      .mockResolvedValueOnce(ok(GENERATED))
      .mockImplementationOnce(async (_t, args) => ok({ ...args, type: "linkedin", updatedAt: "now" }));

    const out = await generateScript(3, "linkedin", AUTH);

    expect(mockDispatch.mock.calls.map((c) => c[0])).toEqual([
      "get_script_company", "fetch_website_content", "generate_outreach_script", "save_company_script",
    ]);
    expect(mockDispatch.mock.calls[2]![1]).toMatchObject({
      scriptType: "linkedin", websiteContent: SITE, extraFields: { City: "Austin" }, userInstructions: "focus on booking",
    });
    expect(mockDispatch.mock.calls[3]![1]).toMatchObject({ companyId: 3, scriptType: "linkedin", websiteContent: SITE });
    // Calls run with the user's own token.
    expect(mockDispatch.mock.calls[0]![2]).toBe(AUTH);
    expect(out.cached).toBe(false);
  });

  it("later scripts reuse the cached website text (no fetch, no re-cache)", async () => {
    mockDispatch
      .mockResolvedValueOnce(ok(company({ websiteContent: SITE })))
      .mockResolvedValueOnce(ok({ ...GENERATED, scriptType: "cold_call" }))
      .mockImplementationOnce(async (_t, args) => ok({ ...args, type: "cold_call" }));

    await generateScript(3, "cold_call", AUTH);

    expect(mockDispatch.mock.calls.map((c) => c[0])).not.toContain("fetch_website_content");
    expect(mockDispatch.mock.calls[2]![1]).not.toHaveProperty("websiteContent");
  });

  it("returns a saved script without any AI call", async () => {
    const saved = { type: "cold_email", status: "ok", script: "Hi there", subject: "Booking", wordCount: 100 };
    mockDispatch.mockResolvedValueOnce(ok(company({ scripts: { cold_email: saved } })));

    const out = await generateScript(3, "cold_email", AUTH);

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ script: saved, cached: true });
  });

  it("regenerate=true re-reads the website and writes a new script", async () => {
    mockDispatch
      .mockResolvedValueOnce(ok(company({ websiteContent: "old cached text ".repeat(20), scripts: { linkedin: { script: "old" } } })))
      .mockResolvedValueOnce(ok({ success: true, content: SITE }))
      .mockResolvedValueOnce(ok(GENERATED))
      .mockImplementationOnce(async (_t, args) => ok({ ...args, type: "linkedin" }));

    const out = await generateScript(3, "linkedin", AUTH, { regenerate: true });

    expect(out.cached).toBe(false);
    expect(mockDispatch.mock.calls.map((c) => c[0])).toEqual([
      "get_script_company", "fetch_website_content", "generate_outreach_script", "save_company_script",
    ]);
    expect(mockDispatch.mock.calls[2]![1]).toMatchObject({ websiteContent: SITE });
  });

  it("reads home + about + services pages", async () => {
    mockDispatch
      .mockResolvedValueOnce(ok(company()))
      .mockResolvedValueOnce(ok({ success: true, content: SITE }))
      .mockResolvedValueOnce(ok(GENERATED))
      .mockImplementationOnce(async (_t, args) => ok({ ...args, type: "linkedin" }));

    await generateScript(3, "linkedin", AUTH);

    expect(mockDispatch.mock.calls[1]![1]).toEqual({ url: "https://brightsmile.example", includeSubpages: true });
  });

  it("retries a failed step automatically instead of making the user click again", async () => {
    mockDispatch
      .mockResolvedValueOnce(ok(company({ websiteContent: SITE })))
      .mockRejectedValueOnce(new Error("MCP timeout"))
      .mockResolvedValueOnce({ data: "transport error", isToolError: true, rawContent: [] })
      .mockResolvedValueOnce(ok(GENERATED))
      .mockImplementationOnce(async (_t, args) => ok({ ...args, type: "linkedin" }));

    const out = await generateScript(3, "linkedin", AUTH);

    expect(mockDispatch.mock.calls.filter((c) => c[0] === "generate_outreach_script")).toHaveLength(3);
    expect(out.script).toMatchObject({ status: "ok", angle: "website" });
  }, 15_000);

  it("passes the industry angle through to the saved script", async () => {
    mockDispatch
      .mockResolvedValueOnce(ok(company({ websiteContent: SITE })))
      .mockResolvedValueOnce(ok({ ...GENERATED, angle: "industry" }))
      .mockImplementationOnce(async (_t, args) => ok({ ...args, type: "linkedin" }));

    await generateScript(3, "linkedin", AUTH);

    expect(mockDispatch.mock.calls[2]![1]).toMatchObject({ angle: "industry" });
  });

  it("maps a missing (or someone else's) company to 404", async () => {
    mockDispatch.mockResolvedValueOnce(fail("MAILFLOW_NOT_FOUND"));

    const err = await generateScript(99, "linkedin", AUTH).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ScriptGenerationError);
    expect(err).toMatchObject({ status: 404 });
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });
});

// ── ScriptFileAgent ───────────────────────────────────────────────────────────

function fileOf(rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Sheet1");
  return {
    filename: "leads.xlsx",
    fileContent: (XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer).toString("base64"),
  };
}

function agentState(overrides: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userMessage: "Save this file for script generation",
    sessionId: "s1",
    userId: "42",
    rawToken: "user-token",
    intent: "script_file_intake",
    ...overrides,
  } as AgentGraphStateType;
}

describe("ScriptFileAgent", () => {
  it("saves valid companies and replies with a link card", async () => {
    mockDispatch.mockResolvedValueOnce(ok({ fileId: 7, filename: "leads.xlsx", companyCount: 2, totalRows: 3 }));

    const patch = await scriptFileAgent.handle(agentState({
      pendingCsvFile: fileOf([["Company", "Website", "City"], ["Acme", "acme.com", "Lahore"], ["Beta", "beta.io", ""], ["Gamma", ""]]),
    }));

    const [tool, args, auth] = mockDispatch.mock.calls[0]!;
    expect(tool).toBe("save_script_file");
    expect(args).toMatchObject({
      filename: "leads.xlsx",
      userInstructions: "Save this file for script generation",
      companies: [
        { rowNumber: 2, companyName: "Acme", website: "https://acme.com", extraFields: { City: "Lahore" } },
        { rowNumber: 3, companyName: "Beta", website: "https://beta.io", extraFields: {} },
      ],
    });
    expect(auth).toMatchObject({ userId: "42", rawToken: "user-token" });

    const body = JSON.parse(patch.formattedResponse!);
    expect(body.status).toBe("success");
    expect(body.data).toMatchObject({ kind: "script_file", fileId: 7, companyCount: 2 });
    expect(body.message).toContain("3 rows: 2 valid, 1 bina website.");
    expect(patch.pendingCsvFile).toBeUndefined();
    expect(patch.toolName).toBeUndefined();
  });

  it("returns the column error and saves nothing", async () => {
    const patch = await scriptFileAgent.handle(agentState({ pendingCsvFile: fileOf([["Company"], ["Acme"]]) }));

    expect(patch.formattedResponse).toBe("Aapki file mein 'Website' column nahi mila.");
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it("reports a save failure without crashing", async () => {
    mockDispatch.mockResolvedValueOnce(fail("MAILFLOW_API_ERROR"));

    const patch = await scriptFileAgent.handle(agentState({ pendingCsvFile: fileOf([["Company", "Website"], ["Acme", "acme.com"]]) }));

    expect(patch.formattedResponse).toContain("Could not save the file");
  });
});
