/**
 * platform/social/group-service.ts — Group business logic
 *
 * Coordinates group operations with validation, authorization,
 * and content screening hooks. Delegates persistence to SocialStore.
 *
 * P1:  Intent-driven — typed methods, not raw store calls
 * P4:  Structural safety — screenContent hook for Guardian (Sprint 4b)
 * P6:  Structured outputs — GroupResult on every operation
 * P10: Human oversight — ownership checks on destructive ops
 * P13: Control plane — name/description length limits from config
 * P15: Agent identity — actor passed through to store
 *
 * @module platform/social
 */

import type { AgentIdentity } from "@/platform/agents/types";
import type {
  SocialStore,
  Group,
  GroupStatus,
  GroupResult,
  CreateGroupInput,
} from "./types";

// ---------------------------------------------------------------------------
// Configuration (P13: control plane — externalize in Sprint 4b)
// ---------------------------------------------------------------------------

/** Group validation limits. Hardcoded now; config-driven in Sprint 4b. */
export const GROUP_LIMITS = {
  /** Minimum group name length */
  minNameLength: 3,
  /** Maximum group name length */
  maxNameLength: 100,
  /** Maximum description length */
  maxDescriptionLength: 500,
} as const;

// ---------------------------------------------------------------------------
// Content screening hook (P4)
// ---------------------------------------------------------------------------

/**
 * Optional content screening function.
 * Returns null if content is clean, or an error string if blocked.
 * Wired to Guardian agent in Sprint 4b.
 */
export type ScreenContentFn = (
  text: string,
  contentType: "group-name" | "group-description"
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// GroupService
// ---------------------------------------------------------------------------

export class GroupService {
  private readonly store: SocialStore;
  private readonly screenContent: ScreenContentFn | null;

  constructor(store: SocialStore, screenContent?: ScreenContentFn) {
    this.store = store;
    this.screenContent = screenContent ?? null;
  }

  /**
   * Create a new group.
   * Validates input, screens content (if hook provided), delegates to store.
   */
  async createGroup(
    input: CreateGroupInput,
    actor?: AgentIdentity
  ): Promise<GroupResult> {
    // ── Validate ────────────────────────────────────────────────
    const nameError = validateName(input.name);
    if (nameError) {
      return { success: false, error: nameError };
    }

    const descError = validateDescription(input.description);
    if (descError) {
      return { success: false, error: descError };
    }

    if (!input.ownerId) {
      return { success: false, error: "Owner ID is required" };
    }

    // ── Screen content (P4) ─────────────────────────────────────
    if (this.screenContent) {
      const nameBlock = await this.screenContent(input.name, "group-name");
      if (nameBlock) {
        return { success: false, error: nameBlock };
      }

      const descBlock = await this.screenContent(input.description, "group-description");
      if (descBlock) {
        return { success: false, error: descBlock };
      }
    }

    // ── Persist ─────────────────────────────────────────────────
    return this.store.createGroup(input, actor);
  }

  /** Get a group by ID. */
  async getGroupById(groupId: string): Promise<Group | undefined> {
    return this.store.getGroupById(groupId);
  }

  /** List groups for a user (active memberships). */
  async listGroupsForUser(userId: string): Promise<readonly Group[]> {
    return this.store.listGroupsForUser(userId);
  }

  /**
   * Archive a group. Only the owner can archive.
   * P10: ownership check before destructive operation.
   */
  async archiveGroup(
    groupId: string,
    requesterId: string,
    actor?: AgentIdentity
  ): Promise<GroupResult> {
    const group = await this.store.getGroupById(groupId);
    if (!group) {
      return { success: false, error: "Group not found" };
    }
    if (group.ownerId !== requesterId) {
      return {
        success: false,
        error: "Only the group owner can archive",
      };
    }
    if (group.status === "archived") {
      return {
        success: false,
        error: "Group is already archived",
      };
    }
    return this.store.updateGroupStatus(groupId, "archived", actor);
  }

  /**
   * Update group status (admin/system action).
   * Accepts any valid status transition.
   */
  async updateGroupStatus(
    groupId: string,
    status: GroupStatus,
    actor?: AgentIdentity
  ): Promise<GroupResult> {
    return this.store.updateGroupStatus(groupId, status, actor);
  }
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < GROUP_LIMITS.minNameLength) {
    return `Group name must be at least ${GROUP_LIMITS.minNameLength} characters`;
  }
  if (trimmed.length > GROUP_LIMITS.maxNameLength) {
    return `Group name must be at most ${GROUP_LIMITS.maxNameLength} characters`;
  }
  return null;
}

function validateDescription(description: string): string | null {
  if (description.length > GROUP_LIMITS.maxDescriptionLength) {
    return `Description must be at most ${GROUP_LIMITS.maxDescriptionLength} characters`;
  }
  return null;
}
