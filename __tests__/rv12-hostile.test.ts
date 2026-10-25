/**
 * __tests__/rv12-hostile.test.ts — Review 12, the fixes proved (the reviewer's proofs, inverted)
 *
 *   H1  a capability mapping removed, emptied or all removed is a widening — held; only a
 *       required feature added to an existing mapping is a reduction.
 *   M1  every append goes to the chain's tail: a later small step never lands in an earlier
 *       segment, and each segment's stepOffset is the count of every step before it — also under
 *       concurrent appends.
 *   M2  a chain is capped (agent.trajectory_max_segments, coded refusal before the action runs);
 *       loadSession reads only the tail segment; history is paged one segment at a time.
 *   L2  a toJSON value is measured as what it writes, so a large one is refused unwritten.
 *   L6  a cyclic chain (a corrupt store) ends every walk instead of looping.
 *   L7  a change of the agent registry reaches every instance's config cache at its next read.
 *
 * In memory; the Postgres side is __tests__/db/rv12.db.test.ts.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req",
}));

/** The governed segment cap, set per test (undefined: the setting's own default). */
let maxSegments: number | undefined;
jest.mock("@/platform/auth/platform-config", () => {
  const actual = jest.requireActual("@/platform/auth/platform-config");
  return {
    ...actual,
    getConfig: async (key: string, fallback: unknown) =>
      key === "agent.trajectory_max_segments" && maxSegments !== undefined
        ? maxSegments
        : actual.getConfig(key, fallback),
  };
});

import { powerReduction } from "@/platform/admin/power-reduction";
import {
  InMemoryTrajectoryStore,
  readTrajectoryChain,
  chainSteps,
  trajectoryChainPages,
  latestTrajectorySegment,
  setTrajectoryStore,
  resetTrajectoryStore,
  type TrajectoryStore,
  type TrajectoryRecord,
} from "@/platform/agents/trajectory-store";
import { storedJsonViolation, TRAJECTORY_MAX_STEPS } from "@/platform/errors/json-limits";
import { DEFAULT_TRAJECTORY_MAX_SEGMENTS } from "@/platform/agents/budget-config";
import { invokeTool } from "@/platform/agents/tool-invoker";
import type { Step } from "@/platform/kernel/types";
import type { AgentIdentity, Tool } from "@/platform/agents/types";
import {
  createSession,
  loadSession,
  resetActivityStateStore,
} from "@/platform/app-framework";
import type { ActivityDefinition } from "@/platform/kernel";

beforeEach(() => {
  maxSegments = undefined;
});

// The seeded mapping (baseline). Playform's evaluateCapability read a capability ABSENT from the
// map as having no required features — "the user gate passes vacuously".
const SEED: [string, string[]][] = [
  ["full-pipeline", ["identify_song", "translate", "speak"]],
  ["translate", ["translate"]],
  ["identify-song", ["identify_song"]],
  ["transcribe", ["transcribe"]],
  ["speak", ["speak"]],
];

describe("R12-1 (H1) a capability mapping removed is a widening — held, never applied unheld", () => {
  it("removing full-pipeline's mapping (its user gate would vanish) is not a reduction", () => {
    const after = SEED.filter(([c]) => c !== "full-pipeline");
    expect(powerReduction("agent.capability_features", SEED, after).reduces).toBe(false);
  });
  it("…nor is the semantically identical [cap, []]", () => {
    const after = SEED.map(([c, f]) => [c, c === "full-pipeline" ? [] : f]);
    expect(powerReduction("agent.capability_features", SEED, after).reduces).toBe(false);
  });
  it("removing all but one mapping, or all of them, is not a reduction", () => {
    expect(powerReduction("agent.capability_features", SEED, [SEED[4]]).reduces).toBe(
      false
    );
    expect(powerReduction("agent.capability_features", SEED, []).reduces).toBe(false);
  });
  it("a required feature added to an existing mapping is the one reduction", () => {
    const after = SEED.map(([c, f]) => [c, c === "translate" ? [...f, "verified"] : f]);
    expect(powerReduction("agent.capability_features", SEED, after)).toEqual({
      reduces: true,
      changes: ["require verified for translate"],
    });
    // …and with any other change beside it, held whole.
    const mixed = after.filter(([c]) => c !== "speak");
    expect(powerReduction("agent.capability_features", SEED, mixed).reduces).toBe(false);
  });
});

const step = (i: number, size: number): Step => ({
  stepIndex: i,
  action: `s${i}`,
  input: { p: "x".repeat(size) },
  output: {},
  cost: 0,
  durationMs: 0,
  timestamp: new Date(0).toISOString(),
  boundary: "commitment",
});

describe("R12-2 (M1) every append goes to the chain's tail", () => {
  it("a later small step appended through the first segment's id lands after the step before it", async () => {
    const store = new InMemoryTrajectoryStore();
    const t = await store.create({ kind: "session", id: "s1" }, "t", "user");
    const id = t.trajectory.trajectoryId;
    for (let i = 0; i < 16; i++)
      await store.addStep(id, step(i, 1_040_000), { rollover: true });
    // The 17th large step does not fit: segment 2.
    const big = await store.addStep(id, step(16, 1_040_000), { rollover: true });
    expect(big!.trajectory.segment).toBe(2);
    expect(big!.trajectory.stepOffset).toBe(16);
    // A later small step, appended through the id the caller holds: the tail, never segment 1.
    const small = await store.addStep(id, step(17, 10), { rollover: true });
    expect(small!.trajectory.trajectoryId).toBe(big!.trajectory.trajectoryId);
    const chain = await readTrajectoryChain(store, id);
    const order = chainSteps(chain).map((s) => s.action);
    expect(order).toEqual(Array.from({ length: 18 }, (_, i) => `s${i}`));
    // Segment 2's stepOffset equals the steps before it.
    expect(chain[0].trajectory.steps.length).toBe(16);
    expect(chain[1].trajectory.stepOffset).toBe(16);
    // Without rollover too: through the first segment's id, the tail.
    const plain = await store.addStep(id, step(18, 10));
    expect(plain!.trajectory.segment).toBe(2);
  });

  it("concurrent appends through every segment's id keep one order and true offsets", async () => {
    const store = new InMemoryTrajectoryStore();
    const t = await store.create({ kind: "agent", id: "a1" }, "t", "user");
    const ids = [t.trajectory.trajectoryId];
    const total = TRAJECTORY_MAX_STEPS * 2 + 50;
    await Promise.all(
      Array.from({ length: total }, async (_, i) => {
        const r = await store.addStep(ids[i % ids.length], step(i, 1), {
          rollover: true,
        });
        if (!ids.includes(r!.trajectory.trajectoryId))
          ids.push(r!.trajectory.trajectoryId);
      })
    );
    const chain = await readTrajectoryChain(store, ids[0]);
    expect(chain.map((r) => r.trajectory.segment ?? 1)).toEqual([1, 2, 3]);
    let before = 0;
    for (const seg of chain) {
      expect(seg.trajectory.stepOffset ?? 0).toBe(before);
      before += seg.trajectory.steps.length;
    }
    expect(before).toBe(total);
    expect(new Set(chainSteps(chain).map((s) => s.action)).size).toBe(total);
  });
});

/** A store that counts what it hands back: calls, and steps' bytes (review 12 M2). */
function counting(inner: TrajectoryStore) {
  const read = { calls: [] as string[], bytes: 0, segments: 0 };
  const tally = (r: TrajectoryRecord | undefined) => {
    if (r && r.trajectory.steps.length) {
      read.bytes += JSON.stringify(r.trajectory.steps).length;
      read.segments += 1;
    }
    return r;
  };
  const store: TrajectoryStore = {
    create: (...a) => inner.create(...a),
    addStep: (...a) => inner.addStep(...a),
    updateStatus: (...a) => inner.updateStatus(...a),
    deleteFinishedBefore: (...a) => inner.deleteFinishedBefore(...a),
    assertRoomForStep: (...a) => inner.assertRoomForStep!(...a),
    getById: async (id) => (read.calls.push("getById"), tally(await inner.getById(id))),
    chainTail: async (id) => (
      read.calls.push("chainTail"),
      tally(await inner.chainTail(id))
    ),
    chainSegment: async (id, n) => (
      read.calls.push("chainSegment"),
      tally(await inner.chainSegment(id, n))
    ),
    query: async (o) => {
      read.calls.push("query");
      const rows = await inner.query(o);
      rows.forEach(tally);
      return rows;
    },
  };
  return { store, read };
}

interface S {
  count: number;
}
const definition: ActivityDefinition<S, { by: number }, { start: number }> = {
  id: "counter",
  capabilities: [],
  actions: [{ type: "increment", effects: ["stateWrite"] }],
  initialState: (c) => ({ count: c.start }),
  validateAction: () => true,
  applyAction: (s) => ({ count: s.count + 1 }),
};
const alice: AgentIdentity = { actorType: "user", actorId: "alice", agentRole: "player" };

describe("R12-M2 a session's chain is bounded, and loading it reads only the tail", () => {
  beforeEach(() => {
    resetActivityStateStore();
    resetTrajectoryStore();
  });
  afterAll(() => resetTrajectoryStore());

  it("loadSession reads one segment's steps — none of its predecessors'", async () => {
    const inner = new InMemoryTrajectoryStore();
    setTrajectoryStore(inner);
    const created = await createSession({
      definition,
      config: { start: 0 },
      participants: [alice],
    });
    const id = created.trajectory.trajectoryId;
    // Three segments: two full of 1 000 steps of ~1 KB, and a tail with a few.
    for (let i = 0; i < TRAJECTORY_MAX_STEPS * 2 + 3; i++) {
      await inner.addStep(id, step(i + 1, 1_000), { rollover: true });
    }
    const tail = await inner.chainTail(id);
    expect(tail!.trajectory.segment).toBe(3);
    const tailBytes = JSON.stringify(tail!.trajectory.steps).length;

    const { store, read } = counting(inner);
    setTrajectoryStore(store);
    const loaded = await loadSession({
      sessionId: created.sessionId,
      definition,
      actor: alice,
      skipRepair: true,
    });
    expect(loaded!.session.trajectory.trajectoryId).toBe(tail!.trajectory.trajectoryId);
    // The tail's steps, once; the predecessors' (~2 MB) never.
    expect(read.bytes).toBe(tailBytes);
    expect(read.bytes).toBeLessThan(10_000);
    expect(read.calls).toEqual(["query", "chainTail"]);
  });

  it("history is paged one segment at a time, in order", async () => {
    const store = new InMemoryTrajectoryStore();
    const t = await store.create({ kind: "session", id: "h" }, "t", "user");
    const id = t.trajectory.trajectoryId;
    for (let i = 0; i < TRAJECTORY_MAX_STEPS + 5; i++) {
      await store.addStep(id, step(i, 1), { rollover: true });
    }
    const { store: c, read } = counting(store);
    const seen: number[] = [];
    let held = 0;
    for await (const seg of trajectoryChainPages(c, id)) {
      seen.push(seg.trajectory.segment ?? 1);
      held = Math.max(held, seg.trajectory.steps.length);
    }
    expect(seen).toEqual([1, 2]);
    expect(held).toBe(TRAJECTORY_MAX_STEPS);
    expect(read.calls).toEqual(["chainTail", "chainSegment"]);
  });

  it("a chain past agent.trajectory_max_segments is refused, coded, before the action runs", async () => {
    maxSegments = 2;
    const store = new InMemoryTrajectoryStore();
    const t = await store.create({ kind: "agent", id: "cap" }, "t", "user");
    const id = t.trajectory.trajectoryId;
    for (let i = 0; i < TRAJECTORY_MAX_STEPS * 2; i++) {
      await store.addStep(id, step(i, 1), { rollover: true });
    }
    // Two full segments: the next step would need a third.
    await expect(
      store.addStep(id, step(TRAJECTORY_MAX_STEPS * 2, 1), { rollover: true })
    ).rejects.toMatchObject({
      code: "request.trajectory_chain_full",
      params: { max: 2 },
    });
    await expect(store.assertRoomForStep(id, { rollover: true })).rejects.toMatchObject({
      code: "request.trajectory_chain_full",
    });
    // Through the pipeline: refused before the tool's work runs.
    let work = 0;
    const tool: Tool = {
      id: "read",
      name: "read",
      description: "",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      effects: [],
      declaredRisk: "ordinary",
      execute: async () => {
        work += 1;
        return { ok: true };
      },
    };
    await expect(
      invokeTool({
        tool,
        input: {},
        actor: alice,
        sessionId: "s",
        trajectoryId: id,
        stepIndex: TRAJECTORY_MAX_STEPS * 2,
        trajectoryStore: store,
        rolloverTrajectory: true,
      })
    ).rejects.toMatchObject({ code: "request.trajectory_chain_full" });
    expect(work).toBe(0);
  });

  it("the default cap is the seeded one, and an invalid setting falls back to it", async () => {
    const { resolveTrajectoryMaxSegments } =
      await import("@/platform/agents/budget-config");
    expect(await resolveTrajectoryMaxSegments()).toBe(DEFAULT_TRAJECTORY_MAX_SEGMENTS);
    maxSegments = 0;
    expect(await resolveTrajectoryMaxSegments()).toBe(DEFAULT_TRAJECTORY_MAX_SEGMENTS);
    maxSegments = 5000;
    expect(await resolveTrajectoryMaxSegments()).toBe(DEFAULT_TRAJECTORY_MAX_SEGMENTS);
    maxSegments = 7;
    expect(await resolveTrajectoryMaxSegments()).toBe(7);
  });
});

describe("R12-3 (L2) a toJSON value is measured as what it writes", () => {
  it("is refused without being written out", () => {
    const s = "y".repeat(1_000_000);
    const doc = { a: { toJSON: () => Array.from({ length: 20 }, () => s) } };
    const spy = jest.spyOn(JSON, "stringify");
    const v = storedJsonViolation(doc);
    expect(v?.code).toBe("request.json_too_large");
    const produced = spy.mock.results.some(
      (r) => typeof r.value === "string" && r.value.length > 1_100_000
    );
    spy.mockRestore();
    expect(produced).toBe(false);
  });
  it("measures recursively — a toJSON result's members' own toJSON — and bounded", () => {
    const s = "z".repeat(600_000);
    const inner = { toJSON: () => [s, s] };
    expect(storedJsonViolation({ outer: { toJSON: () => ({ inner }) } })?.code).toBe(
      "request.json_too_large"
    );
    // A toJSON that returns ever more of itself stops at the depth limit, not the stack.
    const endless: { toJSON: () => unknown } = { toJSON: () => ({ again: endless }) };
    expect(storedJsonViolation(endless)?.code).toBe("request.json_too_deep");
  });
  it("still accepts what writes small (a Date, a boxed primitive, an omitted member)", () => {
    expect(
      storedJsonViolation({
        at: new Date(0),
        n: Object(5),
        s: Object("x"),
        gone: { toJSON: () => undefined },
      })
    ).toBeNull();
  });
});

describe("R12-L6 a cyclic chain (a corrupt store) ends every walk", () => {
  it("chainTail, chainSegment and the pages terminate", async () => {
    const store = new InMemoryTrajectoryStore();
    const t = await store.create({ kind: "agent", id: "cyc" }, "t", "user");
    const id = t.trajectory.trajectoryId;
    for (let i = 0; i < TRAJECTORY_MAX_STEPS + 1; i++) {
      await store.addStep(id, step(i, 1), { rollover: true });
    }
    const tail = await store.chainTail(id);
    // Corrupt it: the first segment now names its own continuation as its predecessor.
    const parts = (
      store as unknown as { parts: { current(): Map<string, TrajectoryRecord> } }
    ).parts;
    const first = parts.current().get(id)!;
    parts.current().set(id, {
      ...first,
      trajectory: {
        ...first.trajectory,
        previousTrajectoryId: tail!.trajectory.trajectoryId,
      },
    });
    const links = (store as unknown as { next: { current(): Map<string, string> } }).next;
    links.current().set(tail!.trajectory.trajectoryId, id);
    expect((await store.chainTail(id))?.trajectory.trajectoryId).toBeDefined();
    expect(await store.chainSegment(id, 3)).toBeUndefined();
    const chain = await readTrajectoryChain(store, id);
    expect(chain.length).toBeLessThanOrEqual(2);
    expect(await latestTrajectorySegment(store, id)).toBeDefined();
  });
  it("a store answering a segment twice, or out of order, ends the pages", async () => {
    const rec = (seg: number, id: string): TrajectoryRecord =>
      ({
        trajectory: { trajectoryId: id, segment: seg, steps: [] },
      }) as unknown as TrajectoryRecord;
    const hostile = {
      chainTail: async () => rec(100_000_000, "t"),
      chainSegment: async (_id: string, n: number) => rec(n === 3 ? 2 : n, `s${n % 2}`),
    } as unknown as TrajectoryStore;
    const chain = await readTrajectoryChain(hostile, "x");
    expect(chain.length).toBeLessThanOrEqual(2);
  });
});

describe("R12-L7 the agent registry reaches every instance's config cache at once", () => {
  type ConfigModule = typeof import("@/platform/auth/platform-config");
  /** A fresh copy of the module: another instance, with its own cache. */
  function instance(): ConfigModule {
    let mod = undefined as ConfigModule | undefined;
    jest.isolateModules(() => {
      jest.doMock("@/platform/data", () =>
        require("@/__tests__/helpers/fake-data").fakeDataModule()
      );
      mod = jest.requireActual<ConfigModule>("@/platform/auth/platform-config");
    });
    return mod!;
  }

  it("a published invalidation makes another instance re-read the key at its next read", async () => {
    const { fakeData } = require("@/__tests__/helpers/fake-data");
    const { resetCache } = require("@/platform/cache");
    resetCache();
    fakeData().reset();
    let stored: unknown = [["agent:a", { status: "active" }]];
    fakeData().answer = (sql: string) =>
      /from platform_config/.test(sql) ? [{ value: stored }] : [];
    const a = instance();
    const b = instance();
    const reads = () =>
      fakeData().statements.filter((s: { sql: string }) => /platform_config/.test(s.sql))
        .length;
    expect(await b.getConfig("agent.trusted_agents", [])).toEqual(stored);
    const first = reads();
    // Cached: no second read.
    await b.getConfig("agent.trusted_agents", []);
    expect(reads()).toBe(first);
    // Changed on A (a kill switch): published; B re-reads at once.
    stored = [["agent:a", { status: "suspended" }]];
    expect(await a.publishConfigInvalidation("agent.trusted_agents")).toBe(true);
    expect(await b.getConfig("agent.trusted_agents", [])).toEqual(stored);
    expect(reads()).toBe(first + 1);
    // A key that is not shared-stamped is served from the cache as before.
    expect(await a.publishConfigInvalidation("rate_limit_rpm")).toBe(true);
    expect(b.isSharedInvalidationKey("rate_limit_rpm")).toBe(false);
  });

  it("an unreadable stamp is not trusted: the key is read from the database every time", async () => {
    const { fakeData } = require("@/__tests__/helpers/fake-data");
    const cache = require("@/platform/cache");
    fakeData().reset();
    fakeData().answer = (sql: string) =>
      /from platform_config/.test(sql) ? [{ value: ["x"] }] : [];
    const b = instance();
    const spy = jest.spyOn(cache.getCache(), "get").mockRejectedValue(new Error("down"));
    await b.getConfig("agent.capability_features", []);
    await b.getConfig("agent.capability_features", []);
    spy.mockRestore();
    expect(
      fakeData().statements.filter((s: { sql: string }) => /platform_config/.test(s.sql))
        .length
    ).toBe(2);
  });

  it("an invalidation that cannot be published is alerted, and says so", async () => {
    const cache = require("@/platform/cache");
    const a = instance();
    const spy = jest.spyOn(cache.getCache(), "set").mockRejectedValue(new Error("down"));
    expect(await a.publishConfigInvalidation("agent.trusted_agents")).toBe(false);
    spy.mockRestore();
  });
});
