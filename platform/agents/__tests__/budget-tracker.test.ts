/**
 * platform/agents/__tests__/budget-tracker.test.ts
 *
 * Tests for BudgetTracker. Covers: check, consume, exhaustion,
 * period tracking, custom config, reset.
 *
 * Not covered here by design: the per-trajectory step limit. It is enforced by
 * runtime.ts inside the execution loop and tested there; this tracker counts steps for
 * observability only.
 */

import { BudgetTracker } from "../budget-tracker";
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
    it("allows when budget is fresh", () => {
      const result = tracker.checkBudget("guardian", "group-1", TIGHT_CONFIG);
      expect(result.allowed).toBe(true);
    });

    it("blocks when daily USD budget exhausted", () => {
      tracker.consume("guardian", "group-1", 0.1, TIGHT_CONFIG);

      const result = tracker.checkBudget("guardian", "group-1", TIGHT_CONFIG);
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/budget exhausted/i);
    });

    it("does not block on step count — that is the runtime's per-trajectory limit", () => {
      // TIGHT_CONFIG.maxStepsPerTrajectory is 3. Four cheap steps used to trip a step
      // gate here, which capped the agent for the whole period rather than for one
      // trajectory. Spend is what this tracker enforces.
      for (let i = 0; i < 4; i++) {
        tracker.consume("guardian", "group-1", 0.001, TIGHT_CONFIG);
      }

      const result = tracker.checkBudget("guardian", "group-1", TIGHT_CONFIG);
      expect(result.allowed).toBe(true);
      expect(tracker.getStatus("guardian", "group-1", TIGHT_CONFIG).usedSteps).toBe(4);
    });
  });

  describe("consume", () => {
    it("tracks accumulated cost", () => {
      tracker.consume("guardian", "group-1", 0.01, TIGHT_CONFIG);
      tracker.consume("guardian", "group-1", 0.02, TIGHT_CONFIG);

      const status = tracker.getStatus("guardian", "group-1", TIGHT_CONFIG);
      expect(status.usedUsd).toBeCloseTo(0.03, 4);
      expect(status.usedSteps).toBe(2);
    });

    it("tracks per-agent independently", () => {
      tracker.consume("guardian", "group-1", 0.05, TIGHT_CONFIG);
      tracker.consume("matchmaker", "group-1", 0.01, TIGHT_CONFIG);

      const guardianStatus = tracker.getStatus("guardian", "group-1", TIGHT_CONFIG);
      const matchmakerStatus = tracker.getStatus("matchmaker", "group-1", TIGHT_CONFIG);

      expect(guardianStatus.usedUsd).toBeCloseTo(0.05, 4);
      expect(matchmakerStatus.usedUsd).toBeCloseTo(0.01, 4);
    });

    it("tracks per-scope independently", () => {
      tracker.consume("guardian", "group-1", 0.05, TIGHT_CONFIG);
      tracker.consume("guardian", "group-2", 0.01, TIGHT_CONFIG);

      const g1 = tracker.getStatus("guardian", "group-1", TIGHT_CONFIG);
      const g2 = tracker.getStatus("guardian", "group-2", TIGHT_CONFIG);

      expect(g1.usedUsd).toBeCloseTo(0.05, 4);
      expect(g2.usedUsd).toBeCloseTo(0.01, 4);
    });
  });

  describe("getStatus", () => {
    it("returns zero usage for fresh budget", () => {
      const status = tracker.getStatus("guardian", "group-1", TIGHT_CONFIG);

      expect(status.usedUsd).toBe(0);
      expect(status.usedSteps).toBe(0);
      expect(status.exhausted).toBe(false);
      expect(status.remainingUsd).toBe(TIGHT_CONFIG.maxCostPerDay);
    });

    it("reports exhausted correctly", () => {
      tracker.consume("guardian", "group-1", 0.1, TIGHT_CONFIG);

      const status = tracker.getStatus("guardian", "group-1", TIGHT_CONFIG);
      expect(status.exhausted).toBe(true);
      expect(status.remainingUsd).toBe(0);
    });

    it("uses current period automatically", () => {
      const status = tracker.getStatus("guardian", "group-1", TIGHT_CONFIG);
      const expected = tracker.getCurrentPeriod();
      expect(status.period).toBe(expected);
    });
  });

  describe("getCurrentPeriod", () => {
    it("returns YYYY-MM-DD format", () => {
      const period = tracker.getCurrentPeriod();
      expect(period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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
    it("clears all budget data", () => {
      tracker.consume("guardian", "group-1", 0.05);
      tracker.reset();

      const status = tracker.getStatus("guardian", "group-1");
      expect(status.usedUsd).toBe(0);
      expect(status.usedSteps).toBe(0);
    });
  });
});
