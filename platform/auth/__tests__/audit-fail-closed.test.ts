/**
 * Fail-closed auditing for the account, consent, device, profile, GDPR and entitlement services
 * (Adversarial Validation, practice 6 — CONTRIBUTING.md).
 *
 * Each security-relevant change is recorded before it takes effect and does not take effect
 * when the record cannot be written. Runs against the in-memory database, so the order of writes
 * and the state afterwards are what the code actually did.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { FakeDatabase, type Row } from "../../../__tests__/helpers/fake-database";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let mockDb: FakeDatabase;
let mockAuditDown = false;

/** The fake client, with audit_log inserts failing while mockAuditDown is set. */
function mockClient(): any {
  const inner = mockDb.client();
  return {
    from: (table: string) => {
      const query = inner.from(table);
      if (table !== "audit_log") return query;
      if (mockAuditDown) {
        query.insert = () => Promise.resolve({ data: null, error: { message: "down" } });
      }
      // exportUserData reads its own audit trail with a filter string, which the fake refuses
      // on purpose; let that one read through unfiltered.
      query.or = () => query;
      return query;
    },
  };
}

jest.mock("@/lib/supabase/server", () => ({
  getSupabaseServiceClient: () => mockClient(),
}));

import { AuditWriteError } from "@/platform/auth/audit";
import { grantConsent, revokeConsent } from "@/platform/auth/consent";
import { recordAgeVerification, recordParentalConsent } from "@/platform/auth/coppa";
import { registerDevice, removeDevice } from "@/platform/auth/devices";
import { getProfileAsAdmin, updateProfile } from "@/platform/auth/profile";
import { estimateExportSize, exportUserData } from "@/platform/auth/data-export";
import { softDeleteUser } from "@/platform/auth/gdpr-deletion";
import { grantEntitlement, revokeEntitlement } from "@/platform/auth/entitlements";

const USER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";

function user(overrides: Row = {}): Row {
  return {
    id: USER,
    email: "u@example.com",
    display_name: "Old",
    real_name: "Real",
    date_of_birth: null,
    parental_consent_status: null,
    deleted_at: null,
    ...overrides,
  };
}

function snapshot(): string {
  return JSON.stringify(mockDb.tables);
}

function auditRows(): Row[] {
  return mockDb.rows("audit_log");
}

beforeEach(() => {
  mockAuditDown = false;
  mockDb = new FakeDatabase(
    {
      users: [user()],
      consent_records: [
        {
          user_id: USER,
          consent_type: "analytics",
          consent_version: "1",
          revoked_at: null,
        },
      ],
      user_devices: [{ user_id: USER, device_id: "dev-old", device_name: "Old phone" }],
      user_entitlements: [
        {
          user_id: USER,
          entitlement_group_id: "eg-old",
          granted_by: ADMIN,
          revoked_at: null,
        },
      ],
    },
    { unique: { consent_records: [["user_id", "consent_type"]] } }
  );
});

/**
 * Each case: the call, the write it makes after the audit record, and a check that the change
 * happened. With the audit store down, the same call must change nothing and report failure.
 */
const cases: {
  name: string;
  action: string;
  run: () => Promise<any>;
  change: [string, string, number];
  applied: () => void;
}[] = [
  {
    name: "grantConsent",
    action: "consent_granted",
    run: () =>
      grantConsent({ userId: USER, consentType: "marketing", consentVersion: "2" }),
    change: ["insert", "consent_records", 1],
    applied: () =>
      expect(mockDb.rows("consent_records").map((r) => r.consent_type)).toContain(
        "marketing"
      ),
  },
  {
    name: "revokeConsent",
    action: "consent_revoked",
    run: () => revokeConsent({ userId: USER, consentType: "analytics" }),
    change: ["update", "consent_records", 1],
    applied: () => expect(mockDb.rows("consent_records")[0].revoked_at).not.toBeNull(),
  },
  {
    name: "recordAgeVerification",
    action: "profile_updated",
    run: () => recordAgeVerification(USER, "2000-06-15"),
    change: ["update", "users", 1],
    applied: () => expect(mockDb.rows("users")[0].date_of_birth).toBe("2000-06-15"),
  },
  {
    name: "recordParentalConsent",
    action: "consent_granted",
    run: () => recordParentalConsent(USER, "granted", "parent@example.com"),
    change: ["update", "users", 1],
    applied: () =>
      expect(mockDb.rows("users")[0].parental_consent_status).toBe("granted"),
  },
  {
    name: "registerDevice",
    action: "device_registered",
    run: () => registerDevice(USER, "dev-new", "New phone"),
    change: ["upsert", "user_devices", 1],
    applied: () =>
      expect(mockDb.rows("user_devices").map((r) => r.device_id)).toContain("dev-new"),
  },
  {
    name: "removeDevice",
    action: "device_removed",
    run: () => removeDevice(USER, "dev-old"),
    change: ["delete", "user_devices", 1],
    applied: () => expect(mockDb.rows("user_devices")).toHaveLength(0),
  },
  {
    name: "updateProfile",
    action: "profile_updated",
    run: () => updateProfile(USER, { displayName: "New" }),
    change: ["update", "users", 1],
    applied: () => expect(mockDb.rows("users")[0].display_name).toBe("New"),
  },
  {
    name: "softDeleteUser",
    action: "account_deleted",
    run: () => softDeleteUser(USER, ADMIN),
    change: ["update", "users", 1],
    applied: () => {
      expect(mockDb.rows("users")[0].deleted_at).not.toBeNull();
      expect(mockDb.rows("users")[0].email).toBeNull();
    },
  },
  {
    name: "grantEntitlement",
    action: "entitlement_granted",
    run: () =>
      grantEntitlement({ userId: USER, entitlementGroupId: "eg-new", grantedBy: ADMIN }),
    change: ["upsert", "user_entitlements", 1],
    applied: () =>
      expect(
        mockDb.rows("user_entitlements").map((r) => r.entitlement_group_id)
      ).toContain("eg-new"),
  },
  {
    name: "revokeEntitlement",
    action: "entitlement_revoked",
    run: () =>
      revokeEntitlement({ userId: USER, entitlementGroupId: "eg-old", revokedBy: ADMIN }),
    change: ["update", "user_entitlements", 1],
    applied: () => expect(mockDb.rows("user_entitlements")[0].revoked_at).not.toBeNull(),
  },
];

describe.each(cases)("$name (fail-closed audit)", ({ action, run, change, applied }) => {
  it("records the action before making the change", async () => {
    const result = await run();
    expect(result.success).toBe(true);
    expect(mockDb.writes[0]).toEqual(["insert", "audit_log", 1]);
    expect(mockDb.writes[1]).toEqual(change);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action,
      target_id: USER,
      details: expect.objectContaining({ outcome: "attempted" }),
    });
    applied();
  });

  it("makes no change and reports failure when the record cannot be written", async () => {
    mockAuditDown = true;
    const before = snapshot();
    const result = await run();
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain("audit unavailable");
    expect(mockDb.writes).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

describe("a change that fails after its record is on file", () => {
  it("adds a failed follow-up record and reports the change's own error", async () => {
    const first = await grantConsent({
      userId: USER,
      consentType: "analytics",
      consentVersion: "2",
    });
    expect(first.success).toBe(false);
    expect(first.error).toMatch(/duplicate key/);
    expect(auditRows().map((r) => r.details.outcome)).toEqual(["attempted", "failed"]);
  });
});

describe("getProfileAsAdmin (fail-closed audit)", () => {
  it("records the admin's view and returns the profile", async () => {
    const profile = await getProfileAsAdmin(ADMIN, USER);
    expect(profile?.id).toBe(USER);
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({
      action: "profile_viewed_by_admin",
      actor_id: ADMIN,
      target_id: USER,
    });
  });

  it("discloses nothing when the view cannot be recorded", async () => {
    mockAuditDown = true;
    await expect(getProfileAsAdmin(ADMIN, USER)).rejects.toBeInstanceOf(AuditWriteError);
  });

  it("records nothing for a profile that does not exist", async () => {
    expect(
      await getProfileAsAdmin(ADMIN, "33333333-3333-4333-8333-333333333333")
    ).toBeNull();
    expect(auditRows()).toHaveLength(0);
  });
});

describe("exportUserData (fail-closed audit)", () => {
  it("records the export and returns the data", async () => {
    const { data, errors } = await exportUserData(USER);
    expect(errors).toEqual([]);
    expect((data.profile as Row).id).toBe(USER);
    expect(mockDb.writes).toEqual([["insert", "audit_log", 1]]);
    expect(auditRows()[0]).toMatchObject({ action: "data_exported" });
  });

  it("returns no data when the export cannot be recorded", async () => {
    mockAuditDown = true;
    const result = await exportUserData(USER);
    expect(result).toEqual({ data: {}, errors: ["audit unavailable"] });
  });
});

describe("softDeleteUser — manifest", () => {
  it("writes no deletion manifest when the record cannot be written", async () => {
    mockAuditDown = true;
    await softDeleteUser(USER, ADMIN);
    expect(mockDb.rows("deletion_manifest")).toHaveLength(0);
  });
});

describe("records that name what happened (Sprint 7X)", () => {
  it("refreshes a known device without a new security record", async () => {
    mockAuditDown = true;
    const result = await registerDevice(USER, "dev-old", "Old phone");
    expect(result).toEqual({ success: true });
    expect(auditRows()).toHaveLength(0);
    expect(mockDb.rows("user_devices")).toHaveLength(1);
  });

  it("records a refused parental consent as consent_denied, not consent_granted", async () => {
    await recordParentalConsent(USER, "denied");
    expect(auditRows()[0]).toMatchObject({ action: "consent_denied" });
  });

  it("does not record a size estimate as an export", async () => {
    const { estimatedBytes } = await estimateExportSize(USER);
    expect(estimatedBytes).toBeGreaterThan(0);
    expect(auditRows()).toHaveLength(0);
  });

  it.each(["not-a-uuid", "x,target_id.neq.null", ""])(
    "refuses to export for the crafted id %p",
    async (id) => {
      const result = await exportUserData(id);
      expect(result).toEqual({ data: {}, errors: ["invalid user id"] });
      expect(auditRows()).toHaveLength(0);
    }
  );
});

describe("recordAudit identity (audit X-8)", () => {
  it.each([
    ["a placeholder actor", { actorId: "authenticated-admin" }],
    ["an agent name as the actor", { actorId: "sentinel-1" }],
    ["a non-id target", { targetId: "user-1" }],
  ])(
    "refuses %s rather than writing a row the database would reject",
    async (_label, ids) => {
      const { recordAudit } = await import("@/platform/auth/audit");
      await expect(recordAudit({ action: "admin_action", ...ids })).rejects.toThrow(
        AuditWriteError
      );
      expect(auditRows()).toHaveLength(0);
    }
  );

  it("records an agent or process by name, with no actor id", async () => {
    const { recordAudit } = await import("@/platform/auth/audit");
    await recordAudit({
      action: "admin_action",
      agent: "escalation-reaper",
      targetId: USER,
    });
    expect(auditRows()[0]).toMatchObject({
      actor_id: null,
      target_id: USER,
      details: { agent: "escalation-reaper" },
    });
  });
});
