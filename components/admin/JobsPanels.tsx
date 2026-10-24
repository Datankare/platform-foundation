"use client";

/**
 * components/admin/JobsPanels.tsx — the operators' Jobs console (ADR-056 D2, D3)
 *
 *   OperatorJobsView   operators (platform_operate): every recurring job — turn it on or off,
 *                      change its interval, run it now, see its last run and outcome — and the
 *                      dead-lettered jobs, to replay or discard
 *   TenantJobsList     a tenant's administrators: their own tenant's recent jobs, read-only
 *
 * Every action calls the server, which decides (tier permission, approvals, dual control, audit);
 * this only shows what it answers. A change asks for its reason inline — never window.prompt —
 * and a discard asks to be confirmed. Every word comes from the catalog (screens.jobs, ADR-051).
 */

import React, { useCallback, useId, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { apiFetch } from "@/platform/auth/api-fetch";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.jobs.${key}`, values);

const card = "bg-[#111827] rounded-xl border border-gray-800 p-5";
const th =
  "text-xs text-gray-400 uppercase tracking-wider py-2 px-3 border-b border-gray-800 text-left";
const td = "py-2 px-3 text-gray-300 border-b border-gray-800/50 align-top";
const input =
  "bg-[#0a0f1e] border border-gray-700 rounded-md px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500";
const button =
  "px-3 py-1 rounded-md text-sm bg-blue-600/80 hover:bg-blue-600 text-white disabled:opacity-50";
const quiet =
  "px-3 py-1 rounded-md text-sm border border-gray-700 text-gray-300 hover:bg-gray-800 disabled:opacity-50";

interface ApiReply {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown>;
}

async function call(url: string, init?: RequestInit): Promise<ApiReply> {
  try {
    const res = await apiFetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

function reasonOf(reply: ApiReply): string {
  const m = reply.body.message ?? reply.body.code;
  return typeof m === "string" && m ? m : t("refused");
}

type Tone = "ok" | "error";

function Status({ text, tone }: { text: string; tone: Tone }) {
  return (
    <p
      role="status"
      className={`text-sm mt-2 ${tone === "ok" ? "text-green-400" : "text-red-400"}`}
    >
      {text}
    </p>
  );
}

const when = (iso: string | null | undefined) =>
  iso ? iso.replace("T", " ").slice(0, 19) : t("never");

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
  description: string;
  owner: string;
  scope: "platform" | "each-tenant";
  runsForSuspended?: boolean;
  enabled: boolean;
  intervalMinutes: number;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  tenantOptOutKey: string | null;
  state: ScheduleState | null;
}

export interface JobRow {
  id: string;
  tenantId?: string | null;
  kind: string;
  status: "queued" | "running" | "succeeded" | "dead" | "parked";
  attempts: number;
  maxAttempts: number;
  source?: string;
  lastError: string | null;
  updatedAt: string;
}

export interface JobsData {
  schedules?: ScheduleRow[];
  deadLetters?: JobRow[];
}

const OUTCOMES = new Set(["succeeded", "retrying", "dead"]);
const STATUSES = new Set(["queued", "running", "succeeded", "dead", "parked"]);
const outcomeLabel = (s: string | null) =>
  s && OUTCOMES.has(s) ? t(`outcome_${s}`) : t("outcome_none");
const statusLabel = (s: string) => (STATUSES.has(s) ? t(`status_${s}`) : s);

/** An action that needs a reason first (a change to governed settings). */
interface Pending {
  readonly label: string;
  readonly submit: (reason: string) => void;
}

function ReasonForm({
  pending,
  busy,
  onDone,
}: {
  pending: Pending;
  busy: boolean;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  const trimmed = reason.trim();
  return (
    <form
      aria-label={pending.label}
      className="flex flex-wrap gap-2 items-end mt-3 p-3 rounded-md border border-gray-700"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed.length < 3) return;
        pending.submit(trimmed);
        onDone();
      }}
    >
      <p className="w-full text-sm text-white">{pending.label}</p>
      <label className="text-sm text-gray-400" htmlFor={id}>
        {t("reason")}
      </label>
      <input
        id={id}
        className={`${input} w-72`}
        value={reason}
        autoFocus
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
      />
      <button className={button} type="submit" disabled={busy || trimmed.length < 3}>
        {t("confirm")}
      </button>
      <button className={quiet} type="button" onClick={onDone}>
        {t("cancel")}
      </button>
    </form>
  );
}

// ── One recurring job ───────────────────────────────────────────────────

function ScheduleRowView({
  row,
  busy,
  ask,
  act,
}: {
  row: ScheduleRow;
  busy: boolean;
  ask: (p: Pending) => void;
  act: (label: string, url: string, init: RequestInit) => Promise<boolean>;
}) {
  const [interval, setIntervalDraft] = useState("");
  const intervalId = useId();
  const base = `/api/operator/jobs/schedules/${encodeURIComponent(row.kind)}`;
  const named = { kind: row.kind };
  const n = Number(interval);
  const intervalValid =
    interval.trim() !== "" &&
    Number.isInteger(n) &&
    n >= row.minIntervalMinutes &&
    n <= row.maxIntervalMinutes;
  const toggleLabel = t(row.enabled ? "turn_off_label" : "turn_on_label", named);
  const intervalLabel = t("interval_label", named);
  const setLabel = t("set_interval_label", named);
  const s = row.state;

  return (
    <tr>
      <td className={td}>
        <span className="font-mono text-blue-300">{row.kind}</span>
        <p className="text-xs text-gray-400 mt-1">{row.description}</p>
        <p className="text-xs text-gray-400 mt-1">
          {t(
            row.scope === "platform"
              ? "scope_platform"
              : row.runsForSuspended
                ? "scope_each_tenant_suspended"
                : "scope_each_tenant"
          )}{" "}
          · {t("owner", { owner: row.owner })}
          {row.tenantOptOutKey && (
            <>
              {" · "}
              {t("tenant_opt_out", { key: row.tenantOptOutKey })}
            </>
          )}
        </p>
      </td>
      <td className={td}>
        <p className={row.enabled ? "text-green-400" : "text-amber-400"}>
          {t(row.enabled ? "enabled" : "disabled")}
        </p>
        <p className="text-xs text-gray-400">
          {t("every", { minutes: row.intervalMinutes })}
        </p>
        <div className="flex gap-2 items-center mt-2">
          <label className="sr-only" htmlFor={intervalId}>
            {intervalLabel}
          </label>
          <input
            id={intervalId}
            className={`${input} w-24`}
            inputMode="numeric"
            value={interval}
            placeholder={String(row.intervalMinutes)}
            onChange={(e) => setIntervalDraft(e.target.value)}
          />
          <button
            className={quiet}
            aria-label={setLabel}
            disabled={busy || !intervalValid}
            onClick={() =>
              ask({
                label: setLabel,
                submit: (reason) =>
                  void act(setLabel, base, {
                    method: "PATCH",
                    body: JSON.stringify({ intervalMinutes: n, changeComment: reason }),
                  }).then((done) => done && setIntervalDraft("")),
              })
            }
          >
            {t("set_interval")}
          </button>
        </div>
        <p className="text-xs text-gray-400 mt-1">
          {t("interval_bounds", {
            min: row.minIntervalMinutes,
            max: row.maxIntervalMinutes,
          })}
        </p>
      </td>
      <td className={td}>
        <p>{t("last_run", { at: when(s?.lastRunAt), count: s?.lastEnqueued ?? 0 })}</p>
        <p className="text-xs text-gray-400">
          {t("next_run", { at: when(s?.nextRunAt) })}
        </p>
        <p
          className={`text-xs ${s?.lastStatus === "dead" ? "text-red-400" : "text-gray-400"}`}
        >
          {outcomeLabel(s?.lastStatus ?? null)}
          {row.scope === "each-tenant" && s?.failing
            ? ` (${t("outcome_tenants", { failing: s.failing, reported: s.reported ?? s.failing })})`
            : ""}
          {s?.lastError ? ` — ${s.lastError}` : ""}
        </p>
      </td>
      <td className={td}>
        {t("queue_counts", {
          queued: s?.queued ?? 0,
          running: s?.running ?? 0,
          dead: s?.dead ?? 0,
        })}
      </td>
      <td className={td}>
        <div className="flex flex-wrap gap-1">
          <button
            className={quiet}
            aria-label={toggleLabel}
            disabled={busy}
            onClick={() =>
              ask({
                label: toggleLabel,
                submit: (reason) =>
                  void act(toggleLabel, base, {
                    method: "PATCH",
                    body: JSON.stringify({
                      enabled: !row.enabled,
                      changeComment: reason,
                    }),
                  }),
              })
            }
          >
            {t(row.enabled ? "turn_off" : "turn_on")}
          </button>
          <button
            className={quiet}
            aria-label={t("run_now_label", named)}
            disabled={busy}
            onClick={() =>
              void act(t("run_now_label", named), `${base}/run`, { method: "POST" })
            }
          >
            {t("run_now")}
          </button>
        </div>
      </td>
    </tr>
  );
}

// ── The console ─────────────────────────────────────────────────────────

export function OperatorJobsView({ data: initial }: { data: JobsData | undefined }) {
  const [data, setData] = useState<JobsData | undefined>(initial);
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setData(initial);
  }
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<JobRow | null>(null);
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(null);

  const reload = useCallback(async () => {
    const r = await call("/api/operator/jobs");
    if (r.ok) setData(r.body as JobsData);
  }, []);

  /** Run one action; report its answer; reload. */
  const act = async (label: string, url: string, init: RequestInit) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await call(url, init);
      setStatus(
        r.ok
          ? {
              text: t(r.status === 202 || r.body.pending ? "held" : "done", { label }),
              tone: "ok",
            }
          : { text: t("failed", { label, reason: reasonOf(r) }), tone: "error" }
      );
      if (r.ok) await reload();
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  if (!data?.schedules) return <p className="text-gray-400">{t("loading")}</p>;
  const dead = data.deadLetters ?? [];

  return (
    <div className="space-y-6">
      <section className={card} aria-labelledby="schedules-heading">
        <h3 id="schedules-heading" className="text-base font-semibold text-white">
          {t("schedules_heading")}
        </h3>
        <p className="text-sm text-gray-400 mt-1">{t("schedules_intro")}</p>
        {pending && (
          <ReasonForm
            key={pending.label}
            pending={pending}
            busy={busy}
            onDone={() => setPending(null)}
          />
        )}
        <table className="w-full text-sm mt-3">
          <thead>
            <tr>
              <th className={th}>{t("col_job")}</th>
              <th className={th}>{t("col_schedule")}</th>
              <th className={th}>{t("col_last")}</th>
              <th className={th}>{t("col_queue")}</th>
              <th className={th}>{t("col_actions")}</th>
            </tr>
          </thead>
          <tbody>
            {data.schedules.map((row) => (
              <ScheduleRowView
                key={row.kind}
                row={row}
                busy={busy}
                ask={setPending}
                act={act}
              />
            ))}
          </tbody>
        </table>
        {status && <Status {...status} />}
      </section>

      <section className={card} aria-labelledby="dead-heading">
        <h3 id="dead-heading" className="text-base font-semibold text-white">
          {t("dead_heading")}
        </h3>
        <p className="text-sm text-gray-400 mt-1">{t("dead_intro")}</p>
        {confirmDiscard && (
          <div
            role="group"
            aria-label={t("discard_label", { kind: confirmDiscard.kind })}
            className="flex flex-wrap gap-2 items-center mt-3 p-3 rounded-md border border-gray-700"
          >
            <p className="w-full text-sm text-white">
              {t("discard_confirm", { kind: confirmDiscard.kind })}
            </p>
            <button
              className={button}
              disabled={busy}
              onClick={() => {
                const job = confirmDiscard;
                setConfirmDiscard(null);
                void act(
                  t("discard_label", { kind: job.kind }),
                  `/api/operator/jobs/dead/${encodeURIComponent(job.id)}`,
                  { method: "POST", body: JSON.stringify({ action: "discard" }) }
                );
              }}
            >
              {t("discard")}
            </button>
            <button className={quiet} onClick={() => setConfirmDiscard(null)}>
              {t("cancel")}
            </button>
          </div>
        )}
        {dead.length === 0 ? (
          <p className="text-sm text-gray-400 mt-3">{t("dead_none")}</p>
        ) : (
          <table className="w-full text-sm mt-3">
            <thead>
              <tr>
                <th className={th}>{t("col_job")}</th>
                <th className={th}>{t("col_tenant")}</th>
                <th className={th}>{t("col_attempts")}</th>
                <th className={th}>{t("col_error")}</th>
                <th className={th}>{t("col_actions")}</th>
              </tr>
            </thead>
            <tbody>
              {dead.map((job) => (
                <tr key={job.id}>
                  <td className={td}>
                    <span className="font-mono text-blue-300">{job.kind}</span>
                    <p className="text-xs text-gray-400">{when(job.updatedAt)}</p>
                  </td>
                  <td className={`${td} font-mono text-xs`}>
                    {job.tenantId ?? t("platform")}
                  </td>
                  <td className={td}>
                    {t("attempts", { attempts: job.attempts, max: job.maxAttempts })}
                  </td>
                  <td className={`${td} text-red-300`}>
                    {job.lastError ?? t("no_error")}
                  </td>
                  <td className={td}>
                    <div className="flex flex-wrap gap-1">
                      <button
                        className={quiet}
                        aria-label={t("replay_label", { kind: job.kind })}
                        disabled={busy}
                        onClick={() =>
                          void act(
                            t("replay_label", { kind: job.kind }),
                            `/api/operator/jobs/dead/${encodeURIComponent(job.id)}`,
                            { method: "POST", body: JSON.stringify({ action: "replay" }) }
                          )
                        }
                      >
                        {t("replay")}
                      </button>
                      <button
                        className={quiet}
                        aria-label={t("discard_label", { kind: job.kind })}
                        disabled={busy}
                        onClick={() => setConfirmDiscard(job)}
                      >
                        {t("discard")}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

// ── A tenant's own history (read-only) ──────────────────────────────────

export function TenantJobsList({ jobs }: { jobs: JobRow[] | null | undefined }) {
  if (jobs === undefined) return null;
  return (
    <section className={card} aria-labelledby="tenant-jobs-heading">
      <h3 id="tenant-jobs-heading" className="text-base font-semibold text-white">
        {t("tenant_heading")}
      </h3>
      <p className="text-sm text-gray-400 mt-1">{t("tenant_intro")}</p>
      {jobs === null ? (
        <p className="text-sm text-gray-400 mt-3">{t("tenant_unavailable")}</p>
      ) : jobs.length === 0 ? (
        <p className="text-sm text-gray-400 mt-3">{t("tenant_none")}</p>
      ) : (
        <table className="w-full text-sm mt-3">
          <thead>
            <tr>
              <th className={th}>{t("col_job")}</th>
              <th className={th}>{t("col_status")}</th>
              <th className={th}>{t("col_attempts")}</th>
              <th className={th}>{t("col_updated")}</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td className={td}>
                  <span className="font-mono text-blue-300">{job.kind}</span>
                  {job.lastError && (
                    <p className="text-xs text-red-300 mt-1">{job.lastError}</p>
                  )}
                </td>
                <td className={td}>{statusLabel(job.status)}</td>
                <td className={td}>
                  {t("attempts", { attempts: job.attempts, max: job.maxAttempts })}
                </td>
                <td className={td}>{when(job.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
