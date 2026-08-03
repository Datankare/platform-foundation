/**
 * platform/agents/__tests__/budget-tracker.test.ts
 *
 * Tests for BudgetTracker. Covers: check, consume, exhaustion,
 * period tracking, custom config, reset, and store atomicity.
 *
 * Not covered here by design: the per-trajectory step limit. It is enforced by
 * runtime.ts inside the execution loop and tested there; this tracker counts steps for
 * observability only.
 */

import { BudgetTracker, InMemoryBudgetStore } from "../budget-tracker";
import type { BudgetConfig } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

const TIGHT_CONFIG: BudgetConfig = {
  maxCostPerTrajectory: 0.05,
  maxCostPerDay: 0.1,
  maxStepsPerTrajectory: 3,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("BudgetTracker", () => {
  let tracker: BudgetTracker;

  beforeEach(() => {
    tracker = new BudgetTracker();
  });

  describe("checkBudget", () => {
    it("allows when budget is fresh", async () => {
      const result = await tracker.checkBudget("guardian", "group", "g1", TIGHT_CONFIG);
      expect(result.allowed).toBe(true);
    });

    it("blocks when daily USD budget exhausted", async () => {
      await tracker.consume("guardian", "group", "g1", 0.1, TIGHT_CONFIG);

      const result = await tracker.checkBudget("guardian", "group", "g1", TIGHT_CONFIG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/budget exhausted/i);
    });

    it("does not block on step count — that is the runtime's per-trajectory limit", async () => {
      // TIGHT_CONFIG.maxStepsPerTrajectory is 3. Four cheap steps used to trip a step
      // gate here, which capped the agent for the whole period rather than for one
      // trajectory. Spend is what this tracker enforces.
      for (let i = 0; i < 4; i++) {
        await tracker.consume("guardian", "group", "g1", 0.001, TIGHT_CONFIG);
      }

      const result = await tracker.checkBudget("guardian", "group", "g1", TIGHT_CONFIG);
      expect(result.allowed).toBe(true);
      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      expect(status.usedSteps).toBe(4);
    });
  });

  describe("consume", () => {
    it("tracks accumulated cost", async () => {
      await tracker.consume("guardian", "group", "g1", 0.01, TIGHT_CONFIG);
      await tracker.consume("guardian", "group", "g1", 0.02, TIGHT_CONFIG);

      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      expect(status.usedUsd).toBeCloseTo(0.03, 4);
      expect(status.usedSteps).toBe(2);
    });

    it("tracks per-agent independently", async () => {
      await tracker.consume("guardian", "group", "g1", 0.05, TIGHT_CONFIG);
      await tracker.consume("matchmaker", "group", "g1", 0.01, TIGHT_CONFIG);

      const guardian = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      const matchmaker = await tracker.getStatus(
        "matchmaker",
        "group",
        "g1",
        TIGHT_CONFIG
      );

      expect(guardian.usedUsd).toBeCloseTo(0.05, 4);
      expect(matchmaker.usedUsd).toBeCloseTo(0.01, 4);
    });

    it("tracks per-scope independently", async () => {
      await tracker.consume("guardian", "group", "g1", 0.05, TIGHT_CONFIG);
      await tracker.consume("guardian", "group", "g2", 0.01, TIGHT_CONFIG);

      const a = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      const b = await tracker.getStatus("guardian", "group", "g2", TIGHT_CONFIG);

      expect(a.usedUsd).toBeCloseTo(0.05, 4);
      expect(b.usedUsd).toBeCloseTo(0.01, 4);
    });

    it("separates scope types that share an id", async () => {
      await tracker.consume("guardian", "group", "x", 0.05, TIGHT_CONFIG);
      await tracker.consume("guardian", "user", "x", 0.01, TIGHT_CONFIG);

      const g = await tracker.getStatus("guardian", "group", "x", TIGHT_CONFIG);
      const u = await tracker.getStatus("guardian", "user", "x", TIGHT_CONFIG);

      expect(g.usedUsd).toBeCloseTo(0.05, 4);
      expect(u.usedUsd).toBeCloseTo(0.01, 4);
    });

    it("loses no increment under concurrent consume", async () => {
      await Promise.all(
        Array.from({ length: 10 }, () =>
          tracker.consume("guardian", "group", "g1", 0.001, TIGHT_CONFIG)
        )
      );

      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      expect(status.usedUsd).toBeCloseTo(0.01, 6);
      expect(status.usedSteps).toBe(10);
    });
  });

  describe("getStatus", () => {
    it("returns zero usage for fresh budget", async () => {
      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);

      expect(status.usedUsd).toBe(0);
      expect(status.usedSteps).toBe(0);
      expect(status.exhausted).toBe(false);
      expect(status.remainingUsd).toBe(TIGHT_CONFIG.maxCostPerDay);
    });

    it("reports exhausted correctly", async () => {
      await tracker.consume("guardian", "group", "g1", 0.1, TIGHT_CONFIG);

      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      expect(status.exhausted).toBe(true);
      expect(status.remainingUsd).toBe(0);
    });

    it("uses current period automatically", async () => {
      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      expect(status.period).toBe(tracker.getCurrentPeriod());
    });

    it("carries scopeType and scopeId rather than a collapsed key", async () => {
      const status = await tracker.getStatus("guardian", "group", "g1", TIGHT_CONFIG);
      expect(status.scopeType).toBe("group");
      expect(status.scopeId).toBe("g1");
    });

    it("permits an absent scopeId for platform scope", async () => {
      await tracker.consume("guardian", "platform", undefined, 0.02, TIGHT_CONFIG);
      const status = await tracker.getStatus(
        "guardian",
        "platform",
        undefined,
        TIGHT_CONFIG
      );
      expect(status.scopeId).toBeUndefined();
      expect(status.usedUsd).toBeCloseTo(0.02, 4);
    });
  });

  describe("getCurrentPeriod", () => {
    it("returns YYYY-MM-DD format", () => {
      expect(tracker.getCurrentPeriod()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it("is today, so maxCostPerDay is enforced over a day", () => {
      const now = new Date();
      const expected = [
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0"),
        String(now.getDate()).padStart(2, "0"),
      ].join("-");
      expect(tracker.getCurrentPeriod()).toBe(expected);
    });
  });

  describe("reset", () => {
    it("clears all budget data", async () => {
      await tracker.consume("guardian", "group", "g1", 0.05);
      await tracker.reset();

      const status = await tracker.getStatus("guardian", "group", "g1");
      expect(status.usedUsd).toBe(0);
      expect(status.usedSteps).toBe(0);
    });
  });

  describe("InMemoryBudgetStore", () => {
    it("is injectable, so a durable store can replace it", async () => {
      const store = new InMemoryBudgetStore();
      const injected = new BudgetTracker(store);
      await injected.consume("guardian", "group", "g1", 0.04, TIGHT_CONFIG);

      const direct = await store.read({
        agentId: "guardian",
        scopeType: "group",
        scopeId: "g1",
        period: injected.getCurrentPeriod(),
      });
      expect(direct.usedUsd).toBeCloseTo(0.04, 4);
    });
  });
});
