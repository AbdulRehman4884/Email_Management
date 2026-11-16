import { describe, expect, it } from "vitest";
import { detectIntentNode, detectScriptFileIntent } from "../detectIntent.node.js";
import type { AgentGraphStateType } from "../../state/agentGraph.state.js";

function state(overrides: Partial<AgentGraphStateType>): AgentGraphStateType {
  return {
    userMessage: "",
    sessionId: "s1" as never,
    userId: "u1" as never,
    messages: [],
    confidence: 0,
    agentDomain: undefined,
    toolArgs: {},
    requiresApproval: false,
    planIndex: 0,
    planResults: [],
    pendingPhase3ContinueExecute: false,
    sessionSchemaVersion: 2,
    ...overrides,
  } as AgentGraphStateType;
}

const FILE = { filename: "companies.xlsx", fileContent: "ZmFrZQ==" };

describe("detectIntentNode — script generation file upload", () => {
  it("file + 'script generation' → script_file_intake", async () => {
    const patch = await detectIntentNode(state({
      pendingCsvFile: FILE,
      userMessage: "Save this file for script generation",
    }));
    expect(patch.intent).toBe("script_file_intake");
  });

  it("file + 'upload these recipients' → upload_csv (unchanged)", async () => {
    const patch = await detectIntentNode(state({ pendingCsvFile: FILE, userMessage: "upload these recipients" }));
    expect(patch.intent).toBe("upload_csv");
  });

  it("file + 'create bulk campaign' → bulk_file_intake (unchanged)", async () => {
    const patch = await detectIntentNode(state({ pendingCsvFile: FILE, userMessage: "create bulk campaign from this file" }));
    expect(patch.intent).toBe("bulk_file_intake");
  });

  it("wins over an active bulk workflow", async () => {
    const patch = await detectIntentNode(state({
      pendingCsvFile: FILE,
      bulkWorkflow: { jobId: 1, currentStep: "awaiting_template_strategy" } as never,
      userMessage: "write sales scripts for these leads",
    }));
    expect(patch.intent).toBe("script_file_intake");
  });
});

describe("detectScriptFileIntent", () => {
  it.each([
    "script generation", "cold call script", "cold emailing for these", "linkedin messages",
    "phone script", "give me a pitch", "scripts for these", "bahi cold calling krni ha inpa",
  ])("file + %j → script_file_intake", (msg) => {
    expect(detectScriptFileIntent(msg, true)).toBe("script_file_intake");
  });

  it("needs a file", () => {
    expect(detectScriptFileIntent("cold call scripts", false)).toBeUndefined();
  });

  it("does not trigger on a file without script keywords", () => {
    expect(detectScriptFileIntent("enrich these contacts", true)).toBeUndefined();
  });
});
