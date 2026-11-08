"use client";

/**
 * components/admin/TrustedAgentsPanel.tsx — the Trusted agents screen, with its forms
 * (TASK-202, N-66)
 *
 * The screen listed the registry and offered no form: a change needed a typed request to the
 * command bar. Now an admin who holds admin_manage_agents (the actions' own permission) registers
 * an agent, changes its scope or its token ceiling, and suspends or reactivates it — each through
 * the governed command-bar path (POST /api/admin/ai/execute with one action: register_agent,
 * set_agent_scope, set_agent_ttl, suspend_agent). Those are config writes to
 * agent.trusted_agents, held by the key's own rules (dual control): the screen says "Applied" or
 * "Held for approval by …", and the result stays until dismissed. Each change is sent alone (an
 * edit changes the scope or the ceiling, not both at once), so a hold never stops a second change
 * half-way.
 *
 * Not read yet, or not readable, is never shown as "no agents" (review 14 L-1).
 *
 * @module components/admin
 */

import React, { useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { isErrorCode, messageKey, type ErrorCode } from "@/platform/errors/registry";
import { networkRefusal, readRefusal } from "@/platform/errors/refusal";
import { isPanelUnavailable, PanelUnavailable } from "./PanelUnavailable";
import { ResultList, result, type ShownResult } from "./ResultList";
import { ExpandableText } from "./ExpandableText";

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

/** One action's answer, as POST /api/admin/ai/execute returns it. */
interface ActionAnswer {
  readonly success?: boolean;
  readonly held?: boolean;
  readonly code?: string;
  readonly params?: Readonly<Record<string, string | number>>;
  readonly error?: string;
}

/** A list typed as lines or commas, each trimmed, empty ones dropped, each once. */
export function parseList(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

/** A token ceiling as typed: a whole number of seconds above zero, else null. */
export function parseTtl(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isInteger(n) && n > 0 ? n : null;
}

/** The reason an action was not done, in the catalog's words. */
function reasonOf(a: ActionAnswer): string {
  return a.code && isErrorCode(a.code)
    ? renderMessage(
        messageKey(a.code as ErrorCode),
        a.params ? { ...a.params } : undefined
      )
    : (a.error ?? "");
}

/** Run one agent action on the governed path; what it did, as a result naming `what`. */
async function runAction(
  tool: string,
  input: Record<string, unknown>,
  what: string
): Promise<{ readonly shown: ShownResult; readonly applied: boolean }> {
  try {
    const res = await apiFetch("/api/admin/ai/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actions: [{ tool, input }] }),
    });
    if (!res.ok) {
      const refused = await readRefusal(res);
      return {
        shown: result("refused", t("refused", { what, reason: refused.message })),
        applied: false,
      };
    }
    const body = (await res.json().catch(() => ({}))) as { results?: ActionAnswer[] };
    const answer = body.results?.[0] ?? {};
    if (answer.success === true)
      return { shown: result("applied", t("applied", { what })), applied: true };
    if (answer.held === true)
      return {
        shown: result("held", t("held", { what, approver: t("approver") })),
        applied: false,
      };
    return {
      shown: result("refused", t("refused", { what, reason: reasonOf(answer) })),
      applied: false,
    };
  } catch {
    return {
      shown: result("refused", t("refused", { what, reason: networkRefusal().message })),
      applied: false,
    };
  }
}

const th =
  "text-xs text-gray-400 uppercase tracking-wider py-2 px-3 border-b border-gray-800 text-left";
const td = "py-2 px-3 border-b border-gray-800/50 align-top text-gray-300";
const field =
  "w-full rounded border border-gray-700 bg-[#0a0f1e] px-3 py-2 text-sm text-gray-100";
const btn = "rounded px-3 py-1.5 text-xs border disabled:opacity-50 whitespace-nowrap";

/* eslint-disable @typescript-eslint/no-explicit-any */
export function TrustedAgentsPanel({
  data,
  hasPermission = () => false,
}: {
  readonly data: any;
  readonly hasPermission?: (code: string) => boolean;
}) {
  const [fresh, setFresh] = useState<Pair[] | null>(null);
  const [results, setResults] = useState<ShownResult[]>([]);
  const [registering, setRegistering] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mayChange = hasPermission(AGENTS_PERMISSION);

  // A new read from the page replaces any read made here.
  const [shownData, setShownData] = useState(data);
  if (data !== shownData) {
    setShownData(data);
    setFresh(null);
  }

  const state =
    data === undefined
      ? "loading"
      : isPanelUnavailable(data) || !Array.isArray(data?.agents)
        ? "unavailable"
        : "ready";
  const pairs: Pair[] = fresh ?? (state === "ready" ? data.agents : []);

  async function reread() {
    try {
      const res = await apiFetch("/api/admin/agent-registry");
      if (!res.ok) return;
      const body = (await res.json()) as { agents?: Pair[] };
      if (Array.isArray(body.agents)) setFresh(body.agents);
    } catch {
      // The list stays; the result says what happened.
    }
  }

  async function act(tool: string, input: Record<string, unknown>, what: string) {
    setBusy(true);
    const { shown, applied } = await runAction(tool, input, what);
    setResults((rs) => [shown, ...rs]);
    if (applied) await reread();
    setBusy(false);
    return shown.kind !== "refused";
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-400">{t("intro")}</p>
      <ResultList
        results={results}
        label={t("results_label")}
        onDismiss={(id) => setResults((rs) => rs.filter((r) => r.id !== id))}
      />
      {!mayChange ? (
        <p className="text-sm text-amber-200">
          {t("cannot_edit", { permission: AGENTS_PERMISSION })}
        </p>
      ) : registering ? (
        <AgentForm
          mode="register"
          busy={busy}
          onCancel={() => setRegistering(false)}
          onSubmit={async (input, what) => {
            if (await act("register_agent", input, what)) setRegistering(false);
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => setRegistering(true)}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white"
        >
          {t("register")}
        </button>
      )}

      {state === "loading" ? (
        <p className="text-sm text-gray-400">
          {renderMessage("screens.admin_console.loading")}
        </p>
      ) : state === "unavailable" ? (
        <PanelUnavailable
          panel={renderMessage("screens.admin_console.sections.agent-registry")}
        />
      ) : pairs.length === 0 ? (
        <p className="text-sm text-gray-400">
          {renderMessage("screens.admin_console.no_agents")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-800 bg-[#111827]">
          <table className="w-full min-w-[36rem] border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className={th}>
                  {t("col_agent")}
                </th>
                <th scope="col" className={th}>
                  {t("col_owner")}
                </th>
                <th scope="col" className={th}>
                  {t("col_scope")}
                </th>
                <th scope="col" className={th}>
                  {t("col_status")}
                </th>
                <th scope="col" className={th}>
                  {t("col_ttl")}
                </th>
                {mayChange ? (
                  <th scope="col" className={th}>
                    {t("col_actions")}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {pairs.map(([id, rec]) => {
                const suspended = rec.status === "suspended";
                return (
                  <React.Fragment key={id}>
                    <tr>
                      <td className={`${td} break-all font-mono text-xs text-gray-200`}>
                        {id}
                      </td>
                      <td className={`${td} break-words`}>{rec.owner}</td>
                      <td className={td}>
                        <ExpandableText
                          text={(rec.scopes ?? []).join(", ") || t("no_scope")}
                          column={t("col_scope")}
                        />
                      </td>
                      <td className={td}>
                        <span className={suspended ? "text-red-400" : "text-green-400"}>
                          {suspended ? t("status_suspended") : t("status_active")}
                        </span>
                      </td>
                      <td className={td}>
                        {rec.maxTokenTtl ? t("ttl", { seconds: rec.maxTokenTtl }) : "—"}
                      </td>
                      {mayChange ? (
                        <td className={td}>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={t("edit_label", { agent: id })}
                              onClick={() => setEditing(editing === id ? null : id)}
                              className={`${btn} border-gray-700 bg-gray-800 text-gray-200`}
                            >
                              {t("edit")}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              aria-label={
                                suspended
                                  ? t("reactivate_label", { agent: id })
                                  : t("suspend_label", { agent: id })
                              }
                              onClick={() => setConfirming(id)}
                              className={`${btn} ${
                                suspended
                                  ? "border-green-700 bg-green-900/40 text-green-200"
                                  : "border-red-700 bg-red-900/40 text-red-200"
                              }`}
                            >
                              {suspended ? t("reactivate") : t("suspend")}
                            </button>
                          </div>
                        </td>
                      ) : null}
                    </tr>
                    {confirming === id ? (
                      <tr>
                        <td colSpan={6} className={td}>
                          <div role="group" className="space-y-2" data-confirm="true">
                            <p className="text-sm text-gray-200">
                              {suspended
                                ? t("confirm_reactivate", { agent: id })
                                : t("confirm_suspend", { agent: id })}
                            </p>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                disabled={busy}
                                onClick={async () => {
                                  await act(
                                    "suspend_agent",
                                    {
                                      agent_id: id,
                                      ...(suspended ? { reactivate: true } : {}),
                                    },
                                    suspended
                                      ? t("what_reactivate", { agent: id })
                                      : t("what_suspend", { agent: id })
                                  );
                                  setConfirming(null);
                                }}
                                className={`${btn} border-blue-600 bg-blue-600 text-white`}
                              >
                                {t("confirm")}
                              </button>
                              <button
                                type="button"
                                onClick={() => setConfirming(null)}
                                className={`${btn} border-gray-700 bg-gray-800 text-gray-200`}
                              >
                                {t("cancel")}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {editing === id ? (
                      <tr>
                        <td colSpan={6} className={td}>
                          <AgentForm
                            mode="edit"
                            agentId={id}
                            record={rec}
                            busy={busy}
                            onCancel={() => setEditing(null)}
                            onSubmit={async (input, what, tool) => {
                              if (await act(tool ?? "set_agent_scope", input, what))
                                setEditing(null);
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** The register form, or an agent's edit form (scope and token ceiling, each saved alone). */
function AgentForm({
  mode,
  agentId,
  record,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly mode: "register" | "edit";
  readonly agentId?: string;
  readonly record?: AgentRecord;
  readonly busy: boolean;
  readonly onSubmit: (
    input: Record<string, unknown>,
    what: string,
    tool?: string
  ) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const [id, setId] = useState("");
  const [owner, setOwner] = useState("");
  const [scopes, setScopes] = useState((record?.scopes ?? []).join(", "));
  const [ttl, setTtl] = useState(record?.maxTokenTtl ? String(record.maxTokenTtl) : "");
  const [problem, setProblem] = useState<string | null>(null);
  const prefix = mode === "register" ? "agent-new" : `agent-${agentId}`;

  async function submit() {
    setProblem(null);
    const list = parseList(scopes);
    if (mode === "register") {
      if (id.trim() === "") return setProblem(t("id_missing"));
      const seconds = ttl.trim() === "" ? undefined : parseTtl(ttl);
      if (seconds === null) return setProblem(t("ttl_invalid"));
      await onSubmit(
        {
          agent_id: id.trim(),
          ...(owner.trim() ? { owner: owner.trim() } : {}),
          scopes: list,
          ...(seconds !== undefined ? { max_token_ttl: seconds } : {}),
        },
        t("what_register", { agent: id.trim() })
      );
      return;
    }
    // Edit: the scope and the ceiling, each its own change — only what differs is sent.
    const scopeChanged =
      JSON.stringify(list) !== JSON.stringify([...(record?.scopes ?? [])]);
    const seconds = parseTtl(ttl);
    if (ttl.trim() !== "" && seconds === null) return setProblem(t("ttl_invalid"));
    const ttlChanged = seconds !== null && seconds !== record?.maxTokenTtl;
    if (!scopeChanged && !ttlChanged) return setProblem(t("nothing_changed"));
    // One change at a time: each is held and approved on its own, and a second change to the
    // registry is refused while the first waits.
    if (scopeChanged && ttlChanged) return setProblem(t("one_at_a_time"));
    if (scopeChanged)
      await onSubmit(
        { agent_id: agentId, scopes: list },
        t("what_scope", {
          agent: agentId ?? "",
          scopes: list.length ? list.join(", ") : t("no_scope"),
        }),
        "set_agent_scope"
      );
    else
      await onSubmit(
        { agent_id: agentId, max_token_ttl: seconds },
        t("what_ttl", { agent: agentId ?? "", seconds: seconds ?? 0 }),
        "set_agent_ttl"
      );
  }

  return (
    <form
      noValidate
      className="space-y-3 rounded-xl border border-blue-900 bg-[#0f172a] p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-semibold text-white">
        {mode === "register"
          ? t("register_title")
          : t("edit_title", { agent: agentId ?? "" })}
      </h3>
      {mode === "register" ? (
        <>
          <Field id={`${prefix}-id`} label={t("field_id")} help={t("field_id_help")}>
            <input
              id={`${prefix}-id`}
              value={id}
              onChange={(e) => setId(e.target.value)}
              className={field}
              required
            />
          </Field>
          <Field
            id={`${prefix}-owner`}
            label={t("field_owner")}
            help={t("field_owner_help")}
          >
            <input
              id={`${prefix}-owner`}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className={field}
            />
          </Field>
        </>
      ) : null}
      <Field id={`${prefix}-scope`} label={t("field_scope")} help={t("field_scope_help")}>
        <textarea
          id={`${prefix}-scope`}
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          rows={2}
          className={field}
        />
      </Field>
      <Field id={`${prefix}-ttl`} label={t("field_ttl")} help={t("field_ttl_help")}>
        <input
          id={`${prefix}-ttl`}
          type="number"
          min={1}
          step={1}
          inputMode="numeric"
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
          className={`${field} max-w-xs`}
        />
      </Field>
      {problem ? (
        <p className="text-sm text-amber-300" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy
            ? t("submitting")
            : mode === "register"
              ? t("submit_register")
              : t("submit_edit")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="text-sm text-gray-300 underline"
        >
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  help,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly help: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm text-gray-300">
        {label}
      </label>
      {children}
      <p className="mt-1 text-xs text-gray-400">{help}</p>
    </div>
  );
}
