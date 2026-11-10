/**
 * __tests__/helpers/fake-data.ts — platform/data for unit tests of routing and handler logic
 *
 *   jest.mock("@/platform/data", () => require("@/__tests__/helpers/fake-data").fakeDataModule());
 *   import { fakeData } from "@/__tests__/helpers/fake-data";
 *
 * Every transaction (tenant, platform, owner) runs its callback with one fake Tx. Audit records
 * (`insert into audit_log`, written by the real platform/auth/audit.ts) are kept in
 * `fakeData().audit` with their details parsed, and fail when `failAudit` is set. Any other
 * statement goes to `fakeData().answer(sql, values)` — rows to return, or a throw to inject a
 * database failure — and is logged in `fakeData().statements`.
 *
 * Who could approve a dual-controlled action (platform/admin/eligible-approvers.ts, N-24) is the
 * `eligible-approvers` statement: answered from `fakeData().approvers` — by default one other
 * staff account holding every permission (FAKE_SECOND_APPROVER), so a hold is held as before; set
 * it to `[]` (or to the accounts you need) to test the refusal, or to `"fail"` to fail the read.
 *
 * This proves only what the code does with the answers it gets. The SQL itself is proved
 * against Postgres in __tests__/db.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type DataModule = typeof import("@/platform/data");

export interface AuditRow {
  action: string;
  actor_id: string | null;
  target_id: string | null;
  details: Record<string, any>;
}

/** One staff account as the eligible-approvers statement returns it. */
export interface FakeStaffRow {
  id: string;
  tenant_id: string;
  sub: string | null;
  email: string | null;
  role_name: string | null;
  permissions: string[];
}

/** The second staff account a fake database has unless a test says otherwise. */
export const FAKE_SECOND_APPROVER: FakeStaffRow = {
  id: "a9a9a9a9-0000-4000-8000-000000000002",
  tenant_id: "00000000-0000-4000-8000-000000000001",
  sub: "a9a9a9a9-0000-4000-8000-0000000000f2",
  email: "second-approver@example.test",
  role_name: "super_admin",
  permissions: ["*"],
};

export interface FakeData {
  /** Audit rows written, in order. */
  audit: AuditRow[];
  /** Make every audit insert fail, as an unavailable log would. */
  failAudit: boolean;
  /** Every non-audit statement, whitespace collapsed, with its values. */
  statements: { sql: string; values: readonly unknown[] }[];
  /** The rows a non-audit statement returns (default: none). Throw to fail it. */
  answer: (sql: string, values: readonly unknown[]) => any[] | undefined;
  /** The staff the eligible-approvers statement returns, or "fail" to fail it. */
  approvers: FakeStaffRow[] | "fail";
  /** Clear everything back to an empty, working database. */
  reset(): void;
}

const KEY = "__FAKE_PLATFORM_DATA__";

function state(): FakeData {
  const g = globalThis as any;
  g[KEY] ??= {
    audit: [],
    failAudit: false,
    statements: [],
    answer: () => undefined,
    approvers: [FAKE_SECOND_APPROVER],
    reset() {
      this.audit = [];
      this.failAudit = false;
      this.statements = [];
      this.answer = () => undefined;
      this.approvers = [FAKE_SECOND_APPROVER];
    },
  } satisfies FakeData;
  return g[KEY];
}

/** The fake's state, shared with the mocked module. */
export function fakeData(): FakeData {
  return state();
}

async function query(text: string, values: readonly unknown[] = []) {
  const sql = text.replace(/\s+/g, " ").trim();
  const s = state();
  if (/^insert into audit_log /i.test(sql)) {
    if (s.failAudit) throw new Error("audit_log is unavailable");
    s.audit.push({
      action: values[0] as string,
      actor_id: (values[1] as string) ?? null,
      target_id: (values[2] as string) ?? null,
      details: JSON.parse(String(values[3] ?? "{}")),
    });
    return { rows: [], rowCount: 1 };
  }
  s.statements.push({ sql, values });
  if (sql.startsWith("/* eligible-approvers */")) {
    if (s.approvers === "fail") throw new Error("users is unavailable");
    return { rows: s.approvers, rowCount: s.approvers.length };
  }
  const rows = s.answer(sql, values) ?? [];
  return { rows, rowCount: rows.length };
}

/** The platform/data module with every transaction on the fake Tx. */
export function fakeDataModule(): Partial<DataModule> {
  const actual = jest.requireActual<DataModule>("@/platform/data");
  const tx = { tenantId: undefined, query } as any;
  return {
    ...actual,
    hasDatabase: () => true,
    withTenantTx: (async (fn: (t: any) => Promise<unknown>) =>
      fn(tx)) as DataModule["withTenantTx"],
    withPlatformTx: (async (fn: (t: any) => Promise<unknown>) =>
      fn(tx)) as DataModule["withPlatformTx"],
    withOwnerTx: (async (_purpose: unknown, fn: (t: any) => Promise<unknown>) =>
      fn(tx)) as DataModule["withOwnerTx"],
  };
}
