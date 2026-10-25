/**
 * @jest-environment node
 */
/**
 * __tests__/data-sql-hygiene.test.ts — data access stays inside its rules (ADR-053 D4)
 *
 *  1. Only platform/data talks to the Postgres driver.
 *  2. Only platform/data sets the tenant (app.tenant_id); a stray set_config elsewhere could put a
 *     transaction in another tenant (__tests__/db proves that the setting is what isolates).
 *  3. SQL text is never built from values: no template literal with a substitution, and no string
 *     concatenation, is passed to tx.query. Values go in as parameters.
 *  4. The owner connection (outside row-level security) is used only from the files listed here,
 *     each for a named purpose.
 */

import { productionSources, read } from "./helpers/route-policy";

const SOURCES = productionSources();
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** Files allowed to open owner transactions, and why. A new one is a reviewed change. */
const OWNER_CALLERS: Readonly<Record<string, string>> = {
  "platform/data/tx.ts": "defines it",
  "platform/data/index.ts": "re-exports it",
  "platform/tenancy/postgres-directory.ts":
    "the tenant directory: listing and managing tenants is an operator's (ADR-053 D7)",
  "platform/tenancy/admin.ts":
    "operating tenants: provisioning, addresses, state, deletion, purge, export (ADR-053 D7)",
  "platform/tenancy/identity.ts":
    "an identity's existing account, in whichever tenant holds it, before assigning its tenant (ADR-053 D2)",
  "platform/auth/platform-config.ts":
    "platform defaults (single-tenant administrators, operators) and operator-set tenant values (ADR-053 D5)",
  "app/api/admin/ai/handlers/shared.ts":
    "command-bar changes to the shared role and entitlement catalog, after mayChangePlatformCatalog (ADR-053 D5)",
  "app/api/admin/entitlements/route.ts":
    "turning a shared entitlement group on or off, after mayChangePlatformCatalog (ADR-053 D5)",
  "platform/admin/config-approval.ts":
    "the config.expire-approvals platform job: expiring stale approvals across tenants (TASK-036, ADR-056 D3)",
  "platform/admin/hold-withdrawal.ts":
    "a platform-scope reduction's withdrawal: finding the tenants holding platform-scope holds of the key, ids only — the withdrawal then runs as each tenant (review 14 L-4)",
  "platform/jobs/postgres-store.ts":
    "the job runner: claiming, settling and scheduling every tenant's jobs; operators' cross-tenant job views (ADR-056 D2)",
};

/** .query(`…${…}…`  or  .query("…" + x  or  .query(x + "…" — SQL text built from values. */
const SQL_FROM_VALUES =
  /\.query(?:\s*<[^>]*>)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+|[\w.]+\s*\+)/;

describe("data access hygiene (ADR-053 D4)", () => {
  it("finds the sources (self-test)", () => {
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it("only platform/data imports the Postgres driver", () => {
    const offenders = SOURCES.filter(
      (f) =>
        !f.startsWith("platform/data/") &&
        /from\s+["']pg["']|require\(["']pg["']\)/.test(read(f))
    );
    expect(offenders).toEqual([]);
  });

  it("only platform/data sets app.tenant_id", () => {
    const offenders = SOURCES.filter(
      (f) => f !== "platform/data/tx.ts" && /app\.tenant_id/.test(strip(read(f)))
    );
    expect(offenders).toEqual([]);
  });

  it("never builds SQL text from values", () => {
    const hits: string[] = [];
    for (const f of SOURCES) {
      const src = strip(read(f));
      for (const m of src.matchAll(new RegExp(SQL_FROM_VALUES, "g")))
        hits.push(`${f}: ${m[0]}`);
    }
    expect(hits).toEqual([]);
  });

  it("opens owner transactions only from the listed files", () => {
    const offenders = SOURCES.filter(
      (f) =>
        !(f in OWNER_CALLERS) && /\bwithOwner(?:Tx|Snapshot)\s*\(/.test(strip(read(f)))
    );
    expect(offenders).toEqual([]);
    for (const f of Object.keys(OWNER_CALLERS)) expect(SOURCES).toContain(f);
  });

  it("recognises SQL built from values (self-test)", () => {
    const re = SQL_FROM_VALUES;
    expect(re.test("tx.query(`select ${x}`)")).toBe(true);
    expect(re.test('tx.query("select " + x)')).toBe(true);
    expect(re.test("tx.query(base + where)")).toBe(true);
    expect(re.test('tx.query("select $1", [x])')).toBe(false);
    expect(re.test("tx.query<Row>(`select a\n from b where c = $1`, [x])")).toBe(false);
  });
});
