# platform/social — Groups, membership and invitations

Group lifecycle for a consuming application: create a group, join it, invite others, and
enforce whatever the moderation layer decides about the content within.

## Registry slot

`socialStore` — `SocialStoreType` is `"supabase" | "memory"`.

| Implementation        | Use                                                               |
| --------------------- | ----------------------------------------------------------------- |
| `InMemorySocialStore` | tests, and the default when nothing is configured                 |
| `SupabaseSocialStore` | persistent; tables `groups`, `group_memberships`, `group_invites` |

Selected by `SOCIAL_STORE`. Verified by `__tests__/contract/social-store-contract.ts`, which
a consumer runs against their own implementation.

## What is here

| File                       | Contents                                                             |
| -------------------------- | -------------------------------------------------------------------- |
| `types.ts`                 | `Group`, `Membership`, `GroupInvite`, and the `SocialStore` contract |
| `group-service.ts`         | Create, join, leave, list — the operations a consumer calls          |
| `invite-service.ts`        | Issue, accept and expire invitations                                 |
| `guardian-adapter.ts`      | Routes group content through moderation                              |
| `memory-social-store.ts`   | Reference implementation                                             |
| `supabase-social-store.ts` | Persistent implementation, raw fetch against PostgREST               |

## Replacing the store

Implement `SocialStore`, register it, and run the kit:

```typescript
import type { SocialStore } from "@/platform/social";

export class DynamoSocialStore implements SocialStore {
  // ... every method on the contract
}
```

```typescript
import { setSocialStore } from "@/platform/social";
setSocialStore(new DynamoSocialStore());
```

```typescript
import { runSocialStoreContract } from "@/__tests__/contract/social-store-contract";

describe("DynamoSocialStore", () => {
  runSocialStoreContract({ makeStore: () => new DynamoSocialStore() });
});
```

## Dependencies

`kernel` for vocabulary, `agents` for the agent identities that act on groups, and
`moderation` through the guardian adapter.
