"use client";

/**
 * components/admin/ActionConfirmPanel.tsx — the command bar's plan, confirmed before it runs
 *
 * TASK-216 (SF-admin-010 to 016): every action's risk comes from the confirmation registry
 * (components/admin/ui/confirmation-registry.ts) — an action that cannot be undone is marked so
 * in words and in red and says what will be lost, whichever action it is (it was only "delete
 * role"); an action whose account the planner did not find is said as that and cannot be
 * confirmed; roles, permissions, features and capabilities are named, never shown as codes, and
 * a held change is named by what it is, never by its id; the panel is a labelled region whose
 * heading takes focus when a plan arrives. The page gives each plan its own panel (a key), so
 * the checked actions are always this plan's.
 */

import React, { useEffect, useId, useRef, useState } from "react";
import { describeSearch } from "./search-description";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import {
  confirmationFor,
  graver,
  type Risk,
} from "@/components/admin/ui/confirmation-registry";
import { consequenceText } from "@/components/admin/ui/ConfirmStep";
import { Checkbox } from "@/components/admin/ui/Field";
import {
  capabilityLabel,
  featureLabel,
  labelled,
  ownerLabel,
  permissionLabel,
  roleLabel,
  tableLabel,
  toolLabel,
} from "@/components/admin/ui/labels";
import { BUTTON, FOCUS_TARGET, SURFACE, TEXT } from "@/components/admin/ui/tokens";

export interface ActionPlan {
  message: string;
  actions: { tool: string; input: Record<string, unknown> }[];
  /** Searches the planner proposed outside this screen's tables, left out (TASK-202, N-65). */
  scopedOut?: readonly string[];
  /** Each account-targeting action's account, by index, as the planner route read it (N-63). */
  accounts?: Readonly<Record<number, { email: string | null; found: boolean }>>;
  /** The display name of each role the plan names, by stored name (TASK-216, SF-admin-013). */
  roles?: Readonly<Record<string, string>>;
}

/** A held change a plan decides, as the Approvals list names it. */
export interface HeldChange {
  /** What the change is, in words ("ann@example.com's role change"). */
  readonly what: string;
  /** The held action (its tool): approving it is as grave as the action itself. */
  readonly tool: string;
}

/** What the plan's words are resolved against. */
export interface DescribeContext {
  readonly roles?: Readonly<Record<string, string>>;
  /** The held change an approve/reject names; null when it is not in the list. */
  readonly held?: HeldChange | null;
}

interface ActionConfirmPanelProps {
  plan: ActionPlan;
  onConfirm: (actions: ActionPlan["actions"]) => void;
  onCancel: () => void;
  isExecuting: boolean;
  /** The held change an approve/reject action names (the Approvals list's row). */
  heldChange?: (input: Readonly<Record<string, unknown>>) => HeldChange | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const d = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.plan.describe.${key}`, values);
const p = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.plan.${key}`, values);

/** A list of codes by their names, or "none". */
function named(v: unknown, label: (code: string) => string): string | string[] {
  return Array.isArray(v) && v.length > 0 ? labelled(v, label) : p("none");
}

/** A list as given (an agent's scopes are named by capability). */
const scopes = (v: unknown) => named(v, capabilityLabel);

/** A text value, or "none" (the catalog's selects take it as their empty branch). */
const textOr = (v: unknown): string =>
  typeof v === "string" && v.trim() !== "" ? v : "none";

/**
 * An account as the confirm step names it (TASK-202, N-63): its address, as the planner route
 * read it — never the id the planner put in. Not read: what was asked, as before.
 */
function accountName(
  asked: unknown,
  account: { email: string | null; found: boolean } | undefined
): string {
  if (account?.found)
    return account.email ?? renderMessage("screens.admin_console.people.no_email");
  if (account && !account.found)
    return renderMessage("screens.admin_console.people.unknown");
  return String(asked ?? "");
}

/** Every change a password-policy action names, in words (SF-admin-014: "see the details"). */
function policyChanges(input: Record<string, any>): string[] {
  const changes: string[] = [];
  if (input.min_length !== undefined)
    changes.push(d("policy_min_length", { value: Number(input.min_length) }));
  if (input.rotation_days !== undefined)
    changes.push(d("policy_rotation", { value: Number(input.rotation_days) }));
  for (const field of ["uppercase", "lowercase", "number", "special"] as const) {
    const value = input[`require_${field}`];
    if (typeof value === "boolean")
      changes.push(d(`policy_require_${field}`, { on: value ? "yes" : "no" }));
  }
  if (input.password_history_count !== undefined)
    changes.push(d("policy_history", { value: Number(input.password_history_count) }));
  return changes;
}

/** What an action does, in the catalog's words. */
export function describeAction(
  action: { tool: string; input: Record<string, any> },
  account?: { email: string | null; found: boolean },
  context: DescribeContext = {}
): string {
  const { tool, input } = action;
  /** A role the plan names: its display name as the planner route read it, else made readable. */
  const role = (name: unknown) =>
    roleLabel(String(name ?? ""), context.roles?.[String(name ?? "")] ?? null);
  const permissions = (v: unknown) =>
    Array.isArray(v) && v.length ? labelled(v, permissionLabel) : "none";
  switch (tool) {
    case "approve_hold":
    case "reject_hold":
      // Named as the Approvals list names it — never by the hold's id (SF-admin-013).
      return d(tool, { what: context.held?.what ?? d("held_unlisted") });
    case "create_role":
      return d("create_role", {
        role: String(input.display_name || input.name || ""),
        permissions: permissions(input.permissions),
      });
    case "delete_role":
      return d("delete_role", { role: role(input.role_name) });
    case "duplicate_role":
      return d("duplicate_role", {
        source: role(input.source_role),
        role: String(input.new_display_name || input.new_name || ""),
      });
    case "assign_permissions":
      return d("assign_permissions", {
        role: role(input.role_name),
        add: named(input.add, permissionLabel),
        remove: named(input.remove, permissionLabel),
      });
    case "change_user_role":
      return d("change_user_role", {
        account: accountName(input.user_identifier, account),
        role: role(input.new_role),
      });
    case "create_entitlement_group":
      return d("create_entitlement_group", {
        group: String(input.display_name || input.code || ""),
        permissions: permissions(input.permissions),
      });
    case "update_password_policy": {
      const changes = policyChanges(input);
      return d("update_password_policy", {
        changes: changes.length ? changes : d("policy_nothing"),
      });
    }
    case "register_agent":
      return d("register_agent", {
        agent: String(input.agent_id ?? ""),
        owner: ownerLabel(String(input.owner || "first-party")),
        scopes: scopes(input.scopes),
      });
    case "suspend_agent":
      return input.reactivate
        ? d("reactivate_agent", { agent: String(input.agent_id ?? "") })
        : d("suspend_agent", { agent: String(input.agent_id ?? "") });
    case "set_agent_scope":
      return d("set_agent_scope", {
        agent: String(input.agent_id ?? ""),
        scopes: scopes(input.scopes),
      });
    case "set_agent_ttl":
      return d("set_agent_ttl", {
        agent: String(input.agent_id ?? ""),
        seconds: Number(input.max_token_ttl) || 0,
      });
    case "block_user_feature":
      return d("block_user_feature", {
        feature: featureLabel(String(input.feature ?? "")),
        account: accountName(input.user_id, account),
        reason: textOr(input.reason),
      });
    case "unblock_user_feature":
      return d("unblock_user_feature", {
        feature: featureLabel(String(input.feature ?? "")),
        account: accountName(input.user_id, account),
      });
    case "set_approval_policy":
      return d("set_approval_policy", {
        approver: roleLabel(String(input.default_approver ?? ""), null),
        rules: Array.isArray(input.rules) ? input.rules.length : 0,
      });
    case "set_capability_mapping":
      return input.remove
        ? d("remove_mapping", {
            capability: capabilityLabel(String(input.capability ?? "")),
          })
        : d("set_mapping", {
            capability: capabilityLabel(String(input.capability ?? "")),
            features: named(input.features, featureLabel),
          });
    case "purge_user_data":
      return d("purge_user_data", { account: accountName(input.userId, account) });
    case "search":
      return describeSearch(input);
    default:
      return toolLabel(tool);
  }
}

const RISK_STYLE: Record<Risk, { box: string; badge: string }> = {
  ordinary: {
    box: "border-blue-800 bg-blue-900/20",
    badge: "bg-blue-900/40 text-blue-200",
  },
  consequential: {
    box: "border-blue-800 bg-blue-900/20",
    badge: "bg-blue-900/40 text-blue-200",
  },
  irreversible: {
    box: "border-red-700 bg-red-950/40",
    badge: "bg-red-900/50 text-red-100",
  },
};

export default function ActionConfirmPanel({
  plan,
  onConfirm,
  onCancel,
  isExecuting,
  heldChange,
}: ActionConfirmPanelProps) {
  const rows = plan.actions.map((action, i) => {
    const account = plan.accounts?.[i];
    const isDecision = action.tool === "approve_hold" || action.tool === "reject_hold";
    const held = isDecision ? (heldChange?.(action.input) ?? null) : undefined;
    const confirmation = confirmationFor(action.tool, action.input, held?.tool);
    return {
      action,
      confirmation,
      // The planner found no such account in this tenant: the server would refuse the action,
      // so it cannot be confirmed (SF-admin-012).
      missing: account !== undefined && !account.found,
      description: describeAction(action, account, { roles: plan.roles, held }),
      consequence: consequenceText(confirmation),
    };
  });
  const [selectedActions, setSelectedActions] = useState<Set<number>>(
    () => new Set(rows.flatMap((row, i) => (row.missing ? [] : [i])))
  );
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  // A plan is waiting: its heading takes focus, so it is in view and announced (SF-admin-016).
  useEffect(() => heading.current?.focus(), []);

  const toggleAction = (index: number) => {
    const next = new Set(selectedActions);
    if (next.has(index)) {
      next.delete(index);
    } else {
      next.add(index);
    }
    setSelectedActions(next);
  };

  const handleConfirm = () => {
    const selected = plan.actions.filter((_, i) => selectedActions.has(i));
    onConfirm(selected);
  };

  // The gravest of the actions still checked: what the button and the note speak for.
  const gravest = rows.reduce<Risk>(
    (risk, row, i) =>
      selectedActions.has(i) ? graver(risk, row.confirmation.risk) : risk,
    "ordinary"
  );

  return (
    <section
      aria-labelledby={titleId}
      data-plan="true"
      className={`${SURFACE.panel} mb-6 p-4 md:p-5`}
    >
      <h3
        id={titleId}
        ref={heading}
        tabIndex={-1}
        className={`mb-2 text-sm font-semibold ${TEXT.strong} ${FOCUS_TARGET}`}
      >
        {plan.actions.length > 0 ? p("proposed") : p("answer")}
      </h3>
      <div className="mb-4">
        <p className={`text-sm whitespace-pre-wrap break-words ${TEXT.quiet}`}>
          {plan.message}
        </p>
        {plan.scopedOut && plan.scopedOut.length > 0 ? (
          <p className={`mt-2 text-xs ${TEXT.faint}`} data-scoped-out="true">
            {p("scoped_out", { tables: labelled(plan.scopedOut, tableLabel) })}
          </p>
        ) : null}
      </div>

      {plan.actions.length > 0 && (
        <ul className="mb-4 space-y-2">
          {rows.map((row, i) => {
            const risk = row.confirmation.risk;
            const style = RISK_STYLE[risk];
            return (
              <li
                key={i}
                data-risk={risk}
                data-missing={row.missing ? "true" : undefined}
                className={`rounded-lg border p-3 ${
                  selectedActions.has(i) ? style.box : "border-gray-700 bg-gray-800/50"
                }`}
              >
                <Checkbox
                  checked={selectedActions.has(i)}
                  disabled={row.missing || isExecuting}
                  onChange={() => toggleAction(i)}
                  label={
                    <>
                      <span className="mb-1 flex flex-wrap items-center gap-2">
                        <span className={`rounded px-1.5 py-0.5 text-xs ${style.badge}`}>
                          {toolLabel(row.action.tool)}
                        </span>
                        {risk === "irreversible" && (
                          <strong
                            className="text-xs font-semibold text-red-200"
                            data-irreversible="true"
                          >
                            {p("destructive")}
                          </strong>
                        )}
                      </span>
                      <span className={`block text-sm break-words ${TEXT.body}`}>
                        {row.description}
                      </span>
                      {row.consequence && (
                        <span
                          className={`mt-1 block text-xs break-words ${
                            risk === "irreversible" ? "text-red-100" : TEXT.quiet
                          }`}
                          data-consequence="true"
                        >
                          {row.consequence}
                        </span>
                      )}
                      {row.missing && (
                        <span
                          className="mt-1 block text-xs text-amber-200"
                          data-account-missing="true"
                        >
                          {p("account_missing")}
                        </span>
                      )}
                    </>
                  }
                />
              </li>
            );
          })}
        </ul>
      )}

      {plan.actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={selectedActions.size === 0 || isExecuting}
            className={gravest === "irreversible" ? BUTTON.danger : BUTTON.primary}
          >
            {isExecuting ? p("executing") : p("confirm", { count: selectedActions.size })}
          </button>
          <button onClick={onCancel} disabled={isExecuting} className={BUTTON.quiet}>
            {p("cancel")}
          </button>
          {gravest === "irreversible" && (
            <p className="text-xs text-red-200" data-irreversible-note="true">
              {p("destructive_note")}
            </p>
          )}
        </div>
      )}

      {/* No actions — just informational */}
      {plan.actions.length === 0 && (
        <button onClick={onCancel} className={BUTTON.quiet}>
          {p("dismiss")}
        </button>
      )}
    </section>
  );
}
