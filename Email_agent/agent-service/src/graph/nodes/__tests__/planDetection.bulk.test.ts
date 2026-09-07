import { describe, expect, it, vi, beforeEach } from "vitest";
import { planDetectionNode } from "../planDetection.node.js";
import { plannerService } from "../../../services/planner.service.js";
import type { AgentGraphStateType } from "../../state/agentGraph.state.js";

vi.mock("../../../services/planner.service.js", () => ({
  plannerService: {
    detectPlan: vi.fn(),
  },
}));

const detectPlan = vi.mocked(plannerService.detectPlan);

beforeEach(() => {
  detectPlan.mockReset();
});

describe("planDetectionNode bulk workflow guard", () => {
  it("skips generic planning for manual bulk rows so tool args are not resolved to {}", async () => {
    const patch = await planDetectionNode({
      sessionId: "s1",
      intent: "bulk_manual_rows_intake",
      pendingCsvFile: undefined,
      pendingEnrichmentStep: undefined,
      pendingEnrichmentAction: undefined,
    } as AgentGraphStateType);

    expect(patch).toEqual({ plan: undefined });
    expect(detectPlan).not.toHaveBeenCalled();
  });
});
