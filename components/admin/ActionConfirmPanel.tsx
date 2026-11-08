"use client";

import React, { useState } from "react";
import { describeSearch } from "./search-description";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { toolLabel } from "./ExecutionResultsPanel";

interface ActionPlan {
  message: string;
  actions: { tool: string; input: Record<string, unknown> }[];
  /** Searches the planner proposed outside this screen's tables, left out (TASK-202, N-65). */
  scopedOut?: readonly string[];
  /** Each account-targeting action's account, by index, as the planner route read it (N-63). */
  accounts?: Readonly<Record<number, { email: string | null; found: boolean }>>;
}

interface ActionConfirmPanelProps {
  plan: ActionPlan;
  onConfirm: (actions: ActionPlan["actions"]) => void;
  onCancel: () => void;
  isExecuting: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const d = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.plan.describe.${key}`, values);
const p = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.plan.${key}`, values);

/** A list in words, or "none". */
function listed(v: unknown): string | string[] {
  return Array.isArray(v) && v.length > 0 ? v.map(String) : p("none");
}

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

/** What an action does, in the catalog's words. */
export function describeAction(
  action: { tool: string; input: Record<string, any> },
  account?: { email: string | null; found: boolean }
): string {
  const { tool, input } = action;
  switch (tool) {
    case "approve_hold":
    case "reject_hold":
      return d(tool, { what: String(input.summary || input.proposalId || "") });
    case "create_role":
      return d("create_role", {
        role: String(input.display_name || input.name || ""),
        permissions:
          Array.isArray(input.permissions) && input.permissions.length
            ? input.permissions.map(String)
            : "none",
      });
    case "delete_role":
      return d("delete_role", { role: String(input.role_name ?? "") });
    case "duplicate_role":
      return d("duplicate_role", {
        source: String(input.source_role ?? ""),
        role: String(input.new_display_name || input.new_name || ""),
      });
    case "assign_permissions":
      return d("assign_permissions", {
        role: String(input.role_name ?? ""),
        add: listed(input.add),
        remove: listed(input.remove),
      });
    case "change_user_role":
      return d("change_user_role", {
        account: accountName(input.user_identifier, account),
        role: String(input.new_role ?? ""),
      });
    case "create_entitlement_group":
      return d("create_entitlement_group", {
        group: String(input.display_name || input.code || ""),
        permissions:
          Array.isArray(input.permissions) && input.permissions.length
            ? input.permissions.map(String)
            : "none",
      });
    case "update_password_policy": {
      const changes: string[] = [];
      if (input.min_length)
        changes.push(d("policy_min_length", { value: input.min_length }));
      if (input.rotation_days !== undefined)
        changes.push(d("policy_rotation", { value: Number(input.rotation_days) }));
      return d("update_password_policy", {
        changes: changes.length ? changes : d("policy_other"),
      });
    }
    case "register_agent":
      return d("register_agent", {
        agent: String(input.agent_id ?? ""),
        owner: String(input.owner || "first-party"),
        scopes: listed(input.scopes),
      });
    case "suspend_agent":
      return input.reactivate
        ? d("reactivate_agent", { agent: String(input.agent_id ?? "") })
        : d("suspend_agent", { agent: String(input.agent_id ?? "") });
    case "set_agent_scope":
      return d("set_agent_scope", {
        agent: String(input.agent_id ?? ""),
        scopes: listed(input.scopes),
      });
    case "set_agent_ttl":
      return d("set_agent_ttl", {
        agent: String(input.agent_id ?? ""),
        seconds: Number(input.max_token_ttl) || 0,
      });
    case "block_user_feature":
      return d("block_user_feature", {
        feature: String(input.feature ?? ""),
        account: accountName(input.user_id, account),
        reason: textOr(input.reason),
      });
    case "unblock_user_feature":
      return d("unblock_user_feature", {
        feature: String(input.feature ?? ""),
        account: accountName(input.user_id, account),
      });
    case "set_approval_policy":
      return d("set_approval_policy", {
        approver: String(input.default_approver ?? ""),
        rules: Array.isArray(input.rules) ? input.rules.length : 0,
      });
    case "set_capability_mapping":
      return input.remove
        ? d("remove_mapping", { capability: String(input.capability ?? "") })
        : d("set_mapping", {
            capability: String(input.capability ?? ""),
            features: listed(input.features),
          });
    case "purge_user_data":
      return d("purge_user_data", { account: accountName(input.userId, account) });
    case "search":
      return describeSearch(input);
    default:
      return d("other", { tool });
  }
}

const destructiveTools = new Set(["delete_role"]);

export default function ActionConfirmPanel({
  plan,
  onConfirm,
  onCancel,
  isExecuting,
}: ActionConfirmPanelProps) {
  const [selectedActions, setSelectedActions] = useState<Set<number>>(
    new Set(plan.actions.map((_, i) => i))
  );

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

  const hasDestructive = plan.actions.some((a) => destructiveTools.has(a.tool));

  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 p-5 mb-6">
      {/* AI Message */}
      <div className="mb-4">
        <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">
          {plan.message}
        </p>
        {plan.scopedOut && plan.scopedOut.length > 0 ? (
          <p className="mt-2 text-xs text-gray-400" data-scoped-out="true">
            {p("scoped_out", { tables: [...plan.scopedOut] })}
          </p>
        ) : null}
      </div>

      {/* Actions List */}
      {plan.actions.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-400 uppercase tracking-wider mb-2">
            {p("proposed")}
          </p>
          <div className="space-y-2">
            {plan.actions.map((action, i) => {
              const isDestructive = destructiveTools.has(action.tool);
              const description = describeAction(action, plan.accounts?.[i]);
              return (
                <label
                  key={i}
                  className={`flex items-start gap-3 p-3 rounded-lg cursor-pointer transition ${
                    selectedActions.has(i)
                      ? isDestructive
                        ? "bg-red-900/20 border border-red-800"
                        : "bg-blue-900/20 border border-blue-800"
                      : "bg-gray-800/50 border border-gray-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedActions.has(i)}
                    onChange={() => toggleAction(i)}
                    className="mt-0.5 rounded border-gray-600"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          isDestructive
                            ? "bg-red-900/30 text-red-400"
                            : "bg-blue-900/30 text-blue-400"
                        }`}
                      >
                        {toolLabel(action.tool)}
                      </span>
                      {isDestructive && (
                        <span className="text-xs text-red-400">⚠ {p("destructive")}</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-300 break-words">{description}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Confirm / Cancel */}
      {plan.actions.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={selectedActions.size === 0 || isExecuting}
            className={`text-sm font-medium px-5 py-2.5 rounded-lg transition disabled:opacity-40 ${
              hasDestructive
                ? "bg-red-600 hover:bg-red-500 text-white"
                : "bg-blue-600 hover:bg-blue-500 text-white"
            }`}
          >
            {isExecuting ? p("executing") : p("confirm", { count: selectedActions.size })}
          </button>
          <button
            onClick={onCancel}
            disabled={isExecuting}
            className="text-sm text-gray-400 hover:text-gray-300 transition"
          >
            {p("cancel")}
          </button>
          {hasDestructive && (
            <p className="text-xs text-red-400 ml-auto">{p("destructive_note")}</p>
          )}
        </div>
      )}

      {/* No actions — just informational */}
      {plan.actions.length === 0 && (
        <button
          onClick={onCancel}
          className="text-sm text-gray-400 hover:text-gray-300 transition"
        >
          {p("dismiss")}
        </button>
      )}
    </div>
  );
}
