/**
 * platform/gdpr/erasure-status.ts — the erasures still open, for the operators' Erasures view
 * (TASK-202, S3-E19)
 *
 * An erasure whose identity was never proven present in a pool can be closed only by two
 * operators' attestation (erasure-attestation.ts), and no screen showed which erasures were open:
 * an operator learned of one from an alert and then called the route by hand. This reads, across
 * tenants (operators only: the route is app/api/operator/erasures), every erasure not yet closed —
 * its data purge not done, or a store outside the database (the sign-in identity) not erased —
 * with each store's step: done or not, attempts, whether its pool could not be verified
 * (`poolUnverified`), an open attestation request and who asked, an attestation that closed it.
 *
 * And whether a second operator exists to approve an attestation (the rules are
 * erasure-attestation.ts's and unchanged here): an approval needs an operator other than the one
 * who asked. `operators` counts the accounts in good standing holding platform_operate, across
 * tenants; each erasure's `secondOperator` says whether anyone may approve its open request (any
 * operator but the requester), or — none open — whether two operators exist at all.
 *
 * Nothing about the erased person is returned beyond the account's id: the erasure removed the
 * address. People who acted (the requester of the erasure, the operators) are named by address
 * through namedOperatorAccounts — never by id.
 *
 * Read-only. One statement for the erasures (at most ERASURE_LIST_LIMIT), one for the operators,
 * one for the names.
 *
 * @module platform/gdpr
 */

import { withOwnerTx, type Tx } from "@/platform/data";
import { OPERATOR_PERMISSION } from "@/platform/admin/config-scope";
import type { RecordedExternalErasure } from "./external-erasure";
import { ATTESTATION_REASONS } from "./erasure-attestation";
import { sameId } from "@/platform/auth/same-id";

/** The most erasures one read lists, newest first. */
export const ERASURE_LIST_LIMIT = 200;

/** A person who acted, as the view names them: by address — or erased, or not found. */
export type ActorView =
  | { readonly kind: "account"; readonly email: string | null }
  | { readonly kind: "erased" }
  | { readonly kind: "unknown" };

/** One store's step of one erasure. */
export interface ErasureStepView {
  readonly store: string;
  readonly done: boolean;
  readonly doneAt?: string;
  readonly attempts: number;
  readonly retryAt?: string;
  /** The last attempt found nothing, in a pool it could not prove the account's. */
  readonly poolUnverified: boolean;
  /** An open request for a second operator to attest it erased. */
  readonly attestationRequest?: {
    readonly by: ActorView;
    /** Whether the viewer asked it (a viewer cannot approve their own request). */
    readonly byViewer: boolean;
    readonly at: string;
    readonly reason: string;
    readonly expiresAt: string;
    readonly expired: boolean;
  };
  /** Closed by two operators' attestation, not by proof. */
  readonly attested?: {
    readonly by: ActorView;
    readonly requestedBy: ActorView;
    readonly at: string;
    readonly reason: string;
  };
}

/** One open erasure. */
export interface ErasureView {
  readonly tenantId: string;
  readonly tenantSlug: string | null;
  /** The erased account's id: the only name it still has. */
  readonly userId: string;
  readonly requestedBy: ActorView;
  readonly softDeletedAt: string;
  readonly purgeAfter: string;
  readonly purgedAt: string | null;
  readonly purgeAttempts: number;
  readonly purgeRetryAt: string | null;
  /** Its data purge failed last time (the reason is in the server log, never shown). */
  readonly purgeFailing: boolean;
  readonly steps: readonly ErasureStepView[];
  /**
   * Whether an operator other than the one who asked exists to approve an attestation of this
   * erasure: for an open request, any operator but its requester; otherwise, two operators.
   */
  readonly secondOperator: boolean;
}

export interface ErasureOverview {
  readonly erasures: readonly ErasureView[];
  /** Accounts in good standing holding platform_operate, across tenants. */
  readonly operators: number;
  /** The reasons an attestation may give (erasure-attestation.ts). */
  readonly reasons: readonly string[];
}

interface ErasureRow extends Record<string, unknown> {
  tenant_id: string;
  slug: string | null;
  user_id: string;
  requested_by: string;
  soft_deleted_at: Date;
  purge_after: Date;
  purged_at: Date | null;
  purge_attempts: number;
  purge_retry_at: Date | null;
  failing: boolean;
  external_erasures: Record<string, RecordedExternalErasure> | null;
}

/**
 * The operators in good standing (platform_operate by role, an inherited role or an active
 * entitlement — as the permission engine resolves it), across tenants: id, subject, address.
 */
const OPERATORS_SQL = `
  select distinct u.id::text as id, u.cognito_sub as sub, u.email
    from users u
   where u.deleted_at is null
     and (u.account_status in ('active', 'warned')
          or (u.account_status = 'restricted' and u.restricted_until < now())
          or (u.account_status = 'suspended' and u.suspended_until < now()))
     and exists (
       select 1 from permissions p
        where p.code = $1
          and (p.id in (select rp.permission_id from role_permissions rp
                         where rp.role_id = u.role_id)
               or p.id in (select rp.permission_id from role_permissions rp
                             join role_inheritance ri on ri.inherits_from_id = rp.role_id
                            where ri.role_id = u.role_id)
               or p.id in (select ep.permission_id
                             from user_entitlements e
                             join entitlement_groups g on g.id = e.entitlement_group_id
                             join entitlement_permissions ep on ep.entitlement_group_id = g.id
                            where e.user_id = u.id and e.revoked_at is null and g.is_active
                              and (e.expires_at is null or e.expires_at > now()))))`;

const ERASURES_SQL = `
  select d.tenant_id::text as tenant_id, t.slug, d.user_id::text as user_id, d.requested_by,
         d.soft_deleted_at, d.purge_after, d.purged_at, d.purge_attempts, d.purge_retry_at,
         (d.last_purge_error is not null) as failing, d.external_erasures
    from user_deletions d
    left join tenants t on t.id = d.tenant_id
   where d.purged_at is null
      or exists (select 1 from jsonb_each(d.external_erasures) s(k, v)
                  where not (v ? 'doneAt'))
   order by d.soft_deleted_at desc, d.user_id
   limit $1`;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * Every open erasure, across tenants, with each step and who may still decide it — for an
 * operator (`viewer`: their users.id). Reads as the owner, purpose "operator".
 */
export async function listOpenErasures(viewer: string): Promise<ErasureOverview> {
  return withOwnerTx("operator", async (tx) => {
    const erasures = (await tx.query<ErasureRow>(ERASURES_SQL, [ERASURE_LIST_LIMIT]))
      .rows;
    const operators = (
      await tx.query<{ id: string; sub: string | null; email: string | null }>(
        OPERATORS_SQL,
        [OPERATOR_PERMISSION]
      )
    ).rows;

    // Everyone named: the erasures' requesters, the attestations' operators.
    const named = new Set<string>();
    for (const e of erasures) {
      named.add(e.requested_by);
      for (const step of Object.values(e.external_erasures ?? {})) {
        if (step?.attestationRequest?.by) named.add(step.attestationRequest.by);
        if (step?.attested?.by) named.add(step.attested.by);
        if (step?.attested?.requestedBy) named.add(step.attested.requestedBy);
      }
    }
    const people = await namedPeople(tx, [...named]);
    const actor = (id: string | undefined): ActorView => {
      const found = id ? people.get(id) : undefined;
      if (!found) return { kind: "unknown" };
      return found.erased ? { kind: "erased" } : { kind: "account", email: found.email };
    };
    const now = Date.now();

    return {
      operators: operators.length,
      reasons: [...ATTESTATION_REASONS],
      erasures: erasures.map((e): ErasureView => {
        const steps = Object.entries(e.external_erasures ?? {}).map(
          ([store, step]): ErasureStepView => {
            const asked = step?.attestationRequest;
            return {
              store,
              done: typeof step?.doneAt === "string",
              ...(step?.doneAt ? { doneAt: step.doneAt } : {}),
              attempts: typeof step?.attempts === "number" ? step.attempts : 0,
              ...(step?.retryAt ? { retryAt: step.retryAt } : {}),
              poolUnverified: step?.poolUnverified === true,
              ...(asked
                ? {
                    attestationRequest: {
                      by: actor(asked.by),
                      byViewer: sameId(asked.by, viewer),
                      at: asked.at,
                      reason: asked.reason,
                      expiresAt: asked.expiresAt,
                      expired: Date.parse(asked.expiresAt) <= now,
                    },
                  }
                : {}),
              ...(step?.attested
                ? {
                    attested: {
                      by: actor(step.attested.by),
                      requestedBy: actor(step.attested.requestedBy),
                      at: step.attested.at,
                      reason: step.attested.reason,
                    },
                  }
                : {}),
            };
          }
        );
        // Who asked the open (unexpired) request, if any: any other operator may approve it.
        const requester = Object.values(e.external_erasures ?? {}).find(
          (s) =>
            s?.attestationRequest &&
            !s.doneAt &&
            Date.parse(s.attestationRequest.expiresAt) > now
        )?.attestationRequest?.by;
        const secondOperator = secondOperatorAvailable(operators, requester);
        return {
          tenantId: e.tenant_id,
          tenantSlug: e.slug ?? null,
          userId: e.user_id,
          requestedBy: actor(e.requested_by),
          softDeletedAt: iso(e.soft_deleted_at) ?? "",
          purgeAfter: iso(e.purge_after) ?? "",
          purgedAt: iso(e.purged_at),
          purgeAttempts: e.purge_attempts ?? 0,
          purgeRetryAt: iso(e.purge_retry_at),
          purgeFailing: e.failing === true,
          steps,
          secondOperator,
        };
      }),
    };
  });
}

/**
 * Whether an operator other than the one who asked can approve an attestation (the rule is
 * erasure-attestation.ts's: a different operator): for an open request by `requester`, any
 * operator who is not them; with none open, two operators at all — one to ask, one to approve.
 */
export function secondOperatorAvailable(
  operators: readonly { readonly id: string; readonly sub: string | null }[],
  requester: string | undefined
): boolean {
  return requester
    ? operators.some((o) => !sameOperator(o, requester))
    : operators.length >= 2;
}

/** Whether operator row `o` is the account `id` names (its id, any case, or its subject). */
function sameOperator(o: { id: string; sub: string | null }, id: string): boolean {
  return sameId(o.id, id) || sameId(o.sub, id);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The accounts these ids name, across tenants (the requesters and operators of the list). */
async function namedPeople(
  tx: Tx,
  ids: readonly string[]
): Promise<Map<string, { email: string | null; erased: boolean }>> {
  const out = new Map<string, { email: string | null; erased: boolean }>();
  const asked = ids.filter(
    (x) => typeof x === "string" && x.length > 0 && x.length <= 128
  );
  if (asked.length === 0) return out;
  const { rows } = await tx.query<{
    id: string;
    sub: string | null;
    email: string | null;
    erased: boolean;
  }>(
    `select u.id::text as id, u.cognito_sub as sub, u.email, (u.deleted_at is not null) as erased
       from users u where u.id = any($1::uuid[]) or u.cognito_sub = any($2::text[])`,
    [asked.filter((x) => UUID.test(x)).map((x) => x.toLowerCase()), asked]
  );
  for (const r of rows)
    for (const key of asked)
      if (sameId(key, r.id) || sameId(key, r.sub))
        out.set(key, { email: r.erased ? null : r.email, erased: r.erased });
  return out;
}
