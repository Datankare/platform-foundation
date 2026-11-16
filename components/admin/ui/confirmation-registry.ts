/**
 * components/admin/ui/confirmation-registry.ts — how much each admin action is confirmed, in one
 * place (TASK-216, SCREEN-FINDINGS P4 and P5, SF-admin-010)
 *
 * The command bar marked only "delete role" as something that cannot be undone: erasing an
 * account, rejecting a held change and removing a capability mapping got the same blue "Confirm"
 * as a search. Each screen that confirmed at all wrote its own step, with its own rule for a
 * reason (a minimum of 1, of 3, none, a fixed code). Here every action a screen or the command
 * bar can ask for has one entry (pass 56d-3, TASK-221, added the operator and moderation screens'):
 *
 *   risk         ordinary       nothing is changed that the same screen cannot change back, or
 *                               nothing is changed at all (a search);
 *                consequential  it takes effect for people — access, standing, a policy — and
 *                               can be changed back;
 *                irreversible   it cannot be undone. The confirm step is marked so, in words
 *                               and in red, and says what will be lost;
 *   reason       whether the confirm step asks why: none, optional, or required (one minimum
 *                length for every screen, said before the mistake — REASON_MIN);
 *   consequence  the catalogue key of what the action does to people, and for an irreversible
 *                one what is lost (screens.admin_console.confirm.consequence.<key>).
 *
 * Every command-bar tool has an entry — the type refuses a new tool without one — and
 * __tests__/admin-console-registries.test.ts holds the list to the server's: every action the
 * server always holds for a second administrator (ALWAYS_HELD_ACTIONS: an erasure) is
 * irreversible here. A screen's own actions are named "<screen>.<action>".
 *
 * Display only: the server decides what is held and what is refused.
 *
 * @module components/admin/ui
 */

import type {
  AdminToolId,
  CLIENT_ROUTED_TOOLS,
} from "@/app/api/admin/ai/tool-permissions";

export type Risk = "ordinary" | "consequential" | "irreversible";
export type ReasonRule = "none" | "optional" | "required";

export interface Confirmation {
  readonly risk: Risk;
  readonly reason: ReasonRule;
  /** screens.admin_console.confirm.consequence.<key>; none for an ordinary action. */
  readonly consequence?: string;
}

/** The fewest characters a reason has, on every screen; and the most. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

type ToolId = AdminToolId | keyof typeof CLIENT_ROUTED_TOOLS;

const ordinary: Confirmation = { risk: "ordinary", reason: "none" };
const consequential = (consequence: string): Confirmation => ({
  risk: "consequential",
  reason: "none",
  consequence,
});
const irreversible = (
  consequence: string,
  reason: ReasonRule = "none"
): Confirmation => ({
  risk: "irreversible",
  reason,
  consequence,
});

const TOOLS = {
  search: ordinary,
  create_role: ordinary,
  duplicate_role: ordinary,
  create_entitlement_group: ordinary,
  delete_role: irreversible("delete_role"),
  assign_permissions: consequential("assign_permissions"),
  change_user_role: consequential("change_user_role"),
  set_entitlement_group_active: consequential("set_entitlement_group_active"),
  update_password_policy: consequential("update_password_policy"),
  register_agent: consequential("register_agent"),
  suspend_agent: consequential("suspend_agent"),
  set_agent_scope: consequential("set_agent_scope"),
  set_agent_ttl: consequential("set_agent_ttl"),
  // The block's reason is kept with it (the tool's `reason`): asked, not required.
  block_user_feature: { ...consequential("block_user_feature"), reason: "optional" },
  unblock_user_feature: ordinary,
  set_approval_policy: consequential("set_approval_policy"),
  set_capability_mapping: consequential("set_capability_mapping"),
  purge_user_data: irreversible("purge_user_data"),
  approve_hold: consequential("approve_hold"),
  reject_hold: irreversible("reject_hold"),
} as const satisfies Record<ToolId, Confirmation>;

/** The actions screens offer themselves (not through the command bar). */
const SCREEN_ACTIONS = {
  "users.change_role": consequential("change_user_role"),
  // The kind of reason is chosen in the step (PURGE_REASONS); an erasure's hold keeps no free
  // text (TASK-194 round 9, I-3), so no note is asked — the approver reads the kind by its label.
  "users.erase": irreversible("purge_user_data"),
  // The operators' Jobs screen (TASK-221, SF-admin-100 to 108). Each change asks why — the route
  // records it (changeComment, or the reason kept with a run, a replay or a discard).
  "jobs.discard": irreversible("discard_job", "required"),
  "jobs.replay": { ...consequential("replay_job"), reason: "required" },
  "jobs.turn_on": { ...consequential("job_turn_on"), reason: "required" },
  "jobs.turn_off": { ...consequential("job_turn_off"), reason: "required" },
  "jobs.set_interval": { ...consequential("job_set_interval"), reason: "required" },
  // Run now: a job that removes records for good cannot be undone (its schedule says so,
  // `deletesData`); any other run still acts on every tenant it runs for.
  "jobs.run_now": { ...consequential("job_run_now"), reason: "optional" },
  "jobs.run_now_deletes": irreversible("job_run_now_deletes", "required"),
  // An external call whose outcome was unknown, marked by a person: it decides whether the
  // workflow waiting on it goes on or ends, and the mark cannot be changed afterwards.
  "jobs.effect_took_effect": irreversible("effect_took_effect"),
  "jobs.effect_no_effect": irreversible("effect_no_effect"),
  // The operators' tenants (TASK-221, E-87 to E-89, SF-admin-117): each state change states what
  // happens to the tenant's people, and asks why (the route records the reason).
  "tenancy.provision": consequential("provision_tenant"),
  "tenancy.add_address": consequential("add_tenant_address"),
  "tenancy.remove_address": consequential("remove_tenant_address"),
  "tenancy.suspend": { ...consequential("suspend_tenant"), reason: "required" },
  "tenancy.resume": { ...consequential("resume_tenant"), reason: "required" },
  "tenancy.restore": { ...consequential("restore_tenant"), reason: "required" },
  "tenancy.request_deletion": {
    ...consequential("request_tenant_deletion"),
    reason: "required",
  },
  // Approved, the deletion takes effect: the tenant's people are locked out and, after its grace
  // period, every row it owns is purged (restoring it is possible only until then).
  "tenancy.approve_deletion": consequential("approve_tenant_deletion"),
  "tenancy.reject_deletion": consequential("reject_tenant_deletion"),
  "tenancy.make_admin": consequential("make_tenant_admin"),
  // Purging the due tenants removes every row they own, for good.
  "tenancy.purge_due": irreversible("purge_due_tenants"),
  // A tenant's own value of a setting (its administrators', or an operator's for it): the comment
  // the record keeps is asked, as on Platform config; going back to the default is a change too.
  "tenant_settings.update": {
    risk: "consequential",
    reason: "required",
    consequence: "update_tenant_setting",
  },
  "tenant_settings.reset": consequential("reset_tenant_setting"),
  // The agent kill switch (TASK-221, SF-admin-127): it only takes power away, and reactivating an
  // agent is a held change — so not "cannot be undone"; the reason is recorded and required.
  "kill_switch.suspend": { ...consequential("suspend_all_agents"), reason: "required" },
  // Erasures' two-operator attestation (TASK-221, SF-admin-091): approved, the step is closed for
  // good on the attesters' word; asking states why (a kind, and a note the record keeps).
  "erasures.ask": { ...consequential("ask_attestation"), reason: "required" },
  "erasures.approve": irreversible("approve_attestation"),
  "erasures.reject": consequential("reject_attestation"),
  // A moderator's decision on a review item (TASK-221, SF-admin-143, 148): it changes an account's
  // standing (overturning restores it); the notes the record keeps are required.
  "review.resolve": { ...consequential("resolve_review"), reason: "required" },
  // Approvals (TASK-220, SF-admin-030): every decision on a held change confirms, as Approve did.
  // Approving is as grave as the change it lets through (confirmationFor, `heldTool`).
  // A decision may carry a note for the record (the route's `note`); only approving asks none.
  "approvals.approve": consequential("approve_hold"),
  "approvals.reject": irreversible("reject_hold", "optional"),
  "approvals.mark_executed": { ...consequential("mark_executed"), reason: "optional" },
  // Approving again runs the change again: as grave as the change.
  "approvals.reapprove": { ...consequential("reapprove_hold"), reason: "optional" },
  // Withdrawn, a run is closed for good: it never runs.
  "approvals.withdraw": irreversible("withdraw_hold", "optional"),
  // A setting changed from its screen (SF-admin-071): the comment the record keeps is required.
  "config.update": {
    risk: "consequential",
    reason: "required",
    consequence: "update_config",
  },
  // The dual-control list (SF-admin-083): always held for a second administrator.
  "dual_control.add": consequential("dual_control_add"),
  "dual_control.remove": consequential("dual_control_remove"),
  // A capability's mapping removed: its capability then needs no feature at all.
  "capability_mapping.remove": consequential("capability_mapping_remove"),
} as const satisfies Record<string, Confirmation>;

export const CONFIRMATIONS: Readonly<Record<string, Confirmation>> = {
  ...TOOLS,
  ...SCREEN_ACTIONS,
};

export type ConfirmableAction = keyof typeof TOOLS | keyof typeof SCREEN_ACTIONS;

const RANK: Record<Risk, number> = { ordinary: 0, consequential: 1, irreversible: 2 };

/** The graver of two risks. */
export function graver(a: Risk, b: Risk): Risk {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * How `action` is confirmed, given what it was asked with:
 *   - an action the registry does not know is consequential — never waved through as ordinary;
 *   - reactivating an agent undoes a suspension: ordinary;
 *   - approving a held change — or approving it again — is as grave as the change it lets
 *     through (`heldTool`: approving an erasure erases).
 */
export function confirmationFor(
  action: string,
  input: Readonly<Record<string, unknown>> = {},
  heldTool?: string
): Confirmation {
  const entry = Object.prototype.hasOwnProperty.call(CONFIRMATIONS, action)
    ? CONFIRMATIONS[action]!
    : consequential("unknown");
  if (action === "suspend_agent" && input.reactivate === true) return ordinary;
  if (
    (action === "approve_hold" ||
      action === "approvals.approve" ||
      action === "approvals.reapprove") &&
    heldTool
  ) {
    const held = confirmationFor(heldTool);
    if (held.risk === "irreversible") return { ...held, reason: entry.reason };
  }
  return entry;
}
