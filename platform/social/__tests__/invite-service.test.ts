/**
 * platform/social/__tests__/invite-service.test.ts
 *
 * Tests for InviteService business logic.
 * Uses InMemorySocialStore (no DB mocks needed).
 * Covers: authorization (inviter is member, invitee is not member,
 * only invitee can accept/decline), accept→addMember flow,
 * self-invite prevention, non-active group check.
 */

import { InviteService } from "../invite-service";
import { InMemorySocialStore } from "../memory-social-store";
import type { CreateGroupInput } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeGroupInput(overrides: Partial<CreateGroupInput> = {}): CreateGroupInput {
  return {
    name: "Test Group",
    description: "A group for testing",
    ownerId: "owner-1",
    ...overrides,
  };
}

function setup(): {
  service: InviteService;
  store: InMemorySocialStore;
} {
  const store = new InMemorySocialStore();
  const service = new InviteService(store);
  return { service, store };
}

/** Create a group and return its ID for use in invite tests. */
async function createTestGroup(
  store: InMemorySocialStore,
  ownerId = "owner-1"
): Promise<string> {
  const result = await store.createGroup(makeGroupInput({ ownerId }));
  return result.group!.id;
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("InviteService", () => {
  // ── createInvite ──────────────────────────────────────────────────

  describe("createInvite", () => {
    it("creates invite when inviter is a member", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const result = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      expect(result.success).toBe(true);
      expect(result.invite).toBeDefined();
      expect(result.invite!.status).toBe("pending");
    });

    it("rejects invite to nonexistent group", async () => {
      const { service } = setup();

      const result = await service.createInvite({
        groupId: "nonexistent",
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Group not found");
    });

    it("rejects invite to non-active group", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);
      await store.updateGroupStatus(groupId, "archived");

      const result = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot invite to a non-active group");
    });

    it("rejects invite from non-member", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const result = await service.createInvite({
        groupId,
        inviterId: "stranger",
        inviteeId: "user-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not an active member/);
    });

    it("rejects invite from member who has left", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);
      await store.addMember(groupId, "user-2", "member");
      await store.removeMember(groupId, "user-2");

      const result = await service.createInvite({
        groupId,
        inviterId: "user-2",
        inviteeId: "user-3",
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not an active member/);
    });

    it("rejects invite when invitee is already a member", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);
      await store.addMember(groupId, "user-2", "member");

      const result = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("User is already an active member");
    });

    it("rejects self-invite", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const result = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "owner-1",
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot invite yourself");
    });

    it("allows inviting a user who previously left", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);
      await store.addMember(groupId, "user-2", "member");
      await store.removeMember(groupId, "user-2");

      const result = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      expect(result.success).toBe(true);
    });
  });

  // ── acceptInvite ──────────────────────────────────────────────────

  describe("acceptInvite", () => {
    it("accepts invite and adds invitee as member", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      const result = await service.acceptInvite(invite.invite!.id, "user-2");

      expect(result.success).toBe(true);
      expect(result.invite!.status).toBe("accepted");

      // Verify membership was created
      const members = await store.getMembers(groupId);
      const userIds = members.map((m) => m.userId);
      expect(userIds).toContain("user-2");
    });

    it("rejects accept by non-invitee", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      const result = await service.acceptInvite(
        invite.invite!.id,
        "user-3" // not the invitee
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/only the invitee/i);
    });

    it("rejects accept of nonexistent invite", async () => {
      const { service } = setup();
      const result = await service.acceptInvite("nonexistent", "user-2");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Invite not found");
    });

    it("rejects accept of already-resolved invite", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      await service.acceptInvite(invite.invite!.id, "user-2");

      // Try to accept again
      const result = await service.acceptInvite(invite.invite!.id, "user-2");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/already resolved/);
    });

    it("new member has 'member' role, not admin/owner", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });
      await service.acceptInvite(invite.invite!.id, "user-2");

      const membership = await store.getMembership(groupId, "user-2");
      expect(membership).toBeDefined();
      expect(membership!.role).toBe("member");
    });
  });

  // ── declineInvite ─────────────────────────────────────────────────

  describe("declineInvite", () => {
    it("declines invite", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      const result = await service.declineInvite(invite.invite!.id, "user-2");

      expect(result.success).toBe(true);
      expect(result.invite!.status).toBe("declined");
    });

    it("rejects decline by non-invitee", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      const result = await service.declineInvite(invite.invite!.id, "user-3");

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/only the invitee/i);
    });

    it("does not add member on decline", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const invite = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });
      await service.declineInvite(invite.invite!.id, "user-2");

      const members = await store.getMembers(groupId);
      const userIds = members.map((m) => m.userId);
      expect(userIds).not.toContain("user-2");
    });
  });

  // ── listPendingInvites ────────────────────────────────────────────

  describe("listPendingInvites", () => {
    it("returns pending invites for the user", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      const invites = await service.listPendingInvites("user-2");
      expect(invites).toHaveLength(1);
    });

    it("returns empty for user with no invites", async () => {
      const { service } = setup();
      const invites = await service.listPendingInvites("nobody");
      expect(invites).toEqual([]);
    });
  });

  // ── getInviteById ─────────────────────────────────────────────────

  describe("getInviteById", () => {
    it("delegates to store", async () => {
      const { service, store } = setup();
      const groupId = await createTestGroup(store);

      const created = await service.createInvite({
        groupId,
        inviterId: "owner-1",
        inviteeId: "user-2",
      });

      const found = await service.getInviteById(created.invite!.id);
      expect(found).toBeDefined();
      expect(found!.id).toBe(created.invite!.id);
    });
  });
});
