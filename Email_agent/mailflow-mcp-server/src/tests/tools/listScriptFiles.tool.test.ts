import { describe, expect, it, vi } from "vitest";
import { listScriptFilesTool } from "../../mcp/tools/scripts/scriptFiles.tools.js";
import { createMockToolContext, createMockMailflowClient } from "../helpers.js";

// QA P4 bug 20: "Which files did I upload for script generation?" — the agent could not read them.
describe("list_script_files", () => {
  it("returns the saved files", async () => {
    const files = [{ id: 3, filename: "DRY RUN (1).xlsx", companyCount: 1, totalRows: 1, scriptCount: 3, createdAt: "2026-10-16T10:00:00Z" }];
    const c = createMockToolContext({ mailflow: createMockMailflowClient({ listScriptFiles: vi.fn().mockResolvedValue(files) }) });
    expect(await listScriptFilesTool.handler({}, c)).toMatchObject({ success: true, data: { files } });
  });
});
