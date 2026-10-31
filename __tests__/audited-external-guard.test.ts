/**
 * __tests__/audited-external-guard.test.ts — every audited() call site carries the flag its act
 * needs (review 13 L5, review 14 L-6)
 *
 * An act audited inside a transaction must be database-only: a rollback undoes its writes, and
 * the `rolled_back` record audited() then writes is true only of them. An act that reaches outside
 * the database passes `{ external: true }`, and audited() refuses it inside an open transaction.
 *
 * Review 13 kept a hand count per file of calls and flags, which a flag moved from one call to
 * another in the same file passed. Now the code is read (helpers/audited-external-scan.ts, the
 * TypeScript compiler API): for every call of audited() and of its wrappers, the act's body — and
 * every function of the same file it calls — is walked for a call into an EXTERNAL_MODULES module,
 * the global fetch, or a function tagged `@external` in its JSDoc (same file or imported); the
 * call's flag must say exactly that. Cache invalidations are not external acts: they are published
 * after the commit (onCommit), never inside the transaction.
 *
 * And the refusal itself: an external act inside a transaction is not recorded and not run; outside
 * one it runs; a database-only act inside one runs.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
let inTx = false;
jest.mock("@/platform/data", () => ({
  ...require("./helpers/fake-data").fakeDataModule(),
  withSeparateTenantTx: require("./helpers/fake-data").fakeDataModule().withTenantTx,
  inTransaction: () => inTx,
  onRollback: () => inTx,
}));

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { audited, AuditedExternalActError } from "@/platform/auth/audit";
import { fakeData } from "./helpers/fake-data";
import {
  auditedFindings,
  scanAudited,
  type SourceText,
} from "./helpers/audited-external-scan";

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", "__tests__", ".next"].includes(e.name)) sources(p, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

const ROOT = process.cwd();
const REPO: SourceText[] = ["platform", "app", "lib", "components"]
  .flatMap((r) => sources(r))
  .map((p) => ({ path: p.split("\\").join("/"), text: readFileSync(p, "utf8") }));
const scan = scanAudited(REPO, ROOT);

describe("every audited() call site's flag matches what its act reaches (AST)", () => {
  it("finds the call sites and wrappers it means to (self-test)", () => {
    expect(scan.sites.length).toBeGreaterThan(30);
    // Keyed by file and name: the two files' `recorded` are two wrappers (S2 round 2).
    expect(Object.keys(scan.wrappers).sort()).toEqual(
      expect.arrayContaining([
        "platform/auth/audit.ts#audited",
        "platform/auth/audit.ts#auditedResponse",
        "app/api/admin/ai/handlers/shared.ts#runAudited",
        "platform/tenancy/admin.ts#recorded",
        "platform/gdpr/erasure-attestation.ts#recorded",
      ])
    );
    const external = scan.sites.filter((s) => s.reaches.length > 0).map((s) => s.file);
    // The purges run every registered module's erasure hook; run-now runs job handlers.
    expect(external).toEqual(
      expect.arrayContaining([
        "platform/auth/gdpr-deletion.ts",
        "app/api/admin/gdpr/route.ts",
        "platform/jobs/operator.ts",
      ])
    );
  });

  it("has no finding: external acts flagged, database-only acts not, every act readable", () => {
    expect(auditedFindings(scan)).toEqual([]);
  });

  it("every wrapper of audited() forwards its options", () => {
    expect(scan.unforwarded).toEqual([]);
  });
});

describe("the scan (self-tests on synthetic sources)", () => {
  const run = (files: SourceText[]) =>
    auditedFindings(
      scanAudited(files, "/nonexistent", (p) => files.find((f) => f.path === p)?.text)
    );
  const HELPERS: SourceText = {
    path: "platform/x/helpers.ts",
    text: `
      /** @external Calls the identity provider. */
      export async function deleteIdentity(id: string) { return id; }
      export async function writeRow(id: string) { return id; }
    `,
  };
  const BARREL: SourceText = {
    path: "platform/x/index.ts",
    text: `export { deleteIdentity, writeRow } from "./helpers";`,
  };
  const site = (body: string): SourceText => ({
    path: "platform/x/site.ts",
    text: `
      import { audited } from "@/platform/auth/audit";
      import { deleteIdentity, writeRow } from "@/platform/x";
      import { fetchWithTimeout } from "@/lib/fetchWithTimeout";
      async function local(id: string) { return deleteIdentity(id); }
      async function dbOnly(id: string) { return writeRow(id); }
      ${body}
    `,
  });

  it("a correctly flagged pair passes", () => {
    expect(
      run([
        HELPERS,
        BARREL,
        site(`
          export async function a(id: string) {
            await audited(E, async () => deleteIdentity(id), { external: true });
            await audited(E, async () => writeRow(id));
          }`),
      ])
    ).toEqual([]);
  });

  it("swapping the flag between the two calls fails — on both", () => {
    const findings = run([
      HELPERS,
      BARREL,
      site(`
        export async function a(id: string) {
          await audited(E, async () => deleteIdentity(id));
          await audited(E, async () => writeRow(id), { external: true });
        }`),
    ]);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatch(
      /reaches outside the database \(deleteIdentity \(@external/
    );
    expect(findings[1]).toMatch(/marked external, but the act reaches nothing/);
  });

  it("reaches through a function of the same file, an external module, and global fetch", () => {
    expect(
      run([
        HELPERS,
        BARREL,
        site(`export const b = () => audited(E, async () => local("x"));`),
      ])
    ).toEqual([expect.stringMatching(/local → deleteIdentity/)]);
    expect(
      run([
        HELPERS,
        BARREL,
        site(`export const c = () => audited(E, async () => fetchWithTimeout("u"));`),
      ])
    ).toEqual([expect.stringMatching(/lib\/fetchWithTimeout/)]);
    expect(
      run([
        HELPERS,
        BARREL,
        site(`export const d = () => audited(E, async () => fetch("u"));`),
      ])
    ).toEqual([expect.stringMatching(/fetch \(outbound HTTP\)/)]);
    expect(
      run([
        HELPERS,
        BARREL,
        site(`export const e = () => audited(E, async () => dbOnly("x"));`),
      ])
    ).toEqual([]);
  });

  it("an act passed by name is read; an act it cannot read is reported", () => {
    expect(
      run([HELPERS, BARREL, site(`export const f = () => audited(E, local);`)])
    ).toEqual([expect.stringMatching(/pass \{ external: true \}/)]);
    expect(
      run([
        HELPERS,
        BARREL,
        site(`export const g = (o: { act: () => Promise<void> }) => audited(E, o.act);`),
      ])
    ).toEqual([expect.stringMatching(/the act cannot be read/)]);
  });

  it("a wrapper must forward its options; its call sites are checked like audited()'s", () => {
    const wrapper = (forward: boolean): SourceText => ({
      path: "platform/x/wrap.ts",
      text: `
        import { audited } from "@/platform/auth/audit";
        export async function wrapped(e: unknown, act: () => Promise<unknown>, options = {}) {
          return audited(e, async () => act()${forward ? ", options" : ""});
        }`,
    });
    const caller: SourceText = {
      path: "platform/x/caller.ts",
      text: `
        import { wrapped } from "./wrap";
        import { deleteIdentity } from "./helpers";
        export const h = () => wrapped(E, async () => deleteIdentity("x"));`,
    };
    expect(run([HELPERS, wrapper(true), caller])).toEqual([
      expect.stringMatching(/caller\.ts:\d+ wrapped\(\): the act reaches outside/),
    ]);
    expect(run([HELPERS, wrapper(false), caller])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/wrap\.ts:wrapped: a wrapper of audited\(\) must forward/),
      ])
    );
  });
});

describe("audited({ external: true }) inside a transaction is refused", () => {
  beforeEach(() => {
    fakeData().reset();
    inTx = false;
  });
  const entry = { action: "admin_action" as const, details: { type: "x" } };

  it("refused inside an open transaction: nothing recorded, nothing run", async () => {
    inTx = true;
    const act = jest.fn(async () => ({ success: true }));
    await expect(audited(entry, act, { external: true })).rejects.toBeInstanceOf(
      AuditedExternalActError
    );
    expect(act).not.toHaveBeenCalled();
    expect(fakeData().audit).toEqual([]);
  });

  it("runs outside a transaction", async () => {
    const act = jest.fn(async () => ({ success: true }));
    await audited(entry, act, { external: true });
    expect(act).toHaveBeenCalledTimes(1);
    expect(fakeData().audit.map((a) => a.details.outcome)).toEqual(["attempted"]);
  });

  it("a database-only act inside a transaction runs", async () => {
    inTx = true;
    const act = jest.fn(async () => ({ success: true }));
    await audited(entry, act);
    expect(act).toHaveBeenCalledTimes(1);
  });
});
