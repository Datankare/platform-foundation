/**
 * platform/social/postgres-social-store.ts — Postgres social store (ADR-053 D4)
 *
 * Groups, memberships and invites in the request's tenant, through platform/data: row-level
 * security keeps each tenant's groups apart, and the (tenant_id, …) foreign keys mean a group,
 * member or invitee is always of the same tenant. tenant_id is filled by its column default.
 *
 * A group and its owner's membership are written in one transaction, so a group never exists
 * without its owner. The partial unique indexes (one active membership per user and group, one
 * pending invite per invitee and group) decide duplicates, so concurrent adds cannot both win.
 *
 * P7:  Provider-aware — swap via SOCIAL_STORE env var
 * P11: Store failures logged, not thrown (for reads); writes surface errors
 *
 * @module platform/social
 */

import { logger } from "@/lib/logger";
import { DataUnavailableError, withTenantTx, type Tx } from "@/platform/data";
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

// ---------------------------------------------------------------------------
// Rows and mapping (timestamptz arrives as Date, jsonb parsed)
// ---------------------------------------------------------------------------

interface GroupRow {
  id: string;
  name: string;
  description: string;
  metadata: Record<string, unknown> | null;
  owner_id: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

interface MembershipRow {
  id: string;
  group_id: string;
  user_id: string;
  role: string;
  joined_at: Date;
  left_at: Date | null;
}

interface InviteRow {
  id: string;
  group_id: string;
  inviter_id: string;
  invitee_id: string;
  status: string;
  created_at: Date;
  resolved_at: Date | null;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : d);

function mapGroupRow(row: GroupRow): Group {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metadata:
      typeof row.metadata === "object" && row.metadata !== null ? row.metadata : {},
    ownerId: row.owner_id,
    status: row.status as GroupStatus,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapMembershipRow(row: MembershipRow): Membership {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    role: row.role as MemberRole,
    joinedAt: iso(row.joined_at),
    leftAt: row.left_at ? iso(row.left_at) : null,
  };
}

function mapInviteRow(row: InviteRow): GroupInvite {
  return {
    id: row.id,
    groupId: row.group_id,
    inviterId: row.inviter_id,
    inviteeId: row.invitee_id,
    status: row.status as GroupInvite["status"],
    createdAt: iso(row.created_at),
    resolvedAt: row.resolved_at ? iso(row.resolved_at) : null,
  };
}

/** Postgres unique_violation. */
const isUniqueViolation = (err: unknown) =>
  (err as { code?: unknown } | null)?.code === "23505";

/** A database refusal as the REST store reported it; an unreachable database as unavailable. */
function writeError(err: unknown): string {
  if (err instanceof DataUnavailableError) return "Store unavailable";
  const code = (err as { code?: unknown } | null)?.code;
  return `Database error: ${typeof code === "string" ? code : "unknown"}`;
}

async function insertMember(
  tx: Tx,
  groupId: string,
  userId: string,
  role: MemberRole
): Promise<Membership> {
  const { rows } = await tx.query<MembershipRow>(
    `insert into group_memberships (group_id, user_id, role)
     values ($1::uuid, $2::uuid, $3::member_role)
     returning id, group_id, user_id, role, joined_at, left_at`,
    [groupId, userId, role]
  );
  return mapMembershipRow(rows[0]);
}

// ---------------------------------------------------------------------------
// PostgresSocialStore
// ---------------------------------------------------------------------------

export class PostgresSocialStore implements SocialStore {
  // ── Groups ──────────────────────────────────────────────────────────

  async createGroup(
    input: CreateGroupInput,
    _actor?: AgentIdentity
  ): Promise<GroupResult> {
    try {
      const group = await withTenantTx(async (tx) => {
        const { rows } = await tx.query<GroupRow>(
          `insert into groups (name, description, metadata, owner_id, status)
           values ($1, coalesce($2, ''), $3::jsonb, $4::uuid, 'active')
           returning id, name, description, metadata, owner_id, status, created_at,
             updated_at`,
          [
            input.name,
            input.description ?? null,
            JSON.stringify(input.metadata ?? {}),
            input.ownerId,
          ]
        );
        const created = mapGroupRow(rows[0]);
        // The owner is a member from the start, in the same transaction.
        await insertMember(tx, created.id, input.ownerId, "owner");
        return created;
      });
      return { success: true, group };
    } catch (err) {
      logger.error("Social store: createGroup failed", {
        error: err instanceof Error ? err.message : "Unknown",
      });
      return { success: false, error: writeError(err) };
    }
  }

  async getGroupById(groupId: string): Promise<Group | undefined> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<GroupRow>(
          `select id, name, description, metadata, owner_id, status, created_at, updated_at
             from groups where id = $1::uuid`,
          [groupId]
        )
      );
      return rows[0] ? mapGroupRow(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  async listGroupsForUser(userId: string): Promise<readonly Group[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<GroupRow>(
          `select g.id, g.name, g.description, g.metadata, g.owner_id, g.status,
                  g.created_at, g.updated_at
             from groups g
            where g.id in (select m.group_id from group_memberships m
                            where m.user_id = $1::uuid and m.left_at is null)`,
          [userId]
        )
      );
      return rows.map(mapGroupRow);
    } catch {
      return [];
    }
  }

  async listActiveGroups(options: {
    readonly after?: string;
    readonly limit: number;
  }): Promise<readonly Group[]> {
    const limit = Math.min(Math.max(Math.floor(options.limit), 1), 200);
    // Read for a job that must not mistake an outage for "no groups": failures propagate.
    const { rows } = await withTenantTx((tx) =>
      tx.query<GroupRow>(
        `select id, name, description, metadata, owner_id, status, created_at, updated_at
           from groups
          where status = 'active' and ($1::uuid is null or id > $1::uuid)
          order by id
          limit $2::int`,
        [options.after ?? null, limit]
      )
    );
    return rows.map(mapGroupRow);
  }

  async updateGroupStatus(
    groupId: string,
    status: GroupStatus,
    _actor?: AgentIdentity
  ): Promise<GroupResult> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<GroupRow>(
          `update groups set status = $2::group_status where id = $1::uuid
           returning id, name, description, metadata, owner_id, status, created_at,
             updated_at`,
          [groupId, status]
        )
      );
      if (!rows[0]) return { success: false, error: "Group not found" };
      return { success: true, group: mapGroupRow(rows[0]) };
    } catch (err) {
      return { success: false, error: writeError(err) };
    }
  }

  // ── Memberships ─────────────────────────────────────────────────────

  async addMember(
    groupId: string,
    userId: string,
    role: MemberRole,
    _actor?: AgentIdentity
  ): Promise<MembershipResult> {
    try {
      const membership = await withTenantTx((tx) =>
        insertMember(tx, groupId, userId, role)
      );
      return { success: true, membership };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { success: false, error: "User is already an active member" };
      }
      return { success: false, error: writeError(err) };
    }
  }

  async removeMember(
    groupId: string,
    userId: string,
    _actor?: AgentIdentity
  ): Promise<MembershipResult> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<MembershipRow>(
          `update group_memberships set left_at = now()
            where group_id = $1::uuid and user_id = $2::uuid and left_at is null
           returning id, group_id, user_id, role, joined_at, left_at`,
          [groupId, userId]
        )
      );
      if (!rows[0]) return { success: false, error: "Active membership not found" };
      return { success: true, membership: mapMembershipRow(rows[0]) };
    } catch (err) {
      // As the REST store answered: a refused request is "not found", an unreachable store
      // is "unavailable".
      return {
        success: false,
        error:
          err instanceof DataUnavailableError
            ? "Store unavailable"
            : "Active membership not found",
      };
    }
  }

  async getMembers(groupId: string): Promise<readonly Membership[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<MembershipRow>(
          `select id, group_id, user_id, role, joined_at, left_at
             from group_memberships
            where group_id = $1::uuid and left_at is null`,
          [groupId]
        )
      );
      return rows.map(mapMembershipRow);
    } catch {
      return [];
    }
  }

  async getMembership(groupId: string, userId: string): Promise<Membership | undefined> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<MembershipRow>(
          `select id, group_id, user_id, role, joined_at, left_at
             from group_memberships
            where group_id = $1::uuid and user_id = $2::uuid
            order by joined_at desc
            limit 1`,
          [groupId, userId]
        )
      );
      return rows[0] ? mapMembershipRow(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }

  // ── Invites ─────────────────────────────────────────────────────────

  async createInvite(
    input: CreateInviteInput,
    _actor?: AgentIdentity
  ): Promise<InviteResult> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<InviteRow>(
          `insert into group_invites (group_id, inviter_id, invitee_id, status)
           values ($1::uuid, $2::uuid, $3::uuid, 'pending')
           returning id, group_id, inviter_id, invitee_id, status, created_at, resolved_at`,
          [input.groupId, input.inviterId, input.inviteeId]
        )
      );
      return { success: true, invite: mapInviteRow(rows[0]) };
    } catch (err) {
      if (isUniqueViolation(err)) {
        return { success: false, error: "Pending invite already exists for this user" };
      }
      return { success: false, error: writeError(err) };
    }
  }

  async resolveInvite(
    inviteId: string,
    resolution: "accepted" | "declined" | "expired",
    _actor?: AgentIdentity
  ): Promise<InviteResult> {
    try {
      // Only a pending invite is resolved; the condition makes a second resolution match none.
      const { rows } = await withTenantTx((tx) =>
        tx.query<InviteRow>(
          `update group_invites set status = $2::invite_status, resolved_at = now()
            where id = $1::uuid and status = 'pending'
           returning id, group_id, inviter_id, invitee_id, status, created_at, resolved_at`,
          [inviteId, resolution]
        )
      );
      if (!rows[0]) {
        return { success: false, error: "Invite not found or already resolved" };
      }
      return { success: true, invite: mapInviteRow(rows[0]) };
    } catch (err) {
      return { success: false, error: writeError(err) };
    }
  }

  async listPendingInvites(userId: string): Promise<readonly GroupInvite[]> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<InviteRow>(
          `select id, group_id, inviter_id, invitee_id, status, created_at, resolved_at
             from group_invites
            where invitee_id = $1::uuid and status = 'pending'
            order by created_at desc`,
          [userId]
        )
      );
      return rows.map(mapInviteRow);
    } catch {
      return [];
    }
  }

  async getInviteById(inviteId: string): Promise<GroupInvite | undefined> {
    try {
      const { rows } = await withTenantTx((tx) =>
        tx.query<InviteRow>(
          `select id, group_id, inviter_id, invitee_id, status, created_at, resolved_at
             from group_invites where id = $1::uuid`,
          [inviteId]
        )
      );
      return rows[0] ? mapInviteRow(rows[0]) : undefined;
    } catch {
      return undefined;
    }
  }
}
