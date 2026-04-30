/**
 * platform/social/__tests__/group-service.test.ts
 *
 * Tests for GroupService business logic.
 * Uses InMemorySocialStore (no DB mocks needed).
 * Covers: validation, content screening hook, ownership checks,
 * archive flow, edge cases.
 */

import { GroupService, GROUP_LIMITS } from "../group-service";
import type { ScreenContentFn } from "../group-service";
import { InMemorySocialStore } from "../memory-social-store";
import type { CreateGroupInput } from "../types";

// ── Helpers ─────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateGroupInput> = {}): CreateGroupInput {
  return {
    name: "Test Group",
    description: "A group for testing",
    ownerId: "owner-1",
    ...overrides,
  };
}

function createService(screenContent?: ScreenContentFn): {
  service: GroupService;
  store: InMemorySocialStore;
} {
  const store = new InMemorySocialStore();
  const service = new GroupService(store, screenContent);
  return { service, store };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("GroupService", () => {
  // ── createGroup ───────────────────────────────────────────────────

  describe("createGroup", () => {
    it("creates a group with valid input", async () => {
      const { service } = createService();
      const result = await service.createGroup(makeInput());

      expect(result.success).toBe(true);
      expect(result.group).toBeDefined();
      expect(result.group!.name).toBe("Test Group");
    });

    it("rejects name shorter than minimum", async () => {
      const { service } = createService();
      const result = await service.createGroup(makeInput({ name: "ab" }));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        new RegExp(`at least ${GROUP_LIMITS.minNameLength} characters`)
      );
    });

    it("rejects name longer than maximum", async () => {
      const { service } = createService();
      const result = await service.createGroup(makeInput({ name: "x".repeat(101) }));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(
        new RegExp(`at most ${GROUP_LIMITS.maxNameLength} characters`)
      );
    });

    it("rejects whitespace-only name", async () => {
      const { service } = createService();
      const result = await service.createGroup(makeInput({ name: "   " }));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/at least/);
    });

    it("rejects description longer than maximum", async () => {
      const { service } = createService();
      const result = await service.createGroup(
        makeInput({
          description: "x".repeat(501),
        })
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/at most/);
    });

    it("rejects empty ownerId", async () => {
      const { service } = createService();
      const result = await service.createGroup(makeInput({ ownerId: "" }));

      expect(result.success).toBe(false);
      expect(result.error).toBe("Owner ID is required");
    });

    it("calls screenContent hook on name and description", async () => {
      const screenFn = jest.fn().mockResolvedValue(null);
      const { service } = createService(screenFn);

      await service.createGroup(makeInput());

      expect(screenFn).toHaveBeenCalledTimes(2);
      expect(screenFn).toHaveBeenCalledWith("Test Group", "group-name");
      expect(screenFn).toHaveBeenCalledWith("A group for testing", "group-description");
    });

    it("blocks group when screenContent rejects name", async () => {
      const screenFn = jest
        .fn()
        .mockResolvedValueOnce("Name contains prohibited content");
      const { service } = createService(screenFn);

      const result = await service.createGroup(makeInput());

      expect(result.success).toBe(false);
      expect(result.error).toBe("Name contains prohibited content");
    });

    it("blocks group when screenContent rejects description", async () => {
      const screenFn = jest
        .fn()
        .mockResolvedValueOnce(null) // name passes
        .mockResolvedValueOnce("Description blocked");
      const { service } = createService(screenFn);

      const result = await service.createGroup(makeInput());

      expect(result.success).toBe(false);
      expect(result.error).toBe("Description blocked");
    });

    it("skips screening when no hook provided", async () => {
      const { service } = createService(); // no screenFn
      const result = await service.createGroup(makeInput());

      expect(result.success).toBe(true);
    });
  });

  // ── getGroupById ──────────────────────────────────────────────────

  describe("getGroupById", () => {
    it("returns group when found", async () => {
      const { service } = createService();
      const created = await service.createGroup(makeInput());
      const found = await service.getGroupById(created.group!.id);

      expect(found).toBeDefined();
      expect(found!.name).toBe("Test Group");
    });

    it("returns undefined when not found", async () => {
      const { service } = createService();
      const found = await service.getGroupById("nonexistent");
      expect(found).toBeUndefined();
    });
  });

  // ── listGroupsForUser ─────────────────────────────────────────────

  describe("listGroupsForUser", () => {
    it("delegates to store", async () => {
      const { service } = createService();
      await service.createGroup(makeInput());
      await service.createGroup(makeInput({ name: "Group 2" }));

      const groups = await service.listGroupsForUser("owner-1");
      expect(groups).toHaveLength(2);
    });
  });

  // ── archiveGroup ──────────────────────────────────────────────────

  describe("archiveGroup", () => {
    it("archives when requester is owner", async () => {
      const { service } = createService();
      const created = await service.createGroup(makeInput());

      const result = await service.archiveGroup(created.group!.id, "owner-1");

      expect(result.success).toBe(true);
      expect(result.group!.status).toBe("archived");
    });

    it("rejects archive by non-owner", async () => {
      const { service, store } = createService();
      const created = await service.createGroup(makeInput());
      await store.addMember(created.group!.id, "user-2", "member");

      const result = await service.archiveGroup(created.group!.id, "user-2");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Only the group owner can archive");
    });

    it("rejects archive of nonexistent group", async () => {
      const { service } = createService();
      const result = await service.archiveGroup("nonexistent", "owner-1");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Group not found");
    });

    it("rejects archive of already-archived group", async () => {
      const { service } = createService();
      const created = await service.createGroup(makeInput());
      await service.archiveGroup(created.group!.id, "owner-1");

      const result = await service.archiveGroup(created.group!.id, "owner-1");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Group is already archived");
    });
  });

  // ── updateGroupStatus ─────────────────────────────────────────────

  describe("updateGroupStatus", () => {
    it("delegates to store for status updates", async () => {
      const { service } = createService();
      const created = await service.createGroup(makeInput());

      const result = await service.updateGroupStatus(created.group!.id, "suspended");

      expect(result.success).toBe(true);
      expect(result.group!.status).toBe("suspended");
    });
  });
});
