"use client";

/**
 * components/admin/JobsPanels.tsx — the operators' Jobs console (ADR-056 D2, D3), on the
 * console's shared parts (TASK-221)
 *
 *   OperatorJobsView   operators (platform_operate): every recurring job — turn it on or off (a
 *                      required one is always on: said so, no switch), change its interval, run it
 *                      now, see its last run and outcome — the dead-lettered jobs, to replay or
 *                      discard, and the external calls whose outcome is unknown, to mark as took
 *                      effect or not (TASK-215, audit B-12)
 *   TenantJobsList     a tenant's administrators: their own tenant's recent jobs, read-only
 *
 * Each list is the one table; a job opens its panel at the row (beside the list when wide, in its
 * place on a phone), and every action there is confirmed in the one confirm step (SF-admin-100,
 * 103, 105, 108):
 *
 *   - Run now says what it will do, and for a job that removes records for good (its schedule's
 *     `deletesData`) that it cannot be undone and why it is run — recorded with the run;
 *   - turning a job on or off, changing its interval, replaying or discarding a dead job ask why
 *     (one minimum length, said before the mistake); the route records it;
 *   - an interval outside its bounds is said at its field, with the bounds (SF-admin-106);
 *   - each section keeps its own outcomes until each is dismissed (SF-admin-101): a replay's
 *     outcome is beside the dead jobs, not under the schedules;
 *   - a tenant is named by its name (SF-admin-102), a job by the catalogue's name, its owner and
 *     its tenant opt-out by name (SF-admin-107), every date in the console's format.
 *
 * Every action calls the server, which decides (tier permission, approvals, dual control, audit);
 * this only shows what it answers.
 *
 * @module components/admin
 */

import React, { useState } from "react";
import { isShownText, renderShown, type ShownText } from "@/platform/errors/shown-text";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { Field, TextInput } from "@/components/admin/ui/Field";
import { IdDetail } from "@/components/admin/ui/Ref";
import { StoredText } from "@/components/admin/ui/Stored";
import { adminCall } from "@/components/admin/ui/admin-call";
import { runOperatorAction, runRouteChange } from "@/components/admin/ui/governed";
import { outcome, refusedOutcome } from "@/components/admin/ui/Outcome";
import {
  effectTypeLabel,
  jobKindLabel,
  ownerLabel,
  settingLabel,
} from "@/components/admin/ui/labels";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { formatDateTime } from "@/components/admin/admin-format";
import { ListUnreadable, elementWith, useChange, useOutcomes } from "./views/kit";
import type { SectionViewProps } from "./section-views";
import { sectionTitle } from "./ui/sections";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.jobs.${key}`, values);

/**
 * A job's recorded failure in the catalog's words (TASK-206, N-102): the runner records a code
 * (platform/jobs/errors.ts describeJobError), `kind` or `kind:detail`. Null for one the catalog
 * does not know — a record written before the codes, which holds the runner's English.
 */
function codedJobError(recorded: string): string | null {
  const m = /^([a-z_]+)(?::(.+))?$/.exec(recorded);
  if (!m) return null;
  const key = `screens.jobs.errors.${m[1]}`;
  const text = renderMessage(key, { detail: m[2] ?? "", noted: m[2] ? "yes" : "no" });
  return text === key ? null : text;
}

/**
 * A job's recorded failure as the console says it: the catalog's words, or — for a record from
 * before the codes — the catalog's note that it predates them (TASK-207, N-108: it was shown as
 * its stored English).
 */
export function jobErrorText(recorded: string): string {
  return codedJobError(recorded) ?? t("errors.uncoded");
}

/**
 * A job's recorded failure on screen: jobErrorText, and for a record from before the codes its
 * stored text behind a disclosure — the operator's evidence, never the screen's words.
 */
export function JobError({ recorded }: { readonly recorded: string }) {
  if (codedJobError(recorded) !== null) return <>{jobErrorText(recorded)}</>;
  return (
    <>
      {t("errors.uncoded")} <StoredText text={recorded} show={t("errors.uncoded_show")} />
    </>
  );
}

// ── Shapes the server sends ─────────────────────────────────────────────

interface ScheduleState {
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastEnqueued: number;
  /** The worst latest outcome across the tenants it ran for. */
  lastStatus: "succeeded" | "retrying" | "dead" | null;
  lastError: string | null;
  lastFinishedAt: string | null;
  /** Tenants (or the platform) with a recorded outcome, and how many of them are failing. */
  reported?: number;
  failing?: number;
  queued: number;
  running: number;
  dead: number;
}

export interface ScheduleRow {
  kind: string;
  description: ShownText | null;
  owner: string;
  scope: "platform" | "each-tenant";
  runsForSuspended?: boolean;
  enabled: boolean;
  intervalMinutes: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  tenantOptOutKey: string | null;
  /** Cannot be turned off (TASK-194 round 18): no "Turn off". */
  required?: boolean;
  /** Running it removes records for good (TASK-221): run now cannot be undone. */
  deletesData?: boolean;
  state: ScheduleState | null;
}

export interface JobRow {
  id: string;
  tenantId?: string | null;
  /** The tenant's name (TASK-221, SF-admin-102); null for the platform or one not listed. */
  tenantName?: string | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "dead" | "parked";
  attempts: number;
  maxAttempts: number;
  source?: string;
  lastError: string | null;
  updatedAt: string;
}

/** An external call whose outcome is unknown, waiting for an operator (TASK-215, audit B-12). */
export interface EffectRow {
  id: string;
  tenantId: string;
  tenantName?: string | null;
  operationId: string;
  effectKey: string;
  effectType: string;
  attempts: number;
  createdAt: string;
}

export interface JobsData {
  schedules?: ScheduleRow[];
  deadLetters?: JobRow[];
  unresolvedEffects?: EffectRow[];
}

const OUTCOMES = new Set(["succeeded", "retrying", "dead"]);
const STATUSES = new Set(["queued", "running", "succeeded", "dead", "parked"]);
const outcomeLabel = (s: string | null) =>
  s && OUTCOMES.has(s) ? t(`outcome_${s}`) : t("outcome_none");
/** A job's state in words; one the catalog does not know is said to be unknown (never as stored). */
const statusLabel = (s: string) =>
  STATUSES.has(s) ? t(`status_${s}`) : t("status_unknown");

/** A job's tenant by name: the platform, or a tenant the directory no longer lists. */
function tenantText(row: {
  tenantId?: string | null;
  tenantName?: string | null;
}): string {
  if (!row.tenantId) return t("platform");
  return row.tenantName ?? t("tenant_unlisted");
}

/** Who runs it, in words: each tenant, each active tenant, or the platform once. */
function scopeText(row: ScheduleRow): string {
  return t(
    row.scope === "platform"
      ? "scope_platform"
      : row.runsForSuspended
        ? "scope_each_tenant_suspended"
        : "scope_each_tenant"
  );
}

/** A run now's answer in words: queued for how many, and what ran within its time. */
function runNowText(kind: string, body: Record<string, unknown>): string {
  const result = (body.result ?? {}) as Record<string, unknown>;
  const report = (result.report ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return t("run_now_done", {
    job: jobKindLabel(kind),
    enqueued: n(result.enqueued),
    succeeded: n(report.succeeded),
    retried: n(report.retried),
    dead: n(report.dead),
  });
}

type Facts = [string, React.ReactNode][];

// ── One recurring job ───────────────────────────────────────────────────

type ScheduleStep = "view" | "toggle" | "interval" | "confirm_interval" | "run";

function ScheduleDetail({
  row,
  run,
  busy,
  add,
  onReload,
  showIds,
  onClose,
}: {
  readonly row: ScheduleRow;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly add: ReturnType<typeof useOutcomes>["add"];
  readonly onReload?: () => void;
  readonly showIds: boolean;
  readonly onClose: () => void;
}) {
  const [step, setStep] = useState<ScheduleStep>("view");
  const [interval, setIntervalDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const base = `/api/operator/jobs/schedules/${encodeURIComponent(row.kind)}`;
  const name = jobKindLabel(row.kind);
  const s = row.state;
  const bounds = { min: row.minIntervalMinutes, max: row.maxIntervalMinutes };
  const facts: Facts = [
    ...(showIds
      ? ([[t("field_kind"), <IdDetail key="k" id={row.kind} show />]] as Facts)
      : []),
    [
      t("field_what"),
      isShownText(row.description) ? renderShown(row.description) : t("no_description"),
    ],
    [t("field_runs_for"), scopeText(row)],
    [t("field_owner"), ownerLabel(row.owner)],
    ...(row.tenantOptOutKey
      ? ([
          [
            t("field_opt_out"),
            t("tenant_opt_out", { setting: settingLabel(row.tenantOptOutKey) }),
          ],
        ] as Facts)
      : []),
    [
      t("field_state"),
      row.required ? t("required") : t(row.enabled ? "enabled" : "disabled"),
    ],
    [t("field_interval"), t("every", { minutes: row.intervalMinutes })],
    [t("field_last_run"), formatDateTime(s?.lastRunAt ?? null)],
    [t("field_next_run"), formatDateTime(s?.nextRunAt ?? null)],
    [
      t("field_outcome"),
      <span key="o">
        {outcomeLabel(s?.lastStatus ?? null)}
        {row.scope === "each-tenant" && s?.failing
          ? ` (${t("outcome_tenants", { failing: s.failing, reported: s.reported ?? s.failing })})`
          : ""}
        {s?.lastError ? (
          <span className="block">
            <JobError recorded={s.lastError} />
          </span>
        ) : null}
      </span>,
    ],
    [
      t("field_queue"),
      t("queue_counts", {
        queued: s?.queued ?? 0,
        running: s?.running ?? 0,
        dead: s?.dead ?? 0,
      }),
    ],
  ];
  const back = () => setStep("view");
  const deletes = row.deletesData === true;
  const wanted = Number(interval.trim());

  let body: React.ReactNode;
  if (step === "toggle")
    body = (
      <ConfirmStep
        action={row.enabled ? "jobs.turn_off" : "jobs.turn_on"}
        title={t(row.enabled ? "confirm_turn_off" : "confirm_turn_on", { job: name })}
        confirmLabel={t(row.enabled ? "turn_off" : "turn_on")}
        busy={busy}
        onCancel={back}
        onConfirm={(given) =>
          void run(
            () =>
              runRouteChange(base, "PATCH", {
                enabled: !row.enabled,
                changeComment: given.reason,
              }),
            t(row.enabled ? "what_turn_off" : "what_turn_on", { job: name })
          ).then(back)
        }
      />
    );
  else if (step === "interval")
    body = (
      <form
        noValidate
        aria-label={t("interval_label", { job: name })}
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          const text = interval.trim();
          if (text === "" || !Number.isInteger(wanted))
            return setProblem(t("interval_not_whole", bounds));
          if (wanted < bounds.min || wanted > bounds.max)
            return setProblem(t("interval_out_of_bounds", bounds));
          if (wanted === row.intervalMinutes) return setProblem(t("interval_unchanged"));
          setProblem(null);
          setStep("confirm_interval");
        }}
      >
        <Field
          label={t("interval_field")}
          help={t("interval_bounds", bounds)}
          error={problem}
        >
          {(control) => (
            <TextInput
              {...control}
              inputMode="numeric"
              value={interval}
              className="max-w-xs"
              onChange={(e) => {
                setIntervalDraft(e.target.value);
                setProblem(null);
              }}
            />
          )}
        </Field>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BUTTON.primary} disabled={busy}>
            {t("review")}
          </button>
          <button type="button" className={BUTTON.quiet} onClick={back}>
            {t("cancel")}
          </button>
        </div>
      </form>
    );
  else if (step === "confirm_interval")
    body = (
      <ConfirmStep
        action="jobs.set_interval"
        title={t("confirm_interval", { job: name })}
        confirmLabel={t("set_interval")}
        busy={busy}
        onCancel={() => setStep("interval")}
        onConfirm={(given) =>
          void run(
            () =>
              runRouteChange(base, "PATCH", {
                intervalMinutes: wanted,
                changeComment: given.reason,
              }),
            t("what_interval", { job: name, minutes: wanted })
          ).then(() => {
            setIntervalDraft("");
            back();
          })
        }
      >
        <p>{t("interval_change", { from: row.intervalMinutes, to: wanted })}</p>
      </ConfirmStep>
    );
  else if (step === "run")
    body = (
      <ConfirmStep
        action={deletes ? "jobs.run_now_deletes" : "jobs.run_now"}
        title={t("confirm_run_now", { job: name })}
        confirmLabel={t("run_now")}
        busy={running}
        onCancel={back}
        onConfirm={(given) => {
          setRunning(true);
          void adminCall(
            `/api/operator/jobs/schedules/${encodeURIComponent(row.kind)}/run`,
            {
              method: "POST",
              json: given.reason ? { reason: given.reason } : {},
            }
          ).then((answer) => {
            setRunning(false);
            add(
              answer.ok
                ? outcome("applied", runNowText(row.kind, answer.body))
                : refusedOutcome(answer.refusal, {
                    action: t("what_run_now", { job: name }),
                  })
            );
            if (answer.ok) onReload?.();
            back();
          });
        }}
      >
        <p>{scopeText(row)}</p>
      </ConfirmStep>
    );
  else
    body = (
      <div className="flex flex-wrap gap-2">
        {row.required ? (
          <p className={`w-full text-xs ${TEXT.faint}`}>{t("required_help")}</p>
        ) : (
          <button
            type="button"
            className={BUTTON.quiet}
            disabled={busy}
            onClick={() => setStep("toggle")}
          >
            {t(row.enabled ? "turn_off" : "turn_on")}
          </button>
        )}
        <button
          type="button"
          className={BUTTON.quiet}
          disabled={busy}
          onClick={() => setStep("interval")}
        >
          {t("change_interval")}
        </button>
        <button
          type="button"
          className={deletes ? BUTTON.danger : BUTTON.primary}
          disabled={busy}
          onClick={() => setStep("run")}
        >
          {t("run_now")}
        </button>
      </div>
    );

  return (
    <DetailPanel
      title={name}
      onClose={onClose}
      returnFocus={() => elementWith("data-job-open", row.kind)}
    >
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        {body}
      </div>
    </DetailPanel>
  );
}

// ── A dead job, and an unresolved call ──────────────────────────────────

function DeadDetail({
  job,
  run,
  busy,
  showIds,
  onClose,
}: {
  readonly job: JobRow;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly showIds: boolean;
  readonly onClose: () => void;
}) {
  const [asking, setAsking] = useState<"replay" | "discard" | null>(null);
  const name = jobKindLabel(job.kind);
  const url = `/api/operator/jobs/dead/${encodeURIComponent(job.id)}`;
  const facts: Facts = [
    ...(showIds
      ? ([[t("field_reference"), <IdDetail key="i" id={job.id} show />]] as Facts)
      : []),
    [t("field_tenant"), tenantText(job)],
    [
      t("field_attempts"),
      t("attempts", { attempts: job.attempts, max: job.maxAttempts }),
    ],
    [t("field_failed_at"), formatDateTime(job.updatedAt)],
    [
      t("field_error"),
      job.lastError ? <JobError key="e" recorded={job.lastError} /> : t("no_error"),
    ],
  ];
  return (
    <DetailPanel
      title={name}
      onClose={onClose}
      returnFocus={() => elementWith("data-dead-open", job.id)}
    >
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        {asking ? (
          <ConfirmStep
            action={asking === "replay" ? "jobs.replay" : "jobs.discard"}
            title={t(asking === "replay" ? "confirm_replay" : "confirm_discard", {
              job: name,
              tenant: tenantText(job),
            })}
            confirmLabel={t(asking)}
            busy={busy}
            onCancel={() => setAsking(null)}
            onConfirm={(given) =>
              void run(
                () =>
                  runOperatorAction(url, "POST", {
                    action: asking,
                    reason: given.reason,
                  }),
                t(asking === "replay" ? "what_replay" : "what_discard", { job: name }),
                { who: tenantText(job) }
              ).then(() => setAsking(null))
            }
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={BUTTON.primary}
              disabled={busy}
              onClick={() => setAsking("replay")}
            >
              {t("replay")}
            </button>
            <button
              type="button"
              className={BUTTON.quiet}
              disabled={busy}
              onClick={() => setAsking("discard")}
            >
              {t("discard")}
            </button>
          </div>
        )}
      </div>
    </DetailPanel>
  );
}

function EffectDetail({
  effect,
  run,
  busy,
  showIds,
  onClose,
}: {
  readonly effect: EffectRow;
  readonly run: ReturnType<typeof useChange>["run"];
  readonly busy: boolean;
  readonly showIds: boolean;
  readonly onClose: () => void;
}) {
  const [asking, setAsking] = useState<"took_effect" | "no_effect" | null>(null);
  const name = effectTypeLabel(effect.effectType);
  const facts: Facts = [
    ...(showIds
      ? ([
          [t("field_call_key"), <IdDetail key="k" id={effect.effectKey} show />],
          [t("field_reference"), <IdDetail key="i" id={effect.id} show />],
        ] as Facts)
      : []),
    [t("field_tenant"), tenantText(effect)],
    [t("field_attempts"), String(effect.attempts)],
    [t("field_since"), formatDateTime(effect.createdAt)],
  ];
  return (
    <DetailPanel
      title={name}
      onClose={onClose}
      returnFocus={() => elementWith("data-effect-open", effect.id)}
    >
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        <p className={`text-sm ${TEXT.quiet}`}>{t("effect_help")}</p>
        {asking ? (
          <ConfirmStep
            action={
              asking === "took_effect"
                ? "jobs.effect_took_effect"
                : "jobs.effect_no_effect"
            }
            title={t(`confirm_${asking}`, { call: name, tenant: tenantText(effect) })}
            confirmLabel={t(asking)}
            busy={busy}
            onCancel={() => setAsking(null)}
            onConfirm={() =>
              void run(
                () =>
                  runOperatorAction(
                    `/api/operator/jobs/effects/${encodeURIComponent(effect.id)}`,
                    "POST",
                    { outcome: asking }
                  ),
                t(`what_${asking}`, { call: name }),
                { who: tenantText(effect) }
              ).then(() => setAsking(null))
            }
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            {(["took_effect", "no_effect"] as const).map((o) => (
              <button
                key={o}
                type="button"
                className={BUTTON.quiet}
                disabled={busy}
                onClick={() => setAsking(o)}
              >
                {t(o)}
              </button>
            ))}
          </div>
        )}
      </div>
    </DetailPanel>
  );
}

/** One section of the console: its heading, its outcomes, its list and the open row's panel. */
function JobsSection({
  id,
  title,
  intro,
  list,
  children,
  detail,
}: {
  readonly id: string;
  readonly title: string;
  readonly intro: string;
  readonly list: React.ReactNode;
  readonly children: React.ReactNode;
  readonly detail: React.ReactNode | null;
}) {
  return (
    <section className={`${SURFACE.panel} min-w-0 space-y-3 p-4`} aria-labelledby={id}>
      <h3 id={id} className={`text-base font-semibold ${TEXT.strong}`}>
        {title}
      </h3>
      <p className={`text-sm ${TEXT.faint}`}>{intro}</p>
      {list}
      <DetailLayout detail={detail}>{children}</DetailLayout>
    </section>
  );
}

// ── The console ─────────────────────────────────────────────────────────

export function OperatorJobsView({ data, onReload, showIds = false }: SectionViewProps) {
  const schedulesOut = useOutcomes(t("schedules_results"));
  const deadOut = useOutcomes(t("dead_results"));
  const effectsOut = useOutcomes(t("effects_results"));
  const schedulesChange = useChange(schedulesOut.add, onReload);
  const deadChange = useChange(deadOut.add, onReload);
  const effectsChange = useChange(effectsOut.add, onReload);
  const [openKind, setOpenKind] = useState<string | null>(null);
  const [openDead, setOpenDead] = useState<string | null>(null);
  const [openEffect, setOpenEffect] = useState<string | null>(null);

  const jobs = (data ?? {}) as JobsData;
  // A body without its lists is not an empty list (review 14 L-1): said as a failed read.
  if (
    !Array.isArray(jobs.schedules) ||
    !Array.isArray(jobs.deadLetters) ||
    !Array.isArray(jobs.unresolvedEffects)
  )
    return <ListUnreadable panel={sectionTitle("jobs")} onRetry={onReload} />;
  const schedules = [...jobs.schedules].sort((a, b) =>
    jobKindLabel(a.kind).localeCompare(jobKindLabel(b.kind))
  );
  const dead = jobs.deadLetters;
  const effects = jobs.unresolvedEffects;
  const schedule = schedules.find((r) => r.kind === openKind) ?? null;
  const deadJob = dead.find((j) => j.id === openDead) ?? null;
  const effect = effects.find((e) => e.id === openEffect) ?? null;

  const scheduleColumns: Column<ScheduleRow>[] = [
    {
      id: "job",
      header: t("col_job"),
      cell: (row) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-job-open={row.kind}
            aria-label={t("open_job", { job: jobKindLabel(row.kind) })}
            className={BUTTON.link}
            onClick={(e) => {
              e.stopPropagation();
              setOpenKind(row.kind);
            }}
          >
            {jobKindLabel(row.kind)}
          </button>
          <span className={`mt-1 block text-xs ${TEXT.faint}`}>{scopeText(row)}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: t("col_schedule"),
      value: (row) =>
        t("state_line", {
          state: row.required ? t("required") : t(row.enabled ? "enabled" : "disabled"),
          minutes: row.intervalMinutes,
        }),
    },
    {
      id: "last",
      header: t("col_last"),
      cell: (row) => (
        <span>
          {formatDateTime(row.state?.lastRunAt ?? null)}
          <span className={`block text-xs ${TEXT.faint}`}>
            {outcomeLabel(row.state?.lastStatus ?? null)}
          </span>
        </span>
      ),
    },
    {
      id: "queue",
      header: t("col_queue"),
      secondary: true,
      value: (row) =>
        t("queue_counts", {
          queued: row.state?.queued ?? 0,
          running: row.state?.running ?? 0,
          dead: row.state?.dead ?? 0,
        }),
    },
  ];
  const deadColumns: Column<JobRow>[] = [
    {
      id: "job",
      header: t("col_job"),
      cell: (job) => (
        <button
          type="button"
          data-dead-open={job.id}
          aria-label={t("open_dead", {
            job: jobKindLabel(job.kind),
            tenant: tenantText(job),
          })}
          className={BUTTON.link}
          onClick={(e) => {
            e.stopPropagation();
            setOpenDead(job.id);
          }}
        >
          {jobKindLabel(job.kind)}
        </button>
      ),
    },
    { id: "tenant", header: t("col_tenant"), value: (job) => tenantText(job) },
    {
      id: "failed",
      header: t("col_failed_at"),
      kind: "datetime",
      value: (job) => job.updatedAt,
    },
    {
      id: "error",
      header: t("col_error"),
      secondary: true,
      cell: (job) =>
        job.lastError ? <JobError recorded={job.lastError} /> : t("no_error"),
    },
  ];
  const effectColumns: Column<EffectRow>[] = [
    {
      id: "call",
      header: t("col_call"),
      cell: (e) => (
        <button
          type="button"
          data-effect-open={e.id}
          aria-label={t("open_effect", {
            call: effectTypeLabel(e.effectType),
            tenant: tenantText(e),
          })}
          className={BUTTON.link}
          onClick={(ev) => {
            ev.stopPropagation();
            setOpenEffect(e.id);
          }}
        >
          {effectTypeLabel(e.effectType)}
        </button>
      ),
    },
    { id: "tenant", header: t("col_tenant"), value: (e) => tenantText(e) },
    { id: "since", header: t("col_since"), kind: "datetime", value: (e) => e.createdAt },
  ];

  return (
    <div className="min-w-0 space-y-6">
      <JobsSection
        id="schedules-heading"
        title={t("schedules_heading")}
        intro={t("schedules_intro")}
        list={schedulesOut.list}
        detail={
          schedule ? (
            <ScheduleDetail
              key={schedule.kind}
              row={schedule}
              run={schedulesChange.run}
              busy={schedulesChange.busy}
              add={schedulesOut.add}
              onReload={onReload}
              showIds={showIds}
              onClose={() => setOpenKind(null)}
            />
          ) : null
        }
      >
        <AdminTable
          caption={t("schedules_caption")}
          columns={scheduleColumns}
          rows={schedules}
          rowKey={(row) => row.kind}
          compact={schedule !== null}
          selectedKey={openKind}
          onRowClick={(row) => setOpenKind(row.kind)}
          empty={t("schedules_none")}
        />
      </JobsSection>

      <JobsSection
        id="dead-heading"
        title={t("dead_heading")}
        intro={t("dead_intro")}
        list={deadOut.list}
        detail={
          deadJob ? (
            <DeadDetail
              key={deadJob.id}
              job={deadJob}
              run={deadChange.run}
              busy={deadChange.busy}
              showIds={showIds}
              onClose={() => setOpenDead(null)}
            />
          ) : null
        }
      >
        <AdminTable
          caption={t("dead_caption")}
          columns={deadColumns}
          rows={dead}
          rowKey={(job) => job.id}
          compact={deadJob !== null}
          selectedKey={openDead}
          onRowClick={(job) => setOpenDead(job.id)}
          empty={t("dead_none")}
        />
      </JobsSection>

      <JobsSection
        id="effects-heading"
        title={t("effects_heading")}
        intro={t("effects_intro")}
        list={effectsOut.list}
        detail={
          effect ? (
            <EffectDetail
              key={effect.id}
              effect={effect}
              run={effectsChange.run}
              busy={effectsChange.busy}
              showIds={showIds}
              onClose={() => setOpenEffect(null)}
            />
          ) : null
        }
      >
        <AdminTable
          caption={t("effects_caption")}
          columns={effectColumns}
          rows={effects}
          rowKey={(e) => e.id}
          compact={effect !== null}
          selectedKey={openEffect}
          onRowClick={(e) => setOpenEffect(e.id)}
          empty={t("effects_none")}
        />
      </JobsSection>
    </div>
  );
}

// ── A tenant's own history (read-only) ──────────────────────────────────

/**
 * A tenant's recent jobs, for its administrators: `undefined` — not part of this read (nothing is
 * shown); `null` — the route could not read them (said so, never "no jobs").
 */
export function TenantJobsList({ jobs }: { readonly jobs: JobRow[] | null | undefined }) {
  if (jobs === undefined) return null;
  const columns: Column<JobRow>[] = [
    {
      id: "job",
      header: t("col_job"),
      cell: (job) => (
        <span className="min-w-0 break-words">
          {jobKindLabel(job.kind)}
          {job.lastError ? (
            <span className="mt-1 block text-xs text-red-300">
              <JobError recorded={job.lastError} />
            </span>
          ) : null}
        </span>
      ),
    },
    { id: "status", header: t("col_status"), value: (job) => statusLabel(job.status) },
    {
      id: "attempts",
      header: t("col_attempts"),
      secondary: true,
      value: (job) => t("attempts", { attempts: job.attempts, max: job.maxAttempts }),
    },
    {
      id: "updated",
      header: t("col_updated"),
      kind: "datetime",
      value: (job) => job.updatedAt,
    },
  ];
  return (
    <section
      className={`${SURFACE.panel} min-w-0 space-y-3 p-4`}
      aria-labelledby="tenant-jobs-heading"
    >
      <h3 id="tenant-jobs-heading" className={`text-base font-semibold ${TEXT.strong}`}>
        {t("tenant_heading")}
      </h3>
      <p className={`text-sm ${TEXT.faint}`}>{t("tenant_intro")}</p>
      {jobs === null ? (
        <p data-read-failed="true" className={`text-sm ${TEXT.quiet}`}>
          {t("tenant_unavailable")}
        </p>
      ) : (
        <AdminTable
          caption={t("tenant_caption")}
          columns={columns}
          rows={jobs}
          rowKey={(job) => job.id}
          empty={t("tenant_none")}
        />
      )}
    </section>
  );
}
