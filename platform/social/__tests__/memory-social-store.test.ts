/**
 * platform/social/__tests__/memory-social-store.test.ts
 *
 * Tests for the InMemorySocialStore.
 * Covers: group CRUD, membership lifecycle, invite lifecycle,
 * edge cases (duplicates, not-found, already-resolved).
 */

import { InMemorySocialStore } from "../memory-social-store";
import type { CreateGroupInput, CreateInviteInput } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeGroupInput(overrides: Partial<CreateGroupInput> = {}): CreateGroupInput {
  return {
    name: "Test Group",
    description: "A group for testing",
    ownerId: "owner-1",
    ...overrides,
  };
}

function makeInviteInput(overrides: Partial<CreateInviteInput> = {}): CreateInviteInput {
  return {
    groupId: "group-1",
    inviterId: "owner-1",
    inviteeId: "user-2",
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("InMemorySocialStore", () => {
  let store: InMemorySocialStore;

  beforeEach(() => {
    store = new InMemorySocialStore();
  });

  // ── Group operations ────────────────────────────────────────────────

  describe("createGroup", () => {
    it("creates a group and returns it", async () => {
      const result = await store.createGroup(makeGroupInput());

      expect(result.success).toBe(true);
      expect(result.group).toBeDefined();
      expect(result.group!.name).toBe("Test Group");
      expect(result.group!.description).toBe("A group for testing");
      expect(result.group!.ownerId).toBe("owner-1");
      expect(result.group!.status).toBe("active");
      expect(result.group!.id).toBeTruthy();
      expect(result.group!.createdAt).toBeTruthy();
    });

    it("assigns unique IDs to each group", async () => {
      const r1 = await store.createGroup(makeGroupInput());
      const r2 = await store.createGroup(makeGroupInput({ name: "Second Group" }));

      expect(r1.group!.id).not.toBe(r2.group!.id);
    });

    it("auto-adds owner as member with owner role", async () => {
      const result = await store.createGroup(makeGroupInput());
      const members = await store.getMembers(result.group!.id);

      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe("owner-1");
      expect(members[0].role).toBe("owner");
    });

    it("stores metadata when provided", async () => {
      const result = await store.createGroup(
        makeGroupInput({
          metadata: { theme: "dark", language: "en" },
        })
      );

      expect(result.group!.metadata).toEqual({
        theme: "dark",
        language: "en",
      });
    });

    it("defaults metadata to empty object", async () => {
      const result = await store.createGroup(makeGroupInput());
      expect(result.group!.metadata).toEqual({});
    });
  });

  describe("getGroupById", () => {
    it("returns the group when found", async () => {
      const created = await store.createGroup(makeGroupInput());
      const found = await store.getGroupById(created.group!.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(created.group!.id);
    });

    it("returns undefined when not found", async () => {
      const found = await store.getGroupById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  describe("listGroupsForUser", () => {
    it("returns groups where user is an active member", async () => {
      const g1 = await store.createGroup(makeGroupInput());
      const g2 = await store.createGroup(makeGroupInput({ name: "Group 2" }));

      // owner-1 is auto-added to both
      const groups = await store.listGroupsForUser("owner-1");
      expect(groups).toHaveLength(2);

      const ids = groups.map((g) => g.id);
      expect(ids).toContain(g1.group!.id);
      expect(ids).toContain(g2.group!.id);
    });

    it("excludes groups where user has left", async () => {
      const g1 = await store.createGroup(makeGroupInput());
      await store.removeMember(g1.group!.id, "owner-1");

      const groups = await store.listGroupsForUser("owner-1");
      expect(groups).toHaveLength(0);
    });

    it("returns empty array for user with no groups", async () => {
      const groups = await store.listGroupsForUser("nobody");
      expect(groups).toEqual([]);
    });
  });

  describe("updateGroupStatus", () => {
    it("updates status to archived", async () => {
      const created = await store.createGroup(makeGroupInput());
      const result = await store.updateGroupStatus(created.group!.id, "archived");

      expect(result.success).toBe(true);
      expect(result.group!.status).toBe("archived");
    });

    it("updates status to suspended", async () => {
      const created = await store.createGroup(makeGroupInput());
      const result = await store.updateGroupStatus(created.group!.id, "suspended");

      expect(result.success).toBe(true);
      expect(result.group!.status).toBe("suspended");
    });

    it("updates the updatedAt timestamp", async () => {
      const created = await store.createGroup(makeGroupInput());
      const originalUpdatedAt = created.group!.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      const result = await store.updateGroupStatus(created.group!.id, "archived");

      expect(result.group!.updatedAt).not.toBe(originalUpdatedAt);
    });

    it("returns error for nonexistent group", async () => {
      const result = await store.updateGroupStatus("nonexistent", "archived");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Group not found");
    });
  });

  // ── Membership operations ───────────────────────────────────────────

  describe("addMember", () => {
    it("adds a member to a group", async () => {
      const group = await store.createGroup(makeGroupInput());
      const result = await store.addMember(group.group!.id, "user-2", "member");

      expect(result.success).toBe(true);
      expect(result.membership).toBeDefined();
      expect(result.membership!.userId).toBe("user-2");
      expect(result.membership!.role).toBe("member");
      expect(result.membership!.leftAt).toBeNull();
    });

    it("rejects duplicate active memberships", async () => {
      const group = await store.createGroup(makeGroupInput());
      // owner-1 is auto-added
      const result = await store.addMember(group.group!.id, "owner-1", "member");

      expect(result.success).toBe(false);
      expect(result.error).toBe("User is already an active member");
    });

    it("allows re-joining after leaving", async () => {
      const group = await store.createGroup(makeGroupInput());
      await store.removeMember(group.group!.id, "owner-1");

      const result = await store.addMember(group.group!.id, "owner-1", "member");

      expect(result.success).toBe(true);
    });
  });

  describe("removeMember", () => {
    it("sets leftAt on the membership", async () => {
      const group = await store.createGroup(makeGroupInput());
      const result = await store.removeMember(group.group!.id, "owner-1");

      expect(result.success).toBe(true);
      expect(result.membership!.leftAt).toBeTruthy();
    });

    it("returns error for non-active membership", async () => {
      const group = await store.createGroup(makeGroupInput());
      const result = await store.removeMember(group.group!.id, "user-999");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Active membership not found");
    });
  });

  describe("getMembers", () => {
    it("returns only active members", async () => {
      const group = await store.createGroup(makeGroupInput());
      await store.addMember(group.group!.id, "user-2", "member");
      await store.addMember(group.group!.id, "user-3", "admin");
      await store.removeMember(group.group!.id, "user-3");

      const members = await store.getMembers(group.group!.id);
      expect(members).toHaveLength(2); // owner-1 + user-2
      const userIds = members.map((m) => m.userId);
      expect(userIds).toContain("owner-1");
      expect(userIds).toContain("user-2");
      expect(userIds).not.toContain("user-3");
    });
  });

  describe("getMembership", () => {
    it("returns membership including left ones", async () => {
      const group = await store.createGroup(makeGroupInput());
      await store.removeMember(group.group!.id, "owner-1");

      const membership = await store.getMembership(group.group!.id, "owner-1");

      expect(membership).toBeDefined();
      expect(membership!.leftAt).toBeTruthy();
    });

    it("returns undefined for non-member", async () => {
      const group = await store.createGroup(makeGroupInput());
      const membership = await store.getMembership(group.group!.id, "nobody");

      expect(membership).toBeUndefined();
    });
  });

  // ── Invite operations ───────────────────────────────────────────────

  describe("createInvite", () => {
    it("creates a pending invite", async () => {
      const group = await store.createGroup(makeGroupInput());
      const result = await store.createInvite(
        makeInviteInput({ groupId: group.group!.id })
      );

      expect(result.success).toBe(true);
      expect(result.invite).toBeDefined();
      expect(result.invite!.status).toBe("pending");
      expect(result.invite!.inviteeId).toBe("user-2");
      expect(result.invite!.resolvedAt).toBeNull();
    });

    it("rejects duplicate pending invites", async () => {
      const group = await store.createGroup(makeGroupInput());
      const input = makeInviteInput({
        groupId: group.group!.id,
      });
      await store.createInvite(input);
      const result = await store.createInvite(input);

      expect(result.success).toBe(false);
      expect(result.error).toBe("Pending invite already exists for this user");
    });

    it("allows new invite after previous was declined", async () => {
      const group = await store.createGroup(makeGroupInput());
      const input = makeInviteInput({
        groupId: group.group!.id,
      });
      const first = await store.createInvite(input);
      await store.resolveInvite(first.invite!.id, "declined");

      const second = await store.createInvite(input);
      expect(second.success).toBe(true);
    });
  });

  describe("resolveInvite", () => {
    it("accepts a pending invite", async () => {
      const group = await store.createGroup(makeGroupInput());
      const invite = await store.createInvite(
        makeInviteInput({ groupId: group.group!.id })
      );
      const result = await store.resolveInvite(invite.invite!.id, "accepted");

      expect(result.success).toBe(true);
      expect(result.invite!.status).toBe("accepted");
      expect(result.invite!.resolvedAt).toBeTruthy();
    });

    it("declines a pending invite", async () => {
      const group = await store.createGroup(makeGroupInput());
      const invite = await store.createInvite(
        makeInviteInput({ groupId: group.group!.id })
      );
      const result = await store.resolveInvite(invite.invite!.id, "declined");

      expect(result.success).toBe(true);
      expect(result.invite!.status).toBe("declined");
    });

    it("rejects resolution of already-resolved invite", async () => {
      const group = await store.createGroup(makeGroupInput());
      const invite = await store.createInvite(
        makeInviteInput({ groupId: group.group!.id })
      );
      await store.resolveInvite(invite.invite!.id, "accepted");

      const result = await store.resolveInvite(invite.invite!.id, "declined");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already resolved/);
    });

    it("returns error for nonexistent invite", async () => {
      const result = await store.resolveInvite("nonexistent", "accepted");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invite not found");
    });
  });

  describe("listPendingInvites", () => {
    it("returns only pending invites for the user", async () => {
      const group = await store.createGroup(makeGroupInput());
      const gid = group.group!.id;

      await store.createInvite(makeInviteInput({ groupId: gid, inviteeId: "user-2" }));
      await store.createInvite(makeInviteInput({ groupId: gid, inviteeId: "user-3" }));

      // Decline one
      const invites = await store.listPendingInvites("user-2");
      expect(invites).toHaveLength(1);
      await store.resolveInvite(invites[0].id, "declined");

      const afterDecline = await store.listPendingInvites("user-2");
      expect(afterDecline).toHaveLength(0);

      // user-3's invite is untouched
      const user3 = await store.listPendingInvites("user-3");
      expect(user3).toHaveLength(1);
    });
  });

  describe("getInviteById", () => {
    it("returns the invite when found", async () => {
      const group = await store.createGroup(makeGroupInput());
      const created = await store.createInvite(
        makeInviteInput({ groupId: group.group!.id })
      );
      const found = await store.getInviteById(created.invite!.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(created.invite!.id);
    });

    it("returns undefined when not found", async () => {
      const found = await store.getInviteById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  // ── Test helpers ────────────────────────────────────────────────────

  describe("test helpers", () => {
    it("tracks counts correctly", async () => {
      expect(store.getGroupCount()).toBe(0);
      expect(store.getMembershipCount()).toBe(0);
      expect(store.getInviteCount()).toBe(0);

      const group = await store.createGroup(makeGroupInput());
      expect(store.getGroupCount()).toBe(1);
      expect(store.getMembershipCount()).toBe(1); // auto owner

      await store.createInvite(makeInviteInput({ groupId: group.group!.id }));
      expect(store.getInviteCount()).toBe(1);
    });

    it("clear() removes all data", async () => {
      await store.createGroup(makeGroupInput());
      store.clear();

      expect(store.getGroupCount()).toBe(0);
      expect(store.getMembershipCount()).toBe(0);
      expect(store.getInviteCount()).toBe(0);
    });
  });
});
