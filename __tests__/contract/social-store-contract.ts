/**
 * __tests__/contract/social-store-contract.ts
 * SocialStore conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type {
  SocialStore,
  CreateGroupInput,
  CreateInviteInput,
} from "@/platform/social/types";

export interface SocialStoreContractFixtures {
  makeStore: () => SocialStore | Promise<SocialStore>;
  /**
   * The users the kit uses, read after each makeStore. A store whose groups must name real
   * users (foreign keys) creates them there; default: fixed ids.
   */
  users?: () => {
    readonly owner: string;
    readonly member: string;
    readonly invitee: string;
  };
}

const DEFAULT_USERS = { owner: "owner-1", member: "member-1", invitee: "invitee-1" };

export function runSocialStoreContract(fx: SocialStoreContractFixtures): void {
  let store: SocialStore;
  let users: {
    readonly owner: string;
    readonly member: string;
    readonly invitee: string;
  };
  let groupInput: CreateGroupInput;

  beforeEach(async () => {
    store = await fx.makeStore();
    users = fx.users?.() ?? DEFAULT_USERS;
    groupInput = {
      name: "Contract Group",
      description: "for conformance",
      ownerId: users.owner,
    };
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

  describe("active groups, a page at a time", () => {
    it("pages through active groups in id order, leaving out the others", async () => {
      const made = [];
      for (let i = 0; i < 3; i++) {
        made.push((await store.createGroup({ ...groupInput, name: `Page ${i}` })).group!);
      }
      await store.updateGroupStatus(made[1].id, "archived");
      const seen: string[] = [];
      let after: string | undefined;
      for (let page = 0; page < 1000; page++) {
        const groups = await store.listActiveGroups({ after, limit: 1 });
        if (groups.length === 0) break;
        expect(groups).toHaveLength(1);
        expect(groups[0].status).toBe("active");
        seen.push(groups[0].id);
        after = groups[0].id;
      }
      const expected = [made[0].id, made[2].id].sort();
      expect(seen.filter((id) => expected.includes(id))).toEqual(expected);
      expect(seen).not.toContain(made[1].id);
      expect([...seen].sort()).toEqual(seen);
    });
  });

  describe("memberships", () => {
    it("adds, lists, and removes members", async () => {
      const res = await store.createGroup(groupInput);
      const group = res.group!;
      const add = await store.addMember(group.id, users.member, "member");
      expect(add.success).toBe(true);
      const members = await store.getMembers(group.id);
      expect(members.some((m) => m.userId === users.member)).toBe(true);
      const remove = await store.removeMember(group.id, users.member);
      expect(remove.success).toBe(true);
      const after = await store.getMembers(group.id);
      expect(after.some((m) => m.userId === users.member)).toBe(false);
    });
  });

  describe("invites", () => {
    it("creates, lists, and resolves invites", async () => {
      const res = await store.createGroup(groupInput);
      const group = res.group!;
      const inviteInput: CreateInviteInput = {
        groupId: group.id,
        inviterId: groupInput.ownerId,
        inviteeId: users.invitee,
      };
      const created = await store.createInvite(inviteInput);
      expect(created.success).toBe(true);
      const invite = created.invite!;
      const pending = await store.listPendingInvites(users.invitee);
      expect(pending.some((i) => i.id === invite.id)).toBe(true);
      const resolved = await store.resolveInvite(invite.id, "accepted");
      expect(resolved.success).toBe(true);
      expect(resolved.invite!.status).toBe("accepted");
      const pendingAfter = await store.listPendingInvites(users.invitee);
      expect(pendingAfter.some((i) => i.id === invite.id)).toBe(false);
    });
  });
}
