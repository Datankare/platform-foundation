/**
 * components/admin/ui/confirmation-registry.ts — how much each admin action is confirmed, in one
 * place (TASK-216, SCREEN-FINDINGS P4 and P5, SF-admin-010)
 *
 * The command bar marked only "delete role" as something that cannot be undone: erasing an
 * account, rejecting a held change and removing a capability mapping got the same blue "Confirm"
 * as a search. Each screen that confirmed at all wrote its own step, with its own rule for a
 * reason (a minimum of 1, of 3, none, a fixed code). Here every action a screen or the command
 * bar can ask for has one entry:
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
 * irreversible here. A screen's own actions are named "<screen>.<action>"; the screens that
 * passes 56d-2 and 56d-3 convert add theirs.
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
  // A dead job discarded (the Jobs screen asks for a reason today, with its own form and an
  // unstated minimum — SF-admin-105, 108): the entry pass 56d-3 moves that screen onto.
  "jobs.discard": irreversible("discard_job", "required"),
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
