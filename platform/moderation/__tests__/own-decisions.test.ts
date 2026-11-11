/**
 * platform/moderation/__tests__/own-decisions.test.ts — a user's own decisions and their appeals
 * (TASK-210, N-117: what the account page lists, so a user can find the decision they appeal)
 *
 * listOwnDecisions on the real in-memory stores: only the caller's own blocks of their input,
 * newest first, each with its appeal; never another account's row, however a store spells an id;
 * the appeal read past its limit asked decision by decision; the window and the reason limits.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

const mockConfig: Record<string, unknown> = {};
jest.mock("@/platform/auth/platform-config", () => ({
  getConfig: jest.fn((key: string, fallback: unknown) =>
    Promise.resolve(key in mockConfig ? mockConfig[key] : fallback)
  ),
}));

import {
  InMemoryReviewQueueStore,
  resetReviewQueueStore,
  setReviewQueueStore,
} from "../review-store";
import {
  InMemoryModerationStore,
  resetModerationStore,
  setModerationStore,
} from "../store";
import {
  listOwnDecisions,
  MAX_APPEAL_REASON_CHARS,
  OWN_DECISIONS_LIMIT,
} from "../review-service";
import type { ModerationAuditRecord, ModerationResult } from "../types";
import type { ReviewQueueItem } from "../review-types";

const ME = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";

function audit(over: Partial<ModerationAuditRecord>): ModerationAuditRecord {
  return {
    inputHash: "0".repeat(64),
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    userId: ME,
    triggeredBy: "blocklist",
    categoriesFlagged: ["dangerous"],
    confidence: 1,
    severity: "critical",
    actionTaken: "block",
    reasoning: [],
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    classifierCostUsd: 0,
    trajectoryId: "traj-x",
    agentId: "guardian",
    pipelineLatencyMs: 1,
    requestId: "req",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...over,
  } as ModerationAuditRecord;
}

let moderation: InMemoryModerationStore;
let queue: InMemoryReviewQueueStore;

beforeEach(() => {
  for (const k of Object.keys(mockConfig)) delete mockConfig[k];
  moderation = new InMemoryModerationStore();
  queue = new InMemoryReviewQueueStore();
  setModerationStore(moderation);
  setReviewQueueStore(queue);
});
afterAll(() => {
  resetModerationStore();
  resetReviewQueueStore();
});

async function appealOf(trajectoryId: string, user = ME): Promise<ReviewQueueItem> {
  const r = await queue.submit({
    source: "appeal",
    priority: "normal",
    status: "pending",
    moderationResult: { action: "block", trajectoryId } as ModerationResult,
    targetUserId: user,
    requestId: "req",
    appealReason: "A reason long enough to be an appeal.",
    originalDecisionId: trajectoryId,
  });
  return r.item!;
}

describe("listOwnDecisions (TASK-210)", () => {
  it("lists only the caller's own blocks of their input, newest first, with the window", async () => {
    await moderation.logAudit(
      audit({ trajectoryId: "old", timestamp: "2026-01-01T00:00:00.000Z" })
    );
    await moderation.logAudit(
      audit({ trajectoryId: "new", timestamp: "2026-01-02T00:00:00.000Z" })
    );
    await moderation.logAudit(audit({ trajectoryId: "warned", actionTaken: "warn" }));
    await moderation.logAudit(audit({ trajectoryId: "model", direction: "output" }));
    await moderation.logAudit(audit({ trajectoryId: "theirs", userId: OTHER }));
    const own = await listOwnDecisions(ME);
    expect(own.decisions.map((d) => d.id)).toEqual(["new", "old"]);
    expect(own.decisions[1]).toEqual({
      id: "old",
      decidedAt: "2026-01-01T00:00:00.000Z",
      contentType: "generation",
      appealableUntil: "2026-01-04T00:00:00.000Z",
      appeal: null,
    });
    expect(own).toMatchObject({
      appealWindowHours: 72,
      minReasonLength: 20,
      maxReasonLength: MAX_APPEAL_REASON_CHARS,
    });
  });

  it("the window and the reason's minimum are the platform's settings", async () => {
    mockConfig["moderation.appeal_window_hours"] = 24;
    mockConfig["moderation.appeal_reason_min_length"] = 40;
    await moderation.logAudit(audit({ trajectoryId: "t" }));
    const own = await listOwnDecisions(ME);
    expect(own.decisions[0].appealableUntil).toBe("2026-01-02T00:00:00.000Z");
    expect(own).toMatchObject({ appealWindowHours: 24, minReasonLength: 40 });
  });

  it("each decision carries its own appeal: where it stands, and its outcome once resolved", async () => {
    await moderation.logAudit(
      audit({ trajectoryId: "a", timestamp: "2026-01-01T00:00:00.000Z" })
    );
    await moderation.logAudit(
      audit({ trajectoryId: "b", timestamp: "2026-01-01T01:00:00.000Z" })
    );
    const appeal = await appealOf("a");
    await queue.update(appeal.id, {
      status: "resolved",
      decision: "modify",
      modifiedAction: "warn",
      resolvedAt: "2026-01-02T00:00:00.000Z",
    } as never);
    const own = await listOwnDecisions(ME);
    const byId = Object.fromEntries(own.decisions.map((d) => [d.id, d]));
    expect(byId.b.appeal).toBeNull();
    expect(byId.a.appeal).toEqual({
      status: "resolved",
      submittedAt: appeal.createdAt,
      decision: "modify",
      modifiedAction: "warn",
      resolvedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("[hostile:self] another account's appeal of a decision with the same id is never shown as mine", async () => {
    await moderation.logAudit(audit({ trajectoryId: "shared" }));
    await appealOf("shared", OTHER);
    const own = await listOwnDecisions(ME);
    expect(own.decisions[0].appeal).toBeNull();
  });

  it("[hostile:id-spelling] a row whose id a store spells in capitals is the same account; another is not", async () => {
    const spelled = {
      queryAudits: jest.fn(async () => [
        audit({ trajectoryId: "mine", userId: ME.toUpperCase() }),
        audit({ trajectoryId: "theirs", userId: OTHER }),
      ]),
    };
    setModerationStore(spelled as never);
    const own = await listOwnDecisions(ME);
    expect(own.decisions.map((d) => d.id)).toEqual(["mine"]);
    expect(spelled.queryAudits).toHaveBeenCalledWith({
      userId: ME,
      actionTaken: "block",
      direction: "input",
      limit: OWN_DECISIONS_LIMIT,
    });
  });

  it("[hostile:store-down] a store that cannot be read throws (the route answers 503)", async () => {
    setModerationStore({
      queryAudits: async () => {
        throw new Error("down");
      },
    } as never);
    await expect(listOwnDecisions(ME)).rejects.toThrow("down");
  });

  it("an appeal read cut at its limit: each listed decision without one is asked alone", async () => {
    await moderation.logAudit(audit({ trajectoryId: "late" }));
    const late = await appealOf("late");
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...late,
      id: `other-${i}`,
      originalDecisionId: `elsewhere-${i}`,
    }));
    jest.spyOn(queue, "query").mockResolvedValueOnce(many);
    const ask = jest.spyOn(queue, "getByOriginalDecisionId");
    const own = await listOwnDecisions(ME);
    expect(ask).toHaveBeenCalledWith("late");
    expect(own.decisions[0].appeal?.status).toBe("pending");
  });

  it("nothing blocked: no decision, and the appeals are not read", async () => {
    const read = jest.spyOn(queue, "query");
    expect((await listOwnDecisions(ME)).decisions).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
