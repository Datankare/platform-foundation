/**
 * platform/auth/audit-details.ts — what an audit record's details may hold (TASK-193, audit A-2,
 * A-3, A-4)
 *
 * An audit record outlives the account it is about (Article 17(3)(e)): its erasure keeps the
 * record and replaces the account's id. So what the details hold is decided here, not by each
 * caller. The audit found three ways personal data got into details and stayed after erasure: a
 * typed address (the operator's "make tenant admin" stored it in the operator's tenant, A-3; a
 * role change's failure text quoted it, A-2), and staff free text about a person (a restriction's
 * reason, a reviewer's notes — "user posted her home address", A-4).
 *
 * The rules, applied by recordAudit to every record before it is written (sanitizeAuditDetails):
 *
 *   - an allowlist per action (for admin_action, per its `type`): AUDIT_DETAILS_SCHEMA names the
 *     keys each may carry beside COMMON_DETAIL_KEYS. Any other key is dropped (named in
 *     `droppedKeys`, and logged); __tests__/audit-details-schema.test.ts reads every call site, so
 *     a new key is registered with its kind before it ships;
 *   - each key has a kind (AUDIT_DETAIL_KINDS): an id, a code, a number, a flag, a time, a list,
 *     a value (a setting's or policy's), or text. No kind may hold a raw address: an
 *     address-shaped string anywhere is replaced by "[address]";
 *   - text (free text a person wrote) is bounded, and erased with the account it is about: the
 *     erasure removes every text key from every record that targets or mentions the account, in
 *     every tenant (platform/auth/user-data.ts auditText, CROSS_TENANT_ERASURE).
 *
 * @module platform/auth
 */

import type { AuditAction } from "@/platform/auth/audit-actions";

export type DetailKind =
  /** An id: a users.id, a record's id, an operation's. */
  | "id"
  /** A fixed value: a name from a catalog, a status, a kind, a key. */
  | "code"
  | "number"
  | "boolean"
  /** An ISO time. */
  | "time"
  /** A list of ids or codes. */
  | "list"
  /** A setting's or a policy's value (structured): kept as it was, bounded (never redacted). */
  | "value"
  /** Free text a person wrote: bounded, and erased with the account it is about. */
  | "text";

/** Every key an audit record's details may carry, and its kind. */
export const AUDIT_DETAIL_KINDS: Readonly<Record<string, DetailKind>> = {
  // The writer's own (COMMON_DETAIL_KEYS).
  type: "code",
  outcome: "code",
  reason: "text",
  agent: "code",
  attemptId: "id",
  holdId: "id",
  operationId: "id",
  prompt_action: "boolean",
  droppedKeys: "list",
  textErased: "boolean",
  // Accounts and sign-in.
  role: "code",
  via: "code",
  banCarriedOver: "boolean",
  phase: "code",
  moduleCount: "number",
  trigger: "code",
  by: "code",
  method: "code",
  code: "code",
  factor: "code",
  field: "code",
  fields: "list",
  from: "value",
  to: "value",
  until: "time",
  source: "code",
  verifiedBy: "code",
  change: "code",
  contentRatingLevel: "number",
  requiresParentalConsent: "boolean",
  consentType: "code",
  consentVersion: "code",
  consentStatus: "code",
  deviceId: "id",
  deviceName: "text",
  entitlementGroupId: "id",
  expiresAt: "time",
  oldRole: "code",
  newRole: "code",
  oldRoleId: "id",
  newRoleId: "id",
  // Administration.
  key: "code",
  keys: "list",
  agents: "list",
  scope: "code",
  label: "code",
  decision: "code",
  requester: "id",
  requiredPermission: "code",
  authority: "code",
  approvedBy: "id",
  approvedAt: "time",
  requestedAt: "time",
  foundBy: "id",
  cause: "text",
  holdIds: "list",
  count: "number",
  status: "code",
  tool: "code",
  approvalKept: "boolean",
  role_name: "code",
  added: "list",
  removed: "list",
  user_id: "id",
  feature: "code",
  previousValue: "value",
  newValue: "value",
  changeComment: "text",
  changeSource: "code",
  name: "code",
  permissions: "list",
  source_role: "code",
  new_name: "code",
  groupId: "id",
  isActive: "boolean",
  previous: "value",
  policy: "value",
  rules: "value",
  changes: "value",
  // Jobs and the operator console.
  kind: "code",
  jobId: "id",
  tenantId: "id",
  enqueued: "number",
  claimed: "number",
  succeeded: "number",
  retried: "number",
  dead: "number",
  slug: "code",
  hosts: "list",
  host: "code",
  requestId: "id",
  note: "text",
  userId: "id",
  found: "number",
  // Erasure attestation (TASK-193 round 1): which store, and the fixed reason given.
  store: "code",
  attestation: "code",
  // Moderation.
  reviewItemId: "id",
  slaHours: "number",
  originalAction: "code",
  modifiedAction: "code",
  trajectoryId: "id",
  trajectoryFrom: "code",
  trajectoryStatus: "code",
  reapedAt: "time",
  reviewerNotes: "text",
  category: "code",
  severity: "code",
  consequence: "code",
  previousStatus: "code",
  newStatus: "code",
  totalActiveStrikes: "number",
  guardianDecisionId: "id",
};

/** Keys every record may carry (the writer's own, and a failure's reason). */
export const COMMON_DETAIL_KEYS: readonly string[] = [
  "type",
  "outcome",
  "reason",
  "agent",
  "attemptId",
  "holdId",
  "operationId",
  "prompt_action",
  "droppedKeys",
];

/**
 * Per action — for admin_action and the other actions that carry a `type`, per
 * `<action>:<type>` — the keys its details may carry beside COMMON_DETAIL_KEYS.
 */
export const AUDIT_DETAILS_SCHEMA: Readonly<Record<string, readonly string[]>> = {
  account_created: ["role", "via", "banCarriedOver"],
  account_deleted: ["phase", "moduleCount", "trigger", "by"],
  gdpr_purge_executed: ["phase", "trigger"],
  gdpr_purge_dry_run: [],
  login_success: ["method"],
  login_failed: ["method", "code"],
  logout: [],
  mfa_enabled: ["factor"],
  mfa_disabled: ["factor"],
  data_exported: ["moduleCount"],
  device_registered: ["deviceId", "deviceName"],
  device_removed: ["deviceId"],
  entitlement_granted: ["entitlementGroupId", "expiresAt"],
  entitlement_revoked: ["entitlementGroupId"],
  consent_granted: ["consentType", "consentVersion"],
  consent_revoked: ["consentType"],
  "consent_granted:parental_consent": ["consentStatus"],
  "consent_denied:parental_consent": ["consentStatus"],
  profile_updated: [
    "field",
    "fields",
    "contentRatingLevel",
    "requiresParentalConsent",
    "from",
    "to",
    "source",
    "verifiedBy",
    "change",
    "banCarriedOver",
  ],
  role_changed: ["oldRole", "newRole", "oldRoleId", "newRoleId"],
  // admin_action, by type.
  "admin_action:account_status_lapsed": ["from", "to", "until"],
  "admin_action:agents_emergency_suspended": ["key", "agents"],
  "admin_action:approval_withdrawn": [
    "source",
    "label",
    "approvedBy",
    "approvedAt",
    "requestedAt",
    "decision",
    "foundBy",
    "key",
    "cause",
    "holdIds",
    "scope",
    "count",
  ],
  "admin_action:approval_decision": [
    "source",
    "decision",
    "requester",
    "requiredPermission",
    "authority",
    "label",
  ],
  "admin_action:approval_run_recovered": [
    "label",
    "status",
    "trajectoryId",
    "trajectoryFrom",
    "trajectoryStatus",
  ],
  "admin_action:approval_apply_recovered": ["source", "key", "status"],
  "admin_action:approved_run_failed": ["tool", "approvalKept"],
  "admin_action:approval_run_conflict": ["tool"],
  "admin_action:action_applied_not_recorded": ["tool"],
  "admin_action:assign_permissions": ["role_name", "added", "removed"],
  "admin_action:block_user_feature": ["user_id", "feature"],
  "admin_action:unblock_user_feature": ["user_id", "feature"],
  "admin_action:config_override_cleared": ["key", "previousValue", "changeComment"],
  "admin_action:config_updated_with_history": [
    "key",
    "scope",
    "previousValue",
    "newValue",
    "changeComment",
    "changeSource",
  ],
  "admin_action:create_entitlement_group": ["code", "permissions"],
  "admin_action:create_role": ["name", "permissions"],
  "admin_action:delete_role": ["role_name", "permissions"],
  "admin_action:duplicate_role": ["source_role", "new_name"],
  "admin_action:entitlement_toggle": ["groupId", "code", "isActive"],
  "admin_action:escalation_sla_block": [
    "reviewItemId",
    "slaHours",
    "originalAction",
    "trajectoryId",
    "reapedAt",
  ],
  "admin_action:escalation_sla_escalate_higher": [
    "reviewItemId",
    "slaHours",
    "trajectoryId",
    "reapedAt",
  ],
  "admin_action:password_policy_updated": ["previous", "policy"],
  "admin_action:update_password_policy": ["previous", "policy"],
  "admin_action:review_resolution": [
    "reviewItemId",
    "source",
    "decision",
    "reviewerNotes",
    "modifiedAction",
    "originalAction",
    "trajectoryId",
  ],
  "admin_action:sentinel_decision": [
    "category",
    "severity",
    "consequence",
    "previousStatus",
    "newStatus",
    "totalActiveStrikes",
    "trajectoryId",
    "guardianDecisionId",
  ],
  "admin_action:sentinel_status_change": [
    "category",
    "severity",
    "consequence",
    "previousStatus",
    "newStatus",
    "totalActiveStrikes",
    "trajectoryId",
    "guardianDecisionId",
  ],
  "admin_action:set_approval_policy": ["rules"],
  "admin_action:power_reduction_applied": ["key", "changes"],
  "admin_action:job_run_now": [
    "kind",
    "enqueued",
    "claimed",
    "succeeded",
    "retried",
    "dead",
  ],
  "admin_action:job_replayed": ["jobId", "kind", "tenantId"],
  "admin_action:job_discarded": ["jobId", "kind", "tenantId"],
  // The operator console (platform/tenancy/admin.ts recorded()).
  "admin_action:tenant_provisioned": ["tenantId", "slug", "hosts"],
  "admin_action:tenant_domain_added": ["tenantId", "host"],
  "admin_action:tenant_domain_removed": ["tenantId", "host"],
  "admin_action:tenant_renamed": ["tenantId", "name"],
  "admin_action:tenant_suspended": ["tenantId"],
  "admin_action:tenant_resumed": ["tenantId"],
  "admin_action:tenant_deletion_requested": ["tenantId"],
  "admin_action:tenant_deletion_approved": ["requestId", "note"],
  "admin_action:tenant_deletion_rejected": ["requestId", "note"],
  "admin_action:tenant_restored": ["tenantId"],
  "admin_action:tenant_purged": ["tenantId"],
  "admin_action:tenant_exported": ["tenantId"],
  "admin_action:tenant_admin_granted": ["tenantId", "userId", "found"],
  "admin_action:external_erasure_attestation_requested": [
    "tenantId",
    "userId",
    "store",
    "attestation",
    "note",
  ],
  "admin_action:external_erasure_attestation_approved": [
    "tenantId",
    "userId",
    "store",
    "attestation",
    "note",
  ],
  "admin_action:external_erasure_attestation_rejected": [
    "tenantId",
    "userId",
    "store",
    "note",
  ],
};

/** The keys of free text a person wrote: erased with the account the record is about. */
export const AUDIT_TEXT_KEYS: readonly string[] = Object.entries(AUDIT_DETAIL_KINDS)
  .filter(([, kind]) => kind === "text")
  .map(([key]) => key);

/** An address-shaped string (anything@anything.tld), anywhere in a value. */
const ADDRESS = /[^\s@"'<>(),;:[\]{}]+@[^\s@"'<>(),;:[\]{}]+\.[^\s@"'<>(),;:[\]{}]+/g;

/** `text` with every address-shaped part replaced. */
export function redactAddresses(text: string): string {
  return text.replace(ADDRESS, "[address]");
}

/** The most characters a text or code value keeps. */
const MAX_TEXT = 1000;
const MAX_CODE = 200;

function scrub(value: unknown, max: number, redact = true): unknown {
  const clean = (t: string) => (redact ? redactAddresses(t) : t);
  if (typeof value === "string") return clean(value).slice(0, max);
  if (Array.isArray(value)) return value.map((v) => scrub(v, max, redact));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        clean(k),
        scrub(v, max, redact),
      ])
    );
  }
  return value;
}

/**
 * Whether a kind's value can carry a person's address, and so has address-shaped parts removed
 * (review round 1, item 9): free text, codes, ids, lists and times can. A setting's or policy's
 * value cannot be about a person — it is configuration (a sender address, a connection string
 * `user@host`) — and is kept as it was, bounded: redacting it recorded a value never set.
 */
export function kindCarriesAddresses(kind: DetailKind): boolean {
  return kind !== "value" && kind !== "number" && kind !== "boolean";
}

/** The schema key of a record: `<action>:<type>` when that is registered, else the action. */
export function schemaKeyOf(action: AuditAction | string, type: unknown): string {
  if (typeof type === "string" && AUDIT_DETAILS_SCHEMA[`${action}:${type}`]) {
    return `${action}:${type}`;
  }
  return action;
}

/** The keys `action` (of `type`) may carry, or undefined when it has no schema. */
export function allowedDetailKeys(
  action: AuditAction | string,
  type: unknown
): ReadonlySet<string> | undefined {
  const own = AUDIT_DETAILS_SCHEMA[schemaKeyOf(action, type)];
  return own ? new Set([...COMMON_DETAIL_KEYS, ...own]) : undefined;
}

/**
 * The details as they may be stored: only the keys the action may carry — COMMON_DETAIL_KEYS
 * alone for an action with no schema — each kept by its kind, with no address-shaped string in
 * any kind that can carry a person's (kindCarriesAddresses: not a setting's value). Any other key is dropped and named in `droppedKeys`; the caller logs it.
 */
export function sanitizeAuditDetails(
  action: AuditAction | string,
  details: Record<string, unknown>
): { readonly details: Record<string, unknown>; readonly dropped: readonly string[] } {
  const allowed = allowedDetailKeys(action, details.type) ?? new Set(COMMON_DETAIL_KEYS);
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(details)) {
    const kind = AUDIT_DETAIL_KINDS[key];
    if (!kind || !allowed.has(key)) {
      if (key !== "droppedKeys") dropped.push(key);
      continue;
    }
    if (value === undefined) continue;
    out[key] =
      kind === "text"
        ? scrub(value, MAX_TEXT)
        : kind === "number" || kind === "boolean"
          ? value
          : scrub(
              value,
              kind === "value" ? MAX_TEXT : MAX_CODE,
              kindCarriesAddresses(kind)
            );
  }
  if (dropped.length > 0) {
    out.droppedKeys = dropped.map((k) => redactAddresses(k).slice(0, 100));
  }
  return { details: out, dropped };
}
