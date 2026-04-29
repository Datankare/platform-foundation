/**
 * platform/social/types.ts — Social system types
 *
 * Foundational types for groups, memberships, and invites.
 * These types are domain-agnostic — they define the social data
 * vocabulary, not any specific agent's behavior.
 *
 * ADR-021: Social System Architecture
 *
 * GenAI Principles:
 *   P1  — Intent-driven: all operations through typed interfaces
 *   P6  — Structured outputs: all types enforce schemas
 *   P8  — Context/memory: group metadata supports agent memory
 *   P10 — Human oversight: invites require explicit accept/decline
 *   P15 — Agent identity: service methods accept AgentIdentity
 *
 * @module platform/social
 */

import type { AgentIdentity } from "@/platform/agents/types";

// ── Group ─────────────────────────────────────────────────────────────

/** Group lifecycle status */
export type GroupStatus = "active" | "archived" | "suspended";

/**
 * A social group. The core organizational unit for social features.
 *
 * Groups have metadata (JSONB) for agent memory (P8/P16) — agents
 * store per-group context here in Sprint 4b.
 */
export interface Group {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Extensible metadata for agent context (P8, P16) */
  readonly metadata: Record<string, unknown>;
  readonly ownerId: string;
  readonly status: GroupStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Membership ────────────────────────────────────────────────────────

/** Role within a group */
export type MemberRole = "owner" | "admin" | "member";

/**
 * A user's membership in a group.
 * leftAt is set when a user leaves or is removed.
 */
export interface Membership {
  readonly id: string;
  readonly groupId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly joinedAt: string;
  readonly leftAt: string | null;
}

// ── Invite ────────────────────────────────────────────────────────────

/** Invite lifecycle status */
export type InviteStatus = "pending" | "accepted" | "declined" | "expired";

/**
 * An invitation to join a group.
 *
 * P10: Invites require explicit user action (accept/decline).
 * No auto-join — the Gatekeeper agent evaluates in Sprint 4b.
 */
export interface GroupInvite {
  readonly id: string;
  readonly groupId: string;
  readonly inviterId: string;
  readonly inviteeId: string;
  readonly status: InviteStatus;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

// ── Service result types (P6: structured outputs) ─────────────────────

/** Result from group operations */
export interface GroupResult {
  readonly success: boolean;
  readonly group?: Group;
  readonly error?: string;
}

/** Result from invite operations */
export interface InviteResult {
  readonly success: boolean;
  readonly invite?: GroupInvite;
  readonly error?: string;
}

/** Result from membership operations */
export interface MembershipResult {
  readonly success: boolean;
  readonly membership?: Membership;
  readonly error?: string;
}

// ── Input types for create operations ─────────────────────────────────

/** Input for creating a group */
export interface CreateGroupInput {
  readonly name: string;
  readonly description: string;
  readonly ownerId: string;
  readonly metadata?: Record<string, unknown>;
}

/** Input for creating an invite */
export interface CreateInviteInput {
  readonly groupId: string;
  readonly inviterId: string;
  readonly inviteeId: string;
}

// ── Social store interface (P7: provider-aware) ───────────────────────

/**
 * SocialStore — persistence interface for groups, memberships, invites.
 *
 * Implementations:
 *   InMemorySocialStore — for tests and development (default)
 *   SupabaseSocialStore — for production
 *
 * P7: Provider-aware — swap via SOCIAL_STORE env var.
 * P4: All writes accept optional AgentIdentity for audit.
 */
export interface SocialStore {
  // ── Groups ────────────────────────────────────────────────────────

  /** Create a group. Returns the created group or error. */
  createGroup(input: CreateGroupInput, actor?: AgentIdentity): Promise<GroupResult>;

  /** Get a group by ID. Returns undefined if not found. */
  getGroupById(groupId: string): Promise<Group | undefined>;

  /** List groups a user belongs to (active memberships). */
  listGroupsForUser(userId: string): Promise<readonly Group[]>;

  /** Update group status (active/archived/suspended). */
  updateGroupStatus(
    groupId: string,
    status: GroupStatus,
    actor?: AgentIdentity
  ): Promise<GroupResult>;

  // ── Memberships ───────────────────────────────────────────────────

  /** Add a member to a group. */
  addMember(
    groupId: string,
    userId: string,
    role: MemberRole,
    actor?: AgentIdentity
  ): Promise<MembershipResult>;

  /** Remove a member (sets leftAt). */
  removeMember(
    groupId: string,
    userId: string,
    actor?: AgentIdentity
  ): Promise<MembershipResult>;

  /** Get active members of a group. */
  getMembers(groupId: string): Promise<readonly Membership[]>;

  /** Get a specific membership (active or not). */
  getMembership(groupId: string, userId: string): Promise<Membership | undefined>;

  // ── Invites ───────────────────────────────────────────────────────

  /** Create an invite. */
  createInvite(input: CreateInviteInput, actor?: AgentIdentity): Promise<InviteResult>;

  /** Resolve an invite (accept/decline/expire). */
  resolveInvite(
    inviteId: string,
    status: "accepted" | "declined" | "expired",
    actor?: AgentIdentity
  ): Promise<InviteResult>;

  /** List pending invites for a user. */
  listPendingInvites(userId: string): Promise<readonly GroupInvite[]>;

  /** Get an invite by ID. */
  getInviteById(inviteId: string): Promise<GroupInvite | undefined>;
}

// ── Gotchas ───────────────────────────────────────────────────────────
//
// (L17) Module-level gotchas — add issues here as they're discovered.
//
// 1. Group.metadata is Record<string, unknown> — always validate
//    structure before accessing nested fields. Use type guards.
//
// 2. Membership.leftAt being set does NOT delete the record. Queries
//    for "active members" must filter where leftAt IS NULL.
//
// 3. InviteStatus transitions are one-way: pending → accepted/declined/
//    expired. Never transition from a resolved status back to pending.
//
