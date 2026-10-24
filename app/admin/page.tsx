"use client";

import React, { useState, useEffect, useCallback } from "react";
import AdminShell from "@/components/admin/AdminShell";
import type { AdminSection } from "@/components/admin/AdminShell";
import AdminPromptBar from "@/components/admin/AdminPromptBar";
import ActionConfirmPanel from "@/components/admin/ActionConfirmPanel";
import ExecutionResultsPanel from "@/components/admin/ExecutionResultsPanel";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { DualControlKeysPanel } from "@/components/admin/DualControlKeysPanel";
import {
  RolesDataView,
  UsersDataView,
  EntitlementsDataView,
  AuditDataView,
  PasswordPolicyDataView,
  TrustedAgentsDataView,
  PerAccountRestrictionsDataView,
  ApprovalPolicyDataView,
  CapabilitiesDataView,
  CapabilityMappingDataView,
} from "@/components/admin/AdminDataViews";
import {
  OperatorTenantsView,
  TenantSettingsView,
} from "@/components/admin/TenancyPanels";
import { apiFetch } from "@/platform/auth/api-fetch";

interface ActionPlan {
  message: string;
  actions: { tool: string; input: Record<string, unknown> }[];
}

interface ExecutionResult {
  tool: string;
  success: boolean;
  result?: string;
  error?: string;
}

const PANEL_TITLES: Record<string, string> = {
  users: "Users",
  roles: "Roles",
  entitlements: "Entitlements",
  audit: "Audit Trail",
  "password-policy": "Password Policy",
  tenant: "Tenant",
  tenants: "Tenants",
};

const PANEL_HINTS: Record<string, string> = {
  users: 'Try: "Show all users" or "Change alice@example.com to admin role"',
  roles: 'Try: "Create a moderator role with can_play and admin_view_audit"',
  entitlements: 'Try: "Create beta_access entitlement with can_translate"',
  audit: 'Try: "Show role changes from the last 7 days"',
  "password-policy": 'Try: "Set minimum length to 16"',
};

const ENDPOINTS: Record<string, string> = {
  users: "/api/admin/users",
  roles: "/api/admin/roles",
  entitlements: "/api/admin/entitlements",
  audit: "/api/admin/audit?offset=0",
  approvals: "/api/admin/approvals",
  "password-policy": "/api/admin/password-policy",
  "agent-registry": "/api/admin/agent-registry",
  "per-account": "/api/admin/per-account",
  "approval-policy": "/api/admin/approval-policy",
  capabilities: "/api/admin/capabilities",
  "capability-mapping": "/api/admin/capability-mapping",
  tenant: "/api/admin/tenant",
  tenants: "/api/operator/tenants",
};

/** One read of a panel's data: undefined when the panel has none or the read failed. */
async function fetchPanelData(panel: AdminSection): Promise<unknown> {
  const endpoint = ENDPOINTS[panel];
  if (!endpoint) return undefined;
  const res = await apiFetch(endpoint);
  return res.ok ? res.json() : undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATA_VIEWS: Record<string, React.FC<{ data: any }>> = {
  users: UsersDataView,
  roles: RolesDataView,
  entitlements: EntitlementsDataView,
  audit: AuditDataView,
  approvals: HeldActionsPanel,
  "dual-control": DualControlKeysPanel,
  "password-policy": PasswordPolicyDataView,
  "agent-registry": TrustedAgentsDataView,
  "per-account": PerAccountRestrictionsDataView,
  "approval-policy": ApprovalPolicyDataView,
  capabilities: CapabilitiesDataView,
  "capability-mapping": CapabilityMappingDataView,
  tenant: TenantSettingsView,
  tenants: OperatorTenantsView,
};

export default function AdminPage() {
  const [currentPlan, setCurrentPlan] = useState<ActionPlan | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [results, setResults] = useState<ExecutionResult[] | null>(null);
  const [panelData, setPanelData] = useState<Record<string, unknown>>({});
  const [activePanel, setActivePanel] = useState<AdminSection>("roles");

  const showPanelData = useCallback((panel: AdminSection, data: unknown) => {
    if (data !== undefined) setPanelData((prev) => ({ ...prev, [panel]: data }));
  }, []);

  /** Reloads a panel's data (after an action). */
  const refreshData = useCallback(
    async (panel: AdminSection) => showPanelData(panel, await fetchPanelData(panel)),
    [showPanelData]
  );

  // The open panel's data; a response for a panel since left is dropped.
  useEffect(() => {
    let current = true;
    void fetchPanelData(activePanel).then((data) => {
      if (current) showPanelData(activePanel, data);
    });
    return () => {
      current = false;
    };
  }, [activePanel, showPanelData]);

  const handleConfirm = async (actions: ActionPlan["actions"]) => {
    setIsExecuting(true);
    try {
      // ADR-040 040c: an approve/reject action routes through the deterministic decision
      // route (real admin identity + server-side enforcement), NOT the command-bar executor
      // (which runs under a non-authenticated actor and cannot clear a hold).
      const decision = actions.find(
        (a) => a.tool === "approve_hold" || a.tool === "reject_hold"
      );
      if (decision) {
        const id = String(decision.input.proposalId ?? "");
        const res = await apiFetch(`/api/admin/approvals/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            decision: decision.tool === "approve_hold" ? "approve" : "reject",
            source: decision.input.source,
          }),
        });
        const body = await res.json().catch(() => ({}));
        setResults([
          {
            tool: decision.tool,
            success: res.ok,
            result: res.ok ? "Decision recorded" : undefined,
            error: res.ok ? undefined : (body.error ?? `Failed (${res.status})`),
          },
        ]);
        setCurrentPlan(null);
        await refreshData(activePanel);
        return;
      }
      const res = await apiFetch("/api/admin/ai/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actions }),
      });
      if (res.ok) {
        const { results: execResults } = await res.json();
        setResults(execResults);
        setCurrentPlan(null);
        await refreshData(activePanel);
      }
    } finally {
      setIsExecuting(false);
    }
  };

  function renderSection(section: AdminSection): React.ReactNode {
    const DataView = DATA_VIEWS[section];

    return (
      <div>
        <h2 className="text-xl font-bold text-white mb-4">
          {PANEL_TITLES[section] || section}
        </h2>

        <AdminPromptBar
          panel={section}
          placeholder={PANEL_HINTS[section]}
          onPlanReceived={(plan) => {
            setCurrentPlan(plan);
            setResults(null);
          }}
        />

        {currentPlan && (
          <ActionConfirmPanel
            plan={currentPlan}
            onConfirm={handleConfirm}
            onCancel={() => setCurrentPlan(null)}
            isExecuting={isExecuting}
          />
        )}

        {results && (
          <ExecutionResultsPanel results={results} onDismiss={() => setResults(null)} />
        )}

        {DataView && <DataView data={panelData[section]} />}
      </div>
    );
  }

  return (
    <AdminShell
      adminName="Administrator"
      hasPermission={() => true}
      onSignOut={() => {
        // A full load, not client navigation: leaving the console keeps no in-memory state.
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.assign("/");
      }}
      onSectionChange={(section) => setActivePanel(section)}
    >
      {renderSection}
    </AdminShell>
  );
}
