/**
 * platform/social/memory-social-store.ts — In-memory social store
 *
 * Default implementation for tests and development.
 * No external dependencies — everything in arrays.
 *
 * P7: Provider-aware — this is the mock/fallback provider.
 * P11: Always available — no network, no failure modes.
 *
 * @module platform/social
 */

import { generateId } from "@/platform/agents/utils";
import type {
  SocialStore,
  Group,
  GroupStatus,
  Membership,
  MemberRole,
  GroupInvite,
  GroupResult,
  InviteResult,
  MembershipResult,
  CreateGroupInput,
  CreateInviteInput,
} from "./types";
import type { AgentIdentity } from "@/platform/agents/types";

export class InMemorySocialStore implements SocialStore {
  private groups: Group[] = [];
  private memberships: Membership[] = [];
  private invites: GroupInvite[] = [];

  // ── Groups ──────────────────────────────────────────────────────────

  async createGroup(
    input: CreateGroupInput,
    _actor?: AgentIdentity
  ): Promise<GroupResult> {
    const now = new Date().toISOString();
    const group: Group = {
      id: generateId(),
      name: input.name,
      description: input.description,
      metadata: input.metadata ?? {},
      ownerId: input.ownerId,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.groups.push(group);

    // Auto-add owner as member with "owner" role
    await this.addMember(group.id, input.ownerId, "owner");

    return { success: true, group };
  }

  async getGroupById(groupId: string): Promise<Group | undefined> {
    return this.groups.find((g) => g.id === groupId);
  }

  async listGroupsForUser(userId: string): Promise<readonly Group[]> {
    const activeGroupIds = this.memberships
      .filter((m) => m.userId === userId && m.leftAt === null)
      .map((m) => m.groupId);
    return this.groups.filter((g) => activeGroupIds.includes(g.id));
  }

  async updateGroupStatus(
    groupId: string,
    newStatus: GroupStatus,
    _actor?: AgentIdentity
  ): Promise<GroupResult> {
    const index = this.groups.findIndex((g) => g.id === groupId);
    if (index === -1) {
      return { success: false, error: "Group not found" };
    }
    const updated: Group = {
      ...this.groups[index],
      status: newStatus,
      updatedAt: new Date().toISOString(),
    };
    this.groups[index] = updated;
    return { success: true, group: updated };
  }

  // ── Memberships ─────────────────────────────────────────────────────

  async addMember(
    groupId: string,
    userId: string,
    role: MemberRole,
    _actor?: AgentIdentity
  ): Promise<MembershipResult> {
    // Check for existing active membership
    const existing = this.memberships.find(
      (m) => m.groupId === groupId && m.userId === userId && m.leftAt === null
    );
    if (existing) {
      return {
        success: false,
        error: "User is already an active member",
      };
    }

    const membership: Membership = {
      id: generateId(),
      groupId,
      userId,
      role,
      joinedAt: new Date().toISOString(),
      leftAt: null,
    };
    this.memberships.push(membership);
    return { success: true, membership };
  }

  async removeMember(
    groupId: string,
    userId: string,
    _actor?: AgentIdentity
  ): Promise<MembershipResult> {
    const index = this.memberships.findIndex(
      (m) => m.groupId === groupId && m.userId === userId && m.leftAt === null
    );
    if (index === -1) {
      return {
        success: false,
        error: "Active membership not found",
      };
    }
    const updated: Membership = {
      ...this.memberships[index],
      leftAt: new Date().toISOString(),
    };
    this.memberships[index] = updated;
    return { success: true, membership: updated };
  }

  async getMembers(groupId: string): Promise<readonly Membership[]> {
    return this.memberships.filter((m) => m.groupId === groupId && m.leftAt === null);
  }

  async getMembership(groupId: string, userId: string): Promise<Membership | undefined> {
    return this.memberships.find((m) => m.groupId === groupId && m.userId === userId);
  }

  // ── Invites ─────────────────────────────────────────────────────────

  async createInvite(
    input: CreateInviteInput,
    _actor?: AgentIdentity
  ): Promise<InviteResult> {
    // Check for existing pending invite
    const existing = this.invites.find(
      (i) =>
        i.groupId === input.groupId &&
        i.inviteeId === input.inviteeId &&
        i.status === "pending"
    );
    if (existing) {
      return {
        success: false,
        error: "Pending invite already exists for this user",
      };
    }

    const invite: GroupInvite = {
      id: generateId(),
      groupId: input.groupId,
      inviterId: input.inviterId,
      inviteeId: input.inviteeId,
      status: "pending",
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    };
    this.invites.push(invite);
    return { success: true, invite };
  }

  async resolveInvite(
    inviteId: string,
    resolution: "accepted" | "declined" | "expired",
    _actor?: AgentIdentity
  ): Promise<InviteResult> {
    const index = this.invites.findIndex((i) => i.id === inviteId);
    if (index === -1) {
      return { success: false, error: "Invite not found" };
    }
    if (this.invites[index].status !== "pending") {
      return {
        success: false,
        error: `Invite already resolved: ${this.invites[index].status}`,
      };
    }
    const updated: GroupInvite = {
      ...this.invites[index],
      status: resolution,
      resolvedAt: new Date().toISOString(),
    };
    this.invites[index] = updated;
    return { success: true, invite: updated };
  }

  async listPendingInvites(userId: string): Promise<readonly GroupInvite[]> {
    return this.invites.filter((i) => i.inviteeId === userId && i.status === "pending");
  }

  async getInviteById(inviteId: string): Promise<GroupInvite | undefined> {
    return this.invites.find((i) => i.id === inviteId);
  }

  // ── Test helpers ────────────────────────────────────────────────────

  /** Get total count of groups (test helper) */
  getGroupCount(): number {
    return this.groups.length;
  }

  /** Get total count of memberships (test helper) */
  getMembershipCount(): number {
    return this.memberships.length;
  }

  /** Get total count of invites (test helper) */
  getInviteCount(): number {
    return this.invites.length;
  }

  /** Clear all data (test helper) */
  clear(): void {
    this.groups = [];
    this.memberships = [];
    this.invites = [];
  }
}
