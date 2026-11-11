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
 * Mounted in the admin console's Moderation section (app/admin/page.tsx, can_moderate — the
 * permission every moderation route checks; TASK-210, N-117: no page mounted it before). An
 * appeal is claimed, released and resolved through the appeals route (/api/moderation/appeals/
 * [id]), every other item through the review route; a refused action shows the refusal's own
 * message. Every word is the catalog's: the item's source, priority, trigger, status, decision
 * and the assistant's suggested decision by their codes.
 *
 * @module components/ReviewDashboard
 */

"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import type {
  ReviewDecision,
  ReviewQueueItem,
  ReviewStatus,
} from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";
import type { ReviewRecommendation } from "@/platform/moderation/review-assist";
import { apiFetch } from "@/platform/auth/api-fetch";
import { readRefusal } from "@/platform/errors/refusal";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  lookup,
  renderMessage,
  type MessageValues,
} from "@/platform/errors/messages";
import { renderShown } from "@/platform/errors/shown-text";
import { recordedFactor, recordedReasons } from "@/platform/moderation/reasons";
import { Recorded, shownOrStored } from "./recorded";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const msg = (key: string, values?: MessageValues) =>
  renderMessage(`screens.review_dashboard.${key}`, values);

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

interface QueueResult {
  items: ReviewQueueItem[];
  error: string | null;
}

/**
 * A closed code's words (screens.review_dashboard.<group>_<code>, passed as that suffix); a code
 * the catalog does not know — a newer server's — as the code itself, never a missing-key marker.
 */
function codeLabel(suffix: string, code: string): string {
  const key = `screens.review_dashboard.${suffix}`;
  return lookup(CATALOGS[DEFAULT_LOCALE], key) === undefined ? code : renderMessage(key);
}

/** The route an item's actions go to: an appeal's own, or the review queue's (ADR-024). */
export function itemActionPath(item: Pick<ReviewQueueItem, "id" | "source">): string {
  const id = encodeURIComponent(item.id);
  return item.source === "appeal"
    ? `/api/moderation/appeals/${id}`
    : `/api/moderation/review/${id}`;
}

/** One read of the review queue; never throws (an outage is an error message). */
async function fetchQueue(status: ReviewStatus | "all"): Promise<QueueResult> {
  try {
    const qs = status === "all" ? "" : `?status=${status}`;
    const res = await apiFetch(`/api/moderation/review${qs}`, {
      headers: { "Content-Type": "application/json" },
    });
    // TASK-181: the refusal's own message (permission, restriction, rate limit, outage).
    if (!res.ok) return { items: [], error: (await readRefusal(res)).message };
    const data = await res.json();
    return { items: Array.isArray(data.items) ? data.items : [], error: null };
  } catch {
    return { items: [], error: msg("service_unreachable") };
  }
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

  const showQueue = useCallback((queue: QueueResult) => {
    setItems(queue.items);
    setError(queue.error);
    setLoading(false);
  }, []);

  // Every read is numbered; only the newest one is shown. A slow earlier response — the
  // previous filter's, or a Refresh overtaken by a filter change — never overwrites a newer one.
  const latestRead = useRef(0);

  /** Reloads the queue (after an action, or Refresh). */
  const load = useCallback(
    async (status: ReviewStatus | "all") => {
      const read = ++latestRead.current;
      setLoading(true);
      setError(null);
      const queue = await fetchQueue(status);
      if (read === latestRead.current) showQueue(queue);
    },
    [showQueue]
  );

  // The filter's queue; leaving the page drops a response still in flight.
  useEffect(() => {
    let current = true;
    const read = ++latestRead.current;
    void fetchQueue(filter).then((queue) => {
      if (current && read === latestRead.current) showQueue(queue);
    });
    return () => {
      current = false;
    };
  }, [filter, showQueue]);

  const selectFilter = (next: ReviewStatus | "all") => {
    if (next === filter) return;
    setLoading(true);
    setError(null);
    setFilter(next);
  };

  const patchItem = useCallback(
    async (id: string, body: Record<string, unknown>) => {
      // The item as shown: its source picks the route its actions go to.
      const item = items.find((i) => i.id === id);
      setBusyId(id);
      setError(null);
      try {
        const res = await apiFetch(itemActionPath(item ?? { id, source: "escalation" }), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          // TASK-181: the refusal's own message (its code's catalog text), never the body's
          // compatibility field — an object a screen cannot show.
          setError((await readRefusal(res)).message);
          return false;
        }
        return true;
      } catch {
        setError(msg("could_not_connect_to_the"));
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [items]
  );

  const getSuggestion = useCallback(async (id: string) => {
    setAssist((a) => ({ ...a, [id]: { loading: true } }));
    try {
      const res = await apiFetch(`/api/moderation/review/${id}/assist`, {
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
      setError(msg("reviewer_notes_are_required_to"));
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
    <div className={`w-full max-w-5xl ${t.container}`} data-testid="review-dashboard">
      <div className="flex items-center justify-between mb-4">
        <h3 className={`text-lg font-semibold ${t.heading}`}>{msg("review_queue")}</h3>
        <button
          type="button"
          onClick={() => load(filter)}
          className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn}`}
          data-testid="rd-refresh"
        >
          {msg("refresh")}
        </button>
      </div>

      <div
        className="flex flex-wrap gap-2 mb-4"
        role="group"
        aria-label={msg("filter_by_status")}
      >
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => selectFilter(s)}
            aria-pressed={filter === s}
            className={`px-3 py-1 rounded-full text-sm font-medium transition-colors ${
              filter === s ? "bg-blue-700 text-white" : t.filterInactive
            }`}
            data-testid={`rd-filter-${s}`}
          >
            {msg(`filter_${s}`)}
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
          {msg("loading_review_queue")}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className={`py-8 text-center text-sm ${t.muted}`} data-testid="rd-empty">
          {msg("no_items_in_the_review")}
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
          {msg("appeal_reason", { reason: item.appealReason ?? "" })}
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
              {msg("get_ai_suggestion")}
            </button>
          )}
          {assist?.loading && (
            <span
              className={`text-sm ${t.muted}`}
              data-testid={`rd-assist-loading-${item.id}`}
            >
              {msg("generating_suggestion")}
            </span>
          )}
          {assist?.fetched && assist.rec && (
            <div
              className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-800"
              data-testid={`rd-assist-banner-${item.id}`}
            >
              {msg("suggested", {
                recommendation: codeLabel(
                  `decision_${assist.rec.recommendation}`,
                  assist.rec.recommendation
                ),
                rationale: assist.rec.rationale,
              })}{" "}
              <span className="text-blue-600">{msg("advisory_you_decide")}</span>
            </div>
          )}
          {assist?.fetched && !assist.rec && (
            <span
              className={`text-sm ${t.muted}`}
              data-testid={`rd-assist-none-${item.id}`}
            >
              {msg("no_suggestion_available_right_now")}
            </span>
          )}
        </div>
      )}

      {item.status === "pending" && (
        <button
          type="button"
          onClick={() => props.onClaim(item.id)}
          disabled={busy}
          className="px-3 py-1 rounded-md text-sm font-medium bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50"
          data-testid={`rd-claim-${item.id}`}
        >
          {msg("claim")}
        </button>
      )}

      {item.status === "claimed" && !isDrafting && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => props.onOpenResolve(item.id)}
            className="px-3 py-1 rounded-md text-sm font-medium bg-blue-700 text-white hover:bg-blue-800"
            data-testid={`rd-resolve-open-${item.id}`}
          >
            {msg("resolve")}
          </button>
          <button
            type="button"
            onClick={() => props.onRelease(item.id)}
            disabled={busy}
            className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn} disabled:opacity-50`}
            data-testid={`rd-release-${item.id}`}
          >
            {msg("release")}
          </button>
        </div>
      )}

      {item.status === "resolved" && (
        <p className={`text-sm ${t.muted}`} data-testid={`rd-decision-${item.id}`}>
          {msg("decision_line", {
            decision: item.decision
              ? codeLabel(`decision_${item.decision}`, item.decision)
              : "",
          })}
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
  // Each control named by its label (WCAG 1.3.1, 4.1.2): ids unique to this panel.
  const id = useId();
  return (
    <div
      className={`mt-3 rounded-lg border p-3 ${t.panel}`}
      data-testid={`rd-resolve-panel-${item.id}`}
    >
      <label htmlFor={`${id}-decision`} className="block text-xs mb-1">
        {msg("decision")}
      </label>
      <select
        id={`${id}-decision`}
        value={draft.decision}
        onChange={(e) =>
          onChange({ ...draft, decision: e.target.value as ReviewDecision })
        }
        className={`w-full mb-2 rounded-md border px-2 py-1 text-sm ${t.input}`}
        data-testid="rd-decision-select"
      >
        {DECISIONS.map((d) => (
          <option key={d} value={d}>
            {msg(`decision_${d}`)}
          </option>
        ))}
      </select>

      {draft.decision === "modify" && (
        <div data-testid="rd-modify-block">
          <label htmlFor={`${id}-modified`} className="block text-xs mb-1">
            {msg("modified_action")}
          </label>
          <select
            id={`${id}-modified`}
            value={draft.modifiedAction}
            onChange={(e) =>
              onChange({ ...draft, modifiedAction: e.target.value as ModerationAction })
            }
            className={`w-full mb-2 rounded-md border px-2 py-1 text-sm ${t.input}`}
            data-testid="rd-modified-action"
          >
            {MODIFIED_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {msg(`action_${a}`)}
              </option>
            ))}
          </select>
        </div>
      )}

      <label htmlFor={`${id}-notes`} className="block text-xs mb-1">
        {msg("reviewer_notes")}
      </label>
      <textarea
        id={`${id}-notes`}
        value={draft.reviewerNotes}
        onChange={(e) => onChange({ ...draft, reviewerNotes: e.target.value })}
        rows={3}
        placeholder={msg("explain_the_decision")}
        className={`w-full mb-2 rounded-md border px-2 py-1 text-sm ${t.input}`}
        data-testid="rd-notes"
      />

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="px-3 py-1 rounded-md text-sm font-medium bg-blue-700 text-white hover:bg-blue-800 disabled:opacity-50"
          data-testid="rd-resolve-submit"
        >
          {msg("submit_decision")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className={`px-3 py-1 rounded-md text-sm font-medium ${t.secondaryBtn}`}
          data-testid="rd-resolve-cancel"
        >
          {msg("cancel")}
        </button>
      </div>
    </div>
  );
}

// ── Decision-context subcomponents ────────────────────────────────────

function ItemHeader({ item, t }: { item: ReviewQueueItem; t: ThemeClasses }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-2">
      <Badge className={SOURCE_BADGE[item.source]}>
        {codeLabel(`source_${item.source}`, item.source)}
      </Badge>
      <Badge className={PRIORITY_BADGE[item.priority]}>
        {codeLabel(`priority_${item.priority}`, item.priority)}
      </Badge>
      <Badge className={STATUS_BADGE[item.status]}>
        {codeLabel(`filter_${item.status}`, item.status)}
      </Badge>
      <span
        className={`ml-auto text-xs ${t.muted}`}
        data-testid={`rd-trajectory-${item.id}`}
      >
        {msg("trajectory_and_user", {
          trajectory: item.moderationResult.trajectoryId ?? "",
          user: item.targetUserId,
        })}
      </span>
    </div>
  );
}

/**
 * The confidence bar's fill. Its width is set on the element's style object after render, never as
 * a `style` attribute: the Content Security Policy allows no inline style attribute (SEC-017,
 * TASK-203 — `style-src` has no 'unsafe-inline'), and a CSSOM property set from script is not one.
 */
function ConfidenceFill({ percent }: { percent: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.style.width = `${percent}%`;
  }, [percent]);
  return (
    <div
      ref={ref}
      className="h-2 w-0 rounded-full bg-amber-500"
      data-testid="rd-confidence-fill"
      data-percent={percent}
    />
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
          <span className={`text-xs ${t.muted} w-20`}>{msg("confidence")}</span>
          <div className={`flex-1 h-2 rounded-full ${t.track}`}>
            <ConfidenceFill percent={confidencePct} />
          </div>
          <span className="text-xs font-medium w-10 text-right">{confidencePct}%</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mb-2">
        <Chip className="bg-blue-100 text-blue-800">
          {codeLabel(`triggered_${m.triggeredBy}`, m.triggeredBy)}
        </Chip>
        {severity && (
          <Chip className="bg-amber-100 text-amber-800">
            {msg("severity", { severity: String(severity) })}
          </Chip>
        )}
        {categories.map((cat) => (
          <Chip key={cat} className="bg-gray-100 text-gray-700">
            {cat}
          </Chip>
        ))}
        {m.contextFactors.map((factor, i) => (
          <Chip key={i} className="bg-gray-100 text-gray-700">
            <Recorded {...recordedFactor(factor)} />
          </Chip>
        ))}
      </div>

      <p className="text-sm mb-1">
        <span className={t.muted}>{msg("action")}</span>{" "}
        {codeLabel(`action_${m.action}`, m.action)}
      </p>
      {/* A div: a reason recorded before the keys carries a <details>, which a <p> may not hold. */}
      <div className="text-sm mb-2" data-testid={`rd-reasoning-${item.id}`}>
        <Recorded {...recordedReasons(m.reasoning)} />
      </div>
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
          <div className="text-xs">
            <Recorded {...shownOrStored(step.description)} />
          </div>
        </div>
      ))}
      {chain.conclusion && (
        <div
          className={`text-xs mt-1 ${t.muted}`}
          data-testid={`rd-conclusion-${item.id}`}
        >
          {typeof chain.conclusion === "string" ? (
            <Recorded {...shownOrStored(chain.conclusion)} />
          ) : (
            msg("conclusion", { conclusion: renderShown(chain.conclusion) })
          )}
        </div>
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
