/**
 * platform/social/supabase-social-store.ts — Supabase social store
 *
 * Production implementation using Supabase REST API via raw fetch().
 * Follows SupabaseModerationStore pattern — no Supabase JS client needed.
 *
 * P7:  Provider-aware — swap via SOCIAL_STORE env var
 * P11: Store failures logged, not thrown (for reads); writes surface errors
 *
 * @module platform/social
 */

import { logger } from "@/lib/logger";
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
// Helpers
// ---------------------------------------------------------------------------

function headers(supabaseKey: string, prefer?: string): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  };
  if (prefer) h["Prefer"] = prefer;
  return h;
}

function mapGroupRow(row: Record<string, unknown>): Group {
  return {
    id: String(row.id ?? ""),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    metadata:
      typeof row.metadata === "object" && row.metadata !== null
        ? (row.metadata as Record<string, unknown>)
        : {},
    ownerId: String(row.owner_id ?? ""),
    status: (row.status as GroupStatus) ?? "active",
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapMembershipRow(row: Record<string, unknown>): Membership {
  return {
    id: String(row.id ?? ""),
    groupId: String(row.group_id ?? ""),
    userId: String(row.user_id ?? ""),
    role: (row.role as MemberRole) ?? "member",
    joinedAt: String(row.joined_at ?? ""),
    leftAt: row.left_at ? String(row.left_at) : null,
  };
}

function mapInviteRow(row: Record<string, unknown>): GroupInvite {
  return {
    id: String(row.id ?? ""),
    groupId: String(row.group_id ?? ""),
    inviterId: String(row.inviter_id ?? ""),
    inviteeId: String(row.invitee_id ?? ""),
    status: (row.status as GroupInvite["status"]) ?? "pending",
    createdAt: String(row.created_at ?? ""),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : null,
  };
}

// ---------------------------------------------------------------------------
// SupabaseSocialStore
// ---------------------------------------------------------------------------

export class SupabaseSocialStore implements SocialStore {
  private readonly url: string;
  private readonly key: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    if (typeof window !== "undefined") {
      throw new Error(
        "SupabaseSocialStore must not be instantiated client-side — service role key would leak"
      );
    }
    this.url = supabaseUrl;
    this.key = supabaseKey;
  }

  // ── Groups ──────────────────────────────────────────────────────────

  async createGroup(
    input: CreateGroupInput,
    _actor?: AgentIdentity
  ): Promise<GroupResult> {
    try {
      const response = await fetch(`${this.url}/rest/v1/groups`, {
        method: "POST",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          name: input.name,
          description: input.description,
          metadata: input.metadata ?? {},
          owner_id: input.ownerId,
          status: "active",
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.error("Social store: createGroup failed", {
          status: response.status,
          body: text,
        });
        return {
          success: false,
          error: `Database error: ${response.status}`,
        };
      }

      const rows = await response.json();
      const group = mapGroupRow(Array.isArray(rows) ? rows[0] : rows);

      // Auto-add owner as member
      await this.addMember(group.id, input.ownerId, "owner");

      return { success: true, group };
    } catch (err) {
      logger.error("Social store: createGroup error", {
        error: err instanceof Error ? err.message : "Unknown",
      });
      return { success: false, error: "Store unavailable" };
    }
  }

  async getGroupById(groupId: string): Promise<Group | undefined> {
    try {
      const response = await fetch(
        `${this.url}/rest/v1/groups?id=eq.${groupId}&limit=1`,
        { headers: headers(this.key) }
      );
      if (!response.ok) return undefined;
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) return undefined;
      return mapGroupRow(rows[0]);
    } catch {
      return undefined;
    }
  }

  async listGroupsForUser(userId: string): Promise<readonly Group[]> {
    try {
      // Get active membership group IDs
      const memResponse = await fetch(
        `${this.url}/rest/v1/group_memberships?user_id=eq.${userId}&left_at=is.null&select=group_id`,
        { headers: headers(this.key) }
      );
      if (!memResponse.ok) return [];
      const memberships = await memResponse.json();
      if (!Array.isArray(memberships) || memberships.length === 0) return [];

      const groupIds = memberships
        .map((m: Record<string, unknown>) => String(m.group_id))
        .join(",");

      const grpResponse = await fetch(`${this.url}/rest/v1/groups?id=in.(${groupIds})`, {
        headers: headers(this.key),
      });
      if (!grpResponse.ok) return [];
      const rows = await grpResponse.json();
      return Array.isArray(rows) ? rows.map(mapGroupRow) : [];
    } catch {
      return [];
    }
  }

  async updateGroupStatus(
    groupId: string,
    status: GroupStatus,
    _actor?: AgentIdentity
  ): Promise<GroupResult> {
    try {
      const response = await fetch(`${this.url}/rest/v1/groups?id=eq.${groupId}`, {
        method: "PATCH",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        return {
          success: false,
          error: `Database error: ${response.status}`,
        };
      }
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return { success: false, error: "Group not found" };
      }
      return { success: true, group: mapGroupRow(rows[0]) };
    } catch {
      return { success: false, error: "Store unavailable" };
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
      const response = await fetch(`${this.url}/rest/v1/group_memberships`, {
        method: "POST",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          group_id: groupId,
          user_id: userId,
          role,
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        // Unique constraint violation = duplicate
        if (response.status === 409 || text.includes("duplicate")) {
          return {
            success: false,
            error: "User is already an active member",
          };
        }
        return {
          success: false,
          error: `Database error: ${response.status}`,
        };
      }
      const rows = await response.json();
      const membership = mapMembershipRow(Array.isArray(rows) ? rows[0] : rows);
      return { success: true, membership };
    } catch {
      return {
        success: false,
        error: "Store unavailable",
      };
    }
  }

  async removeMember(
    groupId: string,
    userId: string,
    _actor?: AgentIdentity
  ): Promise<MembershipResult> {
    try {
      const response = await fetch(
        `${this.url}/rest/v1/group_memberships?group_id=eq.${groupId}&user_id=eq.${userId}&left_at=is.null`,
        {
          method: "PATCH",
          headers: headers(this.key, "return=representation"),
          body: JSON.stringify({
            left_at: new Date().toISOString(),
          }),
        }
      );
      if (!response.ok) {
        return {
          success: false,
          error: "Active membership not found",
        };
      }
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return {
          success: false,
          error: "Active membership not found",
        };
      }
      return {
        success: true,
        membership: mapMembershipRow(rows[0]),
      };
    } catch {
      return {
        success: false,
        error: "Store unavailable",
      };
    }
  }

  async getMembers(groupId: string): Promise<readonly Membership[]> {
    try {
      const response = await fetch(
        `${this.url}/rest/v1/group_memberships?group_id=eq.${groupId}&left_at=is.null`,
        { headers: headers(this.key) }
      );
      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows.map(mapMembershipRow) : [];
    } catch {
      return [];
    }
  }

  async getMembership(groupId: string, userId: string): Promise<Membership | undefined> {
    try {
      const response = await fetch(
        `${this.url}/rest/v1/group_memberships?group_id=eq.${groupId}&user_id=eq.${userId}&order=joined_at.desc&limit=1`,
        { headers: headers(this.key) }
      );
      if (!response.ok) return undefined;
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) return undefined;
      return mapMembershipRow(rows[0]);
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
      const response = await fetch(`${this.url}/rest/v1/group_invites`, {
        method: "POST",
        headers: headers(this.key, "return=representation"),
        body: JSON.stringify({
          group_id: input.groupId,
          inviter_id: input.inviterId,
          invitee_id: input.inviteeId,
          status: "pending",
        }),
      });
      if (!response.ok) {
        const text = await response.text();
        if (response.status === 409 || text.includes("duplicate")) {
          return {
            success: false,
            error: "Pending invite already exists for this user",
          };
        }
        return {
          success: false,
          error: `Database error: ${response.status}`,
        };
      }
      const rows = await response.json();
      const invite = mapInviteRow(Array.isArray(rows) ? rows[0] : rows);
      return { success: true, invite };
    } catch {
      return {
        success: false,
        error: "Store unavailable",
      };
    }
  }

  async resolveInvite(
    inviteId: string,
    resolution: "accepted" | "declined" | "expired",
    _actor?: AgentIdentity
  ): Promise<InviteResult> {
    try {
      // Only resolve pending invites
      const response = await fetch(
        `${this.url}/rest/v1/group_invites?id=eq.${inviteId}&status=eq.pending`,
        {
          method: "PATCH",
          headers: headers(this.key, "return=representation"),
          body: JSON.stringify({
            status: resolution,
            resolved_at: new Date().toISOString(),
          }),
        }
      );
      if (!response.ok) {
        return {
          success: false,
          error: `Database error: ${response.status}`,
        };
      }
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        return {
          success: false,
          error: "Invite not found or already resolved",
        };
      }
      return {
        success: true,
        invite: mapInviteRow(rows[0]),
      };
    } catch {
      return {
        success: false,
        error: "Store unavailable",
      };
    }
  }

  async listPendingInvites(userId: string): Promise<readonly GroupInvite[]> {
    try {
      const response = await fetch(
        `${this.url}/rest/v1/group_invites?invitee_id=eq.${userId}&status=eq.pending&order=created_at.desc`,
        { headers: headers(this.key) }
      );
      if (!response.ok) return [];
      const rows = await response.json();
      return Array.isArray(rows) ? rows.map(mapInviteRow) : [];
    } catch {
      return [];
    }
  }

  async getInviteById(inviteId: string): Promise<GroupInvite | undefined> {
    try {
      const response = await fetch(
        `${this.url}/rest/v1/group_invites?id=eq.${inviteId}&limit=1`,
        { headers: headers(this.key) }
      );
      if (!response.ok) return undefined;
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.length === 0) return undefined;
      return mapInviteRow(rows[0]);
    } catch {
      return undefined;
    }
  }
}
