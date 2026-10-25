"use client";

/**
 * components/admin/TenancyPanels.tsx — the tenant's own settings, and the operators' tenants
 * console (ADR-053 D5, D7)
 *
 *   TenantSettingsView   a tenant's administrators: their tenant, its addresses, today's agent
 *                        spend against its cap, and the settings they may set for it
 *   OperatorTenantsView  operators (platform_operate): every tenant — provision, addresses,
 *                        suspend/resume/restore, two-operator deletion, first administrator,
 *                        export, purge, the tenant's agent kill switch (TASK-172) — and whether
 *                        the deployment is ready for tenants
 *
 * Every action calls the server, which decides; this only shows what it answers. Every word on
 * these screens comes from the catalog (screens.tenancy, ADR-051): no literals.
 */

import React, { useCallback, useId, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { apiFetch } from "@/platform/auth/api-fetch";
import { TenantJobsList, type JobRow } from "@/components/admin/JobsPanels";
import { AgentKillSwitch } from "@/components/admin/AgentKillSwitchPanel";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.tenancy.${key}`, values);

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
  readonly body: Record<string, unknown>;
}

async function call(url: string, init?: RequestInit): Promise<ApiReply> {
  try {
    const res = await apiFetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, body };
  } catch {
    // Offline or the server unreachable: a refusal like any other, never an unhandled rejection.
    return { ok: false, body: {} };
  }
}

/** The message a refusal carries (already in the reader's language), for the status line. */
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

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Read a settings value from text the way the config page does: JSON when it parses. */
function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const usd = (n: number) =>
  new Intl.NumberFormat("en", { style: "currency", currency: "USD" }).format(n);

// ── A tenant's own settings ─────────────────────────────────────────────

interface TenantData {
  tenant?: {
    id: string;
    mode: string;
    slug: string | null;
    name: string | null;
    status: string;
  };
  domains?: { host: string; createdAt: string }[];
  budget?: { usedUsd: number; budgetUsd: number; exhausted: boolean; period: string };
  settings?: {
    key: string;
    description: string | null;
    value: unknown;
    platformValue: unknown;
    overridden: boolean;
  }[];
  /** The tenant's recent background jobs (read-only); null when they could not be read. */
  jobs?: JobRow[] | null;
}

const STATES = new Set(["active", "suspended", "deleted"]);
const stateLabel = (s: string) => (STATES.has(s) ? t(`state_${s}`) : s);

export function TenantSettingsView({ data: initial }: { data: TenantData | undefined }) {
  const [data, setData] = useState<TenantData | undefined>(initial);
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setData(initial);
  }
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(null);

  const reload = useCallback(async () => {
    const r = await call("/api/admin/tenant");
    if (r.ok) setData(r.body as TenantData);
  }, []);

  const save = async (key: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await call("/api/admin/config", {
        method: "PUT",
        body: JSON.stringify({
          key,
          value: parseValue(drafts[key] ?? ""),
          changeComment: t("change_comment"),
        }),
      });
      setStatus(
        r.ok
          ? { text: t(r.body.pending ? "held" : "saved", { key }), tone: "ok" }
          : { text: t("failed", { label: key, reason: reasonOf(r) }), tone: "error" }
      );
      if (r.ok) {
        setDrafts((d) => ({ ...d, [key]: "" }));
        await reload();
      }
    } finally {
      setBusy(false);
    }
  };

  const reset = async (key: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await call(`/api/admin/config?key=${encodeURIComponent(key)}`, {
        method: "DELETE",
      });
      setStatus(
        r.ok
          ? { text: t("reset_done", { key }), tone: "ok" }
          : { text: t("failed", { label: key, reason: reasonOf(r) }), tone: "error" }
      );
      if (r.ok) await reload();
    } finally {
      setBusy(false);
    }
  };

  if (!data?.tenant) return <p className="text-gray-400">{t("loading")}</p>;
  const shared = data.tenant.mode === "shared";

  return (
    <div className="space-y-6">
      <section className={card} aria-labelledby="tenant-heading">
        <h3 id="tenant-heading" className="text-lg font-semibold text-white">
          {data.tenant.name ?? t("this_deployment")}
        </h3>
        <p className="text-sm text-gray-400 mt-1">
          {t(shared ? "kind_shared" : "kind_single")} ·{" "}
          {data.tenant.slug ?? data.tenant.id} · {stateLabel(data.tenant.status)}
        </p>
        <h4 className="text-sm font-semibold text-gray-300 mt-4">{t("addresses")}</h4>
        {data.domains && data.domains.length > 0 ? (
          <ul className="text-sm text-gray-300 mt-1 space-y-1">
            {data.domains.map((d) => (
              <li key={d.host} className="font-mono">
                {d.host}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-400 mt-1">
            {t(shared ? "no_addresses_shared" : "no_addresses_single")}
          </p>
        )}
        {data.budget && (
          <>
            <h4 className="text-sm font-semibold text-gray-300 mt-4">
              {t("spend_heading")}
            </h4>
            <p
              className={`text-sm mt-1 ${data.budget.exhausted ? "text-red-400" : "text-gray-300"}`}
            >
              {t("spend", {
                used: usd(data.budget.usedUsd),
                cap: usd(data.budget.budgetUsd),
              })}
            </p>
            {data.budget.exhausted && (
              <p className="text-sm text-red-400">{t("spend_exhausted")}</p>
            )}
          </>
        )}
      </section>

      <section className={card} aria-labelledby="tenant-settings-heading">
        <h3 id="tenant-settings-heading" className="text-base font-semibold text-white">
          {t(shared ? "settings_heading_shared" : "settings_heading_single")}
        </h3>
        <p className="text-sm text-gray-400 mt-1">
          {t(shared ? "settings_intro_shared" : "settings_intro_single")}
        </p>
        <table className="w-full text-sm mt-3">
          <thead>
            <tr>
              <th className={th}>{t("col_setting")}</th>
              <th className={th}>{t("col_value")}</th>
              <th className={th}>{t("col_default")}</th>
              <th className={th}>{t("col_change")}</th>
            </tr>
          </thead>
          <tbody>
            {(data.settings ?? []).map((s) => (
              <tr key={s.key}>
                <td className={td}>
                  <span className="font-mono text-blue-300">{s.key}</span>
                  {s.description && (
                    <p className="text-xs text-gray-400 mt-1">{s.description}</p>
                  )}
                </td>
                <td className={td}>
                  <span className="font-mono">{show(s.value)}</span>
                  {s.overridden && (
                    <span className="ml-2 text-xs text-amber-400">{t("own_value")}</span>
                  )}
                </td>
                <td className={`${td} font-mono text-gray-400`}>
                  {show(s.platformValue)}
                </td>
                <td className={td}>
                  <div className="flex gap-2 items-center">
                    <label className="sr-only" htmlFor={`v-${s.key}`}>
                      {t("new_value_for", { key: s.key })}
                    </label>
                    <input
                      id={`v-${s.key}`}
                      className={input}
                      value={drafts[s.key] ?? ""}
                      placeholder={show(s.value)}
                      onChange={(e) =>
                        setDrafts((d) => ({ ...d, [s.key]: e.target.value }))
                      }
                    />
                    <button
                      className={button}
                      aria-label={t("save_for", { key: s.key })}
                      disabled={busy || !(drafts[s.key] ?? "").trim()}
                      onClick={() => void save(s.key)}
                    >
                      {t("save")}
                    </button>
                    {shared && s.overridden && (
                      <button
                        className={quiet}
                        aria-label={t("use_default_for", { key: s.key })}
                        disabled={busy}
                        onClick={() => void reset(s.key)}
                      >
                        {t("use_default")}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {status && <Status {...status} />}
      </section>

      <TenantJobsList jobs={data.jobs} />
    </div>
  );
}

// ── The operators' tenants console ──────────────────────────────────────

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  domains: string[];
  userCount: number;
  purgeAfter?: string;
  purgedAt?: string;
  pendingDeletion?: { requestId: string; requestedBy: string };
}

interface Readiness {
  mode: string;
  ready: boolean;
  checks: { name: string; state: string; detail: string }[];
}

type Act = (label: string, url: string, init: RequestInit) => Promise<boolean>;

/** An action that needs one answer first (a reason, an address, an email). */
interface Question {
  /** What the action is, e.g. "Suspend Acme" — the form's accessible name. */
  readonly label: string;
  /** The field's label: Reason, Address, Email. */
  readonly field: string;
  readonly type: "text" | "email";
  readonly submit: (answer: string) => void;
}

/**
 * The one open question, inline above the table — not window.prompt, which blocks the page,
 * cannot be styled or labelled, and is suppressed by some browsers.
 */
function QuestionForm({
  question,
  busy,
  onDone,
}: {
  question: Question;
  busy: boolean;
  onDone: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const id = useId();
  const trimmed = answer.trim();
  return (
    <form
      aria-label={question.label}
      className="flex flex-wrap gap-2 items-end mt-3 p-3 rounded-md border border-gray-700"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed) return;
        question.submit(trimmed);
        onDone();
      }}
    >
      <p className="w-full text-sm text-white">{question.label}</p>
      <label className="text-sm text-gray-400" htmlFor={id}>
        {question.field}
      </label>
      <input
        id={id}
        type={question.type}
        className={`${input} w-72`}
        value={answer}
        autoFocus
        onChange={(e) => setAnswer(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
        }}
      />
      <button className={button} type="submit" disabled={busy || !trimmed}>
        {t("confirm")}
      </button>
      <button className={quiet} type="button" onClick={onDone}>
        {t("cancel")}
      </button>
    </form>
  );
}

/** One tenant's row: its state, addresses and the actions its state allows. */
function TenantRowView({
  tenant,
  busy,
  act,
  ask,
  onSettings,
  onKillSwitch,
}: {
  tenant: TenantRow;
  busy: boolean;
  act: Act;
  ask: (q: Question) => void;
  onSettings: (tenant: TenantRow) => void;
  onKillSwitch: (tenant: TenantRow) => void;
}) {
  const base = `/api/operator/tenants/${encodeURIComponent(tenant.id)}`;
  const named = { tenant: tenant.name };
  const reasonFor = (label: string, url: string, action?: string) =>
    ask({
      label,
      field: t("reason"),
      type: "text",
      submit: (reason) =>
        void act(label, url, {
          method: "POST",
          body: JSON.stringify(action ? { action, reason } : { reason }),
        }),
    });
  const decide = (decision: "approve" | "reject", label: string) =>
    void act(
      label,
      `/api/operator/deletions/${encodeURIComponent(tenant.pendingDeletion!.requestId)}`,
      { method: "POST", body: JSON.stringify({ decision }) }
    );

  return (
    <tr>
      <td className={td}>
        <span className="text-white">{tenant.name}</span>
        <p className="text-xs text-gray-400 font-mono">{tenant.slug}</p>
      </td>
      <td className={td}>
        {stateLabel(tenant.status)}
        {tenant.purgeAfter && !tenant.purgedAt && (
          <p className="text-xs text-amber-400">
            {t("purged_after", { date: tenant.purgeAfter.slice(0, 10) })}
          </p>
        )}
        {tenant.purgedAt && <p className="text-xs text-gray-400">{t("purged")}</p>}
        {tenant.pendingDeletion && (
          <p className="text-xs text-red-400">{t("deletion_pending")}</p>
        )}
      </td>
      <td className={td}>
        <ul className="font-mono text-xs space-y-1">
          {tenant.domains.map((d) => (
            <li key={d}>
              {d}{" "}
              <button
                className="text-red-400 hover:underline"
                aria-label={t("remove_address", { host: d })}
                disabled={busy}
                onClick={() =>
                  void act(
                    t("remove_address", { host: d }),
                    `${base}/domains?host=${encodeURIComponent(d)}`,
                    { method: "DELETE" }
                  )
                }
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
        {!tenant.purgedAt && (
          <button
            className="text-xs text-blue-400 hover:underline mt-1"
            aria-label={t("add_address_label", named)}
            disabled={busy}
            onClick={() =>
              ask({
                label: t("add_address_label", named),
                field: t("address"),
                type: "text",
                submit: (host) =>
                  void act(t("add_address_label", named), `${base}/domains`, {
                    method: "POST",
                    body: JSON.stringify({ host }),
                  }),
              })
            }
          >
            {t("add_address")}
          </button>
        )}
      </td>
      <td className={td}>{tenant.userCount}</td>
      <td className={td}>
        <div className="flex flex-wrap gap-1">
          {tenant.status === "active" && (
            <button
              className={quiet}
              aria-label={t("suspend_label", named)}
              disabled={busy}
              onClick={() =>
                reasonFor(t("suspend_label", named), `${base}/state`, "suspend")
              }
            >
              {t("suspend")}
            </button>
          )}
          {tenant.status === "suspended" && (
            <button
              className={quiet}
              aria-label={t("resume_label", named)}
              disabled={busy}
              onClick={() =>
                reasonFor(t("resume_label", named), `${base}/state`, "resume")
              }
            >
              {t("resume")}
            </button>
          )}
          {tenant.status === "deleted" && !tenant.purgedAt && (
            <button
              className={quiet}
              aria-label={t("restore_label", named)}
              disabled={busy}
              onClick={() =>
                reasonFor(t("restore_label", named), `${base}/state`, "restore")
              }
            >
              {t("restore")}
            </button>
          )}
          {tenant.status !== "deleted" && !tenant.pendingDeletion && (
            <button
              className={quiet}
              aria-label={t("delete_label", named)}
              disabled={busy}
              onClick={() => reasonFor(t("delete_label", named), `${base}/deletion`)}
            >
              {t("delete")}
            </button>
          )}
          {tenant.pendingDeletion && (
            <>
              <button
                className={quiet}
                aria-label={t("approve_deletion_label", named)}
                disabled={busy}
                onClick={() => decide("approve", t("approve_deletion_label", named))}
              >
                {t("approve_deletion")}
              </button>
              <button
                className={quiet}
                aria-label={t("reject_deletion_label", named)}
                disabled={busy}
                onClick={() => decide("reject", t("reject_deletion_label", named))}
              >
                {t("reject_deletion")}
              </button>
            </>
          )}
          {tenant.status !== "deleted" && (
            <button
              className={quiet}
              aria-label={t("make_admin_label", named)}
              disabled={busy}
              onClick={() =>
                ask({
                  label: t("make_admin_label", named),
                  field: t("email"),
                  type: "email",
                  submit: (email) =>
                    void act(t("make_admin_label", named), `${base}/admins`, {
                      method: "POST",
                      body: JSON.stringify({ email }),
                    }),
                })
              }
            >
              {t("make_admin")}
            </button>
          )}
          {tenant.status !== "deleted" && (
            <button
              className={quiet}
              aria-label={t("settings_label", named)}
              disabled={busy}
              onClick={() => onSettings(tenant)}
            >
              {t("settings")}
            </button>
          )}
          {tenant.status !== "deleted" && (
            <button
              className={quiet}
              aria-label={renderMessage("screens.kill_switch.open_label", named)}
              disabled={busy}
              onClick={() => onKillSwitch(tenant)}
            >
              {renderMessage("screens.kill_switch.open")}
            </button>
          )}
          {!tenant.purgedAt && (
            <a
              className={quiet}
              aria-label={t("export_label", named)}
              href={`${base}/export`}
              download
            >
              {t("export")}
            </a>
          )}
        </div>
      </td>
    </tr>
  );
}

const CHECK_TONE: Record<string, string> = {
  ready: "text-green-400",
  not_needed: "text-green-400",
  unknown: "text-amber-400",
};
const CHECK_MARK: Record<string, string> = { ready: "✓", not_needed: "–", unknown: "?" };
const CHECK_STATES = new Set(["ready", "not_needed", "unknown"]);

export function OperatorTenantsView({
  data: initial,
}: {
  data: { tenants?: TenantRow[] } | undefined;
}) {
  const [tenants, setTenants] = useState<TenantRow[] | undefined>(initial?.tenants);
  const [seen, setSeen] = useState(initial);
  if (initial !== seen) {
    setSeen(initial);
    setTenants(initial?.tenants);
  }
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const [form, setForm] = useState({ slug: "", name: "", domains: "" });
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState<Question | null>(null);
  const [settingsFor, setSettingsFor] = useState<{
    tenant: TenantRow;
    data: TenantSettingsData;
  } | null>(null);
  const [killSwitchFor, setKillSwitchFor] = useState<TenantRow | null>(null);

  const openSettings = async (tenant: TenantRow) => {
    setBusy(true);
    try {
      setSettingsFor({ tenant, data: await loadTenantSettings(tenant) });
    } finally {
      setBusy(false);
    }
  };
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(null);
  const slugId = useId();
  const nameId = useId();
  const domainsId = useId();

  const reload = useCallback(async () => {
    const r = await call("/api/operator/tenants");
    if (r.ok) setTenants((r.body.tenants as TenantRow[]) ?? []);
  }, []);

  /** Run one action; report its answer; reload the list. */
  const act = async (label: string, url: string, init: RequestInit) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await call(url, init);
      setStatus(
        r.ok
          ? { text: t("done", { label }), tone: "ok" }
          : { text: t("failed", { label, reason: reasonOf(r) }), tone: "error" }
      );
      if (r.ok) await reload();
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  const provision = async () => {
    const domains = form.domains
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const done = await act(t("provision"), "/api/operator/tenants", {
      method: "POST",
      body: JSON.stringify({ slug: form.slug.trim(), name: form.name.trim(), domains }),
    });
    if (done) setForm({ slug: "", name: "", domains: "" });
  };

  const checkReadiness = async () => {
    const r = await call("/api/operator/readiness");
    if (r.ok) setReadiness(r.body as unknown as Readiness);
    else
      setStatus({
        text: t("failed", { label: t("readiness_label"), reason: reasonOf(r) }),
        tone: "error",
      });
  };

  if (!tenants) return <p className="text-gray-400">{t("loading")}</p>;

  return (
    <div className="space-y-6">
      <section className={card} aria-labelledby="readiness-heading">
        <div className="flex items-center justify-between">
          <h3 id="readiness-heading" className="text-base font-semibold text-white">
            {t("readiness_heading")}
          </h3>
          <button className={quiet} disabled={busy} onClick={() => void checkReadiness()}>
            {t("check")}
          </button>
        </div>
        {readiness && (
          <ul className="mt-3 space-y-1 text-sm">
            {readiness.checks.map((c) => (
              <li key={c.name}>
                <span className={CHECK_TONE[c.state] ?? "text-red-400"}>
                  <span aria-hidden="true">{CHECK_MARK[c.state] ?? "✗"}</span> {c.name}{" "}
                  <span className="sr-only">
                    (
                    {t(
                      CHECK_STATES.has(c.state) ? `check_${c.state}` : "check_not_ready"
                    )}
                    )
                  </span>
                </span>{" "}
                <span className="text-gray-400">{c.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={card} aria-labelledby="provision-heading">
        <h3 id="provision-heading" className="text-base font-semibold text-white">
          {t("provision_heading")}
        </h3>
        <div className="flex flex-wrap gap-2 mt-3 items-end">
          <div className="text-sm text-gray-400">
            <label htmlFor={slugId}>{t("slug")}</label>
            <input
              id={slugId}
              className={`${input} block mt-1`}
              value={form.slug}
              onChange={(e) => setForm({ ...form, slug: e.target.value })}
              placeholder={t("slug_hint")}
            />
          </div>
          <div className="text-sm text-gray-400">
            <label htmlFor={nameId}>{t("name")}</label>
            <input
              id={nameId}
              className={`${input} block mt-1`}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t("name_hint")}
            />
          </div>
          <div className="text-sm text-gray-400">
            <label htmlFor={domainsId}>{t("domains")}</label>
            <input
              id={domainsId}
              className={`${input} block mt-1 w-72`}
              value={form.domains}
              onChange={(e) => setForm({ ...form, domains: e.target.value })}
              placeholder={t("domains_hint")}
            />
          </div>
          <button
            className={button}
            disabled={busy || !form.slug.trim() || !form.name.trim()}
            onClick={() => void provision()}
          >
            {t("provision")}
          </button>
        </div>
      </section>

      <section className={card} aria-labelledby="tenants-heading">
        <div className="flex items-center justify-between">
          <h3 id="tenants-heading" className="text-base font-semibold text-white">
            {t("tenants_heading")}
          </h3>
          <button
            className={quiet}
            disabled={busy}
            onClick={() =>
              void act(t("purge_label"), "/api/operator/purge", { method: "POST" })
            }
          >
            {t("purge_due")}
          </button>
        </div>
        {question && (
          <QuestionForm
            key={question.label}
            question={question}
            busy={busy}
            onDone={() => setQuestion(null)}
          />
        )}
        <table className="w-full text-sm mt-3">
          <thead>
            <tr>
              <th className={th}>{t("col_tenant")}</th>
              <th className={th}>{t("col_state")}</th>
              <th className={th}>{t("col_addresses")}</th>
              <th className={th}>{t("col_users")}</th>
              <th className={th}>{t("col_actions")}</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((row) => (
              <TenantRowView
                key={row.id}
                tenant={row}
                busy={busy}
                act={act}
                ask={setQuestion}
                onSettings={(row) => void openSettings(row)}
                onKillSwitch={setKillSwitchFor}
              />
            ))}
          </tbody>
        </table>
        {status && <Status {...status} />}
      </section>
      {killSwitchFor && (
        <AgentKillSwitch
          key={killSwitchFor.id}
          endpoint={`/api/operator/tenants/${encodeURIComponent(killSwitchFor.id)}/agents/suspend`}
          tenant={killSwitchFor.name}
          onClose={() => setKillSwitchFor(null)}
        />
      )}
      {settingsFor && (
        <OperatorTenantSettings
          key={settingsFor.tenant.id}
          tenant={settingsFor.tenant}
          initial={settingsFor.data}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  );
}

// ── An operator's view of one tenant's settings ─────────────────────────

interface TenantConfigEntry {
  key: string;
  description: string | null;
  value: unknown;
  platformValue: unknown;
  overridden: boolean;
  tenantOverridable: boolean;
  permissionTier: string;
}

interface HeldChange {
  source: "runtime" | "config-approval";
  id: string;
  label: string;
  requester: string;
  requiredPermission: string;
  reason?: string;
}

interface TenantSettingsData {
  readonly entries: TenantConfigEntry[];
  readonly held: HeldChange[];
  /** Why the settings could not be read, for the status line. */
  readonly error?: string;
}

/** One tenant's settings and held changes, read in an event handler (never in an effect). */
export async function loadTenantSettings(
  tenant: Pick<TenantRow, "id" | "name">
): Promise<TenantSettingsData> {
  const base = `/api/operator/tenants/${encodeURIComponent(tenant.id)}`;
  const [c, a] = await Promise.all([call(`${base}/config`), call(`${base}/approvals`)]);
  return {
    entries: c.ok ? ((c.body.entries as TenantConfigEntry[]) ?? []) : [],
    held: a.ok ? ((a.body.approvals as HeldChange[]) ?? []) : [],
    ...(c.ok
      ? {}
      : {
          error: t("failed", {
            label: t("settings_heading", { tenant: tenant.name }),
            reason: reasonOf(c),
          }),
        }),
  };
}

/**
 * Every setting of one tenant, as an operator sets it: any key (not only those its
 * administrators may set), its own value or the platform default; and the held changes those
 * create, to approve or reject. The server governs each change (tier, approval, dual control).
 */
export function OperatorTenantSettings({
  tenant,
  initial,
  onClose,
}: {
  tenant: Pick<TenantRow, "id" | "name">;
  initial: TenantSettingsData;
  onClose: () => void;
}) {
  const base = `/api/operator/tenants/${encodeURIComponent(tenant.id)}`;
  const [entries, setEntries] = useState<TenantConfigEntry[]>(initial.entries);
  const [held, setHeld] = useState<HeldChange[]>(initial.held);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; tone: Tone } | null>(
    initial.error ? { text: initial.error, tone: "error" } : null
  );
  const filterId = useId();
  const named = { tenant: tenant.name };

  const load = async () => {
    const next = await loadTenantSettings(tenant);
    setEntries(next.entries);
    setHeld(next.held);
    if (next.error) setStatus({ text: next.error, tone: "error" });
  };

  const run = async (label: string, url: string, init: RequestInit, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await call(url, init);
      setStatus(
        r.ok
          ? { text: r.body.pending ? t("held", { key: label }) : done, tone: "ok" }
          : { text: t("failed", { label, reason: reasonOf(r) }), tone: "error" }
      );
      if (r.ok) await load();
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  const save = async (key: string) => {
    const ok = await run(
      key,
      `${base}/config`,
      {
        method: "PUT",
        body: JSON.stringify({
          key,
          value: parseValue(drafts[key] ?? ""),
          changeComment: t("operator_change_comment"),
        }),
      },
      t("saved", { key })
    );
    if (ok) setDrafts((d) => ({ ...d, [key]: "" }));
  };

  const reset = (key: string) =>
    run(
      key,
      `${base}/config?key=${encodeURIComponent(key)}`,
      { method: "DELETE" },
      t("reset_done", { key })
    );

  const decide = (h: HeldChange, decision: "approve" | "reject") =>
    run(
      h.label,
      `${base}/approvals/${encodeURIComponent(h.id)}`,
      { method: "POST", body: JSON.stringify({ decision, source: h.source }) },
      t("done", { label: h.label })
    );

  const q = filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) =>
      !q ||
      e.key.toLowerCase().includes(q) ||
      (e.description ?? "").toLowerCase().includes(q)
  );

  return (
    <section className={card} aria-labelledby="tenant-config-heading">
      <div className="flex items-center justify-between">
        <h3 id="tenant-config-heading" className="text-base font-semibold text-white">
          {t("settings_heading", named)}
        </h3>
        <button className={quiet} onClick={onClose}>
          {t("close")}
        </button>
      </div>
      <p className="text-sm text-gray-400 mt-1">{t("settings_intro_operator")}</p>
      {held.length > 0 && (
        <div className="mt-3">
          <h4 className="text-sm font-semibold text-gray-300">{t("held_heading")}</h4>
          <ul className="mt-1 space-y-1 text-sm">
            {held.map((h) => (
              <li
                key={`${h.source}:${h.id}`}
                className="flex flex-wrap gap-2 items-center"
              >
                <span className="font-mono text-blue-300">{h.label}</span>
                <span className="text-gray-400">
                  {t("held_by", {
                    requester: h.requester,
                    permission: h.requiredPermission,
                  })}
                </span>
                <button
                  className={quiet}
                  aria-label={t("approve_held_label", { label: h.label })}
                  disabled={busy}
                  onClick={() => void decide(h, "approve")}
                >
                  {t("approve")}
                </button>
                <button
                  className={quiet}
                  aria-label={t("reject_held_label", { label: h.label })}
                  disabled={busy}
                  onClick={() => void decide(h, "reject")}
                >
                  {t("reject_deletion")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-3">
        <label className="text-sm text-gray-400 mr-2" htmlFor={filterId}>
          {t("filter")}
        </label>
        <input
          id={filterId}
          className={input}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <table className="w-full text-sm mt-3">
        <thead>
          <tr>
            <th className={th}>{t("col_setting")}</th>
            <th className={th}>{t("col_value")}</th>
            <th className={th}>{t("col_default")}</th>
            <th className={th}>{t("col_change")}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((e) => (
            <tr key={e.key}>
              <td className={td}>
                <span className="font-mono text-blue-300">{e.key}</span>
                <p className="text-xs text-gray-400 mt-1">
                  {t(e.tenantOverridable ? "tenant_settable" : "platform_governed")}
                  {e.permissionTier === "safety" ? ` · ${t("safety_tier")}` : ""}
                </p>
                {e.description && (
                  <p className="text-xs text-gray-400 mt-1">{e.description}</p>
                )}
              </td>
              <td className={td}>
                <span className="font-mono">{show(e.value)}</span>
                {e.overridden && (
                  <span className="ml-2 text-xs text-amber-400">{t("own_value")}</span>
                )}
              </td>
              <td className={`${td} font-mono text-gray-400`}>{show(e.platformValue)}</td>
              <td className={td}>
                <div className="flex gap-2 items-center">
                  <label className="sr-only" htmlFor={`ov-${e.key}`}>
                    {t("new_value_for", { key: e.key })}
                  </label>
                  <input
                    id={`ov-${e.key}`}
                    className={input}
                    value={drafts[e.key] ?? ""}
                    placeholder={show(e.value)}
                    onChange={(ev) =>
                      setDrafts((d) => ({ ...d, [e.key]: ev.target.value }))
                    }
                  />
                  <button
                    className={button}
                    aria-label={t("save_for", { key: e.key })}
                    disabled={busy || !(drafts[e.key] ?? "").trim()}
                    onClick={() => void save(e.key)}
                  >
                    {t("save")}
                  </button>
                  {e.overridden && (
                    <button
                      className={quiet}
                      aria-label={t("use_default_for", { key: e.key })}
                      disabled={busy}
                      onClick={() => void reset(e.key)}
                    >
                      {t("use_default")}
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {status && <Status {...status} />}
    </section>
  );
}
