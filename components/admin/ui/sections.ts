/**
 * components/admin/ui/sections.ts — the admin console's one registry of sections (TASK-216,
 * SCREEN-FINDINGS P10; SF-admin-001, 006, 008, 020)
 *
 * A section was keyed in five maps that could drift apart: the shell's navigation, the page's
 * endpoints, its views, its "no command bar" set, and the command bar's hints. This is the one
 * list; every other map of sections is derived from it or held to it:
 *
 *   order, group, icon, title   the shell's navigation and picker, and the section's heading;
 *   permission                  who is offered the section (display only: its route checks);
 *   endpoint                    the read the page makes for it (null: the section reads its own
 *                               pages — Users, the review queue — or has nothing to read);
 *   hints                       the command bar's examples, each naming the tool it would run;
 *   commandBar(id)              what the command bar can do there — DERIVED from the server's
 *                               own maps (the tools the planner is given for the section,
 *                               PANEL_TOOLS — the client-safe names of PANEL_TOOL_SCHEMAS, held
 *                               equal by test — and the tables a search there reads,
 *                               SECTION_SEARCH_TABLES), so the bar is shown exactly where it can
 *                               do something and says what; a section with neither has no bar;
 *   the page's views            components/admin/section-views.tsx, typed so that a section
 *                               without a view does not compile.
 *
 * `?section=` in the address holds the open section: sectionFromSearch reads it against this
 * list, so a reload, Back and a link all lead to a section that exists.
 *
 * Client-safe: data only, no component.
 *
 * @module components/admin/ui
 */

import { renderMessage } from "@/platform/errors/messages";
import { PANEL_TOOLS } from "@/app/api/admin/ai/tool-permissions";
import {
  SECTION_SEARCH_TABLES,
  type SearchableTableName,
} from "@/app/api/admin/ai/search-scope";

export type SectionGroup = "people" | "access" | "safety" | "settings" | "operations";

/** The groups, in the navigation's order. */
export const SECTION_GROUPS: readonly SectionGroup[] = [
  "people",
  "access",
  "safety",
  "settings",
  "operations",
];

export interface SectionHint {
  /** screens.admin_console.hints.<key> */
  readonly key: string;
  /** The command-bar tool the example runs. */
  readonly tool: string;
  /** For `search`: the table it reads (its own permission applies too). */
  readonly table?: SearchableTableName;
}

interface SectionDef {
  readonly id: string;
  readonly group: SectionGroup;
  readonly icon: string;
  readonly permission: string;
  /** The catalogue key of its title. */
  readonly titleKey: string;
  readonly endpoint: string | null;
  readonly hints?: readonly SectionHint[];
}

const title = (id: string) => `screens.admin_console.sections.${id}`;

/**
 * Each section's read, by id — written once, as a literal map, so a reader of the source sees
 * every read the console makes (the awaited-requests guard, __tests__/e2e-awaited-requests.test.ts,
 * reads it through sectionEndpoint). A section not here reads for itself (Users, Moderation, …).
 */
const SECTION_READS = {
  erasures: "/api/operator/erasures",
  roles: "/api/admin/roles",
  entitlements: "/api/admin/entitlements",
  "per-account": "/api/admin/per-account",
  approvals: "/api/admin/approvals",
  "approval-policy": "/api/admin/approval-policy",
  "agent-registry": "/api/admin/agent-registry",
  capabilities: "/api/admin/capabilities",
  "capability-mapping": "/api/admin/capability-mapping",
  "password-policy": "/api/admin/password-policy",
  "platform-config": "/api/admin/config?enhanced=true",
  tenant: "/api/admin/tenant",
  audit: "/api/admin/audit?offset=0",
  jobs: "/api/operator/jobs",
  tenants: "/api/operator/tenants",
} as const;

export const SECTIONS = [
  // People: accounts, and what is decided about them.
  {
    id: "users",
    group: "people",
    icon: "👥",
    permission: "admin_manage_users",
    titleKey: title("users"),
    // The Users panel reads its own pages (search, sort, paging — TASK-185).
    endpoint: null,
    hints: [
      { key: "users_show", tool: "search", table: "users" },
      { key: "users_change_role", tool: "change_user_role" },
    ],
  },
  {
    // The human review queue — escalations, ban reviews and appeals (TASK-210, N-117): the
    // permission every moderation route checks; it reads and acts on its own routes.
    id: "moderation",
    group: "people",
    icon: "⚖️",
    permission: "can_moderate",
    titleKey: title("moderation"),
    endpoint: null,
  },
  {
    // The open erasures and their two-operator attestation (TASK-202, S3-E19): operators only.
    id: "erasures",
    group: "people",
    icon: "🧹",
    permission: "platform_operate",
    titleKey: title("erasures"),
    endpoint: SECTION_READS.erasures,
  },
  // Access: what a role, a group or one account may do.
  {
    id: "roles",
    group: "access",
    icon: "🛡️",
    permission: "admin_manage_roles",
    titleKey: title("roles"),
    endpoint: SECTION_READS.roles,
    hints: [
      { key: "roles_create", tool: "create_role" },
      { key: "roles_show", tool: "search", table: "roles" },
    ],
  },
  {
    id: "entitlements",
    group: "access",
    icon: "🎫",
    permission: "admin_manage_entitlements",
    titleKey: title("entitlements"),
    endpoint: SECTION_READS.entitlements,
    hints: [{ key: "entitlements_create", tool: "create_entitlement_group" }],
  },
  {
    id: "per-account",
    group: "access",
    icon: "🚫",
    permission: "admin_manage_account_restrictions",
    titleKey: title("per-account"),
    endpoint: SECTION_READS["per-account"],
  },
  // Safety: what waits for a second person, and what agents may do.
  {
    id: "approvals",
    group: "safety",
    icon: "✅",
    permission: "can_access_admin",
    titleKey: title("approvals"),
    endpoint: SECTION_READS.approvals,
  },
  {
    id: "approval-policy",
    group: "safety",
    icon: "🤝",
    permission: "admin_manage_approval_policy",
    titleKey: title("approval-policy"),
    endpoint: SECTION_READS["approval-policy"],
  },
  {
    id: "dual-control",
    group: "safety",
    icon: "🔒",
    permission: "config_view",
    titleKey: title("dual-control"),
    endpoint: null,
  },
  {
    // The single-tenant kill switch (TASK-172): the registry's own tier permission, as the route.
    id: "kill-switch",
    group: "safety",
    icon: "🛑",
    permission: "config_manage_safety",
    titleKey: "screens.kill_switch.nav",
    endpoint: null,
  },
  {
    id: "agent-registry",
    group: "safety",
    icon: "🤖",
    permission: "admin_manage_agents",
    titleKey: title("agent-registry"),
    endpoint: SECTION_READS["agent-registry"],
  },
  {
    id: "capabilities",
    group: "safety",
    icon: "🧩",
    permission: "admin_view_audit",
    titleKey: title("capabilities"),
    endpoint: SECTION_READS.capabilities,
  },
  {
    id: "capability-mapping",
    group: "safety",
    icon: "🗺️",
    permission: "admin_manage_config",
    titleKey: title("capability-mapping"),
    endpoint: SECTION_READS["capability-mapping"],
  },
  // Settings: the tenant's and the platform's.
  {
    id: "password-policy",
    group: "settings",
    icon: "🔑",
    permission: "admin_manage_config",
    titleKey: title("password-policy"),
    endpoint: SECTION_READS["password-policy"],
    hints: [{ key: "password_min_length", tool: "update_password_policy" }],
  },
  {
    // Every setting with its metadata, for the edit panel (TASK-202, N-60).
    id: "platform-config",
    group: "settings",
    icon: "⚡",
    permission: "admin_manage_config",
    titleKey: title("platform-config"),
    endpoint: SECTION_READS["platform-config"],
  },
  {
    id: "tenant",
    group: "settings",
    icon: "🏢",
    permission: "can_access_admin",
    titleKey: title("tenant"),
    endpoint: SECTION_READS.tenant,
  },
  // Operations: the record, and the operator's own screens.
  {
    id: "audit",
    group: "operations",
    icon: "📋",
    permission: "admin_view_audit",
    titleKey: title("audit"),
    endpoint: SECTION_READS.audit,
    hints: [{ key: "audit_role_changes", tool: "search", table: "audit_log" }],
  },
  {
    id: "jobs",
    group: "operations",
    icon: "⏱️",
    permission: "platform_operate",
    titleKey: "screens.jobs.nav",
    endpoint: SECTION_READS.jobs,
  },
  {
    id: "tenants",
    group: "operations",
    icon: "🌐",
    permission: "platform_operate",
    titleKey: title("tenants"),
    endpoint: SECTION_READS.tenants,
  },
] as const satisfies readonly SectionDef[];

export type AdminSection = (typeof SECTIONS)[number]["id"];

const BY_ID = new Map<string, SectionDef>(SECTIONS.map((s) => [s.id, s]));

/** The registry entry of `id` (every AdminSection has one). */
export function sectionDef(id: AdminSection): SectionDef {
  return BY_ID.get(id)!;
}

/** Whether `id` names a section. */
export function isSection(id: unknown): id is AdminSection {
  return typeof id === "string" && BY_ID.has(id);
}

/** A section's title: the navigation's label and the section's heading. */
export function sectionTitle(id: AdminSection): string {
  return renderMessage(sectionDef(id).titleKey);
}

/** A group's heading in the navigation. */
export function groupTitle(group: SectionGroup): string {
  return renderMessage(`screens.admin_console.groups.${group}`);
}

/** The read the page makes for a section, or null when the section reads for itself. */
export function sectionEndpoint(id: AdminSection): string | null {
  return id in SECTION_READS ? SECTION_READS[id as keyof typeof SECTION_READS] : null;
}

/**
 * The sections `hasPermission` allows, in the console's order: the one mapping from section to
 * permission (audit B-14). Display only — each section's route checks its own permission.
 */
export function permittedSections(
  hasPermission: (code: string) => boolean
): AdminSection[] {
  return SECTIONS.filter((s) => hasPermission(s.permission)).map((s) => s.id);
}

/** What the command bar can do on a section, as the server gives it to the planner. */
export interface CommandBarScope {
  /** The section's own actions, by tool. */
  readonly tools: readonly string[];
  /** The tables a search there reads. */
  readonly tables: readonly SearchableTableName[];
}

/** The command bar's scope on `id`, or null when it can do nothing there (no bar is shown). */
export function commandBar(id: AdminSection): CommandBarScope | null {
  const tools: readonly string[] = Object.prototype.hasOwnProperty.call(PANEL_TOOLS, id)
    ? PANEL_TOOLS[id as keyof typeof PANEL_TOOLS]
    : [];
  const tables = Object.prototype.hasOwnProperty.call(SECTION_SEARCH_TABLES, id)
    ? SECTION_SEARCH_TABLES[id]!
    : [];
  return tools.length === 0 && tables.length === 0 ? null : { tools, tables };
}

/** A section's example commands (each names a real tool and table: admin-section-hints test). */
export function sectionHints(id: string): readonly SectionHint[] {
  return (BY_ID.get(id) as { hints?: readonly SectionHint[] } | undefined)?.hints ?? [];
}

/** The parameter that holds the open section in the console's address. */
export const SECTION_PARAM = "section";

/** The section a query string names, when it names one. */
export function sectionFromSearch(search: string): AdminSection | null {
  const named = new URLSearchParams(search).get(SECTION_PARAM);
  return isSection(named) ? named : null;
}
