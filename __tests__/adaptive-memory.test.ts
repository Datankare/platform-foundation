/**
 * adaptive-memory.test.ts — ADR-036 D5/D6a: within-session memory is a bounded, per-session
 * slice of the ActivityStateStore that does not cross a session boundary.
 */
import {
  readAdaptiveMemory,
  appendAdaptiveMemory,
  resetAdaptiveMemory,
} from "@/platform/adaptive/memory";
import type { AdaptiveScope } from "@/platform/adaptive";

const scope = (id: string): AdaptiveScope => ({ type: "user", id });
const entry = (n: number) => ({ at: n, behavior: "difficulty", summary: `level=${n}` });

describe("adaptive within-session memory (ADR-036 D5/D6a)", () => {
  beforeEach(() => resetAdaptiveMemory());

  it("reads empty for a fresh session", async () => {
    expect(await readAdaptiveMemory("difficulty", scope("u1"))).toEqual({ recent: [] });
  });

  it("appends and reads back, most recent last", async () => {
    await appendAdaptiveMemory("difficulty", scope("u1"), entry(1));
    await appendAdaptiveMemory("difficulty", scope("u1"), entry(2));
    const mem = await readAdaptiveMemory("difficulty", scope("u1"));
    expect(mem.recent.map((e) => e.summary)).toEqual(["level=1", "level=2"]);
  });

  it("bounds the window to the most recent entries", async () => {
    for (let i = 1; i <= 15; i++) {
      await appendAdaptiveMemory("difficulty", scope("u1"), entry(i));
    }
    const mem = await readAdaptiveMemory("difficulty", scope("u1"));
    expect(mem.recent).toHaveLength(10);
    expect(mem.recent[0].summary).toBe("level=6"); // 1..5 evicted
    expect(mem.recent[9].summary).toBe("level=15");
  });

  it("does not cross a session boundary (different scope sees nothing)", async () => {
    await appendAdaptiveMemory("difficulty", scope("u1"), entry(1));
    expect(await readAdaptiveMemory("difficulty", scope("u2"))).toEqual({ recent: [] });
    // different behavior, same scope, is also isolated
    expect(await readAdaptiveMemory("matchmaker", scope("u1"))).toEqual({ recent: [] });
  });

  it("reset drops all memory (nothing survives)", async () => {
    await appendAdaptiveMemory("difficulty", scope("u1"), entry(1));
    resetAdaptiveMemory();
    expect(await readAdaptiveMemory("difficulty", scope("u1"))).toEqual({ recent: [] });
  });
});
