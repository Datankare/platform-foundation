/**
 * platform/social/__tests__/supabase-social-store.test.ts
 *
 * Tests for SupabaseSocialStore with mocked fetch.
 * Covers: group CRUD, membership operations, invite lifecycle,
 * error handling, client-side guard.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Mocks ───────────────────────────────────────────────────────────────

jest.mock("@/lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// ── Imports ─────────────────────────────────────────────────────────────

import { SupabaseSocialStore } from "../supabase-social-store";

// ── Helpers ─────────────────────────────────────────────────────────────

const TEST_URL = "https://test.supabase.co";
const TEST_KEY = "test-service-role-key";

function createStore(): SupabaseSocialStore {
  return new SupabaseSocialStore(TEST_URL, TEST_KEY);
}

function mockFetchOk(data: any): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  });
}

function mockFetchError(status = 500): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "Internal Server Error",
  });
}

function mockFetchConflict(): void {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status: 409,
    json: async () => ({}),
    text: async () => "duplicate key value",
  });
}

const sampleGroupRow = {
  id: "grp-1",
  name: "Test Group",
  description: "A test group",
  metadata: {},
  owner_id: "user-1",
  status: "active",
  created_at: "2026-04-29T00:00:00Z",
  updated_at: "2026-04-29T00:00:00Z",
};

const sampleMembershipRow = {
  id: "mem-1",
  group_id: "grp-1",
  user_id: "user-1",
  role: "owner",
  joined_at: "2026-04-29T00:00:00Z",
  left_at: null,
};

const sampleInviteRow = {
  id: "inv-1",
  group_id: "grp-1",
  inviter_id: "user-1",
  invitee_id: "user-2",
  status: "pending",
  created_at: "2026-04-29T00:00:00Z",
  resolved_at: null,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe("SupabaseSocialStore", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("constructor", () => {
    it("throws if instantiated client-side", () => {
      const origWindow = global.window;
      (global as any).window = {};
      expect(() => createStore()).toThrow(/client-side/);
      (global as any).window = origWindow;
    });
  });

  // ── Groups ────────────────────────────────────────────────────────

  describe("createGroup", () => {
    it("creates group and auto-adds owner", async () => {
      const store = createStore();
      // First call: create group
      mockFetchOk([sampleGroupRow]);
      // Second call: add owner as member
      mockFetchOk([sampleMembershipRow]);

      const result = await store.createGroup({
        name: "Test Group",
        description: "A test group",
        ownerId: "user-1",
      });

      expect(result.success).toBe(true);
      expect(result.group!.name).toBe("Test Group");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns error on fetch failure", async () => {
      const store = createStore();
      mockFetchError();

      const result = await store.createGroup({
        name: "Test",
        description: "",
        ownerId: "user-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Database error/);
    });

    it("handles network error gracefully", async () => {
      const store = createStore();
      mockFetch.mockRejectedValueOnce(new Error("Network down"));

      const result = await store.createGroup({
        name: "Test",
        description: "",
        ownerId: "user-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Store unavailable");
    });
  });

  describe("getGroupById", () => {
    it("returns group when found", async () => {
      const store = createStore();
      mockFetchOk([sampleGroupRow]);

      const group = await store.getGroupById("grp-1");
      expect(group).toBeDefined();
      expect(group!.name).toBe("Test Group");
    });

    it("returns undefined when not found", async () => {
      const store = createStore();
      mockFetchOk([]);

      const group = await store.getGroupById("missing");
      expect(group).toBeUndefined();
    });

    it("returns undefined on error", async () => {
      const store = createStore();
      mockFetchError();

      const group = await store.getGroupById("grp-1");
      expect(group).toBeUndefined();
    });
  });

  describe("listGroupsForUser", () => {
    it("returns groups for active memberships", async () => {
      const store = createStore();
      // Memberships query
      mockFetchOk([{ group_id: "grp-1" }]);
      // Groups query
      mockFetchOk([sampleGroupRow]);

      const groups = await store.listGroupsForUser("user-1");
      expect(groups).toHaveLength(1);
    });

    it("returns empty on no memberships", async () => {
      const store = createStore();
      mockFetchOk([]);

      const groups = await store.listGroupsForUser("nobody");
      expect(groups).toEqual([]);
    });
  });

  describe("updateGroupStatus", () => {
    it("updates and returns group", async () => {
      const store = createStore();
      mockFetchOk([{ ...sampleGroupRow, status: "archived" }]);

      const result = await store.updateGroupStatus("grp-1", "archived");
      expect(result.success).toBe(true);
      expect(result.group!.status).toBe("archived");
    });

    it("returns error when group not found", async () => {
      const store = createStore();
      mockFetchOk([]);

      const result = await store.updateGroupStatus("missing", "archived");
      expect(result.success).toBe(false);
    });
  });

  // ── Memberships ───────────────────────────────────────────────────

  describe("addMember", () => {
    it("adds member successfully", async () => {
      const store = createStore();
      mockFetchOk([sampleMembershipRow]);

      const result = await store.addMember("grp-1", "user-1", "member");
      expect(result.success).toBe(true);
    });

    it("returns error on duplicate", async () => {
      const store = createStore();
      mockFetchConflict();

      const result = await store.addMember("grp-1", "user-1", "member");
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already an active member/);
    });
  });

  describe("removeMember", () => {
    it("sets leftAt on membership", async () => {
      const store = createStore();
      mockFetchOk([
        {
          ...sampleMembershipRow,
          left_at: "2026-04-29T01:00:00Z",
        },
      ]);

      const result = await store.removeMember("grp-1", "user-1");
      expect(result.success).toBe(true);
      expect(result.membership!.leftAt).toBeTruthy();
    });

    it("returns error when not found", async () => {
      const store = createStore();
      mockFetchOk([]);

      const result = await store.removeMember("grp-1", "nobody");
      expect(result.success).toBe(false);
    });
  });

  describe("getMembers", () => {
    it("returns active members", async () => {
      const store = createStore();
      mockFetchOk([sampleMembershipRow]);

      const members = await store.getMembers("grp-1");
      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe("user-1");
    });
  });

  describe("getMembership", () => {
    it("returns membership when found", async () => {
      const store = createStore();
      mockFetchOk([sampleMembershipRow]);

      const membership = await store.getMembership("grp-1", "user-1");
      expect(membership).toBeDefined();
    });

    it("returns undefined when not found", async () => {
      const store = createStore();
      mockFetchOk([]);

      const membership = await store.getMembership("grp-1", "nobody");
      expect(membership).toBeUndefined();
    });
  });

  // ── Invites ───────────────────────────────────────────────────────

  describe("createInvite", () => {
    it("creates pending invite", async () => {
      const store = createStore();
      mockFetchOk([sampleInviteRow]);

      const result = await store.createInvite({
        groupId: "grp-1",
        inviterId: "user-1",
        inviteeId: "user-2",
      });
      expect(result.success).toBe(true);
      expect(result.invite!.status).toBe("pending");
    });

    it("returns error on duplicate pending", async () => {
      const store = createStore();
      mockFetchConflict();

      const result = await store.createInvite({
        groupId: "grp-1",
        inviterId: "user-1",
        inviteeId: "user-2",
      });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already exists/);
    });
  });

  describe("resolveInvite", () => {
    it("accepts a pending invite", async () => {
      const store = createStore();
      mockFetchOk([
        {
          ...sampleInviteRow,
          status: "accepted",
          resolved_at: "2026-04-29T01:00:00Z",
        },
      ]);

      const result = await store.resolveInvite("inv-1", "accepted");
      expect(result.success).toBe(true);
      expect(result.invite!.status).toBe("accepted");
    });

    it("returns error when not found or already resolved", async () => {
      const store = createStore();
      mockFetchOk([]);

      const result = await store.resolveInvite("missing", "accepted");
      expect(result.success).toBe(false);
    });
  });

  describe("listPendingInvites", () => {
    it("returns pending invites for user", async () => {
      const store = createStore();
      mockFetchOk([sampleInviteRow]);

      const invites = await store.listPendingInvites("user-2");
      expect(invites).toHaveLength(1);
    });
  });

  describe("getInviteById", () => {
    it("returns invite when found", async () => {
      const store = createStore();
      mockFetchOk([sampleInviteRow]);

      const invite = await store.getInviteById("inv-1");
      expect(invite).toBeDefined();
    });

    it("returns undefined when not found", async () => {
      const store = createStore();
      mockFetchOk([]);

      const invite = await store.getInviteById("missing");
      expect(invite).toBeUndefined();
    });
  });
});
