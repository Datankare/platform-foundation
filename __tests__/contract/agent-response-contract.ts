/**
 * __tests__/contract/agent-response-contract.ts
 * AUX response conformance kit (TCK) — ADR-030 L21 requirements 1-8. Not a *.test.ts.
 *
 * One arm per NUMBERED ADR-030 conformance requirement, run against SUPPLIED fixtures.
 * The rest of the suite answers "does our agent surface work"; this answers "does yours",
 * for any consumer that exposes /api/agent/* over its own workflow loop.
 *
 * Registered as a FABRIC entry, for the reason ADR-029 D9 gives for the workflow kit:
 * the response envelope is assembled in process, so there is no provider slot to swap
 * and the meta-test's registry bijection is unaffected.
 *
 * The load-bearing arm is R6 (gate parity). Every other arm inspects one response and so
 * can be satisfied by an orchestrated path that skipped its gates and reported tidily.
 * R6 compares two runs of the same workflow through two entry points, which is the only
 * mechanical evidence that D2's "same machinery" claim holds and that the fast path is
 * not the unsafe one (ADR-030 D4).
 */

import type { AgentGoal, AgentResponse, Step, TrajectoryRecord } from "@/platform/kernel";

/** A goal invocation the kit can replay through either entry point. */
export interface AgentGoalRun {
  readonly goal: AgentGoal;
  readonly input: Record<string, unknown>;
  readonly budgetMaxUSD?: number;
}

export interface AgentResponseFixtures {
  /**
   * Orchestrated entry point (ADR-030 D2): one call runs the whole workflow server-side.
   */
  readonly runOrchestrated: (run: AgentGoalRun) => Promise<AgentResponse<unknown>>;
  /**
   * Choreographed entry point (ADR-030 D2): the SAME workflow walked one hop at a time,
   * each hop's response returned in order. R6 compares the two, so for one input this
   * must thread ONE trajectory and reach the same terminal state as runOrchestrated.
   */
  readonly runChoreographed: (
    run: AgentGoalRun
  ) => Promise<readonly AgentResponse<unknown>[]>;
  /**
   * Resolve a trajectory id against the durable store (R5).
   *
   * GOTCHA-78: the id is passed in, and the record does NOT return it at the top level —
   * it lives at record.trajectory.trajectoryId. Do not assert record.trajectoryId.
   */
  readonly getTrajectory: (trajectoryId: string) => Promise<TrajectoryRecord | undefined>;
  /** The goals published on the capabilities surface (ADR-030 D8, R8). */
  readonly publishedGoals: () => Promise<readonly AgentGoal[]> | readonly AgentGoal[];
  /** A composite goal whose workflow gates at least two steps. */
  readonly orchestratedRun: AgentGoalRun;
  /** A ceiling below the cost of orchestratedRun (R7). */
  readonly infeasibleBudgetUSD: number;
}

/** Affordances that end a workflow rather than naming a further goal (ADR-030 D3). */
const TERMINAL_ACTIONS: readonly string[] = ["done", "retry"];

/**
 * The steps that went through the gates.
 *
 * The action pipeline populates operationId on every step it appends (ADR-029 D4), so a
 * step without one did not traverse the risk floor, budget check and trajectory append.
 * That is what makes this filter the right subject for R6 rather than a boundary filter:
 * a proposal step is cognition and still gated.
 */
function gatedSteps(steps: readonly Step[]): readonly Step[] {
  return steps.filter((s) => s.operationId !== undefined);
}

/** Identity of a gated step for comparison across entry points. */
function stepSignature(s: Step): string {
  return `${s.action}|${s.boundary}|${s.effectiveRisk ?? "unset"}`;
}

export function runAgentResponseContract(fx: AgentResponseFixtures): void {
  let response: AgentResponse<unknown>;

  beforeEach(async () => {
    response = await fx.runOrchestrated(fx.orchestratedRun);
  });

  describe("R1 — one call completes an orchestrated workflow", () => {
    it("reaches a terminal trajectory without a second call", () => {
      expect(response.trajectory.status).toBe("completed");
    });

    it("ran more than one gated step server-side", () => {
      // A composite goal that gated a single step orchestrated nothing, and R6 would
      // then compare two one-element lists and pass without proving anything.
      expect(gatedSteps(response.trajectory.steps).length).toBeGreaterThan(1);
    });
  });

  describe("R2 — the response is a well-formed AgentResponse", () => {
    it("carries result, trajectory, nextActions and cost", () => {
      expect(response).toHaveProperty("result");
      expect(response.trajectory).toBeDefined();
      expect(Array.isArray(response.nextActions)).toBe(true);
      expect(response.cost).toBeDefined();
    });

    it("identifies its trajectory as trajectoryId, with no id synonym", () => {
      // Both halves run here deliberately: the absence check below passes by finding
      // nothing, so it is paired with a control that proves the object was inspected
      // at all (GOTCHA-64 polarity). The synonym is banned by GOTCHA-78 — an id field
      // beside trajectoryId is the exact shape that made the TASK-075a round-trip read
      // undefined and present as a broken store.
      expect(typeof response.trajectory.trajectoryId).toBe("string");
      expect(response.trajectory).not.toHaveProperty("id");
    });

    it("reports cost as a CostSummary, not a bare number", () => {
      expect(typeof response.cost.estimatedCostUSD).toBe("number");
      expect(typeof response.cost.apiCalls).toBe("number");
      expect(typeof response.cost.tokensUsed).toBe("number");
    });
  });

  describe("R3 — nextActions is present, non-empty and reachable", () => {
    it("is never empty — a terminal state is done, not absence (D3)", () => {
      expect(response.nextActions.length).toBeGreaterThan(0);
    });

    it("names only published goals or terminals", async () => {
      const published = await fx.publishedGoals();
      const allowed = new Set<string>([...published, ...TERMINAL_ACTIONS]);
      for (const next of response.nextActions) {
        expect(allowed.has(next.action)).toBe(true);
      }
    });

    it("gives every non-terminal affordance an endpoint to call", () => {
      for (const next of response.nextActions) {
        if (TERMINAL_ACTIONS.includes(next.action)) {
          expect(next.endpoint).toBeNull();
        } else {
          expect(typeof next.endpoint).toBe("string");
        }
      }
    });
  });

  describe("R4 — cost is the sum of the steps", () => {
    it("totals the gated steps rather than reporting an independent figure", () => {
      const stepTotal = response.trajectory.steps.reduce(
        (sum: number, s: Step) => sum + s.cost,
        0
      );
      expect(response.cost.estimatedCostUSD).toBeCloseTo(stepTotal, 6);
    });
  });

  describe("R5 — the trajectory resolves to a durable record", () => {
    it("is readable from the store by its id", async () => {
      const record = await fx.getTrajectory(response.trajectory.trajectoryId);
      // toBeDefined, not toBeNull: the store returns undefined for a miss, and
      // expect(undefined).not.toBeNull() passes -- this arm would have gone green on a
      // trajectory that never persisted. Read the interface, not the prose (GOTCHA-78).
      expect(record).toBeDefined();
      expect(record?.trajectory.trajectoryId).toBe(response.trajectory.trajectoryId);
    });

    it("persists every step the response reported", async () => {
      const record = await fx.getTrajectory(response.trajectory.trajectoryId);
      expect(record?.trajectory.steps.length).toBe(response.trajectory.steps.length);
    });
  });

  describe("R6 — gate parity between the two entry points", () => {
    it("threads one trajectory across the choreographed hops", async () => {
      const hops = await fx.runChoreographed(fx.orchestratedRun);
      expect(hops.length).toBeGreaterThan(0);
      const ids = new Set(hops.map((h) => h.trajectory.trajectoryId));
      expect(ids.size).toBe(1);
    });

    it("gates the same steps whichever door the agent used", async () => {
      const hops = await fx.runChoreographed(fx.orchestratedRun);
      const walked = hops.at(-1);
      expect(walked).toBeDefined();
      if (!walked) return;

      const orchestrated = gatedSteps(response.trajectory.steps);
      const choreographed = gatedSteps(walked.trajectory.steps);

      // Polarity guard: two empty lists are equal, so without this the arm reports
      // parity for a pair of runs that gated nothing at all (GOTCHA-64).
      expect(orchestrated.length).toBeGreaterThan(0);
      expect(choreographed.map(stepSignature)).toEqual(orchestrated.map(stepSignature));
    });
  });

  describe("R7 — a budget ceiling is respected and reported", () => {
    it("reports a cost within a ceiling it can meet", async () => {
      const generous = await fx.runOrchestrated({
        ...fx.orchestratedRun,
        budgetMaxUSD: fx.infeasibleBudgetUSD * 1000,
      });
      expect(generous.cost.estimatedCostUSD).toBeLessThanOrEqual(
        fx.infeasibleBudgetUSD * 1000
      );
    });

    it("does not report completed on a workflow it could not afford", async () => {
      // Either refusal shape conforms: the ceiling may reject before the workflow starts
      // or pause it partway (ADR-029 D8 pauses rather than fails). What it may not do is
      // finish and bill past the ceiling.
      let outcome: AgentResponse<unknown> | undefined;
      let error: unknown;
      try {
        outcome = await fx.runOrchestrated({
          ...fx.orchestratedRun,
          budgetMaxUSD: fx.infeasibleBudgetUSD,
        });
      } catch (err) {
        error = err;
      }

      if (outcome === undefined) {
        expect(String(error)).toMatch(/budget|ceiling/i);
        return;
      }
      expect(outcome.trajectory.status).not.toBe("completed");
      expect(outcome.cost.estimatedCostUSD).toBeLessThanOrEqual(fx.infeasibleBudgetUSD);
    });
  });

  describe("R8 — every implemented goal is discoverable", () => {
    it("publishes the goal the kit just ran", async () => {
      const published = await fx.publishedGoals();
      expect(published).toContain(fx.orchestratedRun.goal);
    });

    it("publishes every goal it hands back as an affordance", async () => {
      const published = await fx.publishedGoals();
      const offered = response.nextActions
        .map((n) => n.action)
        .filter((a) => !TERMINAL_ACTIONS.includes(a));
      for (const goal of offered) {
        expect(published).toContain(goal);
      }
    });
  });
}
