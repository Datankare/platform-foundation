"use client";

/**
 * components/admin/DualControlKeysPanel.tsx — manage config.dual_control_keys (ADR-040 040c).
 *
 * Reads and edits the set of config keys that require an independent approver, through the
 * governed config path (POST /api/admin/config-ai/execute). Editing config.dual_control_keys
 * is itself dual-controlled: update_config raises it to `restricted`, so the change HOLDS and
 * its proposal lands in the Approvals queue for an independent approver — this panel surfaces
 * that. No key is edited directly; the hold is enforced server-side.
 */

import React, { useEffect, useState } from "react";
import { apiFetch } from "@/platform/auth/api-fetch";
import { readRefusal } from "@/platform/errors/refusal";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";

/** The panel's words, from the catalog (round 13, nit 6). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.dual_control.${key}`, values);

export interface ConfigAiResult {
  success?: boolean;
  held?: boolean;
  data?: {
    value?: unknown;
    applied?: boolean;
    pendingApproval?: boolean;
    proposalId?: string;
    /** Filed for two-person approval (a config approval, round 12 I-1); its id, its error. */
    requiresApproval?: boolean;
    approval?: { id?: string } | null;
    approvalError?: string;
  } | null;
  error?: string;
  /** A refusal's registry code (round 15, nit 4: a lost commit reads the list again). */
  code?: string;
}

/** Whether a reply says the change waits on another admin: a runtime hold, or a config approval. */
export function isPending(result: ConfigAiResult): boolean {
  return (
    result.held === true ||
    result.data?.pendingApproval === true ||
    (result.data?.requiresApproval === true && !result.data.approvalError)
  );
}

/**
 * What a reply of the config route says (round 11, item 1). A refusal (any status not ok) reads
 * as the shared handler words it, with its code — never a bare status, and never as pending,
 * whatever its body says (round 15, I-2: a refused filing kept `requiresApproval`). Otherwise the
 * tool's own result: a pending change (202: held, or filed for two-person approval — round 12,
 * I-1; `isPending`), or an applied one.
 */
export async function readConfigAiResult(res: Response): Promise<ConfigAiResult> {
  let body: unknown = null;
  try {
    body = await (typeof res.clone === "function" ? res.clone() : res).json();
  } catch {
    // Not JSON (a proxy's page): no held state; the refusal below says so.
  }
  const result = (body && typeof body === "object" ? body : {}) as ConfigAiResult;
  if (!res.ok) {
    const refused = await readRefusal(res);
    return { success: false, error: refused.message, code: refused.code };
  }
  return result;
}

async function callConfigAi(
  toolId: string,
  input: Record<string, unknown>
): Promise<ConfigAiResult> {
  const res = await apiFetch("/api/admin/config-ai/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolId, input }),
  });
  return readConfigAiResult(res);
}

function readKeys(): Promise<ConfigAiResult> {
  return callConfigAi("get_config", { key: "config.dual_control_keys" });
}

export function DualControlKeysPanel() {
  const [keys, setKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function showKeys(res: ConfigAiResult) {
    const value = res.data?.value;
    setKeys(Array.isArray(value) ? (value as string[]) : []);
    if (res.error) setError(res.error);
    setLoading(false);
  }

  // The first read; a response that arrives after unmount is dropped.
  useEffect(() => {
    let current = true;
    void readKeys().then((res) => {
      if (current) showKeys(res);
    });
    return () => {
      current = false;
    };
  }, []);

  async function commit(next: string[], change: string) {
    setBusy(true);
    setNotice(null);
    setError(null);
    const res = await callConfigAi("update_config", {
      key: "config.dual_control_keys",
      value: next,
      changeComment: change,
      confirmed: true,
    });
    // Waiting on another admin — a runtime hold, or two-person approval (round 12, I-1: it read
    // as "Change applied." with the list updated, though nothing had changed).
    if (isPending(res)) {
      const id = res.data?.proposalId ?? res.data?.approval?.id;
      setNotice(
        t("held", {
          id: id ?? "none",
          kind: res.data?.proposalId ? "proposal" : "approval",
        })
      );
    } else if (res.success === false || res.error) {
      setError(res.error ?? t("not_applied"));
      // The commit was lost: it may have applied (round 15, nit 4) — read the list again, so
      // what is shown is what it is.
      if (res.code === "admin.write_indeterminate") {
        const now = await readKeys();
        const value = now.data?.value;
        if (Array.isArray(value)) setKeys(value as string[]);
      }
    } else {
      setNotice(t("applied"));
      setKeys(next);
    }
    setBusy(false);
  }

  function add() {
    const k = newKey.trim();
    if (!k) return;
    if (keys.includes(k)) {
      setError(t("already", { key: k }));
      return;
    }
    setNewKey("");
    void commit([...keys, k], `Add ${k} to dual-control`);
  }

  function remove(k: string) {
    void commit(
      keys.filter((x) => x !== k),
      `Remove ${k} from dual-control`
    );
  }

  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 p-5">
      <p className="text-sm text-gray-400 mb-4">{t("intro")}</p>
      {notice ? (
        <p className="text-xs text-green-300 mb-3" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-amber-400 mb-3" role="alert">
          {error}
        </p>
      ) : null}
      {loading ? (
        <p className="text-sm text-gray-400">{t("loading")}</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {keys.map((k) => (
            <li
              key={k}
              className="flex items-center justify-between border-b border-gray-800/50 py-2"
            >
              <code className="text-xs text-gray-200">{k}</code>
              <button
                type="button"
                disabled={busy}
                onClick={() => remove(k)}
                aria-label={t("remove_label", { key: k })}
                className="px-2 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300 disabled:opacity-50"
              >
                {t("remove")}
              </button>
            </li>
          ))}
          {keys.length === 0 ? (
            <li className="text-sm text-gray-400">{t("empty")}</li>
          ) : null}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={t("add_placeholder")}
          aria-label={t("add_label")}
          className="flex-1 px-3 py-2 text-sm rounded bg-[#0a0f1e] border border-gray-800 text-gray-200"
        />
        <button
          type="button"
          disabled={busy || !newKey.trim()}
          onClick={add}
          className="px-3 py-2 text-sm rounded bg-green-800/40 border border-green-700 text-green-200 disabled:opacity-50"
        >
          {t("add")}
        </button>
      </div>
    </div>
  );
}
