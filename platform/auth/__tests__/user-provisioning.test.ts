/**
 * TASK-117 — ensureUserProvisioned: creates the platform row on first use, once, and never
 * changes an existing row; reports failure instead of allowing.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let supabaseUrl: string | undefined = "https://x.supabase.co";
jest.mock("@/platform/providers/environment-contract", () => ({
  getSupabaseUrl: () => supabaseUrl,
}));

const mockAudit = jest.fn();
jest.mock("@/platform/auth/audit", () => ({
  writeAuditLog: (...a: any[]) => mockAudit(...a),
}));

type R = { data: any; error: any };
let usersRead: R;
let roleRead: R;
let insertResult: R;
let upsertArgs: any[] = [];

function chain(result: () => R) {
  const c: any = {
    select: jest.fn(() => c),
    eq: jest.fn(() => c),
    maybeSingle: jest.fn(() => Promise.resolve(result())),
    upsert: jest.fn((...a: any[]) => {
      upsertArgs = a;
      return { select: jest.fn(() => Promise.resolve(insertResult)) };
    }),
  };
  return c;
}

const mockFrom = jest.fn((table: string) =>
  table === "roles" ? chain(() => roleRead) : chain(() => usersRead)
);
jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: () => ({ from: (t: string) => mockFrom(t) }),
}));

import { DEFAULT_USER_ROLE, ensureUserProvisioned } from "../user-provisioning";

const SUB = "f418a4e8-90c1-704c-a1b2-c3d4e5f60718";

beforeEach(() => {
  jest.clearAllMocks();
  supabaseUrl = "https://x.supabase.co";
  usersRead = { data: null, error: null };
  roleRead = { data: { id: "role-free" }, error: null };
  insertResult = { data: [{ id: SUB }], error: null };
  upsertArgs = [];
});

describe("ensureUserProvisioned (TASK-117)", () => {
  it("creates the row with the default role, keyed by the subject, and audits it", async () => {
    const out = await ensureUserProvisioned(SUB, {
      email: " Raman@Datankare.com ",
      emailVerified: true,
    });
    expect(out).toBe("created");
    expect(DEFAULT_USER_ROLE).toBe("free");
    expect(upsertArgs[0]).toEqual({
      id: SUB,
      cognito_sub: SUB,
      email: "raman@datankare.com",
      email_verified: true,
      role_id: "role-free",
    });
    expect(upsertArgs[1]).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "account_created", targetId: SUB })
    );
  });

  it("leaves an existing row untouched", async () => {
    usersRead = { data: { id: SUB }, error: null };
    expect(await ensureUserProvisioned(SUB)).toBe("existing");
    expect(upsertArgs).toEqual([]);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("treats a concurrent creation (insert ignored) as existing, without a second audit", async () => {
    insertResult = { data: [], error: null };
    expect(await ensureUserProvisioned(SUB)).toBe("existing");
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("stores no email when the token has none", async () => {
    await ensureUserProvisioned(SUB, { email: "" });
    expect(upsertArgs[0]).toMatchObject({ email: null, email_verified: false });
  });

  it.each([
    ["the read fails", () => (usersRead = { data: null, error: { message: "down" } })],
    [
      "the role read fails",
      () => (roleRead = { data: null, error: { message: "down" } }),
    ],
    ["the default role is missing", () => (roleRead = { data: null, error: null })],
    [
      "the insert fails",
      () => (insertResult = { data: null, error: { message: "dup sub" } }),
    ],
    [
      "the client throws",
      () =>
        mockFrom.mockImplementationOnce(() => {
          throw new Error("boom");
        }),
    ],
  ])("fails (never allows) when %s", async (_label, arrange) => {
    arrange();
    expect(await ensureUserProvisioned(SUB)).toBe("failed");
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it("refuses a subject that is not a UUID, without touching the database", async () => {
    expect(await ensureUserProvisioned("not-a-sub")).toBe("failed");
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("is skipped when no database is configured", async () => {
    supabaseUrl = undefined;
    expect(await ensureUserProvisioned(SUB)).toBe("skipped");
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
