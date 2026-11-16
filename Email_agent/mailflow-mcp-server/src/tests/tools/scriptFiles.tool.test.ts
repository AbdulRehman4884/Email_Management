import { describe, expect, it, vi } from "vitest";
import {
  getScriptCompanyTool,
  saveCompanyScriptTool,
  saveScriptFileTool,
} from "../../mcp/tools/scripts/scriptFiles.tools.js";
import { MailFlowApiError } from "../../lib/errors.js";
import type { ToolContext } from "../../mcp/types/toolContext.js";

function context(overrides: Partial<ToolContext["mailflow"]> = {}): ToolContext {
  return {
    auth: { userId: "1" as never, bearerToken: "token" as never },
    session: { sessionId: "s1", rawAuth: "Bearer token" },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    mailflow: {
      saveScriptFile: vi.fn().mockResolvedValue({ fileId: 7, filename: "leads.xlsx", companyCount: 1, totalRows: 1, report: {}, createdAt: "" }),
      getScriptCompany: vi.fn().mockResolvedValue({ id: 3, companyName: "Acme", scripts: {} }),
      saveCompanyScript: vi.fn().mockResolvedValue({ type: "linkedin", status: "ok" }),
      ...overrides,
    } as never,
  };
}

describe("script file tools", () => {
  it("save_script_file passes the parsed company list to the backend", async () => {
    const ctx = context();
    const input = {
      filename: "leads.xlsx",
      report: { totalRows: 1, validRows: 1 },
      companies: [{ rowNumber: 2, companyName: "Acme", website: "https://acme.com", extraFields: {} }],
    };

    const result = await saveScriptFileTool.handler(input, ctx);

    expect(ctx.mailflow.saveScriptFile).toHaveBeenCalledWith(input);
    expect(result).toEqual({ success: true, data: expect.objectContaining({ fileId: 7 }) });
  });

  it("get_script_company forwards includeContent", async () => {
    const ctx = context();
    await getScriptCompanyTool.handler({ companyId: 3, includeContent: true }, ctx);
    expect(ctx.mailflow.getScriptCompany).toHaveBeenCalledWith(3, true);
  });

  it("save_company_script splits routing fields from the body", async () => {
    const ctx = context();
    await saveCompanyScriptTool.handler({
      companyId: 3, scriptType: "linkedin", status: "ok", whatTheySell: "", problemStatement: "p",
      painPoints: [], recommendedServices: ["n8n"], script: "Hi there", wordCount: 2,
    }, ctx);

    expect(ctx.mailflow.saveCompanyScript).toHaveBeenCalledWith(3, "linkedin", expect.not.objectContaining({ companyId: 3 }));
  });

  it("returns a tool failure instead of throwing when the backend says not found", async () => {
    const ctx = context({ getScriptCompany: vi.fn().mockRejectedValue(new MailFlowApiError(404, "not found")) });
    const result = await getScriptCompanyTool.handler({ companyId: 99, includeContent: false }, ctx);
    expect(result.success).toBe(false);
  });
});
