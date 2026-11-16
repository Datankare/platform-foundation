"use client";

/**
 * components/admin/TrustedAgentsPanel.tsx — the Trusted agents screen, with its forms
 * (TASK-202, N-66; TASK-220)
 *
 * An admin who holds admin_manage_agents (the actions' own permission) registers an agent, changes
 * its scope or its token ceiling, and suspends or reactivates it — each through the governed
 * command-bar path (POST /api/admin/ai/execute with one action: register_agent, set_agent_scope,
 * set_agent_ttl, suspend_agent). Those are config writes to agent.trusted_agents, held by the
 * key's own rules (dual control). Each change is sent alone, so a hold never stops a second
 * change half-way.
 *
 * On the console's shared parts (TASK-220):
 *
 *   - the one table, in the agents' order by name (it was the stored order); an agent's status by
 *     name — an unknown status said to be unknown, never read as "Active" (SF-admin-132); its
 *     scope by capability name; a ceiling not set says the platform's default (a literal dash
 *     before, SF-admin-134);
 *   - an agent's detail beside the list, with one change open at a time — the scope, the ceiling,
 *     or the suspension's confirm step, which takes focus and gives it back (SF-admin-131);
 *   - the scope chosen from the capabilities the capability map knows, by name (SF-admin-130: typed
 *     by hand as codes); a scope the map no longer knows is shown and can be taken away;
 *   - every field's help tied to it (SF-admin-133); a refusal always says why (SF-admin-134: an
 *     empty reason read "…: ");
 *   - an admin without the permission sees the changes disabled, and why, by the permission's name.
 *
 * @module components/admin
 */

import React, { useId, useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { Checkbox, Field, FormProblem, TextInput } from "@/components/admin/ui/Field";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import {
  agentStatusLabel,
  capabilityLabel,
  ownerLabel,
} from "@/components/admin/ui/labels";
import { runAdminAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import {
  NewBadge,
  useChange,
  useNewKeys,
  useOutcomes,
  ListUnreadable,
  elementWith,
} from "@/components/admin/views/kit";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.agents.${key}`, values);

/** The permission the agent actions need (ADMIN_TOOL_PERMISSIONS). */
export const AGENTS_PERMISSION = "admin_manage_agents";

interface AgentRecord {
  readonly owner?: string;
  readonly scopes?: readonly string[];
  readonly status?: string;
  readonly maxTokenTtl?: number;
}
type Pair = readonly [string, AgentRecord];
type Run = ReturnType<typeof useChange>["run"];

/** A change read back before it is sent: each is consequential (the registry's word). */
interface Asking {
  readonly action: "register_agent" | "set_agent_scope" | "set_agent_ttl";
  readonly title: string;
  readonly confirm: string;
  readonly lines: readonly string[];
  readonly send: () => ReturnType<typeof runAdminAction>;
  readonly what: string;
}

/** The confirm step of an asked change: what it changes, from → to, in words. */
function AskStep({
  asking,
  busy,
  run,
  onCancel,
  onDone,
}: {
  readonly asking: Asking;
  readonly busy: boolean;
  readonly run: Run;
  readonly onCancel: () => void;
  readonly onDone: (answer: { standing: string }) => void;
}) {
  return (
    <ConfirmStep
      action={asking.action}
      title={asking.title}
      confirmLabel={asking.confirm}
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => void run(asking.send, asking.what).then(onDone)}
    >
      <ul className="space-y-1" data-agent-change="true">
        {asking.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </ConfirmStep>
  );
}

/** A token ceiling as typed: a whole number of seconds above zero, else null. */
export function parseTtl(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

/** An agent is named by what it was registered as: its id is its name. */
const agentName = (id: string) => id;

const scopeText = (scopes: readonly string[] | undefined) =>
  scopes?.length ? t("scopes", { scopes: scopes.map(capabilityLabel) }) : t("no_scope");

const ttlText = (ttl: number | undefined) =>
  ttl ? t("ttl", { seconds: ttl }) : t("ttl_default");

/** Capabilities to choose from, by name: the map's, and any the agent holds the map lacks. */
function ScopePicker({
  known,
  chosen,
  onChange,
  busy,
}: {
  readonly known: readonly string[] | null;
  readonly chosen: ReadonlySet<string>;
  readonly onChange: (next: Set<string>) => void;
  readonly busy: boolean;
}) {
  const helpId = useId();
  const options = [...new Set([...(known ?? []), ...chosen])].sort((a, b) =>
    capabilityLabel(a).localeCompare(capabilityLabel(b))
  );
  return (
    <fieldset className="min-w-0 space-y-1" aria-describedby={helpId}>
      <legend className={`text-xs font-medium ${TEXT.quiet}`}>{t("field_scope")}</legend>
      <p id={helpId} className={`text-xs ${TEXT.faint}`}>
        {known === null
          ? t("scope_unknown")
          : known.length
            ? t("field_scope_help")
            : t("scope_none_mapped")}
      </p>
      {options.map((c) => (
        <Checkbox
          key={c}
          label={
            known && !known.includes(c)
              ? t("scope_unmapped", { capability: capabilityLabel(c) })
              : capabilityLabel(c)
          }
          checked={chosen.has(c)}
          disabled={busy}
          onChange={(e) => {
            const next = new Set(chosen);
            if (e.target.checked) next.add(c);
            else next.delete(c);
            onChange(next);
          }}
          className={`text-sm ${TEXT.body}`}
        />
      ))}
    </fieldset>
  );
}

function TtlField({
  value,
  onChange,
  problem,
  busy,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly problem: string | null;
  readonly busy: boolean;
}) {
  return (
    <Field label={t("field_ttl")} help={t("field_ttl_help")} error={problem}>
      {(control) => (
        <TextInput
          {...control}
          inputMode="numeric"
          value={value}
          disabled={busy}
          onChange={(e) => onChange(e.target.value)}
          className="max-w-xs"
        />
      )}
    </Field>
  );
}

type Mode = "scope" | "ttl" | "suspend" | null;

/** One agent's changes: one open at a time (SF-admin-131). */
function AgentChanges({
  id,
  rec,
  known,
  run,
  busy,
}: {
  readonly id: string;
  readonly rec: AgentRecord;
  readonly known: readonly string[] | null;
  readonly run: Run;
  readonly busy: boolean;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(rec.scopes ?? []));
  const [ttl, setTtl] = useState(rec.maxTokenTtl ? String(rec.maxTokenTtl) : "");
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const suspendButton = useRef<HTMLButtonElement>(null);
  const suspended = rec.status === "suspended";
  const done = (answer: { standing: string }) => {
    setAsking(null);
    if (answer.standing !== "refused") setMode(null);
  };
  if (asking)
    return (
      <AskStep
        asking={asking}
        busy={busy}
        run={run}
        onCancel={() => setAsking(null)}
        onDone={done}
      />
    );
  if (mode === "suspend")
    return (
      <ConfirmStep
        action="suspend_agent"
        input={suspended ? { reactivate: true } : {}}
        title={
          suspended
            ? t("confirm_reactivate", { agent: agentName(id) })
            : t("confirm_suspend", { agent: agentName(id) })
        }
        confirmLabel={suspended ? t("reactivate") : t("suspend")}
        returnFocus={suspendButton}
        busy={busy}
        onCancel={() => setMode(null)}
        onConfirm={() =>
          void run(
            () =>
              runAdminAction("suspend_agent", {
                agent_id: id,
                ...(suspended ? { reactivate: true } : {}),
              }),
            suspended
              ? t("what_reactivate", { agent: agentName(id) })
              : t("what_suspend", { agent: agentName(id) })
          ).then(() => setMode(null))
        }
      />
    );
  if (mode === "scope")
    return (
      <form
        noValidate
        aria-label={t("scope_title", { agent: agentName(id) })}
        className={`${SURFACE.inset} space-y-3 p-3`}
        onSubmit={(e) => {
          e.preventDefault();
          const list = [...chosen];
          if ([...list].sort().join() === [...(rec.scopes ?? [])].sort().join())
            return setProblem(t("nothing_changed"));
          setProblem(null);
          setAsking({
            action: "set_agent_scope",
            title: t("confirm_scope", { agent: agentName(id) }),
            confirm: t("submit_edit"),
            lines: [
              t("from", { value: scopeText(rec.scopes) }),
              t("to", { value: scopeText(list) }),
            ],
            send: () => runAdminAction("set_agent_scope", { agent_id: id, scopes: list }),
            what: t("what_scope", { agent: agentName(id), scopes: scopeText(list) }),
          });
        }}
      >
        <ScopePicker known={known} chosen={chosen} onChange={setChosen} busy={busy} />
        <FormProblem problem={problem} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BUTTON.primary} disabled={busy}>
            {t("submit_edit")}
          </button>
          <button type="button" className={BUTTON.quiet} onClick={() => setMode(null)}>
            {t("cancel")}
          </button>
        </div>
      </form>
    );
  if (mode === "ttl")
    return (
      <form
        noValidate
        aria-label={t("ttl_title", { agent: agentName(id) })}
        className={`${SURFACE.inset} space-y-3 p-3`}
        onSubmit={(e) => {
          e.preventDefault();
          const seconds = parseTtl(ttl);
          if (seconds === null) return setProblem(t("ttl_invalid"));
          if (seconds === rec.maxTokenTtl) return setProblem(t("nothing_changed"));
          setProblem(null);
          setAsking({
            action: "set_agent_ttl",
            title: t("confirm_ttl", { agent: agentName(id) }),
            confirm: t("submit_edit"),
            lines: [
              t("from", { value: ttlText(rec.maxTokenTtl) }),
              t("to", { value: ttlText(seconds) }),
            ],
            send: () =>
              runAdminAction("set_agent_ttl", { agent_id: id, max_token_ttl: seconds }),
            what: t("what_ttl", { agent: agentName(id), seconds }),
          });
        }}
      >
        <TtlField value={ttl} onChange={setTtl} problem={problem} busy={busy} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={BUTTON.primary} disabled={busy}>
            {t("submit_edit")}
          </button>
          <button type="button" className={BUTTON.quiet} onClick={() => setMode(null)}>
            {t("cancel")}
          </button>
        </div>
      </form>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={BUTTON.quiet} onClick={() => setMode("scope")}>
        {t("change_scope")}
      </button>
      <button type="button" className={BUTTON.quiet} onClick={() => setMode("ttl")}>
        {t("change_ttl")}
      </button>
      <button
        type="button"
        ref={suspendButton}
        className={suspended ? BUTTON.primary : BUTTON.danger}
        onClick={() => setMode("suspend")}
        aria-label={
          suspended
            ? t("reactivate_label", { agent: agentName(id) })
            : t("suspend_label", { agent: agentName(id) })
        }
      >
        {suspended ? t("reactivate") : t("suspend")}
      </button>
    </div>
  );
}

function RegisterAgent({
  known,
  run,
  busy,
  onDone,
}: {
  readonly known: readonly string[] | null;
  readonly run: Run;
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [id, setId] = useState("");
  const [owner, setOwner] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [ttl, setTtl] = useState("");
  const [problems, setProblems] = useState<{ id?: string; ttl?: string }>({});
  const [asking, setAsking] = useState<Asking | null>(null);
  if (asking)
    return (
      <AskStep
        asking={asking}
        busy={busy}
        run={run}
        onCancel={() => setAsking(null)}
        onDone={(answer) => {
          setAsking(null);
          if (answer.standing !== "refused") onDone();
        }}
      />
    );
  return (
    <form
      noValidate
      aria-label={t("register_title")}
      className={`${SURFACE.panel} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        const seconds = ttl.trim() === "" ? undefined : parseTtl(ttl);
        const bad = {
          ...(id.trim() === "" ? { id: t("id_missing") } : {}),
          ...(seconds === null ? { ttl: t("ttl_invalid") } : {}),
        };
        setProblems(bad);
        if (Object.keys(bad).length) return;
        const scopes = [...chosen];
        setAsking({
          action: "register_agent",
          title: t("confirm_register", { agent: id.trim() }),
          confirm: t("submit_register"),
          lines: [
            t("line_owner", { owner: owner.trim() || t("owner_default") }),
            t("line_scope", { value: scopeText(scopes) }),
            t("line_ttl", { value: ttlText(seconds ?? undefined) }),
          ],
          send: () =>
            runAdminAction("register_agent", {
              agent_id: id.trim(),
              ...(owner.trim() ? { owner: owner.trim() } : {}),
              scopes,
              ...(seconds !== undefined ? { max_token_ttl: seconds } : {}),
            }),
          what: t("what_register", { agent: id.trim() }),
        });
      }}
    >
      <h3 className={`text-sm font-semibold ${TEXT.strong}`}>{t("register_title")}</h3>
      <Field label={t("field_id")} help={t("field_id_help")} error={problems.id}>
        {(control) => (
          <TextInput
            {...control}
            value={id}
            disabled={busy}
            autoCapitalize="none"
            onChange={(e) => setId(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("field_owner")} help={t("field_owner_help")}>
        {(control) => (
          <TextInput
            {...control}
            value={owner}
            disabled={busy}
            onChange={(e) => setOwner(e.target.value)}
          />
        )}
      </Field>
      <ScopePicker known={known} chosen={chosen} onChange={setChosen} busy={busy} />
      <TtlField
        value={ttl}
        onChange={setTtl}
        problem={problems.ttl ?? null}
        busy={busy}
      />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary} disabled={busy}>
          {t("submit_register")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

export function TrustedAgentsPanel({
  data,
  hasPermission = () => false,
  onReload,
}: Partial<SectionViewProps> & { readonly data: SectionViewProps["data"] }) {
  const pairs: Pair[] = Array.isArray(data?.agents)
    ? [...(data.agents as Pair[])].sort((a, b) => a[0].localeCompare(b[0]))
    : [];
  const known: string[] | null = Array.isArray(data?.capabilities)
    ? data.capabilities
    : null;
  const mayChange = hasPermission(AGENTS_PERMISSION);
  const fresh = useNewKeys(
    data,
    pairs.map(([id]) => id)
  );
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [openId, setOpenId] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const open = pairs.find(([id]) => id === openId) ?? null;
  const columns: Column<Pair>[] = [
    {
      id: "agent",
      header: t("col_agent"),
      sortBy: ([id]) => id,
      cell: ([id]) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-agent-open={id}
            aria-expanded={openId === id}
            className={BUTTON.link}
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(id);
            }}
          >
            {agentName(id)}
          </button>
          {fresh.has(id) ? <NewBadge /> : null}
        </span>
      ),
    },
    {
      id: "owner",
      header: t("col_owner"),
      secondary: true,
      value: ([, r]) => ownerLabel(r.owner ?? "first-party"),
    },
    { id: "scope", header: t("col_scope"), value: ([, r]) => scopeText(r.scopes) },
    {
      id: "status",
      header: t("col_status"),
      value: ([, r]) => agentStatusLabel(r.status),
    },
    {
      id: "ttl",
      header: t("col_ttl"),
      secondary: true,
      value: ([, r]) => ttlText(r.maxTokenTtl),
    },
  ];
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.agents))
    return <ListUnreadable panel={sectionTitle("agent-registry")} onRetry={onReload} />;
  return (
    <div className="space-y-4">
      <p className={`text-sm ${TEXT.faint}`}>{t("intro")}</p>
      {list}
      {registering ? (
        <RegisterAgent
          known={known}
          run={run}
          busy={busy}
          onDone={() => setRegistering(false)}
        />
      ) : (
        <GatedButton
          allowed={mayChange}
          reason={needsPermission(AGENTS_PERMISSION)}
          className={BUTTON.primary}
          onClick={() => setRegistering(true)}
        >
          {t("register")}
        </GatedButton>
      )}
      <DetailLayout
        detail={
          open ? (
            <DetailPanel
              key={open[0]}
              title={agentName(open[0])}
              onClose={() => setOpenId(null)}
              returnFocus={() => elementWith("data-agent-open", open[0])}
            >
              <div className="space-y-4">
                <DetailFacts
                  facts={[
                    [t("col_owner"), ownerLabel(open[1].owner ?? "first-party")],
                    [t("col_scope"), scopeText(open[1].scopes)],
                    [t("col_status"), agentStatusLabel(open[1].status)],
                    [t("col_ttl"), ttlText(open[1].maxTokenTtl)],
                  ]}
                />
                {mayChange ? (
                  <AgentChanges
                    id={open[0]}
                    rec={open[1]}
                    known={known}
                    run={run}
                    busy={busy}
                  />
                ) : (
                  <p className={`text-sm ${TEXT.quiet}`}>
                    {needsPermission(AGENTS_PERMISSION)}
                  </p>
                )}
              </div>
            </DetailPanel>
          ) : null
        }
      >
        <AdminTable
          caption={t("caption")}
          columns={columns}
          rows={pairs}
          rowKey={([id]) => id}
          empty={t("empty")}
          compact={open !== null}
          selectedKey={openId}
          onRowClick={([id]) => setOpenId(id)}
        />
      </DetailLayout>
    </div>
  );
}
