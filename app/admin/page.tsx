"use client";

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import AdminShell, {
  permittedSections,
  sectionTitle,
} from "@/components/admin/AdminShell";
import { UsersPanel } from "@/components/admin/UsersPanel";
import { sectionPlaceholder } from "@/components/admin/section-hints";
import type { AdminSection } from "@/components/admin/AdminShell";
import AdminPromptBar from "@/components/admin/AdminPromptBar";
import ActionConfirmPanel from "@/components/admin/ActionConfirmPanel";
import ExecutionResultsPanel from "@/components/admin/ExecutionResultsPanel";
import { HeldActionsPanel } from "@/components/admin/HeldActionsPanel";
import { DualControlKeysPanel } from "@/components/admin/DualControlKeysPanel";
import {
  RolesDataView,
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
import { OperatorJobsView } from "@/components/admin/JobsPanels";
import { AdminKillSwitchView } from "@/components/admin/AgentKillSwitchPanel";
import { renderMessage } from "@/platform/errors/messages";
import { apiFetch } from "@/platform/auth/api-fetch";
import { useAuth } from "@/platform/auth/context";
import MfaEnrollment from "@/components/admin/MfaEnrollment";
import { leaveConsole } from "@/components/admin/leave-console";
import {
  isPanelUnavailable,
  PANEL_UNAVAILABLE,
  PanelUnavailable,
} from "@/components/admin/PanelUnavailable";
import { RefusalNotice } from "@/components/refusal/RefusalNotice";
import { useRefusalSessionEnd } from "@/components/refusal/useRefusalSessionEnd";
import {
  announceSessionEnd,
  handleRefusal,
  networkRefusal,
  type Refusal,
} from "@/platform/errors/refusal";

/** The console's own user (GET /api/admin/session), or why it cannot open. */
type ConsoleSession =
  | { kind: "loading" }
  | {
      kind: "admin";
      roleName: string;
      permissions: readonly string[];
      /** The admin's own account id (the Users panel offers no change to it). */
      userId?: string;
    }
  | { kind: "mfa_required" }
  | { kind: "refused" }
  /** Refused for a reason other than access (TASK-181): restricted, unavailable, … */
  | { kind: "refusal"; refusal: Refusal };

/**
 * What the console does with a refused GET /api/admin/session (TASK-181 — it showed one "refused"
 * text for every refusal): no administrative access (`auth.permission_denied`, or not signed in)
 * is the access page; staff without a second factor enrol; an erased account's session ends;
 * anything else — a restricted account, a service that is down — is shown as itself.
 */
function sessionRefused(refusal: Refusal): ConsoleSession {
  if (refusal.code === "auth.mfa_required") return { kind: "mfa_required" };
  if (refusal.code === "auth.permission_denied" || refusal.kind === "sign-in") {
    return { kind: "refused" };
  }
  if (refusal.kind === "signed-out-erased") announceSessionEnd(refusal.code);
  return { kind: "refusal", refusal };
}

/** What a permission list allows: "*" (the development bypass admin) allows everything. */
function permissionCheck(granted: readonly string[]): (code: string) => boolean {
  return (code) => granted.includes("*") || granted.includes(code);
}

interface ActionPlan {
  message: string;
  actions: { tool: string; input: Record<string, unknown> }[];
}

interface ExecutionResult {
  tool: string;
  success: boolean;
  held?: boolean;
  result?: string;
  error?: string;
}

const ENDPOINTS: Record<string, string> = {
  // users: the Users panel reads its own pages (search, sort, paging — TASK-185).
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
  jobs: "/api/operator/jobs",
};

/**
 * One read of a panel's data: undefined when the panel has none or the read failed; the
 * PANEL_UNAVAILABLE marker when the server answered 503 — the data could not be read, which the
 * panel must say, never show as an empty list (review 14 L-1).
 */
async function fetchPanelData(panel: AdminSection): Promise<unknown> {
  const endpoint = ENDPOINTS[panel];
  if (!endpoint) return undefined;
  const res = await apiFetch(endpoint);
  if (res.status === 503) return PANEL_UNAVAILABLE;
  return res.ok ? res.json() : undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATA_VIEWS: Record<string, React.FC<{ data: any }>> = {
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
  jobs: OperatorJobsView,
  "kill-switch": AdminKillSwitchView,
};

/** Sections that are a form of their own, with no command bar (the kill switch, TASK-172). */
const NO_PROMPT_BAR: ReadonlySet<string> = new Set(["kill-switch"]);

export default function AdminPage() {
  const [currentPlan, setCurrentPlan] = useState<ActionPlan | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [results, setResults] = useState<ExecutionResult[] | null>(null);
  const [panelData, setPanelData] = useState<Record<string, unknown>>({});
  // The section chosen in the shell; none at first. What is open and read is `openPanel`, which
  // waits for the session (TASK-184: the console opened "roles" at once and read it before the
  // session answered — a 403 for anyone without admin_manage_roles, and for every admin before
  // the second-factor check).
  const [activePanel, setActivePanel] = useState<AdminSection | null>(null);
  const router = useRouter();
  const [session, setSession] = useState<ConsoleSession>({ kind: "loading" });
  const [sessionAttempt, setSessionAttempt] = useState(0);
  const { signOut } = useAuth();
  useRefusalSessionEnd();

  // Which sections to show: the admin's own permissions (audit B-14 — every section was shown
  // to every admin). Display only: each section's route checks its own permission.
  useEffect(() => {
    let current = true;
    void apiFetch("/api/admin/session")
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as {
          code?: unknown;
          message?: unknown;
          params?: unknown;
          roleName?: unknown;
          permissions?: unknown;
          userId?: unknown;
        };
        if (!current) return;
        if (res.ok && Array.isArray(body.permissions)) {
          setSession({
            kind: "admin",
            roleName: typeof body.roleName === "string" ? body.roleName : "",
            ...(typeof body.userId === "string" ? { userId: body.userId } : {}),
            permissions: body.permissions.filter(
              (p): p is string => typeof p === "string"
            ),
          });
        } else {
          setSession(
            sessionRefused(
              handleRefusal(body.code, {
                message: body.message,
                params: body.params,
                status: res.status,
              })
            )
          );
        }
      })
      .catch(() => {
        if (current) setSession({ kind: "refusal", refusal: networkRefusal() });
      });
    return () => {
      current = false;
    };
  }, [sessionAttempt]);

  const showPanelData = useCallback((panel: AdminSection, data: unknown) => {
    if (data !== undefined) setPanelData((prev) => ({ ...prev, [panel]: data }));
  }, []);

  /** Reloads a panel's data (after an action). */
  // The Users panel reads its own pages; a change made from the command bar re-reads them.
  const [usersRefresh, setUsersRefresh] = useState(0);
  const refreshData = useCallback(
    async (panel: AdminSection) => {
      if (panel === "users") setUsersRefresh((n) => n + 1);
      showPanelData(panel, await fetchPanelData(panel));
    },
    [showPanelData]
  );

  // The sections this admin may open, in the shell's order (AdminShell's one mapping); none until
  // the session has answered "admin".
  const permitted = useMemo(
    () =>
      session.kind === "admin"
        ? permittedSections(permissionCheck(session.permissions))
        : [],
    [session]
  );

  // The open panel: the one chosen, while the session permits it, else the first permitted
  // section; none while nothing is permitted.
  const openPanel =
    activePanel !== null && permitted.includes(activePanel)
      ? activePanel
      : (permitted[0] ?? null);

  // The open panel's data — so only ever a section the session permits; a response for a panel
  // since left is dropped.
  useEffect(() => {
    if (openPanel === null) return;
    let current = true;
    void fetchPanelData(openPanel).then((data) => {
      if (current) showPanelData(openPanel, data);
    });
    return () => {
      current = false;
    };
  }, [openPanel, showPanelData]);

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
        if (openPanel !== null) await refreshData(openPanel);
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
        if (openPanel !== null) await refreshData(openPanel);
      }
    } finally {
      setIsExecuting(false);
    }
  };

  function renderSection(section: AdminSection): React.ReactNode {
    const DataView = DATA_VIEWS[section];
    const title = sectionTitle(section);
    const allowed =
      session.kind === "admin" ? permissionCheck(session.permissions) : () => false;

    return (
      <div>
        <h2 className="text-xl font-bold text-white mb-4">{title}</h2>

        {!NO_PROMPT_BAR.has(section) && (
          <AdminPromptBar
            panel={section}
            placeholder={sectionPlaceholder(section, allowed)}
            onPlanReceived={(plan) => {
              setCurrentPlan(plan);
              setResults(null);
            }}
          />
        )}

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

        {section === "users" && (
          <UsersPanel
            hasPermission={allowed}
            refreshKey={usersRefresh}
            selfId={session.kind === "admin" ? session.userId : undefined}
          />
        )}

        {DataView &&
          (isPanelUnavailable(panelData[section]) ? (
            <PanelUnavailable panel={title} onRetry={() => void refreshData(section)} />
          ) : (
            <DataView data={panelData[section]} />
          ))}
      </div>
    );
  }

  // Nobody, or someone without administrative access: no console shell at all (audit B-14).
  if (session.kind === "refused") {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-sm text-gray-300">
          {renderMessage("screens.admin_console.refused")}
        </p>
        <button
          type="button"
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white"
          onClick={() => router.push("/auth")}
        >
          {renderMessage("screens.admin_console.sign_in")}
        </button>
      </main>
    );
  }

  if (session.kind === "refusal") {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <RefusalNotice
          refusal={session.refusal}
          onRetry={() => setSessionAttempt((n) => n + 1)}
          onSignOut={() => {
            void signOut().then(() => router.push("/auth"));
          }}
        />
      </main>
    );
  }

  if (session.kind === "mfa_required") {
    return (
      <MfaEnrollment
        onSignOut={() => {
          void signOut().then(() => router.push("/auth"));
        }}
      />
    );
  }

  // Nothing is shown, and nothing read, until the session has answered.
  if (session.kind === "loading") {
    return (
      <main
        role="status"
        className="mx-auto max-w-md p-8 text-center text-sm text-gray-300"
      >
        {renderMessage("screens.admin_console.loading")}
      </main>
    );
  }

  // Administrative access, but no section this role may open: say so, never a refused read. A
  // safety net, not a state the platform's server produces: /api/admin/session requires
  // can_access_admin, which always opens Approvals and Tenant. It holds if a section's permission
  // or the session route changes.
  if (permitted.length === 0) {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <RefusalNotice
          refusal={handleRefusal("auth.permission_denied", {
            message: renderMessage("screens.admin_console.no_sections"),
          })}
        />
        <button
          type="button"
          className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm text-white"
          onClick={() => {
            void signOut().then(() => router.push("/auth"));
          }}
        >
          {renderMessage("screens.refusal.sign_out")}
        </button>
      </main>
    );
  }

  return (
    <AdminShell
      adminName={session.roleName || "Administrator"}
      hasPermission={permissionCheck(session.permissions)}
      onSignOut={() => {
        // The session ends — the server revokes it and this browser forgets its tokens — then a
        // full load to sign-in (TASK-184: it only left for "/", still signed in).
        void signOut()
          .catch(() => undefined)
          .then(() => leaveConsole("/auth"));
      }}
      onSectionChange={(section) => setActivePanel(section)}
    >
      {renderSection}
    </AdminShell>
  );
}
