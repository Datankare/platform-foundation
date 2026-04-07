"use client";

import React, { useState } from "react";

interface ActionPlan {
  message: string;
  actions: { tool: string; input: Record<string, unknown> }[];
}

interface ActionConfirmPanelProps {
  plan: ActionPlan;
  onConfirm: (actions: ActionPlan["actions"]) => void;
  onCancel: () => void;
  isExecuting: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

function describeAction(action: { tool: string; input: Record<string, any> }): string {
  const { tool, input } = action;

  switch (tool) {
    case "create_role": {
      const perms = input.permissions?.length
        ? ` with permissions: ${input.permissions.join(", ")}`
        : "";
      return `Create role "${input.display_name || input.name}"${perms}`;
    }
    case "delete_role":
      return `Delete role "${input.role_name}"`;
    case "duplicate_role":
      return `Duplicate "${input.source_role}" as "${input.new_display_name || input.new_name}"`;
    case "assign_permissions": {
      const parts: string[] = [];
      if (input.add?.length) parts.push(`add: ${input.add.join(", ")}`);
      if (input.remove?.length) parts.push(`remove: ${input.remove.join(", ")}`);
      return `Update permissions on "${input.role_name}" — ${parts.join("; ")}`;
    }
    case "assign_role_to_user":
      return `Assign role "${input.role_name}" to ${input.user_emails?.join(", ") || input.user_ids?.join(", ")}`;
    case "change_user_role":
      return `Change "${input.user_identifier}" to role "${input.new_role}"`;
    case "bulk_change_role":
      return `Change ${input.user_identifiers?.length || 0} users to role "${input.new_role}"`;
    case "delete_user":
      return `Delete user "${input.user_identifier}" (soft-delete, GDPR)`;
    case "create_entitlement_group": {
      const perms = input.permissions?.length
        ? ` with: ${input.permissions.join(", ")}`
        : "";
      return `Create entitlement "${input.display_name || input.code}"${perms}`;
    }
    case "grant_entitlement": {
      const expiry = input.expires_in_days
        ? ` (expires in ${input.expires_in_days} days)`
        : "";
      return `Grant "${input.entitlement_code}" to ${input.user_identifiers?.length || 0} users${expiry}`;
    }
    case "revoke_entitlement":
      return `Revoke "${input.entitlement_code}" from ${input.user_identifiers?.length || 0} users`;
    case "delete_entitlement_group":
      return `Delete entitlement group "${input.code}"`;
    case "update_guest_config": {
      const changes: string[] = [];
      if (input.nudge_after_sessions)
        changes.push(`nudge: ${input.nudge_after_sessions} sessions`);
      if (input.grace_after_sessions)
        changes.push(`grace: ${input.grace_after_sessions} sessions`);
      if (input.lockout_after_sessions)
        changes.push(`lockout: ${input.lockout_after_sessions} sessions`);
      if (input.guest_token_ttl_hours)
        changes.push(`TTL: ${input.guest_token_ttl_hours}h`);
      return `Update guest config — ${changes.join(", ")}`;
    }
    case "update_password_policy": {
      const changes: string[] = [];
      if (input.min_length) changes.push(`min length: ${input.min_length}`);
      if (input.rotation_days !== undefined)
        changes.push(`rotation: ${input.rotation_days} days`);
      return `Update password policy — ${changes.join(", ") || "see details"}`;
    }
    case "search":
      return `Search ${input.table} table`;
    case "search_audit":
      return `Search audit log: "${input.filter}"`;
    default:
      return `${tool}: ${JSON.stringify(input)}`;
  }
}

const destructiveTools = new Set([
  "delete_role",
  "delete_user",
  "delete_entitlement_group",
  "revoke_entitlement",
]);

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
        <p className="text-sm text-gray-300 whitespace-pre-wrap">{plan.message}</p>
      </div>

      {/* Actions List */}
      {plan.actions.length > 0 && (
        <div className="mb-4">
          <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">
            Proposed Actions
          </p>
          <div className="space-y-2">
            {plan.actions.map((action, i) => {
              const isDestructive = destructiveTools.has(action.tool);
              const description = describeAction(action);
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
                      <code
                        className={`text-xs px-1.5 py-0.5 rounded ${
                          isDestructive
                            ? "bg-red-900/30 text-red-400"
                            : "bg-blue-900/30 text-blue-400"
                        }`}
                      >
                        {action.tool}
                      </code>
                      {isDestructive && (
                        <span className="text-xs text-red-400">⚠ Destructive</span>
                      )}
                    </div>
                    <p className="text-sm text-gray-300">{description}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Confirm / Cancel */}
      {plan.actions.length > 0 && (
        <div className="flex items-center gap-3">
          <button
            onClick={handleConfirm}
            disabled={selectedActions.size === 0 || isExecuting}
            className={`text-sm font-medium px-5 py-2.5 rounded-lg transition disabled:opacity-40 ${
              hasDestructive
                ? "bg-red-600 hover:bg-red-500 text-white"
                : "bg-blue-600 hover:bg-blue-500 text-white"
            }`}
          >
            {isExecuting
              ? "Executing..."
              : `Confirm ${selectedActions.size} action${selectedActions.size !== 1 ? "s" : ""}`}
          </button>
          <button
            onClick={onCancel}
            disabled={isExecuting}
            className="text-sm text-gray-400 hover:text-gray-300 transition"
          >
            Cancel
          </button>
          {hasDestructive && (
            <p className="text-xs text-red-400 ml-auto">
              This includes destructive actions that cannot be undone.
            </p>
          )}
        </div>
      )}

      {/* No actions — just informational */}
      {plan.actions.length === 0 && (
        <button
          onClick={onCancel}
          className="text-sm text-gray-400 hover:text-gray-300 transition"
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
