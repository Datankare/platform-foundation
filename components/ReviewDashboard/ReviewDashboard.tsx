/**
 * components/ReviewDashboard/ReviewDashboard.tsx — Admin human-review queue
 *
 * ADR-024 / ADR-025 / P10: the human-oversight surface. Lists the review queue
 * and lets a moderator filter, claim, release, and resolve items (uphold /
 * overturn / modify) with the AGENT'S OWN decision context in view — confidence,
 * severity + categories, which layer triggered, context factors, the
 * explanation-chain step timeline, and the trajectory id. A reviewer may also
 * request an on-demand, advisory AI suggestion (ADR-025) that prefills the
 * decision; the human always decides.
 *
 * Conventions (match AdaptiveInput): "use client"; explicit THEMES map keyed by
 * a `variant` prop (no OS prefers-color-scheme); Tailwind core utilities;
 * data-testid on every interactive element AND every visual state.
 *
 * UX: gray = informational (loading / empty / no-suggestion); blue = advisory
 * AI suggestion; red = actual failure only.
 *
 * The per-item card is extracted into ReviewCard (presentational) so the
 * container stays small; all state and handlers live in the container.
 *
 * @module components/ReviewDashboard
 */

"use client";

import React, { useCallback, useEffect, useState } from "react";
import type {
  ReviewDecision,
  ReviewQueueItem,
  ReviewStatus,
} from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";
import type { ReviewRecommendation } from "@/platform/moderation/review-assist";

// ── Theme ─────────────────────────────────────────────────────────────

type Variant = "light" | "dark";

interface ThemeClasses {
  container: string;
  card: string;
  heading: string;
  muted: string;
  track: string;
  filterInactive: string;
  panel: string;
  input: string;
  secondaryBtn: string;
}

const THEMES: Record<Variant, ThemeClasses> = {
  light: {
    container: "text-gray-900",
    card: "border-gray-200 bg-white",
    heading: "text-gray-900",
    muted: "text-gray-500",
    track: "bg-gray-200",
    filterInactive: "bg-gray-100 text-gray-600 hover:bg-gray-200",
    panel: "bg-gray-50 border-gray-200",
    input: "border-gray-300 text-gray-900 placeholder-gray-400 bg-white",
    secondaryBtn: "bg-gray-100 text-gray-700 hover:bg-gray-200",
  },
  dark: {
    container: "text-gray-100",
    card: "border-gray-700 bg-gray-900",
    heading: "text-gray-100",
    muted: "text-gray-400",
    track: "bg-gray-700",
    filterInactive: "bg-gray-700/50 text-gray-300 hover:bg-gray-600",
    panel: "bg-gray-800 border-gray-700",
    input: "border-gray-600 text-white placeholder-gray-500 bg-gray-900",
    secondaryBtn: "bg-gray-700 text-gray-300 hover:bg-gray-600",
  },
};

const SOURCE_BADGE: Record<string, string> = {
  escalation: "bg-amber-100 text-amber-800",
  ban_review: "bg-red-100 text-red-800",
  appeal: "bg-blue-100 text-blue-800",
};
const PRIORITY_BADGE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-amber-100 text-amber-800",
  normal: "bg-gray-100 text-gray-700",
};
const STATUS_BADGE: Record<string, string> = {
  pending: "bg-gray-100 text-gray-700",
  claimed: "bg-blue-100 text-blue-800",
  resolved: "bg-green-100 text-green-800",
};

const STATUS_FILTERS: readonly (ReviewStatus | "all")[] = [
  "all",
  "pending",
  "claimed",
  "resolved",
];
const DECISIONS: readonly ReviewDecision[] = ["uphold", "overturn", "modify"];
const MODIFIED_ACTIONS: readonly ModerationAction[] = [
  "allow",
  "warn",
  "block",
  "escalate",
];

// ── Props + local state ───────────────────────────────────────────────

export interface ReviewDashboardProps {
  readonly variant?: Variant;
}

interface ResolveDraft {
  itemId: string;
  decision: ReviewDecision;
  reviewerNotes: string;
  modifiedAction: ModerationAction;
}

interface AssistState {
  loading?: boolean;
  fetched?: boolean;
  rec?: ReviewRecommendation | null;
}

// ── Container ─────────────────────────────────────────────────────────

export default function ReviewDashboard({ variant = "light" }: ReviewDashboardProps) {
  const t = THEMES[variant];
  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewStatus | "all">("all");
  const [draft, setDraft] = useState<ResolveDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [assist, setAssist] = useState<Record<string, AssistState>>({});

  const load = useCallback(async (status: ReviewStatus | "all") => {
    setLoading(true);
    setError(null);
    try {
      const qs = status === "all" ? "" : `?status=${status}`;
      const res = await fetch(`/api/moderation/review${qs}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        setError("Could not load the review queue. Please try again.");
        setItems([]);
        return;
      }
      const data = await res.json();
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch {
      setError("Could not connect to the review service.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const patchItem = useCallback(async (id: string, body: Record<string, unknown>) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/moderation/review/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "The action could not be completed.");
        return false;
      }
      return true;
    } catch {
      setError("Could not connect to the review service.");
      return false;
    } finally {
      setBusyId(null);
    }
  }, []);

  const getSuggestion = useCallback(async (id: string) => {
    setAssist((a) => ({ ...a, [id]: { loading: true } }));
    try {
      const res = await fetch(`/api/moderation/review/${id}/assist`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        setAssist((a) => ({ ...a, [id]: { fetched: true, rec: null } }));
        return;
      }
      const data = await res.json();
      setAssist((a) => ({
        ...a,
        [id]: { fetched: true, rec: data.recommendation ?? null },
      }));
    } catch {
      setAssist((a) => ({ ...a, [id]: { fetched: true, rec: null } }));
    }
  }, []);

  const handleClaim = useCallback(
    async (id: string) => {
      if (await patchItem(id, { action: "claim" })) load(filter);
    },
    [patchItem, load, filter]
  );

  const handleRelease = useCallback(
    async (id: string) => {
      if (await patchItem(id, { action: "unclaim" })) load(filter);
    },
    [patchItem, load, filter]
  );

  const openResolve = useCallback(
    (id: string) => {
      setDraft({
        itemId: id,
        decision: assist[id]?.rec?.recommendation ?? "uphold",
        reviewerNotes: "",
        modifiedAction: "warn",
      });
    },
    [assist]
  );

  const handleResolveSubmit = useCallback(async () => {
    if (!draft) return;
    if (!draft.reviewerNotes.trim()) {
      setError("Reviewer notes are required to resolve.");
      return;
    }
    const body: Record<string, unknown> = {
      action: "resolve",
      decision: draft.decision,
      reviewerNotes: draft.reviewerNotes,
    };
    if (draft.decision === "modify") body.modifiedAction = draft.modifiedAction;
    if (await patchItem(draft.itemId, body)) {
      setDraft(null);
      load(filter);
    }
  }, [draft, patchItem, load, filter]);

  return (
    <div
      className={`w-full max-w-4xl mx-auto ${t.container}`}
      data-testid="review-dashboard"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className={`text-lg font-semibold ${t.heading}`}>Review queue</h2>
        <button
          type="button"
          onClick={() => load(filter)}
          className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn}`}
          data-testid="rd-refresh"
        >
          Refresh
        </button>
      </div>

      <div className="flex gap-2 mb-4" role="group" aria-label="Filter by status">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setFilter(s)}
            aria-pressed={filter === s}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              filter === s ? "bg-blue-600 text-white" : t.filterInactive
            }`}
            data-testid={`rd-filter-${s}`}
          >
            {s}
          </button>
        ))}
      </div>

      {error && (
        <div
          className="mb-4 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700"
          role="alert"
          data-testid="rd-error"
        >
          {error}
        </div>
      )}

      {loading && (
        <div className={`py-8 text-center text-sm ${t.muted}`} data-testid="rd-loading">
          Loading review queue…
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className={`py-8 text-center text-sm ${t.muted}`} data-testid="rd-empty">
          No items in the review queue.
        </div>
      )}

      {!loading && items.length > 0 && (
        <ul className="space-y-3" data-testid="rd-list">
          {items.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              t={t}
              assist={assist[item.id]}
              draft={draft}
              busyId={busyId}
              onGetSuggestion={getSuggestion}
              onClaim={handleClaim}
              onRelease={handleRelease}
              onOpenResolve={openResolve}
              onCancelResolve={() => setDraft(null)}
              onResolveSubmit={handleResolveSubmit}
              onDraftChange={setDraft}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Per-item card (presentational) ────────────────────────────────────

interface ReviewCardProps {
  item: ReviewQueueItem;
  t: ThemeClasses;
  assist?: AssistState;
  draft: ResolveDraft | null;
  busyId: string | null;
  onGetSuggestion: (id: string) => void;
  onClaim: (id: string) => void;
  onRelease: (id: string) => void;
  onOpenResolve: (id: string) => void;
  onCancelResolve: () => void;
  onResolveSubmit: () => void;
  onDraftChange: (d: ResolveDraft) => void;
}

function ReviewCard(props: ReviewCardProps) {
  const { item, t, assist, draft, busyId } = props;
  const isDrafting = draft?.itemId === item.id;
  const busy = busyId === item.id;

  return (
    <li className={`rounded-lg border p-4 ${t.card}`} data-testid={`rd-item-${item.id}`}>
      <ItemHeader item={item} t={t} />
      <DecisionContext item={item} t={t} />

      {item.explanationChain && <ExplanationTimeline item={item} t={t} />}

      {item.appealReason && (
        <p
          className={`text-xs mb-2 ${t.muted}`}
          data-testid={`rd-appeal-reason-${item.id}`}
        >
          Appeal: {item.appealReason}
        </p>
      )}

      {item.status !== "resolved" && (
        <div className="mb-3" data-testid={`rd-assist-${item.id}`}>
          {!assist && (
            <button
              type="button"
              onClick={() => props.onGetSuggestion(item.id)}
              className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn}`}
              data-testid={`rd-assist-btn-${item.id}`}
            >
              Get AI suggestion
            </button>
          )}
          {assist?.loading && (
            <span
              className={`text-sm ${t.muted}`}
              data-testid={`rd-assist-loading-${item.id}`}
            >
              Generating suggestion…
            </span>
          )}
          {assist?.fetched && assist.rec && (
            <div
              className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800"
              data-testid={`rd-assist-banner-${item.id}`}
            >
              Suggested: {assist.rec.recommendation} — {assist.rec.rationale}{" "}
              <span className="text-blue-600">(advisory; you decide)</span>
            </div>
          )}
          {assist?.fetched && !assist.rec && (
            <span
              className={`text-sm ${t.muted}`}
              data-testid={`rd-assist-none-${item.id}`}
            >
              No suggestion available right now.
            </span>
          )}
        </div>
      )}

      {item.status === "pending" && (
        <button
          type="button"
          onClick={() => props.onClaim(item.id)}
          disabled={busy}
          className="px-3 py-1 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid={`rd-claim-${item.id}`}
        >
          Claim
        </button>
      )}

      {item.status === "claimed" && !isDrafting && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => props.onOpenResolve(item.id)}
            className="px-3 py-1 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700"
            data-testid={`rd-resolve-open-${item.id}`}
          >
            Resolve
          </button>
          <button
            type="button"
            onClick={() => props.onRelease(item.id)}
            disabled={busy}
            className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn} disabled:opacity-50`}
            data-testid={`rd-release-${item.id}`}
          >
            Release
          </button>
        </div>
      )}

      {item.status === "resolved" && (
        <p className={`text-sm ${t.muted}`} data-testid={`rd-decision-${item.id}`}>
          Decision: {item.decision}
        </p>
      )}

      {isDrafting && draft && (
        <ResolvePanel
          item={item}
          t={t}
          draft={draft}
          busy={busy}
          onChange={props.onDraftChange}
          onSubmit={props.onResolveSubmit}
          onCancel={props.onCancelResolve}
        />
      )}
    </li>
  );
}

// ── Resolve panel ─────────────────────────────────────────────────────

interface ResolvePanelProps {
  item: ReviewQueueItem;
  t: ThemeClasses;
  draft: ResolveDraft;
  busy: boolean;
  onChange: (d: ResolveDraft) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function ResolvePanel({
  item,
  t,
  draft,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: ResolvePanelProps) {
  return (
    <div
      className={`mt-3 rounded-lg border p-3 ${t.panel}`}
      data-testid={`rd-resolve-panel-${item.id}`}
    >
      <label className="block text-xs mb-1">Decision</label>
      <select
        value={draft.decision}
        onChange={(e) =>
          onChange({ ...draft, decision: e.target.value as ReviewDecision })
        }
        className={`w-full mb-2 rounded-md border px-2 py-1 text-sm ${t.input}`}
        data-testid="rd-decision-select"
      >
        {DECISIONS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>

      {draft.decision === "modify" && (
        <div data-testid="rd-modify-block">
          <label className="block text-xs mb-1">Modified action</label>
          <select
            value={draft.modifiedAction}
            onChange={(e) =>
              onChange({ ...draft, modifiedAction: e.target.value as ModerationAction })
            }
            className={`w-full mb-2 rounded-md border px-2 py-1 text-sm ${t.input}`}
            data-testid="rd-modified-action"
          >
            {MODIFIED_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
      )}

      <label className="block text-xs mb-1">Reviewer notes</label>
      <textarea
        value={draft.reviewerNotes}
        onChange={(e) => onChange({ ...draft, reviewerNotes: e.target.value })}
        rows={3}
        placeholder="Explain the decision…"
        className={`w-full mb-2 rounded-md border px-2 py-1 text-sm ${t.input}`}
        data-testid="rd-notes"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="px-3 py-1 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          data-testid="rd-resolve-submit"
        >
          Submit decision
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn}`}
          data-testid="rd-resolve-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Decision-context subcomponents ────────────────────────────────────

function ItemHeader({ item, t }: { item: ReviewQueueItem; t: ThemeClasses }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <Badge className={SOURCE_BADGE[item.source]}>{item.source}</Badge>
      <Badge className={PRIORITY_BADGE[item.priority]}>{item.priority}</Badge>
      <Badge className={STATUS_BADGE[item.status]}>{item.status}</Badge>
      <span
        className={`ml-auto text-xs ${t.muted}`}
        data-testid={`rd-trajectory-${item.id}`}
      >
        traj: {item.moderationResult.trajectoryId} · user: {item.targetUserId}
      </span>
    </div>
  );
}

function DecisionContext({ item, t }: { item: ReviewQueueItem; t: ThemeClasses }) {
  const m = item.moderationResult;
  const c = m.classifierOutput;
  const categories = c?.categories ?? [];
  const severity = c?.severity;
  const confidence = c ? (c as unknown as { confidence?: number }).confidence : undefined;
  const confidencePct =
    typeof confidence === "number" ? Math.round(confidence * 100) : null;

  return (
    <div className="mb-2">
      {confidencePct !== null && (
        <div
          className="flex items-center gap-2 mb-2"
          data-testid={`rd-confidence-${item.id}`}
        >
          <span className={`text-xs ${t.muted} w-20`}>Confidence</span>
          <div className={`flex-1 h-2 rounded-full ${t.track}`}>
            <div
              className="h-2 rounded-full bg-amber-500"
              style={{ width: `${confidencePct}%` }}
            />
          </div>
          <span className="text-xs font-medium w-10 text-right">{confidencePct}%</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mb-2">
        <Chip className="bg-blue-100 text-blue-800">{m.triggeredBy}</Chip>
        {severity && (
          <Chip className="bg-amber-100 text-amber-800">severity: {severity}</Chip>
        )}
        {categories.map((cat) => (
          <Chip key={cat} className="bg-gray-100 text-gray-700">
            {cat}
          </Chip>
        ))}
        {m.contextFactors.map((factor) => (
          <Chip key={factor} className="bg-gray-100 text-gray-700">
            {factor}
          </Chip>
        ))}
      </div>

      <p className="text-sm mb-1">
        <span className={t.muted}>Action:</span> {m.action}
      </p>
      <p className="text-sm mb-2">{m.reasoning}</p>
    </div>
  );
}

function ExplanationTimeline({ item, t }: { item: ReviewQueueItem; t: ThemeClasses }) {
  const chain = item.explanationChain;
  if (!chain) return null;
  return (
    <div
      className={`mb-2 border-l-2 ${t.panel} pl-3`}
      data-testid={`rd-timeline-${item.id}`}
    >
      {chain.steps.map((step, i) => (
        <div
          key={`${step.phase}-${i}`}
          className="flex gap-2 items-baseline mb-1"
          data-testid={`rd-step-${item.id}-${i}`}
        >
          <span className={`text-xs ${t.muted} min-w-24`}>{step.phase}</span>
          <span className="text-xs">{step.description}</span>
        </div>
      ))}
      {chain.conclusion && (
        <p className={`text-xs mt-1 ${t.muted}`} data-testid={`rd-conclusion-${item.id}`}>
          Conclusion: {chain.conclusion}
        </p>
      )}
    </div>
  );
}

function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${className ?? ""}`}>
      {children}
    </span>
  );
}

function Chip({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${className ?? ""}`}>
      {children}
    </span>
  );
}
