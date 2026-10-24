/**
 * __tests__/helpers/moderation-isolation-fixtures.ts — tenant isolation fixtures for the
 * moderation and social stores (ADR-053 D8)
 *
 * One fixture set per store interface, run by runTenantIsolationContract against both the
 * in-memory store (memory tenants) and the Postgres store (database tenants). Records that must
 * name a user take one from `userFor()` — any string in memory, a real user of the current
 * tenant in the database (foreign keys). Each fixture remembers the ids a key was written with
 * and every user it used, so a read under tenant B really looks for A's records (by A's ids and
 * A's user) and the "B cannot change A's record" arm really aims at A's record.
 */

import { randomUUID } from "node:crypto";
import type { IsolationTenant } from "../contract/tenant-isolation-contract";
import { runWithTenant } from "@/platform/tenancy/context";
import type {
  ModerationAuditRecord,
  ModerationStore,
  StrikeStore,
} from "@/platform/moderation/types";
import type { ReviewQueueStore } from "@/platform/moderation/review-types";
import type { SocialStore } from "@/platform/social/types";

/** A tenant for in-memory stores: a fresh random tenant id, no database. */
export async function memoryTenant(): Promise<IsolationTenant> {
  const ctx = { tenantId: randomUUID(), mode: "shared" as const };
  return { run: (fn) => runWithTenant(ctx, fn) };
}

/** For in-memory stores: one fixed user id serves every tenant. */
export const memoryUser = async (): Promise<string> =>
  "00000000-0000-4000-8000-00000000150a";

function remember(map: Map<string, string[]>, key: string, id: string): void {
  map.set(key, [...(map.get(key) ?? []), id]);
}

/** At least one id, so the store is always asked (an unknown one when none is known yet). */
const orUnknown = (ids: Iterable<string>): string[] => {
  const list = [...ids];
  return list.length > 0 ? list : [randomUUID()];
};

export function moderationAuditIsolation() {
  const record = (key: string): ModerationAuditRecord => ({
    inputHash: key,
    direction: "input",
    contentType: "generation",
    contentRatingLevel: 1,
    userId: "iso-user",
    triggeredBy: "none",
    categoriesFlagged: [],
    confidence: 1,
    severity: "low",
    actionTaken: "allow",
    reasoning: "isolation",
    severityAdjustment: 0,
    contextFactors: [],
    attributeToUser: true,
    classifierCostUsd: 0,
    trajectoryId: "iso-traj",
    agentId: "iso-agent",
    pipelineLatencyMs: 0,
    requestId: key,
    timestamp: new Date().toISOString(),
  });
  return {
    write: async (s: ModerationStore, key: string) => s.logAudit(record(key)),
    read: async (s: ModerationStore, key: string) => {
      const found = await s.getByInputHash(key);
      return found.length > 0 ? found : null;
    },
  };
}

export function strikeIsolation(userFor: () => Promise<string>) {
  const ids = new Map<string, string[]>();
  const users = new Set<string>();
  const expireAll = async (s: StrikeStore, key: string) => {
    for (const id of orUnknown(ids.get(key) ?? [])) await s.expireStrike(id);
  };
  return {
    write: async (s: StrikeStore, key: string) => {
      const userId = await userFor();
      users.add(userId);
      const res = await s.recordStrike({
        userId,
        category: "harassment",
        severity: "medium",
        moderationAuditId: null,
        guardianDecisionId: key,
        trajectoryId: "iso-traj",
        agentId: "sentinel",
        reason: key,
        expiresAt: null,
        expired: false,
      });
      if (!res.success || !res.record)
        throw new Error(res.error ?? "strike not recorded");
      remember(ids, key, res.record.id);
    },
    read: async (s: StrikeStore, key: string) => {
      for (const userId of orUnknown(users)) {
        const hit = (await s.getActiveStrikes(userId)).find((r) => r.reason === key);
        if (hit) return hit;
      }
      return null;
    },
    update: expireAll,
    remove: expireAll,
  };
}

export function reviewQueueIsolation(userFor: () => Promise<string>) {
  const ids = new Map<string, string[]>();
  return {
    write: async (s: ReviewQueueStore, key: string) => {
      const res = await s.submit({
        source: "escalation",
        priority: "high",
        status: "pending",
        moderationResult: {
          action: "escalate",
          triggeredBy: "classifier",
          direction: "input",
          contentType: "generation",
          contentRatingLevel: 1,
          blocklistMatches: [],
          reasoning: "isolation",
          severityAdjustment: 0,
          contextFactors: [],
          attributeToUser: true,
          pipelineLatencyMs: 1,
          classifierCostUsd: 0,
          trajectoryId: key,
          agentId: "guardian",
        },
        targetUserId: await userFor(),
        requestId: key,
      });
      if (!res.success || !res.item) throw new Error(res.error ?? "item not submitted");
      remember(ids, key, res.item.id);
    },
    read: async (s: ReviewQueueStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? [])) {
        const hit = await s.getById(id);
        if (hit) return hit;
      }
      return null;
    },
    update: async (s: ReviewQueueStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? [])) {
        await s.update(id, {
          status: "claimed",
          claimedBy: "intruder",
          claimedAt: new Date().toISOString(),
        });
      }
    },
  };
}

export function socialIsolation(userFor: () => Promise<string>) {
  const ids = new Map<string, string[]>();
  return {
    write: async (s: SocialStore, key: string) => {
      const res = await s.createGroup({
        name: key,
        description: "isolation",
        ownerId: await userFor(),
      });
      if (!res.success || !res.group) throw new Error(res.error ?? "group not created");
      remember(ids, key, res.group.id);
    },
    read: async (s: SocialStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? [])) {
        const hit = await s.getGroupById(id);
        if (hit && hit.status === "active") return hit;
      }
      return null;
    },
    update: async (s: SocialStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? []))
        await s.updateGroupStatus(id, "suspended");
    },
    // A group is never deleted; archiving takes it out of use.
    remove: async (s: SocialStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? []))
        await s.updateGroupStatus(id, "archived");
    },
  };
}
