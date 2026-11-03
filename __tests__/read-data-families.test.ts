/**
 * __tests__/read-data-families.test.ts — a route returns a kind of data only under the permission
 * of the page that owns it (TASK-194, audit C-10)
 *
 * @guard a route returning a kind of data without the permission of the page that owns it
 *
 * GET /api/admin/tenant (can_access_admin) returned the tenant-settable config values that
 * /api/admin/config requires config_view for, and the tenant's job errors; GET
 * /api/admin/capabilities (admin_view_audit) returned the provider plumbing C-21 hid from
 * /api/agent/capabilities. Each panel had been judged on its own. Here the data families are
 * named by the function that reads them, with the permission of the page that owns them; every
 * route method that calls one must hold that permission — its guard requires it, or the method
 * checks it with holds() before including the data — or pass the data through the function that
 * strips it to what everyone may see. Operators (platform_operate) read every tenant's families
 * in the operator console by design.
 */

import { readFileSync } from "node:fs";
import { apiRoutes } from "./helpers/route-policy";
import { routeMethods } from "./helpers/route-methods";

interface Family {
  readonly source: string;
  readonly permission: string;
  /** A function whose output is the family stripped to what any caller may see. */
  readonly strippedBy?: string;
  readonly owner: string;
}

const FAMILIES: readonly Family[] = [
  {
    source: "listEnhancedConfig",
    permission: "config_view",
    owner: "the Platform config page (GET /api/admin/config)",
  },
  {
    source: "listTenantJobHistory",
    permission: "config_view",
    owner: "the tenant's settings and jobs (their errors name the platform's internals)",
  },
  {
    source: "getActiveProviders",
    permission: "platform_operate",
    strippedBy: "capabilitySelections",
    owner: "the operators' view of the platform's plumbing (audit C-21)",
  },
];

const OPERATOR = "platform_operate";

/** The permission a method's guard requires, from its file's literal or same-file constant. */
function guardPermissions(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(
    /\b(?:requireAdmin|adminGuard)\(\s*request\s*,\s*(?:"([a-z_]+)"|([A-Za-z_]\w*))/g
  )) {
    if (m[1]) out.push(m[1]);
    else {
      const c = src.match(new RegExp(`const\\s+${m[2]}\\s*=\\s*"([a-z_]+)"`));
      if (c) out.push(c[1]);
    }
  }
  return out;
}

/** Each method's own text: from its `export const METHOD` to the next one. */
function methodTexts(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const starts = [
    ...src.matchAll(
      /export\s+(?:const|async\s+function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
    ),
  ];
  starts.forEach((m, i) => {
    out[m[1]] = src.slice(m.index, starts[i + 1]?.index ?? src.length);
  });
  return out;
}

/** The family reads of one route file without their owner's permission; counts each read. */
function familyFindings(file: string, src: string, count: { reads: number }): string[] {
  const findings: string[] = [];
  const texts = methodTexts(src);
  for (const m of routeMethods(src, file)) {
    const text = texts[m.method] ?? "";
    const guarded = guardPermissions(text);
    for (const f of FAMILIES) {
      if (!m.calls.includes(f.source)) continue;
      count.reads += 1;
      const ok =
        guarded.includes(f.permission) ||
        guarded.includes(OPERATOR) ||
        new RegExp(`\\bholds\\(\\s*[\\w.]+\\s*,\\s*"${f.permission}"`).test(text) ||
        (f.strippedBy !== undefined && m.calls.includes(f.strippedBy));
      if (!ok)
        findings.push(
          `${file} ${m.method}: ${f.source} needs ${f.permission} (${f.owner})`
        );
    }
  }
  return findings;
}

describe("each data family only under its owning page's permission (TASK-194, C-10)", () => {
  const count = { reads: 0 };
  const findings = apiRoutes().flatMap((file) =>
    familyFindings(file, readFileSync(file, "utf8"), count)
  );

  it("finds the routes that read the families (self-test)", () => {
    expect(count.reads).toBeGreaterThan(4);
  });

  it("[self-test] reports a planted route that returns a family under another permission", () => {
    const planted = [
      "export async function GET(request: Request) {",
      '  const g = await requireAdmin(request, "users_view");',
      "  return Response.json(await listEnhancedConfig());",
      "}",
      "export async function POST(request: Request) {",
      '  const g = await requireAdmin(request, "config_view");',
      "  return Response.json(await listEnhancedConfig());",
      "}",
    ].join("\n");
    expect(familyFindings("app/api/planted/route.ts", planted, { reads: 0 })).toEqual([
      "app/api/planted/route.ts GET: listEnhancedConfig needs config_view (the Platform config page (GET /api/admin/config))",
    ]);
  });

  it("no route returns a family without its owner's permission", () => {
    expect(findings).toEqual([]);
  });
});
