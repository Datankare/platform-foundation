/**
 * platform/auth/__tests__/data-failures.test.ts — branches a real database cannot be made to take
 *
 * With platform/data mocked: a write that fails after its audit record is on file (the users
 * updates in coppa.ts have no constraint a valid call can trip), and permission resolution
 * through an active entitlement group (the replayed catalog holds none, and tests never write
 * platform tables). The SQL itself is proven in __tests__/db/*.db.test.ts.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/** Queries answered in order by `answers`; an Error answer is thrown. */
let answers: (Record<string, unknown>[] | Error)[] = [];
const queries: string[] = [];
jest.mock("@/platform/data", () => ({
  withTenantTx: (fn: (tx: unknown) => unknown) =>
    fn({
      tenantId: "00000000-0000-4000-8000-000000000001",
      query: async (text: string) => {
        queries.push(text);
        const next = answers.shift() ?? [];
        if (next instanceof Error) throw next;
        return { rows: next, rowCount: next.length };
      },
    }),
  hasDatabase: () => true,
}));

import { recordAgeVerification, recordParentalConsent } from "@/platform/auth/coppa";
import { resolvePermissions } from "@/platform/auth/permissions";

const USER = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  answers = [];
  queries.length = 0;
});

describe("coppa: a write that fails after its record", () => {
  it.each([
    ["recordAgeVerification", () => recordAgeVerification(USER, "2000-06-15")],
    ["recordParentalConsent", () => recordParentalConsent(USER, "granted")],
  ])("%s reports the error and records the failed outcome", async (_name, run) => {
    answers = [[], new Error("update refused"), []];
    const out = await run();
    expect(out).toMatchObject({ success: false, error: "update refused" });
    expect(queries.filter((q) => /insert into audit_log/.test(q))).toHaveLength(2);
  });
});

describe("resolvePermissions through an entitlement group", () => {
  it("adds the active group's code and permissions", async () => {
    answers = [
      [{ id: USER, role_id: "r1" }], // user
      [{ name: "free" }], // role
      [{ permission_id: "p-play" }], // role + inherited permissions
      [{ id: "g-pro", code: "pro" }], // active groups
      [{ permission_id: "p-pro" }], // group permissions
      [{ code: "can_play" }, { code: "can_pro" }], // codes
    ];
    await expect(resolvePermissions(USER)).resolves.toEqual({
      userId: USER,
      roleId: "r1",
      roleName: "free",
      permissions: ["can_play", "can_pro"],
      entitlementGroups: ["pro"],
    });
    expect(queries[4]).toMatch(/from entitlement_permissions/);
  });

  it("names an unknown role and grants nothing without permission rows", async () => {
    answers = [[{ id: USER, role_id: "r1" }], [], [], []];
    await expect(resolvePermissions(USER)).resolves.toMatchObject({
      roleName: "unknown",
      permissions: [],
    });
  });

  it("returns null, never a partial set, when a later read fails", async () => {
    answers = [[{ id: USER, role_id: "r1" }], new Error("down")];
    await expect(resolvePermissions(USER)).resolves.toBeNull();
  });
});
