# Runbook — undecided approvals and the agent kill switch (review 11 H-1, M-2; review 12 H2, L7; reviews 13, 14; TASK-170, TASK-172, TASK-173)

Two incidents a person must act on: an approved change whose run did not end within its lease, so
whether it took effect is unknown (an **undecided** approval, status `indeterminate`); and an agent
that must be stopped now (the **kill switch**). Every action here is audited and alerted.

| Symptom                                                                       | Section                                                                                    |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Alert `approvals.indeterminate`; a row "whether it took effect is unknown"    | [1. An undecided approval](#1-an-undecided-approval)                                       |
| Alert `approvals.run_conflict`                                                | [2. A run that ended after it was decided](#2-a-run-that-ended-after-it-was-decided)       |
| An agent misbehaves and must stop                                             | [3. Suspending agents](#3-suspending-agents)                                               |
| Alert `config.power_reduced` or `agents.emergency_suspended`                  | [4. A reduction nobody approved](#4-a-reduction-nobody-approved)                           |
| A decision answers `approvals.stale`                                          | [5. A stale held change](#5-a-stale-held-change)                                           |
| Alert `config.invalidation_unpublished`                                       | [3. Suspending agents](#how-fast-it-reaches-every-instance)                                |
| Alert `cache.stamp_breaker_open`                                              | [3. Suspending agents](#how-fast-it-reaches-every-instance)                                |
| Alert `cache.stamp_read_lag`                                                  | [3. Suspending agents](#how-fast-it-reaches-every-instance)                                |
| A config or role change answered "may or may not have been applied"           | [1. An undecided approval](#1-an-undecided-approval)                                       |
| An admin panel shows "Unavailable — could not read"                           | [3. Suspending agents](#3-suspending-agents)                                               |
| Alert `approvals.withdrawal_incomplete`                                       | [3. Suspending agents](#3-suspending-agents)                                               |
| An audit record with `outcome: indeterminate`                                 | [1. An undecided approval](#1-an-undecided-approval)                                       |
| An agent workflow is `awaiting_retry`, or a held step says "approve it again" | [1b. A workflow waiting to be approved again](#1b-a-workflow-waiting-to-be-approved-again) |

Read-only SQL below runs on the owner connection (the Supabase SQL editor, or `psql
"$DATABASE_OWNER_URL"`). Decisions are made through the console or the API, never by hand, so they
are audited.

## 1. An undecided approval

An approved held change runs once: its run claims the approval (`executing`, with a run token) and
ends it — `executed`, or `approved` again when it failed before taking effect. A run that has not
ended after 10 minutes (`RUN_LEASE_SECONDS`) — its process died, or it is simply slow — is taken
back by `config.expire-approvals`: `executed` when its step was recorded, `approved` again when it
was atomic (one transaction, rolled back with it), otherwise **`indeterminate`**. It is never given
back to `approved` on a guess: the process may have died between the effect and its record, and a
second approval would run the effect again (review 11 H-1). An undecided approval is not runnable,
does not lapse, and blocks a second proposal for the same operation.

The job raises `approvals.indeterminate` (an error log line with `alert`, a metric
`alert.approvals.indeterminate`, an error report) and the approvals page lists the row first.

1. Find it: the approvals page (**Took effect** / **Did not — approve again**), or

   ```sql
   select tenant_id, id, label, operation_id, payload, decided_by, decided_at, last_run_error, updated_at
     from proposals where status = 'indeterminate' order by updated_at;
   ```

2. Verify whether the change took effect — by the change itself, not by the proposal: the config
   value and its history (`platform_config_history`, `tenant_config_overrides`), the role or entitlement
   the action set, the trajectory step (`agent_trajectories.steps` with the proposal's
   `operation_id`, in its trajectory or a continuation of it), the audit records with its
   `holdId`.
3. Decide (an admin who holds the hold's permission; `POST /api/admin/approvals/{id}`, or the
   operator route for a tenant):
   - it took effect → `{"decision": "mark_executed", "source": "runtime", "note": "…"}` — the
     approval is used;
   - it did not → `{"decision": "reapprove", "source": "runtime", "note": "…"}` — a fresh approval
     by an independent approver (never the requester), run at once, exactly once.

   Both need an admin other than the hold's requester (review 12 L7): the requester's own
   `mark_executed` answers `approvals.self_approval`, as their approval would.

   `approve` and `reject` on an undecided row answer `approvals.indeterminate` (409).

4. If the run was only slow, it may still end: its completion by its token lands while the row is
   undecided (the row becomes `executed`). After a decision, a late end is a conflict (§2).

**An audit record with `outcome: indeterminate`** (review 13 L5): an audited act ran inside a
transaction whose commit was sent and whose answer was lost with the connection — it may have
committed or not. The act's `attempted` record shares its `attemptId`. Verify by the change itself,
as in step 2 (the config value and its history, the role, the row the act wrote); nothing needs
undoing if it did not land. A record `rolled_back` is certain: the database refused or undid it.

The same holds when the act's **own** transaction loses its commit (review 14 L-2): a config write
(`setConfigWithHistory`, a reset — `clearTenantConfig`) or a command-bar role change answers
"The database connection was lost while the change was being saved: it may or may not have been
applied" (`indeterminate: true`), and its audit says `indeterminate`, not `failed`. The change's
invalidation is published all the same (every instance re-reads the key, or the user's
permissions, at its next read), so whichever way it went, no instance serves a stale value. Read
the setting (or the user's role) again: if it shows the new value, it landed — do nothing; if not,
make the change again.

## 1b. A workflow waiting to be approved again

An agent workflow's approved step whose run failed before taking effect keeps its approval
(`approvals.run_failed`, "approve it again to retry"). Its trajectory waits at that step in
**`awaiting_retry`** (migration 053, TASK-170) — it is not over, and its own agent cannot retry it:
the agent's continuation runs nothing and is answered `held` with `awaiting: "retry"`. A run whose
approval could not be given back leaves the trajectory **`indeterminate`** until a person decides
the run (§1); its continuation answers `awaiting: "outcome"`.

```sql
select tenant_id, id, trigger, status, updated_at from agent_trajectories
 where status in ('awaiting_retry', 'indeterminate') order by updated_at;
```

| To                      | Do (through the app's approval route — never by hand)                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retry it                | Approve it again: the route runs `resumeApprovedAction` on the kept approval — once, however many approve at once; the workflow then continues                                            |
| Not retry it            | Reject it: the route withdraws the kept approval (`withdrawHeldAction`); the trajectory records the withdrawal and is `failed`                                                            |
| Decide an undecided run | `reapprove` (it did not take effect — `resolveUndecidedHeldAction` "approved", then resumed once) or `mark_executed` (it did — the workflow ends `failed`: its output was never recorded) |

**A run lost mid-run** (TASK-173): when `config.expire-approvals` takes back an agent workflow's run
that never ended, it moves the workflow with the approval, in the same statement — `indeterminate`
for an undecided run (decide it as in §1, then it resumes once), `awaiting_retry` for an atomic run
approved again. Its `approval_run_recovered` audit record names the trajectory moved
(`trajectoryId`, `trajectoryFrom`, `trajectoryStatus`; null when the trajectory was already
finished). Whatever the trajectory's status, the agent's continuation answers `held` with the right
`awaiting` and never proposes the step again.

```sql
select created_at, details->>'holdId' as hold, details->>'status' as approval,
       details->>'trajectoryId' as trajectory, details->>'trajectoryFrom' as was,
       details->>'trajectoryStatus' as now
  from audit_log where details->>'type' = 'approval_run_recovered' order by created_at desc limit 20;
```

A kept approval withdrawn by another path (`config.expire-approvals` once it lapses) ends its
workflow the next time the workflow is continued. Retention keeps `awaiting_retry` and
`indeterminate` trajectories.

## 2. A run that ended after it was decided

`approvals.run_conflict` (audit `approval_run_conflict`, with `holdId`): a run's effect landed
after its claim had been taken back and decided by a person — usually a slow run that was
re-approved. The effect is real; the error said "applied". Check whether the change now applied
twice (the fresh approval's run and the slow one) and correct the target by an ordinary, audited
change. Then look at why the run took longer than the lease (the statement timeout bounds each
database step; an external call does not).

## 3. Suspending agents

A change that only removes power is applied at once by the one admin making it — no second
approver (review 11 M-2): suspending an agent, narrowing its scopes, lowering its token lifetime,
adding a required feature to a capability mapping. The admin needs the key's own permission
(`config_manage_safety`). From the command bar: `suspend_agent`, `set_agent_scope`,
`set_agent_ttl`, `set_capability_mapping` with a longer feature list; from the config page: the
edited `agent.trusted_agents`. A change that also widens anything — a mixed edit — is held for a
second admin as before, whole.

**Removing or emptying a capability mapping is held** (review 12 H1): a consumer that reads an
absent capability as "no features required" is widened by it, and the platform cannot tell how a
consumer reads the map. To stop a capability at once, suspend the agents that use it (below), or
add a feature no caller holds to its mapping (a reduction, applied at once).

**An admin panel showing "Unavailable — could not read"** (review 14 L-1): its read was answered 503
— the store is down, or the stored value of `agent.trusted_agents` / `agent.capability_features` is
not well formed (a list of `[agentId, record]` / `[capability, features[]]` pairs). It is never shown
as an empty list. Retry; if it persists, read the value on the owner connection
(`select key, value from platform_config where key = 'agent.trusted_agents'`, and the tenant's
`tenant_config_overrides`) and correct it with an audited change.

Every reduction applied this way, and the kill switch, **withdraws every pending hold on the same
key and scope** (review 12 H2, review 13 L1) — runtime holds and two-person approvals, audited
(`approval_withdrawn`, reason `superseded`; one record per batch of up to 100, `holdIds`, `scope`,
`count` — review 13 L7): they were requested against the value that no longer stands. A reduction
of a tenant's own value withdraws that tenant's tenant-scope holds (and resets); a reduction of the
platform default withdraws platform-scope holds; a hold of the other scope stands (its
compare-and-set still guards it). Their requesters ask again. A hold whose withdrawal did not land
is refused as stale when approved (§5). One call withdraws at most 2 000 runtime holds and 2 000
approvals.

**A platform-scope reduction reaches every tenant** (review 14 L-4): in a shared deployment a
pending change to a platform default is stored in the tenant the operator who requested it acted
in. A reduction of the platform default finds, on the owner connection, every tenant holding a
pending platform-scope hold or approval of the key, and withdraws them in each — as that tenant,
under its row-level security, audited in **that tenant's** log (`approval_withdrawn`, `scope:
platform`). The answer's `tenants` lists the other tenants reached. To check none is left:

```sql
select tenant_id, id, status from config_pending_approvals
 where config_key = '<key>' and scope = 'platform' and status = 'pending';
```

**`approvals.withdrawal_incomplete`** says how many were left pending (`remaining`) — past the
bound, held by a concurrent reviewer (a two-person approval row another admin was deciding at that
moment is skipped, never waited on — review 14 L-3: always counted and alerted now), or in a tenant
that could not be reached. Each left pending is **still safe**: its approval applies only onto the
value it was requested against (compare-and-set, §5), which the reduction changed, so it is refused
as `approvals.stale` — it cannot undo the reduction. Reject them from the approvals page (or let
them lapse); the query above lists them.

**In the console** (TASK-172): the admin console's **Agent kill switch** section (shown to
`config_manage_safety` holders) suspends the current tenant's agents; the operators' **Tenants**
console has **Agent kill switch** on each tenant's row (`platform_operate`). Each asks for the
reason, then for an explicit confirmation, and shows what the route answered: the agents suspended,
the pending holds withdrawn, and — when none was active — whether every instance was told again to
drop its cached registry (`republished`; "did not go through" is `config.invalidation_unpublished`,
below). "Unavailable" (503) means nothing was suspended: try again, or use the API.

**Every agent of a tenant at once** (operators, `platform_operate`):

```bash
curl -sS -X POST "https://$HOST/api/operator/tenants/$TENANT_ID/agents/suspend" \
  -H "authorization: Bearer $OPERATOR_TOKEN" -H "content-type: application/json" \
  -d '{"reason": "incident 2026-10-24: agent:x looping"}'
# → {"suspended": ["agent:x", "agent:y"], "withdrawn": ["<hold id>", …]}
```

**Every agent of the current tenant, in any deployment mode** (review 12 L7) — a single-tenant
deployment's own administrators, who hold `config_manage_safety` but not `platform_operate`:

```bash
curl -sS -X POST "https://$HOST/api/admin/agents/suspend" \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"reason": "incident 2026-10-24: agent:x looping"}'
# → {"suspended": ["agent:x", "agent:y"], "withdrawn": ["<hold id>", …]}
# every agent already suspended → {"suspended": [], "withdrawn": [], "republished": true}
```

In a single-tenant deployment it suspends the deployment's agents (the platform default); in a
shared one, the tenant's own registry where the caller may change it (an operator; else refused —
use the operator route). `withdrawn` lists the pending holds it withdrew.

It suspends every active agent in the tenant's `agent.trusted_agents`, compare-and-set (a
concurrent change makes it answer `admin.kill_switch_failed` — run it again). Check:

```sql
select key, value from tenant_config_overrides where tenant_id = '<tenant>' and key = 'agent.trusted_agents';
```

Reactivating an agent is a widening: it is held for a second safety admin.

Audit: `agents_emergency_suspended` with `outcome` `attempted`, then `succeeded` or `failed`
(review 12 L3) — a compare-and-set that failed is on file as failed, never read as done.

### How fast it reaches every instance

The instance that made the change drops its cached value at once. A change of
`agent.trusted_agents` or `agent.capability_features` also publishes an invalidation stamp through
the shared cache (`CACHE_PROVIDER`: Upstash or Valkey in a deployment); every other instance reads
that stamp before it serves its cached copy, so it re-reads the key from the database **at its next
read of it** — one shared-cache round trip, not the 60-second cache lifetime (review 12 L7). What is
left:

- a request that read the registry before the change finishes with the value it read (bounded by
  that request);
- when the stamp cannot be published (alert `config.invalidation_unpublished`), other instances may
  serve the old value for up to **60 seconds** (the cache lifetime): once the shared cache answers,
  run the kill switch again — when every agent is already suspended it writes nothing but publishes
  the invalidation again (review 13 L2; the answer says `"republished": true`, or `false` if the
  cache still refuses) — or wait 60 seconds;
- when an instance cannot read the stamp it does not trust its cached copy — it reads the database
  on every read (no staleness, more load). A stamp read waits at most **200 ms**; after 5 failures in
  a row the instance stops asking the shared cache for 30 s (alert `cache.stamp_breaker_open`, metric
  `alert.cache.stamp_breaker_open`), then sends one probe — it closes again when the cache answers
  (review 13 M2). While it is open every read of these keys, and every permission check, goes to the
  database: check the cache (`CACHE_PROVIDER`, its health on `/api/health/ready`) and the database's
  load. The alert is raised at most once per 5 minutes per instance, with the number of openings
  since the last (`count`, tag `openings` — a flapping cache, review 14 M-2); its text says the
  instance's event loop was responsive, so it is the cache;
- an instance whose **event loop is stalled** (CPU-saturated: long synchronous work, too little CPU)
  cannot read its sockets in time, so a healthy cache's answers would time out. At the 200 ms bound
  the reader yields once and takes an answer that has arrived; a read still unanswered during
  event-loop lag above 100 ms is read from the database and counted as **lag, not a cache
  failure** (review 14 M-2): it never opens the breaker. Metric `cache.stamp_read_lag` (values
  `lagMs`, the instance's `loopDelayP99Ms` / `loopDelayMaxMs`), alert `cache.stamp_read_lag` at
  most once per 5 minutes per instance with the count. Look at the **instance** — CPU, long tasks,
  the instance size — not at the cache;
- a credential a consuming app already issued to an agent is the app's to refuse: it must check
  the agent's status in `agent.trusted_agents` on every request it serves (Playform:
  `lib/agent-identity.ts`), which the above now makes current.

## 4. A reduction nobody approved

`config.power_reduced` (audit `power_reduction_applied`, with the changes) and
`agents.emergency_suspended` (audit `agents_emergency_suspended`, with the agents and reason) tell
the admins who did not approve it. Nothing to undo unless it was wrong: reactivation is held, as any
widening.

## 5. A stale held change

`approvals.stale` (409): the setting a held change would replace was changed after the change was
requested — by the kill switch, a power reduction, or another approved change (review 12 H2). Every
held config change records the value it replaces and is applied only onto it; nothing was applied,
the hold is withdrawn (audit `approval_withdrawn`, reason `stale`), and approving it again answers 409. Tell the requester to ask again against the current value. A hold requested before this release
recorded no value and is refused the same way.

**A reset** (`reset_config`, or an approval with `action` `reset`) is also compared on what it
resets **to** (review 13 M1): it is applied only while the platform default the tenant would inherit
is the one recorded when the reset was requested (the approval's proposed value; `inherited` on a
runtime hold). A default changed since makes it stale — the tenant keeps its own value, never one
no approver saw. A held reset requested before this release recorded no default and is refused the
same way.

**A value changed and changed back** before the approval (A → B → A) is not stale (review 13 L6,
accepted): the compare-and-set compares values, not versions, and the value the change replaces is
exactly the one the approver was shown, so the approved change lands on what was reviewed. The
intermediate change is in the setting's history. If an intermediate change matters to the decision
(it was a kill switch that was then undone), reject and ask for a fresh request.

```sql
select tenant_id, id, label, payload->>'key' as key, decision_note, updated_at
  from proposals where status = 'rejected' and decision_note like '%stale%' order by updated_at desc;
```

## 6. Holds and trajectories that end on their own (TASK-193)

- **A hold never decided** expires `config.approval_expiry_days` after it was requested, like an
  unused approval: config.expire-approvals withdraws it (audited `approval_withdrawn`, reason
  `expired`, `decision: undecided`) and ends its trajectory. A decision on one answers
  `approvals.expired`; ask again.
- **An undecided run** (`approvals.indeterminate`) is alerted when it is found, then reminded at
  most once a day while it waits (`proposals.reminded_at`). Decide it as in §1.
- **An abandoned trajectory** — open, no activity for `agent.trajectory.abandon_after_hours`, no
  open hold — is ended `failed` by agents.trajectory-retention, with a `trajectory-abandoned` step,
  then deleted with the other finished ones after `agent.trajectory.retention_days` (counted from
  its last activity). `agents.indeterminate_reaped`: one was `indeterminate` — an external effect
  neither confirmed nor denied; check the effect ledger for its operations before it is deleted.
  Check: `select status, count(*) from agent_trajectories where status in ('running', 'paused', 'awaiting_retry', 'indeterminate') and updated_at < now() - interval '1 day' group by 1;` —
  only rows with an open hold, app sessions' and workflows' remain.
- **A workflow's trajectory** (its trigger is a workflow goal) is the user's to continue — after a
  step-cap or budget pause, or after an approved step — so it is ended only past
  `agent.workflow.abandon_after_days` (30) without activity; an executed held step does not
  complete it either. Its holds end as any hold does.
