/**
 * effect.test.ts — ADR-037 D5: durable content surfaces through the shared governed-effect router,
 * forced to boundary "commitment", with every pipeline outcome translated. Surfacing is an ordinary
 * governed effect (the same platform primitive the adaptive effect uses) — applied when the gate
 * allows, held when approval is required, rejected/conflict otherwise.
 */
jest.mock("@/platform/action-pipeline", () => {
  const actual = jest.requireActual("@/platform/action-pipeline");
  return { ...actual, executeActionPipeline: jest.fn() };
});
import { executeActionPipeline, PipelineRejectedError } from "@/platform/action-pipeline";
import { routeContentEffect } from "@/platform/content";
import type { ContentEffectRequest } from "@/platform/content";

const pipe = executeActionPipeline as jest.Mock;

interface Surfaced {
  readonly digestId: string;
}

const req = (): ContentEffectRequest<Surfaced> => ({
  spec: { type: "content-surface-digest", effects: ["stateWrite"] },
  actor: { actorType: "agent", actorId: "content-curator-host", agentRole: "content" },
  sessionId: "g1",
  label: "content-surface-digest",
  cost: 0,
  stateStore: {} as never,
  trajectoryStore: {} as never,
  trajectoryId: "t1",
  stepIndex: 0,
  expectedVersion: 2,
  computeNextState: () => ({ digestId: "d1" }),
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

describe("content effect routing (ADR-037 D5)", () => {
  it("translates a pipeline commit to applied (surfaced)", async () => {
    pipe.mockResolvedValue(
      success({ sessionId: "g1", state: { digestId: "d1" }, version: 3 })
    );
    const r = await routeContentEffect(req());
    expect(r.status).toBe("applied");
    expect(r.committed?.version).toBe(3);
  });

  it("forces boundary=commitment — a caller cannot downgrade it", async () => {
    pipe.mockResolvedValue(success(null));
    await routeContentEffect(req());
    expect(pipe).toHaveBeenCalledWith(
      expect.objectContaining({ boundary: "commitment" })
    );
  });

  it("translates requires-approval to held", async () => {
    pipe.mockRejectedValue(
      new PipelineRejectedError("needs review", "requires-approval")
    );
    const r = await routeContentEffect(req());
    expect(r.status).toBe("held");
    expect(r.reason).toBe("requires-approval");
  });

  it("translates budget-exceeded to rejected", async () => {
    pipe.mockRejectedValue(new PipelineRejectedError("too costly", "budget-exceeded"));
    const r = await routeContentEffect(req());
    expect(r.status).toBe("rejected");
    expect(r.reason).toBe("budget-exceeded");
  });

  it("translates a CAS loss to conflict", async () => {
    pipe.mockResolvedValue({
      conflict: true,
      currentVersion: 4,
      currentState: { digestId: "old" },
    });
    const r = await routeContentEffect(req());
    expect(r.status).toBe("conflict");
    expect(r.currentVersion).toBe(4);
  });

  it("propagates an unexpected (non-rejection) error", async () => {
    pipe.mockRejectedValue(new Error("boom"));
    await expect(routeContentEffect(req())).rejects.toThrow("boom");
  });
});
