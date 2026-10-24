# platform/social — Groups, membership and invitations

Group lifecycle for a consuming application: create a group, join it, invite others, and
enforce whatever the moderation layer decides about the content within.

This is the `social` product module (ADR-054 D2). Its definition, `module.ts`, declares what it
adds to the core when an app registers it (`platform/modules/app-modules.ts`): the store slot
below, the five social agents (`agent-configs.ts` — matchmaker, gatekeeper, concierge, analyst,
curator), their prompts (`prompts/social/`) and eval suites (`prompts/evals/social/`), the curator
content type, the `social` moderation content kind and the Teams feature (a preview). Its files,
tests, kit and migration (015) are listed in `platform/modules/manifest.json`; the core imports
none of them. (Guardian's `guardian-social` agent is the core's: Guardian screens all content.)

## Registry slot

`socialStore`, selected by `SOCIAL_STORE`: `"postgres" | "supabase" | "memory"` (`"supabase"` is
read as `"postgres"`). A durable slot: a durable selection without `DATABASE_URL` is refused, and
production refuses memory (TASK-107) — declared in `module.ts`, enforced by the provider registry
like the core's stores.

| Implementation        | Use                                                                         |
| --------------------- | --------------------------------------------------------------------------- |
| `InMemorySocialStore` | tests, and the default when nothing is configured; one partition per tenant |
| `PostgresSocialStore` | persistent; tables `groups`, `group_memberships`, `group_invites`           |

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
| `postgres-social-store.ts` | Persistent implementation, Postgres through `platform/data`          |
| `store.ts`                 | The active store (`getSocialStore` / `setSocialStore`)               |
| `agent-configs.ts`         | The five social agents' configurations                               |
| `module.ts`                | The module definition (ADR-054)                                      |

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
