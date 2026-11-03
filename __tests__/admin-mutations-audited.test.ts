/**
 * __tests__/admin-mutations-audited.test.ts — every staff change knows who made it, and records it
 * (TASK-194, audit C-9)
 *
 * POST /api/moderation/review filed an escalation behind adminGuard, which throws the verified
 * identity away, and wrote no audit record: a moderator's made-up escalation, whose reasoning
 * text then steered the reviewer-assist model shown to another moderator, named no one. Every
 * non-GET method of a staff route (one that calls requireAdmin or adminGuard) must:
 *
 *   - use requireAdmin — adminGuard answers only allow/refuse, so the method cannot know who acts;
 *   - reach an audit writer (audited, auditedResponse, runAudited, recordAudit, recordAuthEvent,
 *     writeAuditLog), through any production function it calls (helpers/call-graph.ts) — or be
 *     listed below as changing nothing, with the reason.
 */

import { readFileSync } from "node:fs";
import { apiRoutes } from "./helpers/route-policy";
import { routeMethods } from "./helpers/route-methods";
import { buildCallGraph, reaching } from "./helpers/call-graph";

const AUDIT_WRITERS = [
  "audited",
  "auditedResponse",
  "runAudited",
  "recordAudit",
  "recordAuthEvent",
  "writeAuditLog",
];

/** Guards and wrappers every staff method calls: never counted as the method's own record. */
const OPAQUE = [
  "requireAdmin",
  "adminGuard",
  "requireAuth",
  "requireActor",
  "requireActorWithStatus",
  "tenantRoute",
  "enforceRateLimit",
];

/** Staff non-GET methods that record nothing, and why. */
const NO_RECORD: Readonly<Record<string, string>> = {
  "app/api/admin/ai/route.ts POST":
    "Plans only: the command bar's planner proposes actions for the admin to confirm; nothing changes until /api/admin/ai/execute runs them, each recorded.",
  "app/api/admin/config-ai/route.ts POST":
    "Answers only: the config assistant's reply; a change it suggests is made through /api/admin/config-ai/execute, recorded.",
  "app/api/moderation/review/[id]/assist/route.ts POST":
    "Advises only: the reviewer-assist recommendation for an item; the moderator's decision is made and recorded through /api/moderation/review/[id].",
  "app/api/operator/tenants/[id]/state/route.ts POST":
    "Dispatches through its ACTIONS table (suspendTenant, resumeTenant, restoreTenant), which this name-based scan does not follow; each records through recorded() — checked below.",
};

const GRAPH = buildCallGraph();
const RECORDS = reaching(GRAPH, AUDIT_WRITERS, OPAQUE);

const STAFF: { route: string; method: string; calls: readonly string[] }[] = [];
for (const file of apiRoutes()) {
  for (const m of routeMethods(readFileSync(file, "utf8"), file)) {
    if (m.method === "GET") continue;
    if (m.calls.includes("requireAdmin") || m.calls.includes("adminGuard"))
      STAFF.push({ route: `${file} ${m.method}`, method: m.method, calls: m.calls });
  }
}

describe("staff changes name their actor and are recorded (TASK-194, C-9)", () => {
  it("finds the staff methods and the writers (self-test)", () => {
    expect(STAFF.length).toBeGreaterThan(30);
    expect(RECORDS.has("decideApproval")).toBe(true);
    expect(RECORDS.has("suspendTenant")).toBe(true);
  });

  it("no staff change uses adminGuard: the method must know who acts", () => {
    expect(
      STAFF.filter((s) => s.calls.includes("adminGuard")).map((s) => s.route)
    ).toEqual([]);
  });

  it("every staff change reaches an audit writer, or is listed as changing nothing", () => {
    const unrecorded = STAFF.filter(
      (s) => !NO_RECORD[s.route] && !s.calls.some((c) => RECORDS.has(c))
    ).map((s) => s.route);
    expect(unrecorded).toEqual([]);
  });

  it("lists only staff methods that exist and record nothing, each with its reason", () => {
    for (const [route, why] of Object.entries(NO_RECORD)) {
      const s = STAFF.find((x) => x.route === route);
      expect({ route, found: !!s, why: why.length > 40 }).toEqual({
        route,
        found: true,
        why: true,
      });
    }
    // The table-dispatched operator actions do record.
    for (const fn of ["suspendTenant", "resumeTenant", "restoreTenant"])
      expect({ fn, records: RECORDS.has(fn) }).toEqual({ fn, records: true });
  });
});
