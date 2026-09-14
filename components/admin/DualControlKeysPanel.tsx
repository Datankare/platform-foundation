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

interface ConfigAiResult {
  success?: boolean;
  held?: boolean;
  data?: {
    value?: unknown;
    applied?: boolean;
    pendingApproval?: boolean;
    proposalId?: string;
  } | null;
  error?: string;
}

async function callConfigAi(
  toolId: string,
  input: Record<string, unknown>
): Promise<ConfigAiResult> {
  const res = await fetch("/api/admin/config-ai/execute", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toolId, input }),
  });
  return (await res.json().catch(() => ({}))) as ConfigAiResult;
}

export function DualControlKeysPanel() {
  const [keys, setKeys] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKey, setNewKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    const res = await callConfigAi("get_config", { key: "config.dual_control_keys" });
    const value = res.data?.value;
    setKeys(Array.isArray(value) ? (value as string[]) : []);
    if (res.error) setError(res.error);
    setLoading(false);
  }

  useEffect(() => {
    void load();
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
    if (res.held || res.data?.pendingApproval) {
      const ref = res.data?.proposalId ? ` (proposal ${res.data.proposalId})` : "";
      setNotice(
        `Change held for approval${ref} — an independent approver must clear it in Approvals.`
      );
    } else if (res.success === false || res.error) {
      setError(res.error ?? "The change could not be applied.");
    } else {
      setNotice("Change applied.");
      setKeys(next);
    }
    setBusy(false);
  }

  function add() {
    const k = newKey.trim();
    if (!k) return;
    if (keys.includes(k)) {
      setError(`"${k}" is already dual-controlled.`);
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
      <p className="text-sm text-gray-400 mb-4">
        Keys that require an independent approver before a change applies. Editing this
        set is itself dual-controlled — changes here are held for approval.
      </p>
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
        <p className="text-sm text-gray-500">Loading…</p>
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
                aria-label={`Remove ${k}`}
                className="px-2 py-1 text-xs rounded bg-gray-800 border border-gray-700 text-gray-300 disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
          {keys.length === 0 ? (
            <li className="text-sm text-gray-500">No keys are dual-controlled.</li>
          ) : null}
        </ul>
      )}
      <div className="flex gap-2">
        <input
          type="text"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="config key to add (e.g. moderation.escalation_sla_hours)"
          aria-label="Config key to add to dual-control"
          className="flex-1 px-3 py-2 text-sm rounded bg-[#0a0f1e] border border-gray-800 text-gray-200"
        />
        <button
          type="button"
          disabled={busy || !newKey.trim()}
          onClick={add}
          className="px-3 py-2 text-sm rounded bg-green-800/40 border border-green-700 text-green-200 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}
