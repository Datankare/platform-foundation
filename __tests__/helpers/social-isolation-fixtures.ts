/**
 * __tests__/helpers/social-isolation-fixtures.ts — tenant isolation fixtures for the social store
 * (ADR-053 D8)
 *
 * The social module's half of the store isolation fixtures (ADR-054: a core helper names no
 * module), built on the shared helpers in ./moderation-isolation-fixtures.ts. Run by
 * runTenantIsolationContract against the in-memory and the Postgres social store.
 */

import type { SocialStore } from "@/platform/social/types";
import { orUnknown, remember } from "./moderation-isolation-fixtures";

export function socialIsolation(userFor: () => Promise<string>) {
  const ids = new Map<string, string[]>();
  return {
    write: async (s: SocialStore, key: string) => {
      const res = await s.createGroup({
        name: key,
        description: "isolation",
        ownerId: await userFor(),
      });
      if (!res.success || !res.group) throw new Error(res.error ?? "group not created");
      remember(ids, key, res.group.id);
    },
    read: async (s: SocialStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? [])) {
        const hit = await s.getGroupById(id);
        if (hit && hit.status === "active") return hit;
      }
      return null;
    },
    update: async (s: SocialStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? []))
        await s.updateGroupStatus(id, "suspended");
    },
    // A group is never deleted; archiving takes it out of use.
    remove: async (s: SocialStore, key: string) => {
      for (const id of orUnknown(ids.get(key) ?? []))
        await s.updateGroupStatus(id, "archived");
    },
  };
}
