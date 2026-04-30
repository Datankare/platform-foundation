/**
 * platform/social/invite-service.ts — Invite business logic
 *
 * Coordinates invite lifecycle: create, accept (→ add member),
 * decline, list pending. Enforces authorization at every step.
 *
 * P1:  Intent-driven — typed methods
 * P6:  Structured outputs — InviteResult on every operation
 * P10: Human oversight — invites require explicit accept/decline
 * P15: Agent identity — actor passed through to store
 *
 * @module platform/social
 */

import type { AgentIdentity } from "@/platform/agents/types";
import type { SocialStore, GroupInvite, InviteResult, CreateInviteInput } from "./types";

export class InviteService {
  private readonly store: SocialStore;

  constructor(store: SocialStore) {
    this.store = store;
  }

  /**
   * Create an invite.
   *
   * Validates:
   * - Group exists
   * - Inviter is an active member of the group
   * - Invitee is not already an active member
   * - No duplicate pending invite
   */
  async createInvite(
    input: CreateInviteInput,
    actor?: AgentIdentity
  ): Promise<InviteResult> {
    // ── Validate group exists ───────────────────────────────────
    const group = await this.store.getGroupById(input.groupId);
    if (!group) {
      return { success: false, error: "Group not found" };
    }
    if (group.status !== "active") {
      return {
        success: false,
        error: "Cannot invite to a non-active group",
      };
    }

    // ── Self-invite check ───────────────────────────────────────
    if (input.inviterId === input.inviteeId) {
      return {
        success: false,
        error: "Cannot invite yourself",
      };
    }

    // ── Validate inviter is member ──────────────────────────────
    const inviterMembership = await this.store.getMembership(
      input.groupId,
      input.inviterId
    );
    if (!inviterMembership || inviterMembership.leftAt !== null) {
      return {
        success: false,
        error: "Inviter is not an active member of the group",
      };
    }

    // ── Validate invitee is not already member ──────────────────
    const inviteeMembership = await this.store.getMembership(
      input.groupId,
      input.inviteeId
    );
    if (inviteeMembership && inviteeMembership.leftAt === null) {
      return {
        success: false,
        error: "User is already an active member",
      };
    }

    // ── Delegate to store (handles duplicate pending check) ─────
    return this.store.createInvite(input, actor);
  }

  /**
   * Accept an invite.
   *
   * P10: Only the invitee can accept. Accepting auto-adds as member.
   */
  async acceptInvite(
    inviteId: string,
    accepterId: string,
    actor?: AgentIdentity
  ): Promise<InviteResult> {
    const invite = await this.store.getInviteById(inviteId);
    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    // Authorization: only the invitee can accept
    if (invite.inviteeId !== accepterId) {
      return {
        success: false,
        error: "Only the invitee can accept this invite",
      };
    }

    // Resolve the invite
    const result = await this.store.resolveInvite(inviteId, "accepted", actor);
    if (!result.success) return result;

    // Auto-add as member (P10: invite accepted = explicit consent)
    const memberResult = await this.store.addMember(
      invite.groupId,
      invite.inviteeId,
      "member",
      actor
    );
    if (!memberResult.success) {
      return {
        success: false,
        error: `Invite accepted but membership failed: ${memberResult.error}`,
      };
    }

    return result;
  }

  /**
   * Decline an invite.
   * P10: Only the invitee can decline.
   */
  async declineInvite(
    inviteId: string,
    declinerId: string,
    actor?: AgentIdentity
  ): Promise<InviteResult> {
    const invite = await this.store.getInviteById(inviteId);
    if (!invite) {
      return { success: false, error: "Invite not found" };
    }

    if (invite.inviteeId !== declinerId) {
      return {
        success: false,
        error: "Only the invitee can decline this invite",
      };
    }

    return this.store.resolveInvite(inviteId, "declined", actor);
  }

  /** List pending invites for a user. */
  async listPendingInvites(userId: string): Promise<readonly GroupInvite[]> {
    return this.store.listPendingInvites(userId);
  }

  /** Get an invite by ID. */
  async getInviteById(inviteId: string): Promise<GroupInvite | undefined> {
    return this.store.getInviteById(inviteId);
  }
}
