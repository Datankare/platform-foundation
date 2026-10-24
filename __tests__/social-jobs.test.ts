/**
 * @jest-environment node
 */
/**
 * The social module's scheduled agents (platform/social/jobs.ts, ADR-056 D3): each walks the
 * tenant's active groups a page at a time, runs its agent through executeAgent (so the governed
 * budgets bind), stops at a budget pause, continues in a next part when time or the page runs
 * out, and is turned off for a tenant by social.scheduled_agents_enabled (the runner reads it).
 */

jest.mock("@/platform/agents/runtime", () => ({ executeAgent: jest.fn() }));
jest.mock("@/platform/ai/orchestrator", () => ({ getOrchestrator: () => ({}) }));

import { executeAgent } from "@/platform/agents/runtime";
import {
  GROUP_PAGE,
  SCHEDULED_AGENTS_KEY,
  SOCIAL_JOBS,
  runAnalyst,
  runCurator,
} from "@/platform/social/jobs";
import { InMemorySocialStore } from "@/platform/social/memory-social-store";
import { resetSocialStore, setSocialStore } from "@/platform/social/store";
import { SOCIAL_MODULE } from "@/platform/social/module";
import { runWithTenant } from "@/platform/tenancy/context";
import type { JobContext } from "@/platform/jobs/types";

const T = { tenantId: "aaaaaaaa-0000-4000-8000-00000000000a", mode: "shared" as const };
const exec = executeAgent as jest.Mock;
let store: InMemorySocialStore;

const ctx = (over: Partial<JobContext> = {}): JobContext =>
  ({
    jobId: "j",
    kind: "social.analyst",
    tenantId: T.tenantId,
    payload: {},
    attempt: 1,
    maxAttempts: 3,
    source: "schedule",
    signal: new AbortController().signal,
    deadline: Date.now() + 60_000,
    agent: "job:social.analyst",
    ...over,
  }) as JobContext;

async function groups(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await runWithTenant(T, () =>
      store.createGroup({ name: `G${i}`, description: "", ownerId: `owner-${i}` })
    );
    ids.push(r.group!.id);
  }
  return ids.sort();
}

beforeEach(() => {
  exec.mockReset();
  exec.mockResolvedValue({ success: true, finalStatus: "completed", trajectoryId: "t" });
  store = new InMemorySocialStore();
  setSocialStore(store);
});
afterAll(() => resetSocialStore());

describe("social jobs", () => {
  it("are the module's, recurring per tenant, with the tenant opt-out", () => {
    expect(SOCIAL_MODULE.jobs.map((j) => j.kind)).toEqual([
      "social.analyst",
      "social.curator",
    ]);
    for (const j of SOCIAL_JOBS) {
      expect(j.schedule).toMatchObject({
        scope: "each-tenant",
        tenantOptOutKey: SCHEDULED_AGENTS_KEY,
      });
    }
  });

  it("the analyst runs the analyst agent on every active group, as the group's scope", async () => {
    const ids = await groups(3);
    const r = await runWithTenant(T, () => runAnalyst(ctx()));
    expect(r).toEqual({ summary: { groups: 3 } });
    expect(exec.mock.calls.map((c) => [c[0], c[2], c[3]])).toEqual(
      ids.map((id) => ["analyst", "group", id])
    );
  });

  it("the curator runs the curator agent on every active group", async () => {
    await groups(2);
    const r = await runWithTenant(T, () => runCurator(ctx({ kind: "social.curator" })));
    expect(r).toEqual({ summary: { groups: 2 } });
    expect(exec.mock.calls.every((c) => c[0] === "curator")).toBe(true);
  });

  it("stops at a budget pause, with no next part (the next slot tries again)", async () => {
    await groups(3);
    exec.mockResolvedValueOnce({ success: true, finalStatus: "completed" });
    exec.mockResolvedValueOnce({
      success: false,
      finalStatus: "paused",
      error: "budget",
    });
    const r = await runWithTenant(T, () => runAnalyst(ctx()));
    expect(r).toEqual({ summary: { groups: 1, budgetExhausted: true } });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("continues after a full page from the last group", async () => {
    const ids = await groups(GROUP_PAGE + 2);
    const first = await runWithTenant(T, () => runAnalyst(ctx()));
    expect(first.continueWith).toEqual({ after: ids[GROUP_PAGE - 1] });
    const second = await runWithTenant(T, () =>
      runAnalyst(ctx({ payload: first.continueWith! }))
    );
    expect(second).toEqual({ summary: { groups: 2 } });
    expect(exec).toHaveBeenCalledTimes(GROUP_PAGE + 2);
  });

  it("does not start a run it has no time for, and continues from there", async () => {
    const ids = await groups(3);
    const r = await runWithTenant(T, () =>
      runAnalyst(ctx({ deadline: Date.now() + 1_000 }))
    );
    expect(exec).not.toHaveBeenCalled();
    expect(r).toEqual({
      summary: { groups: 0, more: true },
      continueWith: { after: undefined },
    });
    const aborted = new AbortController();
    aborted.abort();
    const r2 = await runWithTenant(T, () =>
      runAnalyst(ctx({ signal: aborted.signal, payload: { after: ids[0] } }))
    );
    expect(r2.continueWith).toEqual({ after: ids[0] });
  });

  it("leaves out archived groups", async () => {
    const ids = await groups(2);
    await runWithTenant(T, () => store.updateGroupStatus(ids[0], "archived"));
    await runWithTenant(T, () => runCurator(ctx()));
    expect(exec.mock.calls.map((c) => c[3])).toEqual([ids[1]]);
  });
});
