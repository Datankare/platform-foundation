"use client";

/**
 * components/admin/SectionConsole.tsx — one open section of the admin console: its heading, its
 * command bar, the plan and the outcomes of what was run there, and its view (TASK-216)
 *
 * The page gives each section its own console (a key), so nothing of one section follows the
 * admin to the next: a plan made on Users can no longer be confirmed under Roles, where it ran
 * against the wrong panel (SF-admin-001), and a section left and reopened is read again, saying
 * so, instead of showing what it held before as if it were current (SF-admin-002).
 *
 *   - The section's read goes through PanelState (E-4): a failed read is said, for every status
 *     and for no answer, and is never an empty list; every section has Refresh and its read time.
 *   - A confirmed plan's failure to get any answer is an outcome like any other (E-1): the
 *     shared call helper never throws.
 *   - An approve or reject from the command bar says what the decision route answered (E-2): it
 *     took effect, it still waits for another approver, it applied but could not be recorded, or
 *     why it was refused and what became of the approval — the Approvals panel's own reader.
 *   - The command bar is shown where it can do something, and says what (SF-admin-020).
 *   - Outcomes stay until each is dismissed; a new run adds to them.
 */

import React, { useCallback, useState } from "react";
import { SectionHeading } from "@/components/admin/AdminShell";
import {
  commandBar,
  sectionEndpoint,
  sectionTitle,
  type AdminSection,
} from "@/components/admin/ui/sections";
import { SECTION_VIEWS, type SectionViewProps } from "@/components/admin/section-views";
import { UsersPanel, type UserListFilters } from "@/components/admin/UsersPanel";
import {
  afterFiltersChanged,
  applyUsersSearch,
  resultsFor,
} from "@/components/admin/users-search-handoff";
import { mayShowDetails, ShowDetailsToggle } from "@/components/admin/ShowDetailsToggle";
import { sectionPlaceholder, sectionScope } from "@/components/admin/section-hints";
import AdminPromptBar from "@/components/admin/AdminPromptBar";
import ActionConfirmPanel, {
  type ActionPlan,
  type HeldChange,
} from "@/components/admin/ActionConfirmPanel";
import ExecutionResultsPanel, {
  type ExecutionResult,
} from "@/components/admin/ExecutionResultsPanel";
import { acceptedResult, describeWhat } from "@/components/admin/HeldActionsPanel";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import {
  refusedDecisionText,
  type DecisionOutcome,
} from "@/components/admin/decision-outcome";
import ReviewDashboard from "@/components/ReviewDashboard/ReviewDashboard";
import { renderMessage } from "@/platform/errors/messages";
import { adminCall, type CallBody } from "@/components/admin/ui/admin-call";
import { PanelState, usePanelRead } from "@/components/admin/ui/PanelState";
import { newOutcomeId } from "@/components/admin/ui/Outcome";

/**
 * The sections whose views keep a stored name, a code or an id as a detail, shown only with "Show
 * details" (TASK-220: Roles' stored names, a capability's address, an audit entry's ids, …).
 */
const DETAIL_SECTIONS: ReadonlySet<AdminSection> = new Set<AdminSection>([
  // The operator and moderation screens (TASK-221): a tenant's id, a job's kind, an erased
  // account's whole id, a withdrawn hold's reference, a decision's and an account's ids.
  "tenant",
  "tenants",
  "jobs",
  "erasures",
  "kill-switch",
  "moderation",
  "roles",
  "entitlements",
  "per-account",
  "approvals",
  "capabilities",
  "capability-mapping",
  "platform-config",
  "dual-control",
  "agent-registry",
  "audit",
]);

/** The signed-in admin, as the section needs them. */
export interface ConsoleAdmin {
  readonly roleName: string;
  /** The admin's own account id (the Users panel offers no change to it). */
  readonly userId?: string;
}

type Action = ActionPlan["actions"][number];

const r = (key: string, values?: Record<string, string>) =>
  renderMessage(`screens.admin_console.results.${key}`, values);

/** The held change an approve/reject names, among the Approvals list's rows. */
function heldRow(
  body: CallBody | null,
  input: Readonly<Record<string, unknown>>
): PendingApproval | null {
  const rows = Array.isArray(body?.approvals)
    ? (body.approvals as PendingApproval[])
    : [];
  return (
    rows.find(
      (row) =>
        row.id === String(input.proposalId ?? "") &&
        (input.source === undefined || row.source === input.source)
    ) ?? null
  );
}

/**
 * A planned approve/reject (ADR-040 040c), sent to the deterministic decision route — real admin
 * identity and server-side enforcement — never the command-bar executor. Its answer in words
 * (E-2): what the route said became of the change, never one "Decision recorded" for every 2xx.
 */
export async function decideFromPlan(
  decision: Action,
  row: PendingApproval | null
): Promise<ExecutionResult> {
  const id = String(decision.input.proposalId ?? "");
  const approve = decision.tool === "approve_hold";
  const answer = await adminCall(`/api/admin/approvals/${encodeURIComponent(id)}`, {
    method: "POST",
    json: { decision: approve ? "approve" : "reject", source: decision.input.source },
  });
  const what = row ? describeWhat(row) : r("held_change");
  if (!answer.ok) {
    // Refused: what became of the approval, and what to do (the Approvals panel's reader); else
    // the catalogue's sentence for the refusal's code.
    const text =
      refusedDecisionText(
        row?.label ?? decision.tool,
        answer.refusal,
        answer.body as DecisionOutcome,
        what
      ) ?? r("decision_refused", { what, reason: answer.refusal.message });
    return { tool: decision.tool, success: false, text };
  }
  const body = answer.body;
  const waits = approve && Boolean(body.pendingApproval);
  const unrecorded = approve && body.recorded === false;
  const text = row
    ? acceptedResult(approve ? "approve" : "reject", row, body).text
    : !approve
      ? r("decision_rejected", { what })
      : waits
        ? r("decision_waits", { what })
        : unrecorded
          ? r("decision_unrecorded", { what })
          : r("decision_applied", { what });
  return {
    tool: decision.tool,
    success: !waits,
    ...(waits ? { held: true, next: r("next_waits") } : {}),
    ...(unrecorded ? { unrecorded: true } : {}),
    text,
  };
}

export function SectionConsole({
  section,
  admin,
  hasPermission,
  showDetails,
  onShowDetails,
}: {
  readonly section: AdminSection;
  readonly admin: ConsoleAdmin;
  readonly hasPermission: (code: string) => boolean;
  /** "Show details" (admins and super-admins only): kept by the page for the console session. */
  readonly showDetails: boolean;
  readonly onShowDetails: (next: boolean) => void;
}) {
  const [plan, setPlan] = useState<{ seq: number; plan: ActionPlan } | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const [results, setResults] = useState<ExecutionResult[]>([]);
  // Bumped after a command-bar change: the section's data, and the Users list, are read again.
  const [refresh, setRefresh] = useState(0);
  // The command bar's users-search filters, applied to the Users list (TASK-190).
  const [userFilters, setUserFilters] = useState<UserListFilters>({});
  // Bumped on each hand-off: the Users panel clears its own search box (TASK-190 round 1).
  const [usersHandoff, setUsersHandoff] = useState(0);

  const endpoint = sectionEndpoint(section);
  const { read, reload } = usePanelRead(endpoint, refresh);
  const title = sectionTitle(section);
  const scope = commandBar(section);
  const View = SECTION_VIEWS[section] as React.FC<SectionViewProps> | null;
  const body = read.phase === "ready" ? read.body : null;

  const heldChange = useCallback(
    (input: Readonly<Record<string, unknown>>): HeldChange | null => {
      const row = heldRow(body, input);
      return row ? { what: describeWhat(row), tool: row.label } : null;
    },
    [body]
  );

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
        const decided = await decideFromPlan(decision, heldRow(body, decision.input));
        setResults((shown) => [...shown, { ...decided, uid: newOutcomeId() }]);
        setPlan(null);
        setRefresh((n) => n + 1);
        return;
      }
      const answer = await adminCall("/api/admin/ai/execute", {
        method: "POST",
        json: { actions },
      });
      if (!answer.ok) {
        // The plan refused as a whole (no result per action — its shape, the caller, a limit) or
        // never answered: said, never dropped silently (round 11, item 1; E-1). The plan stays,
        // to be confirmed again. A held plan is 202, read below with its results.
        setResults((shown) => [
          ...shown,
          {
            uid: newOutcomeId(),
            tool: actions[0]?.tool ?? "",
            success: false,
            text: answer.refusal.message,
          },
        ]);
        return;
      }
      const executed = Array.isArray(answer.body.results)
        ? (answer.body.results as ExecutionResult[])
        : [];
      const applied = applyUsersSearch(section, executed, actions, userFilters);
      setResults((shown) => [
        // A new users search drives the list: an earlier one's "shown in the list below" is
        // no longer true.
        ...(applied.filters ? (afterFiltersChanged(shown) ?? []) : shown),
        ...applied.results.map((result) => ({ ...result, uid: newOutcomeId() })),
      ]);
      if (applied.filters) {
        setUserFilters(applied.filters);
        setUsersHandoff((n) => n + 1);
      }
      setPlan(null);
      setRefresh((n) => n + 1);
    } finally {
      setIsExecuting(false);
    }
  };

  // "Show details" only where it changes something (TASK-190 round 1, item 5): the Users screen,
  // a section whose view keeps a stored name or an id as a detail (TASK-220), and a section
  // showing a search table with an id column.
  const detailsOffered =
    mayShowDetails(admin.roleName) &&
    (section === "users" ||
      DETAIL_SECTIONS.has(section) ||
      results.some((res) => res.success && res.table?.columns.includes("id")));
  const showIds = detailsOffered && showDetails;

  return (
    <div className="min-w-0">
      <SectionHeading section={section}>
        {detailsOffered && (
          <ShowDetailsToggle pressed={showDetails} onChange={onShowDetails} />
        )}
      </SectionHeading>

      {scope && (
        <AdminPromptBar
          panel={section}
          placeholder={sectionPlaceholder(section, hasPermission)}
          scope={sectionScope(section, hasPermission)}
          onPlanReceived={(received) =>
            setPlan((was) => ({ seq: (was?.seq ?? 0) + 1, plan: received }))
          }
        />
      )}

      {plan && (
        <ActionConfirmPanel
          // Each plan has its own panel: the checked actions are this plan's (SF-admin-011).
          key={plan.seq}
          plan={plan.plan}
          heldChange={heldChange}
          onConfirm={handleConfirm}
          onCancel={() => setPlan(null)}
          isExecuting={isExecuting}
        />
      )}

      <ExecutionResultsPanel
        // A users search is "in the list below" only on the Users screen.
        results={resultsFor(section, results)}
        showIds={showIds}
        onDismiss={(index) => setResults((shown) => shown.filter((_, i) => i !== index))}
      />

      {section === "users" && (
        <UsersPanel
          hasPermission={hasPermission}
          refreshKey={refresh}
          selfId={admin.userId}
          filters={userFilters}
          onFiltersChange={(next) => {
            // The search's row no longer describes the list: dismissed (round 1, item 1).
            setUserFilters(next);
            setResults((current) => afterFiltersChanged(current) ?? []);
          }}
          showIds={showIds}
          handoff={usersHandoff}
        />
      )}

      {/* The review queue reads and acts on its own routes (can_moderate, TASK-210). */}
      {section === "moderation" && <ReviewDashboard showIds={showIds} />}

      {View &&
        (endpoint === null ? (
          <View
            data={undefined}
            hasPermission={hasPermission}
            viewerId={admin.userId}
            showIds={showIds}
          />
        ) : (
          <PanelState read={read} panel={title} onReload={reload}>
            {(data) => (
              <View
                data={data}
                hasPermission={hasPermission}
                onReload={reload}
                viewerId={admin.userId}
                showIds={showIds}
              />
            )}
          </PanelState>
        ))}
    </div>
  );
}
