"use client";

/**
 * components/ReviewDashboard/ReviewDashboard.tsx — the human review queue (ADR-024, ADR-025, P10),
 * on the console's shared parts (TASK-221)
 *
 * Lists the review queue and lets a moderator filter it, claim, release and resolve items (uphold,
 * overturn, modify) with the agent's own decision context in view — confidence, severity and
 * categories, which layer triggered, context factors, the explanation's steps. A reviewer may ask
 * for an advisory AI suggestion (ADR-025) that prefills the decision; the human always decides.
 * Mounted in the admin console's Moderation section (can_moderate, TASK-210). An appeal is acted
 * on through the appeals route, every other item through the review route.
 *
 * What the review found and how each is done (SF-admin-140 to 149):
 *
 *   - an item names its account by address and its decision by its kind and date — the ids only
 *     with "Show details" (140);
 *   - who holds a claim, and since when, is shown; Resolve and Release are offered only to the
 *     moderator who holds it — anyone else is told who does (141); a resolved item says who
 *     decided, when, and their notes or the platform's own note (the reaper's block);
 *   - what became of a claim, a release or a decision is an outcome kept until dismissed (142); a
 *     refusal is said on its item, and too-short notes at their field (143);
 *   - categories, severity and explanation steps by name (144); a refused suggestion says why
 *     (145); an item says how long it has waited and, for an open escalation, when the reaper acts
 *     on it — or that it is overdue (146); the console's own dark colours (147);
 *   - each decision is explained before it is chosen, and confirmed with the reviewer's notes
 *     (148); the queue is read a page at a time (149), and a queue that cannot be read is said —
 *     never "No items" (the route refuses it as unavailable).
 *
 * @module components/ReviewDashboard
 */

import React, { useEffect, useRef, useState } from "react";
import type {
  ReviewDecision,
  ReviewQueueItem,
  ReviewStatus,
} from "@/platform/moderation/review-types";
import type { ModerationAction } from "@/platform/moderation/types";
import type { ReviewRecommendation } from "@/platform/moderation/review-assist";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  lookup,
  renderMessage,
  type MessageValues,
} from "@/platform/errors/messages";
import { renderShown, isShownText, type ShownText } from "@/platform/errors/shown-text";
import type { Refusal } from "@/platform/errors/refusal";
import { recordedFactor, recordedReasons } from "@/platform/moderation/reasons";
import { Recorded, shownOrStored } from "./recorded";
import { adminCall, type CallBody } from "@/components/admin/ui/admin-call";
import { PanelState, Reading, usePanelRead } from "@/components/admin/ui/PanelState";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { Field, Select } from "@/components/admin/ui/Field";
import {
  OutcomeList,
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import { IdDetail, PersonRef } from "@/components/admin/ui/Ref";
import { categoryLabel, phaseLabel, severityLabel } from "@/components/admin/ui/labels";
import { pageRange } from "@/components/admin/ui/AdminTable";
import { BUTTON, SURFACE, TEXT, TONE } from "@/components/admin/ui/tokens";
import { ExpandableText } from "@/components/admin/ExpandableText";
import { formatDateTime, fullTimestamp } from "@/components/admin/admin-format";
import type { PersonRef as Person } from "@/components/admin/people";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const msg = (key: string, values?: MessageValues) =>
  renderMessage(`screens.review_dashboard.${key}`, values);

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
/** Items one page holds. */
export const PAGE_SIZE = 25;

/** An item as the review route lists it (TASK-221): its people by address, its due time. */
export type QueueItem = ReviewQueueItem & {
  readonly target?: Person | null;
  readonly claimer?: Person | null;
  readonly resolver?: Person | null;
  readonly claimedByViewer?: boolean;
  /** An open escalation: when the escalation reaper acts on it (ADR-041). */
  readonly dueAt?: string;
};

/**
 * A closed code's words (screens.review_dashboard.<group>_<code>, passed as that suffix); a code
 * the catalog does not know — a newer server's — said to be unknown, never as stored.
 */
function codeLabel(suffix: string): string {
  const key = `screens.review_dashboard.${suffix}`;
  return lookup(CATALOGS[DEFAULT_LOCALE], key) === undefined
    ? msg("unknown_value")
    : renderMessage(key);
}

/** The route an item's actions go to: an appeal's own, or the review queue's (ADR-024). */
export function itemActionPath(item: Pick<ReviewQueueItem, "id" | "source">): string {
  const id = encodeURIComponent(item.id);
  return item.source === "appeal"
    ? `/api/moderation/appeals/${id}`
    : `/api/moderation/review/${id}`;
}

/** The queue's read for a filter and a page. */
export function queueUrl(status: ReviewStatus | "all", offset: number): string {
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (offset > 0) qs.set("offset", String(offset));
  qs.set("limit", String(PAGE_SIZE));
  return `/api/moderation/review?${qs.toString()}`;
}

/** What an item is, in one line: its kind, about whom (for an outcome). */
function itemName(item: QueueItem): string {
  return msg("item_name", {
    source: codeLabel(`source_${item.source}`),
    account: item.target?.email ?? msg("account_unnamed"),
  });
}

type AssistState =
  | { readonly phase: "loading" }
  | { readonly phase: "done"; readonly rec: ReviewRecommendation | null }
  | { readonly phase: "refused"; readonly refusal: Refusal };

// ── Container ─────────────────────────────────────────────────────────

export default function ReviewDashboard({
  showIds = false,
}: {
  readonly showIds?: boolean;
}) {
  const [filter, setFilter] = useState<ReviewStatus | "all">("all");
  const [offset, setOffset] = useState(0);
  const { read, reload } = usePanelRead(queueUrl(filter, offset));
  const [outcomes, setOutcomes] = useState<OutcomeEntry[]>([]);
  const add = (entry: OutcomeEntry) => setOutcomes((shown) => [...shown, entry]);
  const title = msg("review_queue");

  return (
    <div className="w-full min-w-0 max-w-5xl space-y-4" data-testid="review-dashboard">
      <h3 className={`text-lg font-semibold ${TEXT.strong}`}>{title}</h3>
      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label={msg("filter_by_status")}
      >
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setFilter(s);
              setOffset(0);
            }}
            aria-pressed={filter === s}
            className={filter === s ? BUTTON.primary : BUTTON.quiet}
            data-testid={`rd-filter-${s}`}
          >
            {msg(`filter_${s}`)}
          </button>
        ))}
      </div>
      <OutcomeList
        outcomes={outcomes}
        label={msg("results_label")}
        onDismiss={(id) => setOutcomes((shown) => shown.filter((o) => o.id !== id))}
      />
      <PanelState
        read={read}
        panel={title}
        onReload={reload}
        empty={(body) =>
          Array.isArray(body.items) && body.items.length === 0
            ? offset > 0
              ? msg("page_empty")
              : msg("no_items_in_the_review")
            : null
        }
      >
        {(body: CallBody) => {
          const items = Array.isArray(body.items) ? (body.items as QueueItem[]) : [];
          const readAt = read.phase === "ready" ? read.readAt : new Date(0);
          return (
            <>
              <ul className="space-y-3" data-testid="rd-list" aria-label={title}>
                {items.map((item) => (
                  <ReviewCard
                    key={item.id}
                    item={item}
                    readAt={readAt}
                    showIds={showIds}
                    onDone={(entry) => {
                      add(entry);
                      reload();
                    }}
                    onChanged={reload}
                  />
                ))}
              </ul>
              {offset > 0 || body.hasMore === true ? (
                <nav
                  aria-label={msg("pager_label")}
                  className={`flex flex-wrap items-center gap-3 text-sm ${TEXT.quiet}`}
                >
                  <button
                    type="button"
                    className={BUTTON.quiet}
                    disabled={offset === 0}
                    onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    {msg("previous_page")}
                  </button>
                  <span data-page-range="true">
                    {pageRange({ offset, shown: items.length, total: null })}
                  </span>
                  <button
                    type="button"
                    className={BUTTON.quiet}
                    disabled={body.hasMore !== true}
                    onClick={() => setOffset(offset + PAGE_SIZE)}
                  >
                    {msg("next_page")}
                  </button>
                </nav>
              ) : null}
            </>
          );
        }}
      </PanelState>
    </div>
  );
}

// ── Per-item card ─────────────────────────────────────────────────────

function ReviewCard({
  item,
  readAt,
  showIds,
  onDone,
  onChanged,
}: {
  readonly item: QueueItem;
  readonly readAt: Date;
  readonly showIds: boolean;
  /** An action done: its outcome (kept above the list), and the queue read again. */
  readonly onDone: (entry: OutcomeEntry) => void;
  /** The item is no longer what it was (a refusal that may have changed it). */
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [assist, setAssist] = useState<AssistState | null>(null);
  const [resolving, setResolving] = useState<{
    decision: ReviewDecision;
    modifiedAction: ModerationAction;
  } | null>(null);
  const [askingNotes, setAskingNotes] = useState(false);
  const [refusals, setRefusals] = useState<OutcomeEntry[]>([]);
  const resolveButton = useRef<HTMLButtonElement>(null);
  const name = itemName(item);

  const patch = async (body: Record<string, unknown>, done: string) => {
    setBusy(true);
    const answer = await adminCall(itemActionPath(item), { method: "PATCH", json: body });
    setBusy(false);
    if (answer.ok) {
      setResolving(null);
      setAskingNotes(false);
      onDone(outcome("applied", done, { who: item.target?.email ?? undefined }));
      return;
    }
    setRefusals((shown) => [...shown, refusedOutcome(answer.refusal, { action: name })]);
    if (answer.status === 409 || answer.status === 404) onChanged();
  };

  const suggest = async () => {
    setAssist({ phase: "loading" });
    const answer = await adminCall(
      `/api/moderation/review/${encodeURIComponent(item.id)}/assist`,
      {
        method: "POST",
      }
    );
    setAssist(
      answer.ok
        ? {
            phase: "done",
            rec: (answer.body.recommendation as ReviewRecommendation | undefined) ?? null,
          }
        : { phase: "refused", refusal: answer.refusal }
    );
  };

  return (
    <li
      className={`${SURFACE.panel} min-w-0 space-y-3 p-4`}
      data-testid={`rd-item-${item.id}`}
    >
      <ItemHeader item={item} readAt={readAt} showIds={showIds} />
      <DecisionContext item={item} />
      {item.explanationChain && <ExplanationTimeline item={item} />}
      {item.appealReason && (
        <p
          className={`text-sm ${TEXT.quiet}`}
          data-testid={`rd-appeal-reason-${item.id}`}
        >
          {msg("appeal_reason", { reason: item.appealReason })}
        </p>
      )}
      <OutcomeList
        outcomes={refusals}
        label={msg("item_results_label", { item: name })}
        onDismiss={(id) => setRefusals((shown) => shown.filter((o) => o.id !== id))}
      />

      {item.status !== "resolved" && (
        <div data-testid={`rd-assist-${item.id}`}>
          {assist === null ? (
            <button type="button" onClick={() => void suggest()} className={BUTTON.quiet}>
              {msg("get_ai_suggestion")}
            </button>
          ) : assist.phase === "loading" ? (
            <Reading text={msg("generating_suggestion")} />
          ) : assist.phase === "refused" ? (
            <p className={`text-sm ${TEXT.quiet}`}>
              {msg("suggestion_refused", { reason: assist.refusal.message })}
            </p>
          ) : assist.rec ? (
            <p className={`rounded-lg border px-3 py-2 text-sm ${TONE.held}`}>
              {msg("suggested", {
                recommendation: codeLabel(`decision_${assist.rec.recommendation}`),
                rationale: assist.rec.rationale,
              })}{" "}
              {msg("advisory_you_decide")}
            </p>
          ) : (
            <p className={`text-sm ${TEXT.quiet}`}>
              {msg("no_suggestion_available_right_now")}
            </p>
          )}
        </div>
      )}

      <ClaimLine item={item} />

      {item.status === "pending" && (
        <button
          type="button"
          onClick={() =>
            void patch({ action: "claim" }, msg("done_claim", { item: name }))
          }
          disabled={busy}
          className={BUTTON.primary}
        >
          {msg("claim")}
        </button>
      )}

      {item.status === "claimed" && item.claimedByViewer && !resolving && (
        <div className="flex flex-wrap gap-2">
          <button
            ref={resolveButton}
            type="button"
            onClick={() =>
              setResolving({
                decision:
                  assist?.phase === "done" && assist.rec
                    ? assist.rec.recommendation
                    : "uphold",
                modifiedAction: "warn",
              })
            }
            className={BUTTON.primary}
          >
            {msg("resolve")}
          </button>
          <button
            type="button"
            onClick={() =>
              void patch({ action: "unclaim" }, msg("done_release", { item: name }))
            }
            disabled={busy}
            className={BUTTON.quiet}
          >
            {msg("release")}
          </button>
        </div>
      )}

      {resolving && !askingNotes && (
        <ResolveForm
          draft={resolving}
          onChange={setResolving}
          onNext={() => setAskingNotes(true)}
          onCancel={() => setResolving(null)}
        />
      )}
      {resolving && askingNotes && (
        <ConfirmStep
          action="review.resolve"
          title={msg("confirm_resolve", {
            decision: codeLabel(`decision_${resolving.decision}`),
            item: name,
          })}
          reasonLabel={msg("reviewer_notes")}
          confirmLabel={msg("submit_decision")}
          busy={busy}
          returnFocus={resolveButton}
          onCancel={() => setAskingNotes(false)}
          onConfirm={(given) =>
            void patch(
              {
                action: "resolve",
                decision: resolving.decision,
                reviewerNotes: given.reason,
                ...(resolving.decision === "modify"
                  ? { modifiedAction: resolving.modifiedAction }
                  : {}),
              },
              msg(`done_${resolving.decision}`, { item: name })
            )
          }
        >
          <p>{msg(`decision_help_${resolving.decision}`)}</p>
          {resolving.decision === "modify" ? (
            <p>
              {msg("modify_to", {
                action: codeLabel(`action_${resolving.modifiedAction}`),
              })}
            </p>
          ) : null}
        </ConfirmStep>
      )}

      {item.status === "resolved" && <Resolution item={item} />}
    </li>
  );
}

/** The decision chosen, with what each one does, before it is confirmed with notes. */
function ResolveForm({
  draft,
  onChange,
  onNext,
  onCancel,
}: {
  readonly draft: { decision: ReviewDecision; modifiedAction: ModerationAction };
  readonly onChange: (d: {
    decision: ReviewDecision;
    modifiedAction: ModerationAction;
  }) => void;
  readonly onNext: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <form
      noValidate
      aria-label={msg("resolve_form")}
      className={`${SURFACE.inset} space-y-3 p-3`}
      onSubmit={(e) => {
        e.preventDefault();
        onNext();
      }}
    >
      <Field label={msg("decision")} help={msg(`decision_help_${draft.decision}`)}>
        {(control) => (
          <Select
            {...control}
            value={draft.decision}
            onChange={(e) =>
              onChange({ ...draft, decision: e.target.value as ReviewDecision })
            }
          >
            {DECISIONS.map((d) => (
              <option key={d} value={d}>
                {msg(`decision_${d}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {draft.decision === "modify" && (
        <Field label={msg("modified_action")}>
          {(control) => (
            <Select
              {...control}
              value={draft.modifiedAction}
              onChange={(e) =>
                onChange({ ...draft, modifiedAction: e.target.value as ModerationAction })
              }
            >
              {MODIFIED_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {msg(`action_${a}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary}>
          {msg("review_decision")}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON.quiet}>
          {msg("cancel")}
        </button>
      </div>
    </form>
  );
}

// ── What an item is, who holds it, and how it was decided ─────────────

function When({ iso }: { readonly iso: string }) {
  return (
    <time dateTime={iso} title={fullTimestamp(iso)}>
      {formatDateTime(iso)}
    </time>
  );
}

function ItemHeader({
  item,
  readAt,
  showIds,
}: {
  readonly item: QueueItem;
  readonly readAt: Date;
  readonly showIds: boolean;
}) {
  const overdue = item.dueAt !== undefined && Date.parse(item.dueAt) <= readAt.getTime();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded border px-2 py-0.5 ${TONE.info}`}>
          {codeLabel(`source_${item.source}`)}
        </span>
        <span
          className={`rounded border px-2 py-0.5 ${item.priority === "critical" ? TONE.refused : TONE.info}`}
        >
          {msg("priority", { priority: codeLabel(`priority_${item.priority}`) })}
        </span>
        <span className={`rounded border px-2 py-0.5 ${TONE.info}`}>
          {codeLabel(`filter_${item.status}`)}
        </span>
      </div>
      <p className={`text-sm ${TEXT.body}`} data-testid={`rd-trajectory-${item.id}`}>
        {msg("account")} <PersonRef person={item.target} /> ·{" "}
        {msg("decision_of", {
          action: codeLabel(`action_${item.moderationResult.action}`),
        })}
      </p>
      <p className={`text-xs ${TEXT.faint}`}>
        {msg("waiting_since")} <When iso={item.createdAt} />
        {item.dueAt ? (
          <span
            className={overdue ? "block text-red-300" : "block"}
            data-due={overdue ? "overdue" : "due"}
          >
            {overdue ? msg("overdue_since") : msg("due_at")} <When iso={item.dueAt} />
          </span>
        ) : null}
      </p>
      {showIds ? (
        <p className="text-xs">
          <IdDetail id={item.moderationResult.trajectoryId ?? item.id} show />{" "}
          <IdDetail id={item.targetUserId} show />
        </p>
      ) : null}
    </div>
  );
}

/** Who holds the claim, and since when — and that only they act on it. */
function ClaimLine({ item }: { readonly item: QueueItem }) {
  if (item.status !== "claimed") return null;
  return (
    <p className={`text-sm ${TEXT.quiet}`} data-claim="true">
      {item.claimedByViewer ? msg("claimed_by_you") : msg("claimed_by")}{" "}
      {item.claimedByViewer ? null : <PersonRef person={item.claimer} />}
      {item.claimedAt ? (
        <>
          {" · "}
          <When iso={item.claimedAt} />
        </>
      ) : null}
      {item.claimedByViewer ? null : (
        <span className="block text-xs">{msg("claimed_by_other_help")}</span>
      )}
    </p>
  );
}

/** How it was decided: the decision, who and when, and the notes kept with it. */
function Resolution({ item }: { readonly item: QueueItem }) {
  const notes: ShownText | undefined =
    item.notesShown && isShownText(item.notesShown)
      ? (item.notesShown as ShownText)
      : undefined;
  return (
    <div className="space-y-1 text-sm">
      <p className={TEXT.body} data-testid={`rd-decision-${item.id}`}>
        {msg("decision_line", {
          decision: item.decision
            ? codeLabel(`decision_${item.decision}`)
            : msg("decision_unknown"),
        })}
      </p>
      {item.decision === "modify" && item.modifiedAction ? (
        <p className={TEXT.quiet}>
          {msg("modify_to", { action: codeLabel(`action_${item.modifiedAction}`) })}
        </p>
      ) : null}
      <p className={`text-xs ${TEXT.faint}`}>
        {msg("decided_by")}{" "}
        {item.resolvedBy ? (
          <PersonRef person={item.resolver} />
        ) : (
          msg("decided_by_platform")
        )}
        {item.resolvedAt ? (
          <>
            {" · "}
            <When iso={item.resolvedAt} />
          </>
        ) : null}
      </p>
      {item.reviewerNotes ? (
        <p className={`text-xs ${TEXT.quiet}`}>
          {msg("notes")}{" "}
          <ExpandableText text={item.reviewerNotes} column={msg("notes")} />
        </p>
      ) : notes ? (
        <p className={`text-xs ${TEXT.quiet}`}>
          {msg("platform_note", { note: renderShown(notes) })}
        </p>
      ) : null}
    </div>
  );
}

// ── Decision-context subcomponents ────────────────────────────────────

/**
 * The confidence bar's fill. Its width is set on the element's style object after render, never as
 * a `style` attribute: the Content Security Policy allows no inline style attribute (SEC-017,
 * TASK-203 — `style-src` has no 'unsafe-inline'), and a CSSOM property set from script is not one.
 */
function ConfidenceFill({ percent }: { readonly percent: number }) {
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

function DecisionContext({ item }: { readonly item: QueueItem }) {
  const m = item.moderationResult;
  const c = m.classifierOutput;
  const categories = c?.categories ?? [];
  const severity = c?.severity;
  const confidence = c ? (c as unknown as { confidence?: number }).confidence : undefined;
  const confidencePct =
    typeof confidence === "number" ? Math.round(confidence * 100) : null;
  const chip = `rounded border px-2 py-0.5 text-xs ${TONE.info}`;
  return (
    <div className="space-y-2">
      {confidencePct !== null && (
        <div className="flex items-center gap-2" data-testid={`rd-confidence-${item.id}`}>
          <span className={`w-20 text-xs ${TEXT.faint}`}>{msg("confidence")}</span>
          <div className="h-2 flex-1 rounded-full bg-gray-700">
            <ConfidenceFill percent={confidencePct} />
          </div>
          <span className={`w-10 text-right text-xs ${TEXT.body}`}>
            {msg("percent", { percent: confidencePct })}
          </span>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <span className={chip}>{codeLabel(`triggered_${m.triggeredBy}`)}</span>
        {severity && (
          <span className={chip}>
            {msg("severity", { severity: severityLabel(String(severity)) })}
          </span>
        )}
        {categories.map((cat) => (
          <span key={cat} className={chip}>
            {categoryLabel(cat)}
          </span>
        ))}
        {m.contextFactors.map((factor, i) => (
          <span key={i} className={chip}>
            <Recorded {...recordedFactor(factor)} />
          </span>
        ))}
      </div>
      <p className={`text-sm ${TEXT.body}`}>
        <span className={TEXT.faint}>{msg("action")}</span>{" "}
        {codeLabel(`action_${m.action}`)}
      </p>
      {/* A div: a reason recorded before the keys carries a <details>, which a <p> may not hold. */}
      <div className={`text-sm ${TEXT.body}`} data-testid={`rd-reasoning-${item.id}`}>
        <Recorded {...recordedReasons(m.reasoning)} />
      </div>
    </div>
  );
}

function ExplanationTimeline({ item }: { readonly item: QueueItem }) {
  const chain = item.explanationChain;
  if (!chain) return null;
  return (
    <div
      className="border-l-2 border-gray-700 pl-3"
      data-testid={`rd-timeline-${item.id}`}
    >
      {chain.steps.map((step, i) => (
        <div
          key={`${step.phase}-${i}`}
          className="mb-1 flex flex-wrap items-baseline gap-2"
          data-testid={`rd-step-${item.id}-${i}`}
        >
          <span className={`min-w-24 text-xs ${TEXT.faint}`}>
            {phaseLabel(step.phase)}
          </span>
          <div className={`text-xs ${TEXT.body}`}>
            <Recorded {...shownOrStored(step.description)} />
          </div>
        </div>
      ))}
      {chain.conclusion && (
        <div
          className={`mt-1 text-xs ${TEXT.faint}`}
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
