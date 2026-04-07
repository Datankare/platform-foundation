"use client";

import React, { useState, useEffect, useCallback } from "react";
import AdminShell from "@/components/admin/AdminShell";
import type { AdminSection } from "@/components/admin/AdminShell";
import AdminPromptBar from "@/components/admin/AdminPromptBar";
import ActionConfirmPanel from "@/components/admin/ActionConfirmPanel";
import ExecutionResultsPanel from "@/components/admin/ExecutionResultsPanel";
import {
  RolesDataView,
  UsersDataView,
  EntitlementsDataView,
  AuditDataView,
  GuestConfigDataView,
  PasswordPolicyDataView,
} from "@/components/admin/AdminDataViews";

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
  "guest-config": "Guest Configuration",
  "password-policy": "Password Policy",
};

const PANEL_HINTS: Record<string, string> = {
  users: 'Try: "Show all users" or "Change alice@example.com to admin role"',
  roles: 'Try: "Create a moderator role with can_play and can_view_audit"',
  entitlements: 'Try: "Create beta_access entitlement with can_translate"',
  audit: 'Try: "Show role changes from the last 7 days"',
  "guest-config": 'Try: "Set nudge to 5 sessions and lockout to 15"',
  "password-policy": 'Try: "Set minimum length to 16"',
};

const ENDPOINTS: Record<string, string> = {
  users: "/api/admin/users",
  roles: "/api/admin/roles",
  entitlements: "/api/admin/entitlements",
  audit: "/api/admin/audit?offset=0",
  "guest-config": "/api/admin/guest-config",
  "password-policy": "/api/admin/password-policy",
};

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATA_VIEWS: Record<string, React.FC<{ data: any }>> = {
  users: UsersDataView,
  roles: RolesDataView,
  entitlements: EntitlementsDataView,
  audit: AuditDataView,
  "guest-config": GuestConfigDataView,
  "password-policy": PasswordPolicyDataView,
};

export default function AdminPage() {
  const [currentPlan, setCurrentPlan] = useState<ActionPlan | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [results, setResults] = useState<ExecutionResult[] | null>(null);
  const [panelData, setPanelData] = useState<Record<string, unknown>>({});
  const [activePanel, setActivePanel] = useState<AdminSection>("roles");

  const refreshData = useCallback(async (panel: AdminSection) => {
    const endpoint = ENDPOINTS[panel];
    if (!endpoint) return;
    const res = await fetch(endpoint);
    if (res.ok) {
      const data = await res.json();
      setPanelData((prev) => ({ ...prev, [panel]: data }));
    }
  }, []);

  useEffect(() => {
    refreshData(activePanel);
  }, [activePanel, refreshData]);

  const handleConfirm = async (actions: ActionPlan["actions"]) => {
    setIsExecuting(true);
    try {
      const res = await fetch("/api/admin/ai/execute", {
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
      onSignOut={() => (window.location.href = "/")}
      onSectionChange={(section) => setActivePanel(section)}
    >
      {renderSection}
    </AdminShell>
  );
}
