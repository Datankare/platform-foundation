# GDPR Hard Purge

Complete user data deletion pipeline for GDPR/CCPA compliance. Orchestrates deletion across all registered data stores with audit trail.

## Quick Start

```typescript
import { withTenantTx } from "@/platform/data";
import { PurgePipeline, CachePurgeHandler } from "@/platform/gdpr";

const pipeline = new PurgePipeline();

// Register handlers (consumers add their own)
pipeline.register(myProfileHandler);
pipeline.register(myContentHandler);
pipeline.register(new CachePurgeHandler(clearUserCache));

// Set up audit logging — the record belongs to the current tenant (tenant_id is its column default)
pipeline.onAudit(async (entry) => {
  await withTenantTx((tx) =>
    tx.query(
      `insert into purge_log (purge_id, user_id, requested_by, reason, status, steps_json,
                              total_deleted, requested_at, completed_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
      [
        entry.purge_id,
        entry.user_id,
        entry.requested_by,
        entry.reason,
        entry.status,
        entry.steps_json,
        entry.total_deleted,
        entry.requested_at,
        entry.completed_at,
      ]
    )
  );
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
import { withTenantTx } from "@/platform/data";
import type { PurgeHandler } from "@/platform/gdpr";

class MyAppDataPurgeHandler implements PurgeHandler {
  readonly name = "myapp:user-data";
  readonly priority = 50; // Lower = earlier execution

  async execute(userId: string, dryRun: boolean): Promise<number> {
    // Row-level security confines both statements to the current tenant's rows.
    return withTenantTx(async (tx) => {
      if (dryRun) {
        const { rows } = await tx.query<{ n: number }>(
          "select count(*)::int as n from user_data where user_id = $1",
          [userId]
        );
        return rows[0]?.n ?? 0;
      }
      const { rowCount } = await tx.query("delete from user_data where user_id = $1", [
        userId,
      ]);
      return rowCount;
    });
  }
}
```

Your own table needs `tenant_id`, forced row-level security and the `tenant_isolation` policy, as
the platform's tables have (migration 049).

## Priority Guidelines

| Range  | Use Case                                    |
| ------ | ------------------------------------------- |
| 1–20   | Auth/identity deletion (Cognito, profiles)  |
| 21–50  | Primary data (content, preferences)         |
| 51–80  | Secondary data (analytics, logs)            |
| 81–100 | Infrastructure cleanup (cache, rate limits) |

## Database

Migration `009_gdpr_purge_log.sql` creates the `purge_log` audit table; migration `049_tenancy.sql` gives it `tenant_id` under forced row-level security, so `app_tenant` reads and writes only the current tenant's purge records.

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
- `supabase/migrations/009_gdpr_purge_log.sql`, `supabase/migrations/049_tenancy.sql`
