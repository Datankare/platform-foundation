/**
 * __tests__/app-framework-session.test.ts
 * Behavioral layer for the application framework (ADR-028 D3/D5/D6/D7/D8/D10).
 */

import {
  computeEffectiveRisk,
  effectFloor,
  maxRisk,
  requiresTwoPhase,
  resolveTier,
} from "@/platform/app-framework/actions";
import {
  advanceTurn,
  assertTurnConfigSupported,
  initTurnState,
  isCurrentTurn,
  removeParticipant,
} from "@/platform/app-framework/turn";
import {
  createSession,
  dispatch,
  isConflict,
  resetSessionEventSubscribers,
  subscribeSessionEvents,
  ActionRejectedError,
} from "@/platform/app-framework/session";
import { getActivityStateStore, resetActivityStateStore } from "@/platform/app-framework";
import type {
  ActionSpec,
  ActivityDefinition,
  SessionEvent,
} from "@/platform/app-framework/types";
import type { AgentIdentity } from "@/platform/agents/types";

// ── Fixtures ──────────────────────────────────────────────────────────

interface CounterState {
  count: number;
}
type CounterAction = { by: number } | undefined;
interface CounterConfig {
  start: number;
}

const ACTIONS: readonly ActionSpec[] = [
  { type: "increment", effects: ["stateWrite"] },
  { type: "tally", effects: ["stateWrite"], commutative: true },
  { type: "preview", effects: [], ephemeral: true },
  { type: "wipe", effects: ["restricted"] },
  { type: "notify", effects: ["sendMessage"] },
];

const definition: ActivityDefinition<CounterState, CounterAction, CounterConfig> = {
  id: "counter",
  capabilities: ["persistent"],
  actions: ACTIONS,
  initialState: (c) => ({ count: c.start }),
  validateAction: (s) => s.count < 100,
  applyAction: (s, a) => ({ count: s.count + (a.payload?.by ?? 1) }),
};

const turnDefinition: ActivityDefinition<CounterState, CounterAction, CounterConfig> = {
  ...definition,
  id: "turn-counter",
  capabilities: ["turn-based"],
};

const alice: AgentIdentity = {
  actorType: "user",
  actorId: "alice",
  agentRole: "player",
};
const bob: AgentIdentity = { actorType: "user", actorId: "bob", agentRole: "player" };

beforeEach(() => {
  resetActivityStateStore();
  resetSessionEventSubscribers();
});

// ── D3: risk + tiers (anti-gaming) ────────────────────────────────────

describe("D3 — effective risk and durability tiers", () => {
  it("takes the max of declared risk and effect floor", () => {
    expect(effectFloor(["stateWrite"])).toBe("ordinary");
    expect(effectFloor(["externalCall"])).toBe("consequential");
    expect(effectFloor(["restricted"])).toBe("restricted");
    expect(maxRisk("ordinary", "consequential")).toBe("consequential");
  });

  it("cannot be gamed downward by a low declared risk", () => {
    const sneaky: ActionSpec = {
      type: "x",
      effects: ["restricted"],
      declaredRisk: "ordinary",
    };
    expect(computeEffectiveRisk(sneaky)).toBe("restricted");
  });

  it("honors a raised declared risk", () => {
    const cautious: ActionSpec = {
      type: "x",
      effects: ["stateWrite"],
      declaredRisk: "consequential",
    };
    expect(computeEffectiveRisk(cautious)).toBe("consequential");
  });

  it("classifies tiers and gates restricted actions", () => {
    expect(resolveTier({ type: "a", effects: [], ephemeral: true })).toBe("ephemeral");
    expect(resolveTier({ type: "b", effects: ["stateWrite"] })).toBe("durable");
    expect(resolveTier({ type: "c", effects: ["restricted"] })).toBe("two-phase");
    expect(requiresTwoPhase({ type: "c", effects: ["restricted"] })).toBe(true);
  });

  it("resolves ephemeral-but-writes-state toward durable (structural invariant)", () => {
    expect(resolveTier({ type: "d", effects: ["stateWrite"], ephemeral: true })).toBe(
      "durable"
    );
  });
});

// ── D6: turn core + extension guard ───────────────────────────────────

describe("D6 — turn core", () => {
  it("initializes, validates, and advances turns", () => {
    const t = initTurnState([alice, bob]);
    expect(isCurrentTurn(t, "alice")).toBe(true);
    const t2 = advanceTurn(t);
    expect(isCurrentTurn(t2, "bob")).toBe(true);
    expect(t2.turnNumber).toBe(2);
    expect(isCurrentTurn(advanceTurn(t2), "alice")).toBe(true);
  });

  it("removes a participant without losing the current actor", () => {
    const t = advanceTurn(initTurnState([alice, bob])); // bob's turn
    const t2 = removeParticipant(t, "alice");
    expect(t2.order).toEqual(["bob"]);
    expect(isCurrentTurn(t2, "bob")).toBe(true);
  });

  it("throws on declared-but-unimplemented variant machinery", () => {
    expect(() => assertTurnConfigSupported({ turnTimeoutMs: 30_000 })).toThrow(
      /not implemented/
    );
    expect(() => assertTurnConfigSupported({ simultaneous: true })).toThrow(/ADR-028 D6/);
    expect(() => assertTurnConfigSupported()).not.toThrow();
    expect(() => assertTurnConfigSupported({})).not.toThrow();
  });
});

// ── Session lifecycle + D5/D7/D8/D10 ──────────────────────────────────

describe("session dispatch", () => {
  it("creates a session at version 1 and commits an action to version 2", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    expect(s.current.version).toBe(1);

    const out = await dispatch({
      session: s,
      definition,
      action: { type: "increment", payload: { by: 5 } },
      actor: alice,
    });
    expect(isConflict(out)).toBe(false);
    if (!isConflict(out)) {
      expect(out.result.version).toBe(2);
      expect(out.result.state.count).toBe(5);
    }
  });

  it("D7 — returns the AUX shape with nextActions and cost", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    const out = await dispatch({
      session: s,
      definition,
      action: { type: "increment", payload: { by: 1 } },
      actor: alice,
      cost: 0.002,
    });
    if (isConflict(out)) throw new Error("unexpected conflict");
    expect(out.cost).toBe(0.002);
    expect(out.nextActions).toEqual(expect.arrayContaining(["increment"]));
    expect(out.trajectory).toBeDefined();
  });

  it("D7 — opt-out skips nextActions enumeration on hot paths", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    const out = await dispatch({
      session: s,
      definition,
      action: { type: "increment", payload: { by: 1 } },
      actor: alice,
      options: { computeNextActions: false },
    });
    if (isConflict(out)) throw new Error("unexpected conflict");
    expect(out.nextActions).toEqual([]);
  });

  it("D5 — rejects a stale commit and mutates nothing", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    // Advance the store behind the session's back so the session's version is stale.
    await getActivityStateStore<CounterState>().commit(
      s.sessionId,
      1,
      { count: 42 },
      "op-external"
    );

    const out = await dispatch({
      session: s,
      definition,
      action: { type: "increment", payload: { by: 1 } },
      actor: alice,
    });
    expect(isConflict(out)).toBe(true);
    if (isConflict(out)) {
      expect(out.currentVersion).toBe(2);
      expect(out.currentState.count).toBe(42);
    }
  });

  it("D3 — two-phase actions cannot direct-commit", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    await expect(
      dispatch({
        session: s,
        definition,
        action: { type: "wipe", payload: undefined },
        actor: alice,
      })
    ).rejects.toThrow(ActionRejectedError);
  });

  it("D3 — ephemeral actions never persist", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    const out = await dispatch({
      session: s,
      definition,
      action: { type: "preview", payload: { by: 9 } },
      actor: alice,
    });
    if (isConflict(out)) throw new Error("unexpected conflict");
    const persisted = await getActivityStateStore<CounterState>().load(s.sessionId);
    expect(persisted?.version).toBe(1); // unchanged — nothing committed
    expect(persisted?.state.count).toBe(0);
  });

  it("D6 — rejects an action taken out of turn", async () => {
    const s = await createSession({
      definition: turnDefinition,
      config: { start: 0 },
      participants: [alice, bob],
    });
    await expect(
      dispatch({
        session: s,
        definition: turnDefinition,
        action: { type: "increment", payload: { by: 1 } },
        actor: bob,
      })
    ).rejects.toThrow(/not bob's turn/);
  });

  it("D10 — rejects an action exceeding the session budget ceiling", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
      budget: { maxCostPerTrajectory: 0.01, maxCostPerDay: 1, maxStepsPerTrajectory: 10 },
    });
    await expect(
      dispatch({
        session: s,
        definition,
        action: { type: "increment", payload: { by: 1 } },
        actor: alice,
        cost: 0.5,
      })
    ).rejects.toThrow(/exceeds session ceiling/);
  });

  it("D8 — emits a state-change event carrying agentic fields", async () => {
    const events: SessionEvent[] = [];
    subscribeSessionEvents((e) => events.push(e));

    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    await dispatch({
      session: s,
      definition,
      action: { type: "increment", payload: { by: 1 } },
      actor: alice,
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("state-change");
    expect(events[0].operationId).toMatch(/^op_/);
    expect(events[0].trajectoryId).toBe(s.trajectory.trajectoryId);
    expect(events[0].intent).toBe("commit");
  });

  it("D5 — commutative actions commit without a version precondition", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    await getActivityStateStore<CounterState>().commit(
      s.sessionId,
      1,
      { count: 7 },
      "op-external"
    );
    // Session version is stale, but a commutative action still lands.
    const out = await dispatch({
      session: s,
      definition,
      action: { type: "tally", payload: { by: 1 } },
      actor: alice,
    });
    expect(isConflict(out)).toBe(false);
  });

  it("rejects an unknown action type", async () => {
    const s = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    await expect(
      dispatch({
        session: s,
        definition,
        action: { type: "nope", payload: undefined },
        actor: alice,
      })
    ).rejects.toThrow(/unknown action/);
  });
});
