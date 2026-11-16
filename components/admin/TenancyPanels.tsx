"use client";

/**
 * components/admin/TenancyPanels.tsx — the tenant's own settings, and the operators' tenants
 * console (ADR-053 D5, D7), on the console's shared parts (TASK-221)
 *
 *   TenantSettingsView   a tenant's administrators: their tenant, its addresses, today's agent
 *                        spend against its cap, the settings they may set for it, its recent jobs
 *   OperatorTenantsView  operators (platform_operate): whether the deployment is ready for
 *                        tenants, provisioning, and every tenant — opened in its own panel for its
 *                        state changes, two-operator deletion, addresses, first administrator,
 *                        settings and their held changes, export, and the agent kill switch
 *
 * What the review found and how each is done (SCREEN-FINDINGS, Tenancy; E-87 to E-89, E-91):
 *
 *   - every state change, address change, deletion decision, purge and held-change decision is
 *     confirmed, saying what happens to the tenant's people; a purge says it cannot be undone and
 *     which tenants it removes (E-87 to E-89, SF-admin-117);
 *   - a tenant opens in its own panel in place of the list, its heading focused, with a "Reading"
 *     state while its settings are read; Close returns to the row (SF-admin-112) — and the list
 *     has only the columns that fit a phone, so the screen never scrolls sideways;
 *   - a setting is edited by its type and confirmed, offered only to an operator who holds its
 *     tier's permission (SF-admin-110, E-91); a held change is the Approvals card — before and
 *     after, who asked and why, when — decided through the Approvals confirm step (SF-admin-111);
 *   - a read of the held changes that fails is said, never "none" (SF-admin-115);
 *   - outcomes are kept until dismissed and say who and how many: the address made an
 *     administrator, the tenants purged and their rows (SF-admin-113);
 *   - a tenant is named by its name, the deletion's requester by address, and Approve is not
 *     offered on one's own request (SF-admin-114); the export says it is working and whether the
 *     file is whole (SF-admin-116); states and readiness checks by name, a check's time
 *     (SF-admin-118, 119).
 *
 * Every action calls the server, which decides; this only shows what it answers.
 *
 * @module components/admin
 */

import React, { useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { isShownText, renderShown, type ShownText } from "@/platform/errors/shown-text";
import { handleRefusal } from "@/platform/errors/refusal";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { TenantJobsList, type JobRow } from "./JobsPanels";
import { AgentKillSwitch } from "./AgentKillSwitchPanel";
import { decideHeld, decisionGate, HoldCard, type Decision } from "./HeldActionsPanel";
import { formatDate, formatTime } from "./admin-format";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { DetailFacts, DetailPanel } from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { Field, TextInput } from "@/components/admin/ui/Field";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import {
  PanelState,
  ReadFailed,
  Reading,
  usePanelRead,
} from "@/components/admin/ui/PanelState";
import { IdDetail, PersonRef } from "@/components/admin/ui/Ref";
import { adminCall, type CallBody } from "@/components/admin/ui/admin-call";
import { adminDownload } from "@/components/admin/ui/download";
import {
  outcome,
  refusedOutcome,
  type OutcomeEntry,
} from "@/components/admin/ui/Outcome";
import {
  readinessCheckLabel,
  tenantStateLabel,
  usdText,
} from "@/components/admin/ui/labels";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { sectionTitle } from "@/components/admin/ui/sections";
import { ListUnreadable, elementWith, useOutcomes } from "./views/kit";
import { TenantSettingsList, type TenantSettingEntry } from "./views/TenantSettings";
import type { SectionViewProps } from "./section-views";
import type { PersonRef as Person } from "./people";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.tenancy.${key}`, values);

type Facts = [string, React.ReactNode][];

/** A card of the screen: its heading and what is under it. */
function Card({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className={`${SURFACE.panel} min-w-0 space-y-3 p-4`} aria-labelledby={id}>
      <h3 id={id} className={`text-base font-semibold ${TEXT.strong}`}>
        {title}
      </h3>
      {children}
    </section>
  );
}

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
  /** Null: the admin may not see the settings (config_view). */
  settings?: TenantSettingEntry[] | null;
  /** The tenant's recent background jobs (read-only); null when they could not be read. */
  jobs?: JobRow[] | null;
}

export function TenantSettingsView({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const { add, list } = useOutcomes(t("results_label"));
  const tenantData = (data ?? {}) as TenantData;
  const tenant = tenantData.tenant;
  // A body without its tenant is not a tenant with nothing: said as a failed read.
  if (!tenant)
    return <ListUnreadable panel={sectionTitle("tenant")} onRetry={onReload} />;
  const shared = tenant.mode === "shared";
  const name = tenant.name ?? t("this_deployment");
  const domains = tenantData.domains ?? [];
  const budget = tenantData.budget;
  const facts: Facts = [
    [t("field_kind"), t(shared ? "kind_shared" : "kind_single")],
    [t("field_state"), tenantStateLabel(tenant.status)],
    [t("field_short_name"), tenant.slug ?? t("no_short_name")],
    ...(showIds
      ? ([[t("field_reference"), <IdDetail key="i" id={tenant.id} show />]] as Facts)
      : []),
    [
      t("addresses"),
      domains.length > 0 ? (
        <ul key="d" className="space-y-1">
          {domains.map((d) => (
            <li key={d.host} className="break-words">
              {d.host}
            </li>
          ))}
        </ul>
      ) : (
        t(shared ? "no_addresses_shared" : "no_addresses_single")
      ),
    ],
    ...(budget
      ? ([
          [
            t("spend_heading"),
            <span key="b">
              {t("spend", {
                used: usdText(budget.usedUsd),
                cap: usdText(budget.budgetUsd),
              })}
              {budget.exhausted ? (
                <span className="block text-red-300">{t("spend_exhausted")}</span>
              ) : null}
            </span>,
          ],
        ] as Facts)
      : []),
  ];
  return (
    <div className="min-w-0 space-y-6">
      <Card id="tenant-heading" title={name}>
        <DetailFacts facts={facts} />
      </Card>
      <Card
        id="tenant-settings-heading"
        title={t(shared ? "settings_heading_shared" : "settings_heading_single")}
      >
        <p className={`text-sm ${TEXT.faint}`}>
          {t(shared ? "settings_intro_shared" : "settings_intro_single")}
        </p>
        {list}
        {tenantData.settings === null ? (
          <p className={`text-sm ${TEXT.quiet}`} data-settings-not-shown="true">
            {t("settings_need_view", { permission: needsPermission("config_view") })}
          </p>
        ) : !Array.isArray(tenantData.settings) ? (
          <ListUnreadable panel={t("settings_panel")} onRetry={onReload} />
        ) : (
          <TenantSettingsList
            entries={tenantData.settings}
            url="/api/admin/config"
            tenant={name}
            caption={t("settings_caption", { tenant: name })}
            mayReset={shared}
            hasPermission={hasPermission}
            showIds={showIds}
            add={add}
            onChanged={onReload}
          />
        )}
      </Card>
      <TenantJobsList jobs={tenantData.jobs} />
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
  pendingDeletion?: {
    requestId: string;
    requestedBy: string;
    /** Who asked, by address (TASK-221); null when unknown. */
    requester?: Person | null;
    /** The viewer asked it: another operator approves. */
    byViewer?: boolean;
  };
}

interface Readiness {
  mode: string;
  ready: boolean;
  checks: { name: string; state: string; detail: ShownText }[];
}

const CHECK_STATES = new Set(["ready", "not_needed", "unknown"]);

/** Whether the deployment is ready for tenants: checked on request, with the time of the check. */
function ReadinessCard() {
  const [state, setState] = useState<
    | { phase: "idle" }
    | { phase: "checking" }
    | { phase: "done"; readiness: Readiness; at: Date }
    | { phase: "failed"; refusal: ReturnType<typeof handleRefusal> }
  >({ phase: "idle" });
  const check = async () => {
    setState({ phase: "checking" });
    const answer = await adminCall("/api/operator/readiness");
    if (!answer.ok) return setState({ phase: "failed", refusal: answer.refusal });
    const body = answer.body as unknown as Readiness;
    if (!Array.isArray(body.checks))
      return setState({
        phase: "failed",
        refusal: handleRefusal(undefined, {
          message: renderMessage("screens.admin_console.views.not_a_list", {
            panel: t("readiness_heading"),
          }),
        }),
      });
    setState({ phase: "done", readiness: body, at: new Date() });
  };
  return (
    <Card id="readiness-heading" title={t("readiness_heading")}>
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={BUTTON.quiet}
          disabled={state.phase === "checking"}
          onClick={() => void check()}
        >
          {state.phase === "done" ? t("check_again") : t("check")}
        </button>
        {state.phase === "checking" ? <Reading text={t("checking")} /> : null}
        {state.phase === "done" ? (
          <span className={`text-xs ${TEXT.faint}`}>
            {t("checked_at", { time: formatTime(state.at) })}
          </span>
        ) : null}
      </div>
      {state.phase === "failed" ? (
        <ReadFailed
          panel={t("readiness_heading")}
          refusal={state.refusal}
          onRetry={() => void check()}
        />
      ) : null}
      {state.phase === "done" ? (
        <>
          <p className={`text-sm ${TEXT.body}`}>
            {state.readiness.ready ? t("ready_yes") : t("ready_no")}
          </p>
          <ul className="space-y-1 text-sm">
            {state.readiness.checks.map((c) => (
              <li key={c.name} className="break-words" data-check={c.name}>
                <span className={TEXT.strong}>{readinessCheckLabel(c.name)}</span>
                {": "}
                <span>
                  {t(CHECK_STATES.has(c.state) ? `check_${c.state}` : "check_not_ready")}
                </span>
                {isShownText(c.detail) ? (
                  <span className={`block text-xs ${TEXT.faint}`}>
                    {renderShown(c.detail)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

/** Provision a tenant: its short name, its name and addresses — read back before it is sent. */
function ProvisionCard({
  add,
  onReload,
}: {
  readonly add: (entry: OutcomeEntry) => void;
  readonly onReload?: () => void;
}) {
  const [form, setForm] = useState({ slug: "", name: "", domains: "" });
  const [problem, setProblem] = useState<{ slug?: string; name?: string }>({});
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const domains = form.domains
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const send = async () => {
    setBusy(true);
    const answer = await adminCall("/api/operator/tenants", {
      method: "POST",
      json: { slug: form.slug.trim(), name: form.name.trim(), domains },
    });
    setBusy(false);
    setAsking(false);
    const what = t("what_provision", { tenant: form.name.trim() });
    if (!answer.ok) return add(refusedOutcome(answer.refusal, { action: what }));
    add(outcome("applied", what, { next: t("provision_next") }));
    setForm({ slug: "", name: "", domains: "" });
    onReload?.();
  };
  return (
    <Card id="provision-heading" title={t("provision_heading")}>
      {asking ? (
        <ConfirmStep
          action="tenancy.provision"
          title={t("confirm_provision", { tenant: form.name.trim() })}
          confirmLabel={t("provision")}
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => void send()}
        >
          <DetailFacts
            facts={[
              [t("slug"), form.slug.trim()],
              [t("name"), form.name.trim()],
              [
                t("addresses"),
                domains.length ? domains.join(", ") : t("no_addresses_given"),
              ],
            ]}
          />
        </ConfirmStep>
      ) : (
        <form
          noValidate
          aria-label={t("provision_heading")}
          className="grid min-w-0 gap-3 sm:grid-cols-3"
          onSubmit={(e) => {
            e.preventDefault();
            const next = {
              ...(form.slug.trim() ? {} : { slug: t("slug_needed") }),
              ...(form.name.trim() ? {} : { name: t("name_needed") }),
            };
            setProblem(next);
            if (!next.slug && !next.name) setAsking(true);
          }}
        >
          <Field label={t("slug")} help={t("slug_help")} error={problem.slug}>
            {(control) => (
              <TextInput
                {...control}
                value={form.slug}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, slug: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("name")} help={t("name_help")} error={problem.name}>
            {(control) => (
              <TextInput
                {...control}
                value={form.name}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            )}
          </Field>
          <Field label={t("domains")} help={t("domains_help")}>
            {(control) => (
              <TextInput
                {...control}
                value={form.domains}
                autoComplete="off"
                onChange={(e) => setForm({ ...form, domains: e.target.value })}
              />
            )}
          </Field>
          <div className="sm:col-span-3">
            <button type="submit" className={BUTTON.primary}>
              {t("review")}
            </button>
          </div>
        </form>
      )}
    </Card>
  );
}

/** One answer from an operator route, as an outcome naming what was done and for whom. */
function answered(
  answer: Awaited<ReturnType<typeof adminCall>>,
  what: string,
  tenant: string,
  done: Omit<OutcomeEntry, "id" | "tone" | "text"> & {
    readonly text?: string;
    readonly held?: boolean;
  } = {}
): OutcomeEntry {
  if (!answer.ok) return refusedOutcome(answer.refusal, { action: what, who: tenant });
  const { text, held, ...more } = done;
  return outcome(held ? "held" : "applied", text ?? what, { who: tenant, ...more });
}

type TenantStep =
  | { kind: "view" }
  | { kind: "state"; action: "suspend" | "resume" | "restore" }
  | { kind: "delete" }
  | { kind: "decide_deletion"; decision: "approve" | "reject" }
  | { kind: "add_address" }
  | { kind: "confirm_address"; host: string }
  | { kind: "remove_address"; host: string }
  | { kind: "make_admin" }
  | { kind: "confirm_admin"; email: string };

/** A form of one field, then its confirm step (an address, an email). */
function OneField({
  formLabel,
  label,
  help,
  type,
  check,
  onNext,
  onCancel,
}: {
  /** What the form does ("Add an address for Acme"). */
  readonly formLabel: string;
  readonly label: string;
  readonly help: string;
  readonly type: "text" | "email";
  readonly check: (value: string) => string | null;
  readonly onNext: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      noValidate
      aria-label={formLabel}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        const bad = check(value.trim());
        setProblem(bad);
        if (!bad) onNext(value.trim());
      }}
    >
      <Field label={label} help={help} error={problem}>
        {(control) => (
          <TextInput
            {...control}
            type={type}
            value={value}
            autoComplete="off"
            onChange={(e) => {
              setValue(e.target.value);
              setProblem(null);
            }}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary}>
          {t("review")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onCancel}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** The tenant's own settings and their held changes, read when its panel asks for them. */
function OperatorTenantSettings({
  tenant,
  hasPermission,
  viewerId,
  showIds,
  add,
}: {
  readonly tenant: Pick<TenantRow, "id" | "name">;
  readonly hasPermission: (code: string) => boolean;
  readonly viewerId?: string;
  readonly showIds: boolean;
  readonly add: (entry: OutcomeEntry) => void;
}) {
  const base = `/api/operator/tenants/${encodeURIComponent(tenant.id)}`;
  const config = usePanelRead(
    `/api/operator/tenants/${encodeURIComponent(tenant.id)}/config`
  );
  const held = usePanelRead(
    `/api/operator/tenants/${encodeURIComponent(tenant.id)}/approvals`
  );
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const reload = () => {
    config.reload();
    held.reload();
  };
  const decide = async (row: PendingApproval, decision: Decision, note: string) => {
    const key = `${row.source}:${row.id}`;
    setBusyKey(key);
    const decided = await decideHeld(
      `${base}/approvals/${encodeURIComponent(row.id)}`,
      row,
      decision,
      note
    );
    setBusyKey(null);
    add({ ...decided.entry, who: tenant.name });
    if (decided.reload) reload();
  };
  return (
    <div className="min-w-0 space-y-4">
      <p className={`text-sm ${TEXT.faint}`}>{t("settings_intro_operator")}</p>
      <section aria-label={t("held_heading")} className="space-y-2">
        <h4 className={`text-sm font-semibold ${TEXT.quiet}`}>{t("held_heading")}</h4>
        <PanelState
          read={held.read}
          panel={t("held_panel", { tenant: tenant.name })}
          onReload={held.reload}
          empty={(body) =>
            Array.isArray(body.approvals) && body.approvals.length === 0
              ? t("held_none")
              : null
          }
        >
          {(body: CallBody) =>
            !Array.isArray(body.approvals) ? (
              <ListUnreadable
                panel={t("held_panel", { tenant: tenant.name })}
                onRetry={held.reload}
              />
            ) : (
              <ul aria-label={t("held_heading")} className="space-y-3">
                {(body.approvals as PendingApproval[]).map((a) => {
                  const key = `${a.source}:${a.id}`;
                  return (
                    <HoldCard
                      key={key}
                      a={a}
                      gate={decisionGate(a, viewerId, hasPermission)}
                      busy={busyKey === key}
                      showIds={showIds}
                      onDecide={(decision, note) => decide(a, decision, note)}
                    />
                  );
                })}
              </ul>
            )
          }
        </PanelState>
      </section>
      <section
        aria-label={t("settings_heading", { tenant: tenant.name })}
        className="space-y-2"
      >
        <h4 className={`text-sm font-semibold ${TEXT.quiet}`}>
          {t("settings_heading", { tenant: tenant.name })}
        </h4>
        <PanelState
          read={config.read}
          panel={t("settings_heading", { tenant: tenant.name })}
          onReload={config.reload}
        >
          {(body: CallBody) =>
            !Array.isArray(body.entries) ? (
              <ListUnreadable
                panel={t("settings_heading", { tenant: tenant.name })}
                onRetry={config.reload}
              />
            ) : (
              <TenantSettingsList
                entries={body.entries as TenantSettingEntry[]}
                url={`${base}/config`}
                tenant={tenant.name}
                caption={t("settings_caption", { tenant: tenant.name })}
                mayReset
                hasPermission={hasPermission}
                showIds={showIds}
                add={add}
                onChanged={reload}
              />
            )
          }
        </PanelState>
      </section>
    </div>
  );
}

/** The open step of a tenant's panel: a confirm step, or the one field it asks first. */
function TenantStepView({
  step,
  tenant,
  busy,
  send,
  back,
  setStep,
}: {
  readonly step: TenantStep;
  readonly tenant: TenantRow;
  readonly busy: boolean;
  readonly send: (
    what: string,
    method: "POST" | "DELETE",
    url: string,
    json: unknown,
    more?: Parameters<typeof answered>[3]
  ) => Promise<void>;
  readonly back: () => void;
  readonly setStep: (next: TenantStep) => void;
}) {
  const base = `/api/operator/tenants/${encodeURIComponent(tenant.id)}`;
  const named = { tenant: tenant.name };
  const pending = tenant.pendingDeletion;
  const stateConsequence: Record<"suspend" | "resume" | "restore", string> = {
    suspend: "suspend",
    resume: "resume",
    restore: "restore",
  };

  let body: React.ReactNode = null;
  if (step.kind === "state")
    body = (
      <ConfirmStep
        action={`tenancy.${step.action}`}
        title={t(`confirm_${stateConsequence[step.action]}`, named)}
        confirmLabel={t(step.action)}
        busy={busy}
        onCancel={back}
        onConfirm={(given) =>
          void send(t(`${step.action}_label`, named), "POST", `${base}/state`, {
            action: step.action,
            reason: given.reason,
          })
        }
      />
    );
  else if (step.kind === "delete")
    body = (
      <ConfirmStep
        action="tenancy.request_deletion"
        title={t("confirm_delete", named)}
        confirmLabel={t("delete")}
        busy={busy}
        onCancel={back}
        onConfirm={(given) =>
          void send(
            t("delete_label", named),
            "POST",
            `${base}/deletion`,
            { reason: given.reason },
            { held: true, next: t("delete_next") }
          )
        }
      />
    );
  else if (step.kind === "decide_deletion" && pending)
    body = (
      <ConfirmStep
        action={`tenancy.${step.decision}_deletion`}
        title={t(`confirm_${step.decision}_deletion`, named)}
        confirmLabel={t(`${step.decision}_deletion`)}
        busy={busy}
        onCancel={back}
        onConfirm={() =>
          void send(
            t(`${step.decision}_deletion_label`, named),
            "POST",
            `/api/operator/deletions/${encodeURIComponent(pending.requestId)}`,
            { decision: step.decision }
          )
        }
      >
        <p>
          {t("deletion_by")} <PersonRef person={pending.requester} />
        </p>
      </ConfirmStep>
    );
  else if (step.kind === "add_address")
    body = (
      <OneField
        formLabel={t("add_address_label", named)}
        label={t("address")}
        help={t("address_help")}
        type="text"
        check={(v) => (v ? null : t("address_needed"))}
        onNext={(host) => setStep({ kind: "confirm_address", host })}
        onCancel={back}
      />
    );
  else if (step.kind === "confirm_address")
    body = (
      <ConfirmStep
        action="tenancy.add_address"
        title={t("confirm_add_address", { host: step.host, tenant: tenant.name })}
        confirmLabel={t("add_address")}
        busy={busy}
        onCancel={back}
        onConfirm={() =>
          void send(
            t("what_add_address", { host: step.host }),
            "POST",
            `${base}/domains`,
            {
              host: step.host,
            }
          )
        }
      />
    );
  else if (step.kind === "remove_address")
    body = (
      <ConfirmStep
        action="tenancy.remove_address"
        title={t("confirm_remove_address", { host: step.host, tenant: tenant.name })}
        confirmLabel={t("remove")}
        busy={busy}
        onCancel={back}
        onConfirm={() =>
          void send(
            t("what_remove_address", { host: step.host }),
            "DELETE",
            `${base}/domains?host=${encodeURIComponent(step.host)}`,
            undefined
          )
        }
      />
    );
  else if (step.kind === "make_admin")
    body = (
      <OneField
        formLabel={t("make_admin_label", named)}
        label={t("email")}
        help={t("email_help", named)}
        type="email"
        check={(v) => (/^[^\s@]+@[^\s@]+$/.test(v) ? null : t("email_needed"))}
        onNext={(email) => setStep({ kind: "confirm_admin", email })}
        onCancel={back}
      />
    );
  else if (step.kind === "confirm_admin")
    body = (
      <ConfirmStep
        action="tenancy.make_admin"
        title={t("confirm_make_admin", { email: step.email, tenant: tenant.name })}
        confirmLabel={t("make_admin")}
        busy={busy}
        onCancel={back}
        onConfirm={() =>
          void send(
            t("what_make_admin", { email: step.email }),
            "POST",
            `${base}/admins`,
            { email: step.email },
            { text: t("made_admin", { email: step.email, tenant: tenant.name }) }
          )
        }
      />
    );

  return <>{body}</>;
}

/** One tenant's panel: its facts, the changes its state allows, its settings, export, kill switch. */
function TenantDetail({
  tenant,
  hasPermission,
  viewerId,
  showIds,
  add,
  onReload,
  onClose,
}: {
  readonly tenant: TenantRow;
  readonly hasPermission: (code: string) => boolean;
  readonly viewerId?: string;
  readonly showIds: boolean;
  readonly add: (entry: OutcomeEntry) => void;
  readonly onReload?: () => void;
  readonly onClose: () => void;
}) {
  const [step, setStep] = useState<TenantStep>({ kind: "view" });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<"actions" | "settings" | "kill">("actions");
  const base = `/api/operator/tenants/${encodeURIComponent(tenant.id)}`;
  const named = { tenant: tenant.name };
  const back = () => setStep({ kind: "view" });
  const deleted = tenant.status === "deleted";
  const pending = tenant.pendingDeletion;

  const send = async (
    what: string,
    method: "POST" | "DELETE",
    url: string,
    json: unknown,
    more: Parameters<typeof answered>[3] = {}
  ) => {
    setBusy(true);
    const answer = await adminCall(url, { method, json });
    setBusy(false);
    add(answered(answer, what, tenant.name, more));
    back();
    if (answer.ok) onReload?.();
  };

  const exportData = async () => {
    setExporting(true);
    const got = await adminDownload(`${base}/export`, `tenant-${tenant.slug}.ndjson`, {
      // A whole export ends with its "done" line; a failure part-way ends with an error line.
      whole: (tail) => /"done"\s*:\s*true/.test(tail),
      incomplete: handleRefusal(undefined, { message: t("export_incomplete") }),
    });
    setExporting(false);
    add(
      got.ok
        ? outcome(
            "applied",
            t("export_done", { tenant: tenant.name, file: got.filename })
          )
        : refusedOutcome(got.refusal, { action: t("export_label", named) })
    );
  };

  const facts: Facts = [
    [t("field_state"), tenantStateLabel(tenant.status)],
    [t("field_short_name"), tenant.slug],
    ...(showIds
      ? ([[t("field_reference"), <IdDetail key="i" id={tenant.id} show />]] as Facts)
      : []),
    [t("col_users"), String(tenant.userCount)],
    ...(tenant.purgeAfter && !tenant.purgedAt
      ? ([
          [t("field_purge"), t("purged_after", { date: formatDate(tenant.purgeAfter) })],
        ] as Facts)
      : []),
    ...(tenant.purgedAt ? ([[t("field_purge"), t("purged")]] as Facts) : []),
    ...(pending
      ? ([
          [
            t("field_deletion"),
            <span key="p">
              {t("deletion_pending")}{" "}
              {pending.byViewer ? (
                t("deletion_by_you")
              ) : (
                <>
                  {t("deletion_by")} <PersonRef person={pending.requester} />
                </>
              )}
            </span>,
          ],
        ] as Facts)
      : []),
  ];

  const body =
    step.kind === "view" ? null : (
      <TenantStepView
        step={step}
        tenant={tenant}
        busy={busy}
        send={send}
        back={back}
        setStep={setStep}
      />
    );

  const stateButton = (action: "suspend" | "resume" | "restore") => (
    <button
      type="button"
      className={BUTTON.quiet}
      disabled={busy}
      aria-label={t(`${action}_label`, named)}
      onClick={() => setStep({ kind: "state", action })}
    >
      {t(action)}
    </button>
  );

  return (
    <DetailPanel
      title={tenant.name}
      onClose={onClose}
      returnFocus={() => elementWith("data-tenant-open", tenant.id)}
    >
      <div className="min-w-0 space-y-4">
        <DetailFacts facts={facts} />
        <div
          role="group"
          aria-label={t("panel_parts", named)}
          className="flex flex-wrap gap-2"
        >
          {(
            [
              ["actions", t("tab_actions")],
              ...(deleted
                ? []
                : ([
                    ["settings", t("tab_settings")],
                    ["kill", t("tab_kill")],
                  ] as const)),
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              className={tab === id ? BUTTON.primary : BUTTON.quiet}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "settings" && !deleted ? (
          <OperatorTenantSettings
            tenant={tenant}
            hasPermission={hasPermission}
            viewerId={viewerId}
            showIds={showIds}
            add={add}
          />
        ) : tab === "kill" && !deleted ? (
          <AgentKillSwitch
            endpoint={`${base}/agents/suspend`}
            tenant={tenant.name}
            showIds={showIds}
          />
        ) : body !== null ? (
          body
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {tenant.status === "active" ? stateButton("suspend") : null}
              {tenant.status === "suspended" ? stateButton("resume") : null}
              {deleted && !tenant.purgedAt ? stateButton("restore") : null}
              {!deleted && !pending ? (
                <button
                  type="button"
                  className={BUTTON.quiet}
                  disabled={busy}
                  aria-label={t("delete_label", named)}
                  onClick={() => setStep({ kind: "delete" })}
                >
                  {t("delete")}
                </button>
              ) : null}
              {pending ? (
                <>
                  <GatedButton
                    allowed={!pending.byViewer}
                    reason={t("approve_own")}
                    className={BUTTON.primary}
                    disabled={busy}
                    aria-label={t("approve_deletion_label", named)}
                    onClick={() =>
                      setStep({ kind: "decide_deletion", decision: "approve" })
                    }
                  >
                    {t("approve_deletion")}
                  </GatedButton>
                  <button
                    type="button"
                    className={BUTTON.quiet}
                    disabled={busy}
                    aria-label={t("reject_deletion_label", named)}
                    onClick={() =>
                      setStep({ kind: "decide_deletion", decision: "reject" })
                    }
                  >
                    {t("reject_deletion")}
                  </button>
                </>
              ) : null}
              {!deleted ? (
                <button
                  type="button"
                  className={BUTTON.quiet}
                  disabled={busy}
                  aria-label={t("make_admin_label", named)}
                  onClick={() => setStep({ kind: "make_admin" })}
                >
                  {t("make_admin")}
                </button>
              ) : null}
              {!tenant.purgedAt ? (
                <button
                  type="button"
                  className={BUTTON.quiet}
                  disabled={exporting}
                  aria-label={t("export_label", named)}
                  onClick={() => void exportData()}
                >
                  {exporting ? t("exporting") : t("export")}
                </button>
              ) : null}
            </div>
            {exporting ? <Reading text={t("exporting_status", named)} /> : null}
            <div className="space-y-2">
              <h4 className={`text-sm font-semibold ${TEXT.quiet}`}>{t("addresses")}</h4>
              {tenant.domains.length ? (
                <ul className="space-y-1 text-sm">
                  {tenant.domains.map((d) => (
                    <li key={d} className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="min-w-0 break-words">{d}</span>
                      <button
                        type="button"
                        className={BUTTON.link}
                        disabled={busy}
                        aria-label={t("remove_address", { host: d })}
                        onClick={() => setStep({ kind: "remove_address", host: d })}
                      >
                        {t("remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={`text-sm ${TEXT.faint}`}>{t("no_addresses")}</p>
              )}
              {!tenant.purgedAt ? (
                <button
                  type="button"
                  className={BUTTON.quiet}
                  disabled={busy}
                  aria-label={t("add_address_label", named)}
                  onClick={() => setStep({ kind: "add_address" })}
                >
                  {t("add_address")}
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </DetailPanel>
  );
}

/** The tenants whose purge time has passed: what Purge due removes. */
function dueForPurge(tenants: readonly TenantRow[], now: number): TenantRow[] {
  return tenants.filter(
    (x) =>
      x.status === "deleted" &&
      !x.purgedAt &&
      x.purgeAfter !== undefined &&
      Date.parse(x.purgeAfter) <= now
  );
}

/** Purge due's answer in words: each tenant purged by name, and its rows. */
function purgedText(body: CallBody, tenants: readonly TenantRow[]): string {
  const result = Array.isArray(body.result)
    ? (body.result as { tenantId?: unknown; rows?: unknown }[])
    : [];
  if (result.length === 0) return t("purge_none_done");
  const byId = new Map(tenants.map((x) => [x.id.toLowerCase(), x.name]));
  return t("purge_done", {
    count: result.length,
    tenants: result.map((r) =>
      t("purge_one", {
        tenant:
          (typeof r.tenantId === "string" && byId.get(r.tenantId.toLowerCase())) ||
          t("tenant_unlisted"),
        rows: typeof r.rows === "number" ? r.rows : 0,
      })
    ),
  });
}

export function OperatorTenantsView({
  data,
  hasPermission = () => false,
  onReload,
  viewerId,
  showIds = false,
}: SectionViewProps) {
  const { add, list } = useOutcomes(t("results_label"));
  const [openId, setOpenId] = useState<string | null>(null);
  // Asking: the tenants due when Purge due was chosen (the time read in the click, not a render).
  const [purging, setPurging] = useState<
    { phase: "no" } | { phase: "asking" | "busy"; due: readonly TenantRow[] }
  >({ phase: "no" });
  const purgeButton = useRef<HTMLButtonElement>(null);

  const tenants = (data as { tenants?: unknown } | undefined)?.tenants;
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(tenants))
    return <ListUnreadable panel={sectionTitle("tenants")} onRetry={onReload} />;
  const rows = [...(tenants as TenantRow[])].sort((a, b) => a.name.localeCompare(b.name));
  const open = rows.find((x) => x.id === openId) ?? null;

  const purge = async (due: readonly TenantRow[]) => {
    setPurging({ phase: "busy", due });
    const answer = await adminCall("/api/operator/purge", { method: "POST" });
    setPurging({ phase: "no" });
    add(
      answer.ok
        ? outcome("applied", purgedText(answer.body, rows), { action: t("purge_label") })
        : refusedOutcome(answer.refusal, { action: t("purge_label") })
    );
    if (answer.ok) onReload?.();
  };

  const columns: Column<TenantRow>[] = [
    {
      id: "tenant",
      header: t("col_tenant"),
      cell: (row) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-tenant-open={row.id}
            aria-label={t("open_tenant", { tenant: row.name })}
            className={BUTTON.link}
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(row.id);
            }}
          >
            {row.name}
          </button>
          <span className={`mt-1 block text-xs ${TEXT.faint}`}>{row.slug}</span>
        </span>
      ),
    },
    {
      id: "state",
      header: t("col_state"),
      cell: (row) => (
        <span>
          {tenantStateLabel(row.status)}
          {row.pendingDeletion ? (
            <span className="block text-xs text-red-300">{t("deletion_pending")}</span>
          ) : null}
          {row.purgeAfter && !row.purgedAt ? (
            <span className="block text-xs text-amber-300">
              {t("purged_after", { date: formatDate(row.purgeAfter) })}
            </span>
          ) : null}
        </span>
      ),
    },
    { id: "users", header: t("col_users"), value: (row) => String(row.userCount) },
    {
      id: "addresses",
      header: t("col_addresses"),
      secondary: true,
      value: (row) => (row.domains.length ? row.domains.join(", ") : t("no_addresses")),
    },
  ];

  return (
    <div className="min-w-0 space-y-6">
      {list}
      {open ? (
        <TenantDetail
          key={open.id}
          tenant={open}
          hasPermission={hasPermission}
          viewerId={viewerId}
          showIds={showIds}
          add={add}
          onReload={onReload}
          onClose={() => setOpenId(null)}
        />
      ) : (
        <>
          <ReadinessCard />
          <ProvisionCard add={add} onReload={onReload} />
          <Card id="tenants-heading" title={t("tenants_heading")}>
            {purging.phase === "no" ? (
              <button
                ref={purgeButton}
                type="button"
                className={BUTTON.quiet}
                onClick={() =>
                  setPurging({ phase: "asking", due: dueForPurge(rows, Date.now()) })
                }
              >
                {t("purge_due")}
              </button>
            ) : (
              <ConfirmStep
                action="tenancy.purge_due"
                title={t("confirm_purge")}
                confirmLabel={t("purge_due")}
                busy={purging.phase === "busy"}
                returnFocus={purgeButton}
                onCancel={() => setPurging({ phase: "no" })}
                onConfirm={() => void purge(purging.due)}
              >
                <p>
                  {purging.due.length
                    ? t("purge_which", { tenants: purging.due.map((x) => x.name) })
                    : t("purge_none_due")}
                </p>
              </ConfirmStep>
            )}
            <AdminTable
              caption={t("tenants_caption")}
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              onRowClick={(row) => setOpenId(row.id)}
              empty={t("tenants_none")}
            />
          </Card>
        </>
      )}
    </div>
  );
}

export type { TenantRow };
