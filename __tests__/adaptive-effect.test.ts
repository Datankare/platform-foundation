/**
 * adaptive-effect.test.ts — ADR-036 D4: adaptive effects route through the governed pipeline,
 * forced to boundary "commitment", with every pipeline outcome translated.
 */
jest.mock("@/platform/action-pipeline", () => {
  const actual = jest.requireActual("@/platform/action-pipeline");
  return { ...actual, executeActionPipeline: jest.fn() };
});
import { executeActionPipeline, PipelineRejectedError } from "@/platform/action-pipeline";
import { routeAdaptiveEffect } from "@/platform/adaptive/effect";
import type { AdaptiveEffectRequest } from "@/platform/adaptive";

const pipe = executeActionPipeline as jest.Mock;

interface St {
  readonly level: number;
}

const req = (): AdaptiveEffectRequest<St> => ({
  spec: { type: "adaptive-set-level", effects: ["stateWrite"] },
  actor: { actorType: "agent", actorId: "difficulty-agent", agentRole: "adaptive" },
  sessionId: "s1",
  label: "adaptive-set-level",
  cost: 0,
  stateStore: {} as never,
  trajectoryStore: {} as never,
  trajectoryId: "t1",
  stepIndex: 0,
  expectedVersion: 3,
  computeNextState: () => ({ level: 7 }),
});

const success = (committed: unknown) => ({
  conflict: false,
  tier: "durable",
  context: {},
  committed,
  step: null,
  trajectory: null,
});

beforeEach(() => pipe.mockReset());

describe("adaptive effect routing (ADR-036 D4)", () => {
  it("translates a pipeline commit to applied", async () => {
    pipe.mockResolvedValue(success({ sessionId: "s1", state: { level: 7 }, version: 4 }));
    const r = await routeAdaptiveEffect(req());
    expect(r.status).toBe("applied");
    expect(r.committed?.version).toBe(4);
  });

  it("forces boundary=commitment — a caller cannot downgrade it", async () => {
    pipe.mockResolvedValue(success(null));
    await routeAdaptiveEffect(req());
    expect(pipe).toHaveBeenCalledWith(
      expect.objectContaining({ boundary: "commitment" })
    );
  });

  it("translates requires-approval to held", async () => {
    pipe.mockRejectedValue(
      new PipelineRejectedError("needs approval", "requires-approval")
    );
    const r = await routeAdaptiveEffect(req());
    expect(r.status).toBe("held");
    expect(r.reason).toBe("requires-approval");
  });

  it("translates budget-exceeded to rejected", async () => {
    pipe.mockRejectedValue(new PipelineRejectedError("too costly", "budget-exceeded"));
    const r = await routeAdaptiveEffect(req());
    expect(r.status).toBe("rejected");
    expect(r.reason).toBe("budget-exceeded");
  });

  it("translates a CAS loss to conflict", async () => {
    pipe.mockResolvedValue({
      conflict: true,
      currentVersion: 5,
      currentState: { level: 2 },
    });
    const r = await routeAdaptiveEffect(req());
    expect(r.status).toBe("conflict");
    expect(r.currentVersion).toBe(5);
    expect(r.currentState).toEqual({ level: 2 });
  });

  it("propagates an unexpected (non-rejection) error", async () => {
    pipe.mockRejectedValue(new Error("boom"));
    await expect(routeAdaptiveEffect(req())).rejects.toThrow("boom");
  });
});
