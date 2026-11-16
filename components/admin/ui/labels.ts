/**
 * components/admin/ui/labels.ts — the name a person reads for every code the console holds
 * (TASK-216, TASK-220; SCREEN-FINDINGS P7)
 *
 * Screens showed stored codes where a name belongs: "admin_manage_users", "role_permissions",
 * "signed_in_within_days", a job's kind, a setting's key. Every kind of code has one function
 * here, and each answers the same way: the catalogue's name when it has one, else the code made
 * readable ("data_retention" → "Data retention") — never the raw code, and never a missing-key
 * marker. A screen that needs the stored code shows it as a detail ("Show details").
 *
 * Client-safe. A person is named by PersonRef (./Ref.tsx).
 *
 * @module components/admin/ui
 */

import { renderMessage } from "@/platform/errors/messages";
import { readableRole } from "@/components/admin/admin-format";

/** How many characters of an id are shown before "more". */
export const SHORT_ID = 8;

/** Initialisms a stored code writes in lower case. */
const ACRONYMS = /\b(?:ai|api|coppa|gdpr|id|mfa|sla|sso|ttl|tts|url)\b/g;

/**
 * "strike_ban_threshold" → "Strike ban threshold"; "data.retention" → "Data retention";
 * "purgeReason" → "Purge reason".
 */
export function readableCode(code: string): string {
  const words = code
    // camelCase is words too ("purgeReason" → "purge reason").
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._\-:/]+/g, " ")
    // A level's number is a word of its own ("level1" → "level 1").
    .replace(/\b([a-z]+)(\d+)\b/gi, "$1 $2")
    .trim()
    .toLowerCase()
    // Initialisms as people write them ("sla" → "SLA").
    .replace(ACRONYMS, (w) => w.toUpperCase());
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

function fromCatalogue(key: string, code: string): string {
  const text = renderMessage(key);
  return text === key ? readableCode(code) : text;
}

/** A permission by its catalogue name ("Manage users"). */
export function permissionLabel(code: string): string {
  const key = ["screens.permissions", code, "name"].join(".");
  const text = renderMessage(key);
  if (text === key) return readableCode(code);
  // The catalogue's names are in title case; the console writes sentence case.
  return readableRole(text, text);
}

/** A role by its display name, else its stored name made readable. */
export const roleLabel = (name: string, displayName?: string | null): string =>
  readableRole(name, displayName ?? null);

const kind = (group: string) => (code: string) =>
  fromCatalogue(["screens.admin_console.labels", group, code].join("."), code);

/** A feature an account can be blocked from ("translate" → "Translate"). */
export const featureLabel = kind("features");
/** A table a search reads ("audit_log" → "the audit log"). */
export const tableLabel = kind("tables");
/** A search filter the planner named ("signed_in_within_days" → "signed in within days"). */
export const filterLabel = kind("filters");
/** A trusted agent's owner ("first-party"). */
export const ownerLabel = kind("owners");
/** A capability an agent may use. */
export const capabilityLabel = kind("capabilities");
/** A password-policy field. */
export const policyFieldLabel = kind("policy_fields");
/** Who must approve ("admin", "super_admin"): a role. */
export const approverLabel = (code: string): string => readableRole(code, null);
/** An agent action's risk level ("restricted"). */
export const riskLabel = kind("risks");
/** An agent action's effect ("stateWrite" → "Writes state"). */
export const effectLabel = kind("effects");
/** Who approves under the approval policy: a person, an agent, the system. */
export const policyApproverLabel = kind("policy_approvers");
/** An audit record's action ("role_changed" → "Role changed"). */
export const auditActionLabel = kind("audit_actions");
/** A key in an audit record's details ("purgeReason" → "Reason for the erasure"). */
export const detailKeyLabel = kind("detail_keys");
/** A setting's category ("moderation"). */
export const settingCategoryLabel = kind("setting_categories");
/** A store an erasure reaches ("identity-provider" → "The sign-in service"; TASK-221). */
export const storeLabel = kind("stores");
/** A content category a classifier flagged ("self_harm" → "Self-harm"). */
export const categoryLabel = kind("categories");
/** A classifier's severity ("high" → "High"). */
export const severityLabel = kind("severities");
/** A step of a decision's explanation ("input-screening" → "Input screening"). */
export const phaseLabel = kind("phases");
/** A kind of external call whose outcome may be unknown ("song-identification"). */
export const effectTypeLabel = kind("effect_types");
/** A readiness check of the deployment, by the catalogue's name (screens.readiness.names). */
export function readinessCheckLabel(name: string): string {
  return fromCatalogue(["screens.readiness.names", name].join("."), name);
}

/**
 * A tenant's state (TASK-221, SF-admin-118: "active", in lower case, where Users writes "Active"):
 * the known states by name, any other said to be unknown — never shown as stored.
 */
export function tenantStateLabel(state: unknown): string {
  return state === "active" || state === "suspended" || state === "deleted"
    ? renderMessage(`screens.admin_console.labels.tenant_state.${state}`)
    : renderMessage("screens.admin_console.labels.tenant_state.unknown");
}

/** A capability's goal ("translate-and-speak"). */
export const goalLabel = kind("goals");
/** A goal step's intent. */
export const intentLabel = kind("intents");

/** The kind of reason an erasure was asked for (PURGE_REASONS), as the Users screen offers it. */
export function purgeReasonLabel(reason: string): string {
  return fromCatalogue(
    `screens.admin_console.users.erase_reason_${reason.replace(/-/g, "_")}`,
    reason
  );
}

/**
 * A trusted agent's status (SF-admin-132: anything but "suspended" read "Active"): the known
 * statuses by name, any other said to be unknown — never read as active.
 */
export function agentStatusLabel(status: unknown): string {
  return status === "active" || status === "suspended"
    ? renderMessage(`screens.admin_console.labels.agent_status.${status}`)
    : renderMessage("screens.admin_console.labels.agent_status.unknown");
}

/**
 * One of a setting's allowed values, by name: the catalogue's for that setting
 * (labels.setting_values.<key, dots as underscores>.<value>), else the value made readable.
 */
export function settingValueLabel(key: string, value: string): string {
  return fromCatalogue(
    [
      "screens.admin_console.labels.setting_values",
      key.replace(/[.-]/g, "_"),
      value,
    ].join("."),
    value
  );
}

/** An amount in US dollars, in the console's locale ("$0.004"): never a hand-made "$" string. */
export function usdText(amount: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(amount);
}

/**
 * A job by its catalogue name — a short name; what it does is screens.jobs.kinds, its description
 * (TASK-221: the description was shown as the job's name). The platform's jobs are named in
 * labels.jobs, a consuming app's own in its catalogue (screens.app.jobs, the namespace an app may
 * use — ADR-051 D1); each key is the kind with its dots and hyphens as underscores.
 */
export function jobKindLabel(jobKind: string): string {
  const id = jobKind.replace(/[.-]/g, "_");
  const platform = `screens.admin_console.labels.jobs.${id}`;
  const own = renderMessage(platform);
  if (own !== platform) return own;
  return fromCatalogue(`screens.app.jobs.${id}`, jobKind);
}

/**
 * A setting by a readable name: "moderation.strike_ban_threshold" → "Moderation: strike ban
 * threshold". (The catalogue holds each setting's description, screens.settings; its name is
 * its key, made readable.)
 */
export function settingLabel(key: string): string {
  const [first, ...rest] = key.split(".");
  if (!first) return "";
  if (rest.length === 0) return readableCode(first);
  const tail = readableCode(rest.join(" "));
  // Sentence case after the colon — an initialism stays as written ("escalation SLA hours").
  const lowered = /^[A-Z]{2,}\b/.test(tail)
    ? tail
    : tail.charAt(0).toLowerCase() + tail.slice(1);
  return `${readableCode(first)}: ${lowered}`;
}

/** A search result's column: the catalogue's heading, else the column made readable. */
export function columnLabel(column: string): string {
  return fromCatalogue(`screens.admin_console.search.columns.${column}`, column);
}

/** An action's name in words (TASK-202, N-62: the screen named the tool, "update_config"). */
export function toolLabel(tool: string): string {
  const key = `screens.admin_console.tools.${tool}`;
  const text = renderMessage(key);
  // A tool the catalogue does not name is said to be one, by its name made readable.
  return text === key
    ? renderMessage("screens.admin_console.tools.unknown", { tool: readableCode(tool) })
    : text;
}

/** Several codes as one readable list value (the catalogue's list formatting takes an array). */
export const labelled = (
  codes: readonly unknown[],
  label: (code: string) => string
): string[] => codes.map((c) => label(String(c)));
