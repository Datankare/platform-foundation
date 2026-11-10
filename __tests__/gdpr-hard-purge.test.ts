/**
 * GDPR Hard Purge Pipeline Tests.
 *
 * Tests PurgePipeline orchestration, handler registration,
 * dry-run mode, timeout, error handling, and audit callback.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { PurgePipeline } from "../platform/gdpr/hard-purge";
import type { PurgeHandler, PurgeAuditEntry } from "../platform/gdpr/types";

/** Test helper: create a mock handler */
function createMockHandler(
  name: string,
  priority: number,
  deletedCount: number,
  shouldFail = false
): PurgeHandler {
  return {
    name,
    priority,
    execute: jest.fn(async (_userId: string, dryRun: boolean) => {
      if (shouldFail) throw new Error(`${name} failed`);
      if (dryRun) return 0;
      return deletedCount;
    }),
  };
}

describe("PurgePipeline", () => {
  it("executes handlers in priority order", async () => {
    const pipeline = new PurgePipeline();
    const order: string[] = [];

    const h1: PurgeHandler = {
      name: "second",
      priority: 20,
      execute: async () => {
        order.push("second");
        return 5;
      },
    };
    const h2: PurgeHandler = {
      name: "first",
      priority: 10,
      execute: async () => {
        order.push("first");
        return 3;
      },
    };

    pipeline.register(h1);
    pipeline.register(h2);

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "admin-1",
      reason: "user-request",
    });

    expect(order).toEqual(["first", "second"]);
    expect(result.totalDeleted).toBe(8);
    expect(result.status).toBe("completed");
  });

  it("returns completed status when all handlers succeed", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("db:profiles", 10, 1));
    pipeline.register(createMockHandler("db:content", 20, 5));

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "account-deletion",
    });

    expect(result.status).toBe("completed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].handler).toBe("db:profiles");
    expect(result.steps[1].handler).toBe("db:content");
  });

  it("returns partial status when some handlers fail", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("db:profiles", 10, 1));
    pipeline.register(createMockHandler("db:content", 20, 0, true));
    pipeline.register(createMockHandler("cache:entries", 30, 2));

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "admin-1",
      reason: "admin-action",
    });

    expect(result.status).toBe("partial");
    expect(result.steps[1].success).toBe(false);
    // R-77: the step says it failed; the handler's own text is logged.
    expect(result.steps[1].error).toBe("the call did not complete");
    expect(jest.requireMock("@/lib/logger").logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "db:content failed" })
    );
    // Other handlers still ran
    expect(result.steps[0].success).toBe(true);
    expect(result.steps[2].success).toBe(true);
    expect(result.totalDeleted).toBe(3);
  });

  it("returns failed status when all handlers fail", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 0, true));
    pipeline.register(createMockHandler("h2", 20, 0, true));

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });

    expect(result.status).toBe("failed");
    expect(result.totalDeleted).toBe(0);
  });

  it("stops on first error when continueOnError is false", async () => {
    const pipeline = new PurgePipeline({ continueOnError: false });
    const h3 = createMockHandler("third", 30, 10);

    pipeline.register(createMockHandler("first", 10, 1));
    pipeline.register(createMockHandler("second", 20, 0, true));
    pipeline.register(h3);

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "admin-1",
      reason: "legal-order",
    });

    expect(result.steps).toHaveLength(2); // Stopped after second
    expect(h3.execute).not.toHaveBeenCalled();
  });

  it("supports dry-run mode", async () => {
    const pipeline = new PurgePipeline();
    const handler = createMockHandler("db:profiles", 10, 5);
    pipeline.register(handler);

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "admin-1",
      reason: "user-request",
      dryRun: true,
    });

    expect(handler.execute).toHaveBeenCalledWith("user-1", true, expect.any(AbortSignal));
    expect(result.totalDeleted).toBe(0); // Dry run returns 0
    expect(result.status).toBe("completed");
  });

  it("prevents duplicate handler names", () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("db:profiles", 10, 1));

    expect(() => {
      pipeline.register(createMockHandler("db:profiles", 20, 2));
    }).toThrow("already registered");
  });

  it("fails, never reports completed, when no handlers are registered (X-15)", async () => {
    const pipeline = new PurgePipeline();
    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });

    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(0);
    expect(result.totalDeleted).toBe(0);
  });

  it("generates unique purge IDs", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 0));

    const r1 = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });
    const r2 = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });

    expect(r1.purgeId).not.toBe(r2.purgeId);
    expect(r1.purgeId).toMatch(/^purge_/);
  });

  it("records timestamps", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 1));

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });

    expect(result.requestedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
    expect(new Date(result.requestedAt!).getTime()).toBeGreaterThan(0);
  });

  it("records step durations", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 1));

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });

    expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("reports handler names via getHandlerNames", () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("alpha", 20, 0));
    pipeline.register(createMockHandler("beta", 10, 0));

    // Should be sorted by priority
    expect(pipeline.getHandlerNames()).toEqual(["beta", "alpha"]);
  });
});

describe("PurgePipeline — audit callback", () => {
  it("calls audit callback on completion", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 3));

    const auditEntries: PurgeAuditEntry[] = [];
    pipeline.onAudit(async (entry) => {
      auditEntries.push(entry);
    });

    await pipeline.execute({
      userId: "user-1",
      requestedBy: "admin-1",
      reason: "admin-action",
    });

    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0].user_id).toBe("user-1");
    expect(auditEntries[0].requested_by).toBe("admin-1");
    expect(auditEntries[0].reason).toBe("admin-action");
    expect(auditEntries[0].status).toBe("completed");
    expect(auditEntries[0].total_deleted).toBe(3);
  });

  it("does not call audit on dry run", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 3));

    const auditEntries: PurgeAuditEntry[] = [];
    pipeline.onAudit(async (entry) => {
      auditEntries.push(entry);
    });

    await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
      dryRun: true,
    });

    expect(auditEntries).toHaveLength(0);
  });

  it("does not fail if audit callback throws", async () => {
    const pipeline = new PurgePipeline();
    pipeline.register(createMockHandler("h1", 10, 1));

    const { logger } = jest.requireMock("@/lib/logger") as {
      logger: { error: jest.Mock };
    };
    pipeline.onAudit(async () => {
      throw new Error("Audit DB down");
    });

    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });

    // Purge still succeeded
    expect(result.status).toBe("completed");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Purge record not written"),
      expect.objectContaining({ error: "Audit DB down" })
    );
  });
});

describe("PurgePipeline — timeout (N-27)", () => {
  afterEach(() => jest.useRealTimers());

  it("a timed-out purge is indeterminate, not failed: the running handler may still finish", async () => {
    jest.useFakeTimers();
    const audit = jest.fn().mockResolvedValue(undefined);
    const pipeline = new PurgePipeline({ timeoutMs: 1000 });
    pipeline.onAudit(audit);
    let seen: AbortSignal | undefined;
    pipeline.register({
      name: "slow",
      priority: 10,
      execute: (_u, _d, signal) => {
        seen = signal;
        return new Promise((resolve) => setTimeout(() => resolve(7), 5000));
      },
    });
    const later = jest.fn().mockResolvedValue(1);
    pipeline.register({ name: "later", priority: 20, execute: later });

    const resultPromise = pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });
    await jest.advanceTimersByTimeAsync(1500);
    const result = await resultPromise;

    expect(result.status).toBe("indeterminate");
    expect(seen?.aborted).toBe(true);
    expect(result.steps.map((s) => [s.handler, s.error])).toEqual([
      [
        "slow",
        "Still running when the time limit ran out: whether it completed is not known",
      ],
      ["later", "Not started: the time limit ran out"],
    ]);
    // The record says the same.
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "indeterminate" })
    );
    const returned = JSON.stringify(result);

    // The slow handler finishes after the result was returned: nothing returned changes, and no
    // further handler starts.
    await jest.advanceTimersByTimeAsync(5000);
    expect(JSON.stringify(result)).toBe(returned);
    expect(later).not.toHaveBeenCalled();
  });

  it("a purge that finishes in time is judged by its steps, with the signal never aborted", async () => {
    let seen: AbortSignal | undefined;
    const pipeline = new PurgePipeline({ timeoutMs: 1000 });
    pipeline.register({
      name: "fast",
      priority: 10,
      execute: async (_u, _d, signal) => {
        seen = signal;
        return 2;
      },
    });
    const result = await pipeline.execute({
      userId: "user-1",
      requestedBy: "self",
      reason: "user-request",
    });
    expect(result.status).toBe("completed");
    expect(seen?.aborted).toBe(false);
  });
});
