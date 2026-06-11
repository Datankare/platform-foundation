/**
 * __tests__/contract/social-store-contract.ts
 * SocialStore conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type {
  SocialStore,
  CreateGroupInput,
  CreateInviteInput,
} from "@/platform/social/types";

const groupInput: CreateGroupInput = {
  name: "Contract Group",
  description: "for conformance",
  ownerId: "owner-1",
};

export interface SocialStoreContractFixtures {
  makeStore: () => SocialStore | Promise<SocialStore>;
}

export function runSocialStoreContract(fx: SocialStoreContractFixtures): void {
  let store: SocialStore;

  beforeEach(async () => {
    store = await fx.makeStore();
  });

  describe("groups", () => {
    it("creates a group and fetches it by id", async () => {
      const res = await store.createGroup(groupInput);
      expect(res.success).toBe(true);
      const group = res.group!;
      expect(group.id).toBeTruthy();
      expect(group.name).toBe(groupInput.name);
      expect(group.ownerId).toBe(groupInput.ownerId);
      expect(group.status).toBe("active");
      const fetched = await store.getGroupById(group.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(group.id);
    });

    it("lists groups for the owner and updates status", async () => {
      const res = await store.createGroup(groupInput);
      const group = res.group!;
      const groups = await store.listGroupsForUser(groupInput.ownerId);
      expect(groups.some((g) => g.id === group.id)).toBe(true);
      const updated = await store.updateGroupStatus(group.id, "archived");
      expect(updated.success).toBe(true);
      expect(updated.group!.status).toBe("archived");
    });
  });

  describe("memberships", () => {
    it("adds, lists, and removes members", async () => {
      const res = await store.createGroup(groupInput);
      const group = res.group!;
      const add = await store.addMember(group.id, "member-1", "member");
      expect(add.success).toBe(true);
      const members = await store.getMembers(group.id);
      expect(members.some((m) => m.userId === "member-1")).toBe(true);
      const remove = await store.removeMember(group.id, "member-1");
      expect(remove.success).toBe(true);
      const after = await store.getMembers(group.id);
      expect(after.some((m) => m.userId === "member-1")).toBe(false);
    });
  });

  describe("invites", () => {
    it("creates, lists, and resolves invites", async () => {
      const res = await store.createGroup(groupInput);
      const group = res.group!;
      const inviteInput: CreateInviteInput = {
        groupId: group.id,
        inviterId: groupInput.ownerId,
        inviteeId: "invitee-1",
      };
      const created = await store.createInvite(inviteInput);
      expect(created.success).toBe(true);
      const invite = created.invite!;
      const pending = await store.listPendingInvites("invitee-1");
      expect(pending.some((i) => i.id === invite.id)).toBe(true);
      const resolved = await store.resolveInvite(invite.id, "accepted");
      expect(resolved.success).toBe(true);
      expect(resolved.invite!.status).toBe("accepted");
      const pendingAfter = await store.listPendingInvites("invitee-1");
      expect(pendingAfter.some((i) => i.id === invite.id)).toBe(false);
    });
  });
}
