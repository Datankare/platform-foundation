/**
 * platform/agents/__tests__/trajectory-store.test.ts
 *
 * Tests for InMemoryTrajectoryStore. Covers: create, addStep,
 * updateStatus, getById, query with filters, cost accumulation.
 */

import { InMemoryTrajectoryStore } from "../trajectory-store";
import type { Step } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    stepIndex: 0,
    action: "test-action",
    boundary: "cognition",
    input: { data: "in" },
    output: { data: "out" },
    cost: 0.001,
    durationMs: 50,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("InMemoryTrajectoryStore", () => {
  let store: InMemoryTrajectoryStore;

  beforeEach(() => {
    store = new InMemoryTrajectoryStore();
  });

  describe("create", () => {
    it("creates a running trajectory", async () => {
      const record = await store.create("guardian", "content-screen", "group", "group-1");

      expect(record.trajectory.agentId).toBe("guardian");
      expect(record.trajectory.status).toBe("running");
      expect(record.trajectory.steps).toHaveLength(0);
      expect(record.trajectory.totalCost).toBe(0);
      expect(record.trigger).toBe("content-screen");
      expect(record.scopeType).toBe("group");
      expect(record.scopeId).toBe("group-1");
    });

    it("assigns unique trajectory IDs", async () => {
      const firstRecord = await store.create("guardian", "a", "platform");
      const secondRecord = await store.create("guardian", "b", "platform");
      expect(firstRecord.trajectory.trajectoryId).not.toBe(
        secondRecord.trajectory.trajectoryId
      );
    });

    it("defaults scopeId to null", async () => {
      const record = await store.create("guardian", "trigger", "platform");
      expect(record.scopeId).toBeNull();
    });
  });

  describe("addStep", () => {
    it("appends a step to the trajectory", async () => {
      const record = await store.create("guardian", "trigger", "platform");
      const updated = await store.addStep(record.trajectory.trajectoryId, makeStep());

      expect(updated).toBeDefined();
      expect(updated!.trajectory.steps).toHaveLength(1);
      expect(updated!.trajectory.steps[0].action).toBe("test-action");
    });

    it("accumulates cost across steps", async () => {
      const record = await store.create("guardian", "trigger", "platform");
      const tid = record.trajectory.trajectoryId;

      await store.addStep(tid, makeStep({ cost: 0.01 }));
      const updated = await store.addStep(tid, makeStep({ stepIndex: 1, cost: 0.02 }));

      expect(updated!.trajectory.totalCost).toBeCloseTo(0.03, 4);
      expect(updated!.costSummary.usd).toBeCloseTo(0.03, 4);
    });

    it("returns undefined for nonexistent trajectory", async () => {
      const result = await store.addStep("nonexistent", makeStep());
      expect(result).toBeUndefined();
    });
  });

  describe("updateStatus", () => {
    it("updates status to completed", async () => {
      const record = await store.create("guardian", "trigger", "platform");
      const updated = await store.updateStatus(
        record.trajectory.trajectoryId,
        "completed"
      );

      expect(updated!.trajectory.status).toBe("completed");
    });

    it("updates status to failed", async () => {
      const record = await store.create("guardian", "trigger", "platform");
      const updated = await store.updateStatus(record.trajectory.trajectoryId, "failed");

      expect(updated!.trajectory.status).toBe("failed");
    });

    it("returns undefined for nonexistent trajectory", async () => {
      const result = await store.updateStatus("nonexistent", "completed");
      expect(result).toBeUndefined();
    });
  });

  describe("getById", () => {
    it("returns the trajectory record", async () => {
      const record = await store.create("guardian", "trigger", "platform");
      const found = await store.getById(record.trajectory.trajectoryId);

      expect(found).toBeDefined();
      expect(found!.trajectory.agentId).toBe("guardian");
    });

    it("returns undefined when not found", async () => {
      const found = await store.getById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("query", () => {
    it("filters by agentId", async () => {
      await store.create("guardian", "a", "platform");
      await store.create("matchmaker", "b", "platform");

      const results = await store.query({
        agentId: "guardian",
      });
      expect(results).toHaveLength(1);
      expect(results[0].trajectory.agentId).toBe("guardian");
    });

    it("filters by scopeType and scopeId", async () => {
      await store.create("guardian", "a", "group", "group-1");
      await store.create("guardian", "b", "group", "group-2");
      await store.create("guardian", "c", "platform");

      const results = await store.query({
        scopeType: "group",
        scopeId: "group-1",
      });
      expect(results).toHaveLength(1);
    });

    it("filters by status", async () => {
      const r1 = await store.create("guardian", "a", "platform");
      await store.create("guardian", "b", "platform");
      await store.updateStatus(r1.trajectory.trajectoryId, "completed");

      const results = await store.query({
        status: "running",
      });
      expect(results).toHaveLength(1);
    });

    it("respects limit", async () => {
      await store.create("guardian", "a", "platform");
      await store.create("guardian", "b", "platform");
      await store.create("guardian", "c", "platform");

      const results = await store.query({ limit: 2 });
      expect(results).toHaveLength(2);
    });

    it("returns most recent first", async () => {
      await store.create("guardian", "first", "platform");
      // Small delay so timestamps differ
      await new Promise((r) => setTimeout(r, 5));
      await store.create("guardian", "second", "platform");

      const results = await store.query({});
      expect(results[0].trigger).toBe("second");
      expect(results[1].trigger).toBe("first");
    });
  });

  describe("test helpers", () => {
    it("tracks count", async () => {
      expect(store.getRecordCount()).toBe(0);
      await store.create("guardian", "a", "platform");
      expect(store.getRecordCount()).toBe(1);
    });

    it("clear removes all", async () => {
      await store.create("guardian", "a", "platform");
      store.clear();
      expect(store.getRecordCount()).toBe(0);
    });
  });
});
