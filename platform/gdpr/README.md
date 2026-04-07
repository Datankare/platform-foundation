# GDPR Hard Purge

Complete user data deletion pipeline for GDPR/CCPA compliance. Orchestrates deletion across all registered data stores with audit trail.

## Quick Start

```typescript
import { PurgePipeline, CachePurgeHandler } from "@/platform/gdpr";

const pipeline = new PurgePipeline();

// Register handlers (consumers add their own)
pipeline.register(mySupabaseProfileHandler);
pipeline.register(mySupabaseContentHandler);
pipeline.register(new CachePurgeHandler(clearUserCache));

// Set up audit logging
pipeline.onAudit(async (entry) => {
  await supabase.from("purge_log").insert(entry);
});

// Execute
const result = await pipeline.execute({
  userId: "user-123",
  requestedBy: "self",
  reason: "user-request",
});

// result.status: "completed" | "partial" | "failed"
// result.totalDeleted: number of records removed
```

## Dry Run Mode

```typescript
const result = await pipeline.execute({
  userId: "user-123",
  requestedBy: "admin-1",
  reason: "user-request",
  dryRun: true, // Reports what would be deleted without deleting
});
```

## Writing Custom Purge Handlers

```typescript
import type { PurgeHandler } from "@/platform/gdpr";

class MyAppDataPurgeHandler implements PurgeHandler {
  readonly name = "myapp:user-data";
  readonly priority = 50; // Lower = earlier execution

  async execute(userId: string, dryRun: boolean): Promise<number> {
    if (dryRun) {
      const { count } = await supabase
        .from("user_data")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId);
      return count ?? 0;
    }

    const { count } = await supabase.from("user_data").delete().eq("user_id", userId);
    return count ?? 0;
  }
}
```

## Priority Guidelines

| Range  | Use Case                                    |
| ------ | ------------------------------------------- |
| 1–20   | Auth/identity deletion (Cognito, profiles)  |
| 21–50  | Primary data (content, preferences)         |
| 51–80  | Secondary data (analytics, logs)            |
| 81–100 | Infrastructure cleanup (cache, rate limits) |

## Database

Migration `009_gdpr_purge_log.sql` creates the `purge_log` audit table. Only `super_admin` can read purge logs (RLS enforced).

## Architecture

```
platform/gdpr/
├── types.ts        ← PurgeHandler, PurgeResult, PurgeRequest interfaces
├── hard-purge.ts   ← PurgePipeline orchestrator, built-in handlers
├── index.ts        ← Barrel exports
└── README.md       ← This file
```

## See Also

- ROADMAP.md Phase 2 Sprint 4 — GDPR hard purge
- `supabase/migrations/009_gdpr_purge_log.sql`
