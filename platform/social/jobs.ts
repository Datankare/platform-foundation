/**
 * platform/social/jobs.ts — the social module's scheduled agents (ADR-056 D3, ADR-054 D4)
 *
 * The analyst (group health) and curator (activity digests) agents were documented as scheduled
 * but had no schedule (TASK-141). Each is now a recurring job the module contributes, run for every active
 * tenant in that tenant's context:
 *
 *   - a tenant's administrators may turn both off for their tenant
 *     (social.scheduled_agents_enabled, tenant settable — migration 051);
 *   - every agent run goes through executeAgent, so each agent's governed budgets bind
 *     (ADR-048): a run the budget pauses ends the job's work for this slot, and the next slot
 *     tries again — the job never spends past a cap;
 *   - groups are walked a page at a time; work that does not fit in one attempt continues in a
 *     next part (a cursor), so no attempt runs past its time.
 *
 * What a run produces is recorded in the agent's trajectory (the health report, the digest):
 * delivering digests to members waits for group participation (TASK-108).
 *
 * @module platform/social
 */

import { executeAgent } from "@/platform/agents/runtime";
import { getOrchestrator } from "@/platform/ai/orchestrator";
import type { JobContext, JobDefinition, JobResult } from "@/platform/jobs/types";
import { createAnalystWorkflow } from "./agents/analyst";
import { createCuratorWorkflow } from "./agents/curator";
import { getSocialStore } from "./store";
import type { Group, Membership } from "./types";

/** The tenant setting that turns the scheduled agents off for a tenant (migration 051). */
export const SCHEDULED_AGENTS_KEY = "social.scheduled_agents_enabled";

/** Groups read per page. */
export const GROUP_PAGE = 20;
/** Left at the end of an attempt: an agent run is not started with less than this. */
const RUN_MARGIN_MS = 8_000;
const DAY_MS = 24 * 60 * 60_000;

/** A count of what changed in the window — membership is the only activity there is yet. */
function joinedSince(members: readonly Membership[], since: number): number {
  return members.filter((m) => new Date(m.joinedAt).getTime() >= since).length;
}

type GroupRun = (group: Group, ctx: JobContext) => Promise<"done" | "budget">;

/**
 * Walk the tenant's active groups from the cursor in the payload, running `perGroup` on each
 * while time is left. Stops at a budget pause (no continuation: the next slot retries), and
 * continues in a next part when time or the page runs out.
 */
async function walkGroups(ctx: JobContext, perGroup: GroupRun): Promise<JobResult> {
  const after = typeof ctx.payload.after === "string" ? ctx.payload.after : undefined;
  const groups = await getSocialStore().listActiveGroups({ after, limit: GROUP_PAGE });
  let done = 0;
  let last: string | undefined;
  for (const group of groups) {
    if (ctx.signal.aborted || Date.now() > ctx.deadline - RUN_MARGIN_MS) {
      return {
        summary: { groups: done, more: true },
        continueWith: { after: last ?? after },
      };
    }
    if ((await perGroup(group, ctx)) === "budget") {
      return { summary: { groups: done, budgetExhausted: true } };
    }
    done++;
    last = group.id;
  }
  return groups.length === GROUP_PAGE
    ? { summary: { groups: done, more: true }, continueWith: { after: last } }
    : { summary: { groups: done } };
}

const analyzeGroup: GroupRun = async (group) => {
  const members = await getSocialStore().getMembers(group.id);
  const now = Date.now();
  const { workflow } = createAnalystWorkflow(
    {
      groupName: group.name,
      memberCount: members.length,
      recentActivitySummary:
        `${members.length} active members; ${joinedSince(members, now - 7 * DAY_MS)} joined ` +
        `in the last 7 days; created ${group.createdAt.slice(0, 10)}.`,
    },
    getOrchestrator()
  );
  const run = await executeAgent(
    "analyst",
    "schedule:social.analyst",
    "group",
    group.id,
    workflow
  );
  return run.finalStatus === "paused" ? "budget" : "done";
};

const curateGroup: GroupRun = async (group) => {
  const members = await getSocialStore().getMembers(group.id);
  const joined = joinedSince(members, Date.now() - DAY_MS);
  // Nothing happened: the curator's first step ends the run without a model call.
  const recentActivity =
    joined > 0 ? [`${joined} new member(s) joined in the last day.`] : [];
  const { workflow } = createCuratorWorkflow(
    // Addressed to the group's owner: the one member a digest can be delivered to before
    // TASK-108 defines participation.
    { groupName: group.name, userId: group.ownerId, recentActivity },
    getOrchestrator()
  );
  const run = await executeAgent(
    "curator",
    "schedule:social.curator",
    "group",
    group.id,
    workflow
  );
  return run.finalStatus === "paused" ? "budget" : "done";
};

export const SOCIAL_JOBS: readonly JobDefinition[] = Object.freeze([
  {
    kind: "social.analyst",
    description:
      "Runs the analyst agent over the tenant's groups (group health reports).",
    timeoutMs: 40_000,
    maxAttempts: 3,
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 10080,
      tenantOptOutKey: SCHEDULED_AGENTS_KEY,
    },
    handler: (ctx) => runAnalyst(ctx),
  },
  {
    kind: "social.curator",
    description: "Runs the curator agent over the tenant's groups (activity digests).",
    timeoutMs: 40_000,
    maxAttempts: 3,
    schedule: {
      scope: "each-tenant",
      defaultIntervalMinutes: 1440,
      minIntervalMinutes: 60,
      maxIntervalMinutes: 10080,
      tenantOptOutKey: SCHEDULED_AGENTS_KEY,
    },
    handler: (ctx) => runCurator(ctx),
  },
] satisfies JobDefinition[]);

/**
 * The analyst over every active group of the current tenant, a page at a time.
 *
 * @scheduled social.analyst
 */
export function runAnalyst(ctx: JobContext): Promise<JobResult> {
  return walkGroups(ctx, analyzeGroup);
}

/**
 * The curator over every active group of the current tenant, a page at a time.
 *
 * @scheduled social.curator
 */
export function runCurator(ctx: JobContext): Promise<JobResult> {
  return walkGroups(ctx, curateGroup);
}
