"use client";

/**
 * components/admin/DualControlKeysPanel.tsx — the settings under dual control
 * (config.dual_control_keys; ADR-040 040c; TASK-220)
 *
 * The settings whose changes wait for an independent approver. Changing this list is itself
 * dual-controlled: update_config raises it to `restricted`, so a change made here is held for a
 * second administrator, or refused — never applied at once (ALWAYS_DUAL_CONTROLLED,
 * platform/admin/config-handlers.ts).
 *
 * On the console's shared parts (TASK-220):
 *
 *   - the list is read with the settings (the console's read, PanelState): a failed read is said as
 *     one — never "No settings are dual-controlled", which read as an unprotected list
 *     (SF-admin-080); a request with no answer is a "Not done" outcome, and the buttons come back
 *     (SF-admin-081);
 *   - a held change is named — "Add Moderation: strike ban threshold to dual control" — with a link
 *     to Approvals, never the proposal's id (SF-admin-082);
 *   - a change already waiting in Approvals is marked on the list, so the same change is not
 *     asked twice (SF-admin-083); a waiting change a viewer may not see in full is said as one;
 *   - a setting is added from the settings themselves, found by name (SF-admin-084: typed by hand
 *     as a raw key);
 *   - adding and removing are offered only to an administrator who holds the list's own tier
 *     permission (E-66: shown to anyone who could open the section), each confirmed.
 *
 * @module components/admin
 */

import React, { useMemo, useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { handleRefusal } from "@/platform/errors/refusal";
import type { PendingApproval } from "@/platform/admin/pending-approvals";
import { listChange } from "./config-value";
import { editPermission, type SettingEntry } from "./PlatformConfigPanel";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { Field, Select, TextInput } from "@/components/admin/ui/Field";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { ReadFailed, usePanelRead } from "@/components/admin/ui/PanelState";
import { IdDetail } from "@/components/admin/ui/Ref";
import { SectionLink } from "@/components/admin/ui/SectionLink";
import { settingLabel } from "@/components/admin/ui/labels";
import { runConfigAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { useChange, useOutcomes } from "@/components/admin/views/kit";
import type { SectionViewProps } from "@/components/admin/section-views";

/** The panel's words, from the catalog (round 13, nit 6). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.dual_control.${key}`, values);

/** The setting that holds the list. */
export const DUAL_CONTROL_KEY = "config.dual_control_keys";

/** What waits in Approvals for the list: keys being added, keys being removed, any change. */
export interface PendingListChanges {
  readonly adding: ReadonlySet<string>;
  readonly removing: ReadonlySet<string>;
  /** A change to the list waits whose values this viewer is not shown. */
  readonly unseen: boolean;
}

/** The changes to the list that wait in Approvals (SF-admin-083). */
export function pendingListChanges(
  approvals: readonly PendingApproval[] | null
): PendingListChanges {
  const adding = new Set<string>();
  const removing = new Set<string>();
  let unseen = false;
  for (const a of approvals ?? []) {
    const key = a.change?.key ?? a.configKey;
    if (key !== DUAL_CONTROL_KEY) continue;
    const items = a.change ? listChange(a.change.before, a.change.after) : undefined;
    if (!items) {
      unseen = true;
      continue;
    }
    // listChange gives each item as JSON text for a non-string; the keys are strings.
    for (const k of items.added) adding.add(k);
    for (const k of items.removed) removing.add(k);
  }
  return { adding, removing, unseen };
}

type Row = { readonly key: string };

export function DualControlKeysPanel({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const entries: SettingEntry[] = useMemo(
    () => (Array.isArray(data?.entries) ? data.entries : []),
    [data]
  );
  const entry = entries.find((e) => e.key === DUAL_CONTROL_KEY) ?? null;
  const keys: string[] =
    entry && Array.isArray(entry.value)
      ? (entry.value as unknown[]).filter((k): k is string => typeof k === "string")
      : [];
  const approvals = usePanelRead("/api/admin/approvals");
  const pending = pendingListChanges(
    approvals.read.phase === "ready" && Array.isArray(approvals.read.body.approvals)
      ? (approvals.read.body.approvals as PendingApproval[])
      : null
  );
  const { add, list } = useOutcomes(t("results_label"));
  const reloadBoth = () => {
    onReload?.();
    approvals.reload();
  };
  const { busy, run } = useChange(add, reloadBoth);
  const [removing, setRemoving] = useState<string | null>(null);
  const removeOpener = useRef<HTMLButtonElement | null>(null);

  if (!entry)
    return (
      <ReadFailed
        panel={renderMessage("screens.admin_console.sections.dual-control")}
        refusal={handleRefusal(undefined, { message: t("missing") })}
        onRetry={onReload}
      />
    );
  const permission = editPermission(entry.permissionTier);
  const mayChange = hasPermission(permission);

  const change = (next: string[], what: string) =>
    void run(
      () =>
        runConfigAction("update_config", {
          key: DUAL_CONTROL_KEY,
          value: next,
          // No comment of the screen's own (TASK-209): the record keeps the list before and after.
          changeComment: "",
          confirmed: true,
        }),
      what,
      {
        heldNext: t("held_next"),
        heldDetail: <SectionLink section="approvals">{t("open_approvals")}</SectionLink>,
      }
    ).then((answer) => {
      // Held (the only way it is not refused): the list is unchanged, and its waiting change shows.
      if (answer.standing === "held") approvals.reload();
    });

  const columns: Column<Row>[] = [
    {
      id: "setting",
      header: t("col_setting"),
      sortBy: (r) => settingLabel(r.key),
      cell: (r) => (
        <span className="min-w-0 break-words">
          {settingLabel(r.key)} <IdDetail id={r.key} show={showIds} />
          {pending.removing.has(r.key) ? (
            <span className="block text-xs text-blue-200" data-pending="remove">
              {t("pending_remove")}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "change",
      header: t("col_change"),
      cell: (r) => (
        <GatedButton
          allowed={mayChange && !pending.removing.has(r.key)}
          reason={mayChange ? t("pending_remove") : needsPermission(permission)}
          disabled={busy}
          className={BUTTON.quiet}
          aria-label={t("remove_label", { setting: settingLabel(r.key) })}
          onClick={(e) => {
            removeOpener.current = e.currentTarget;
            setRemoving(r.key);
          }}
        >
          {t("remove")}
        </GatedButton>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <p className={`text-sm ${TEXT.faint}`}>{t("intro")}</p>
      {list}
      {approvals.read.phase === "failed" ? (
        <ReadFailed
          panel={renderMessage("screens.admin_console.sections.approvals")}
          refusal={approvals.read.refusal}
          onRetry={approvals.reload}
        />
      ) : null}
      {approvals.read.phase === "ready" &&
      Array.isArray(approvals.read.body.unreadable) &&
      approvals.read.body.unreadable.includes("runtime") ? (
        // The changes under dual control could not be read: what waits is not marked.
        <ReadFailed
          panel={renderMessage("screens.admin_console.sections.approvals")}
          refusal={handleRefusal("service.unavailable", {
            message: t("pending_unreadable"),
          })}
          onRetry={approvals.reload}
        />
      ) : null}
      {pending.unseen ? (
        <p className="text-sm text-blue-200">{t("pending_unseen")}</p>
      ) : null}
      {pending.adding.size ? (
        <p className="text-sm text-blue-200" data-pending="add">
          {t("pending_add", { settings: [...pending.adding].map(settingLabel) })}
        </p>
      ) : null}
      <AddSetting
        entries={entries}
        keys={keys}
        pendingAdd={pending.adding}
        allowed={mayChange}
        reason={needsPermission(permission)}
        busy={busy}
        onAdd={(key) =>
          change([...keys, key], t("what_add", { setting: settingLabel(key) }))
        }
      />
      {removing ? (
        <ConfirmStep
          action="dual_control.remove"
          title={t("confirm_remove", { setting: settingLabel(removing) })}
          confirmLabel={t("remove")}
          returnFocus={removeOpener}
          busy={busy}
          onCancel={() => setRemoving(null)}
          onConfirm={() => {
            const key = removing;
            setRemoving(null);
            change(
              keys.filter((k) => k !== key),
              t("what_remove", { setting: settingLabel(key) })
            );
          }}
        />
      ) : null}
      <AdminTable
        caption={t("caption")}
        columns={columns}
        rows={[...keys]
          .sort((a, b) => settingLabel(a).localeCompare(settingLabel(b)))
          .map((key) => ({ key }))}
        rowKey={(r) => r.key}
        empty={t("empty")}
      />
    </div>
  );
}

/** A setting added from the settings themselves, found by name (SF-admin-084). */
function AddSetting({
  entries,
  keys,
  pendingAdd,
  allowed,
  reason,
  busy,
  onAdd,
}: {
  readonly entries: readonly SettingEntry[];
  readonly keys: readonly string[];
  readonly pendingAdd: ReadonlySet<string>;
  readonly allowed: boolean;
  readonly reason: string;
  readonly busy: boolean;
  readonly onAdd: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const [chosen, setChosen] = useState("");
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const needle = find.trim().toLowerCase();
  const offered = entries
    .filter((e) => !keys.includes(e.key) && !pendingAdd.has(e.key))
    .filter(
      (e) =>
        !needle ||
        settingLabel(e.key).toLowerCase().includes(needle) ||
        e.key.toLowerCase().includes(needle)
    )
    .sort((a, b) => settingLabel(a.key).localeCompare(settingLabel(b.key)));
  if (!open)
    return (
      <GatedButton
        allowed={allowed}
        reason={reason}
        className={BUTTON.primary}
        onClick={() => setOpen(true)}
      >
        {t("add")}
      </GatedButton>
    );
  if (asking && chosen)
    return (
      <ConfirmStep
        action="dual_control.add"
        title={t("confirm_add", { setting: settingLabel(chosen) })}
        confirmLabel={t("add_confirm")}
        returnFocus={opener}
        busy={busy}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          setOpen(false);
          onAdd(chosen);
          setChosen("");
        }}
      />
    );
  return (
    <form
      noValidate
      aria-label={t("add_title")}
      className={`${SURFACE.panel} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!chosen) return setProblem(t("choose"));
        setProblem(null);
        setAsking(true);
      }}
    >
      <Field label={t("find_label")} help={t("find_help")}>
        {(control) => (
          <TextInput
            {...control}
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("choose_label")} error={problem}>
        {(control) => (
          <Select {...control} value={chosen} onChange={(e) => setChosen(e.target.value)}>
            <option value="">{t("choose_none", { count: offered.length })}</option>
            {offered.map((e) => (
              <option key={e.key} value={e.key}>
                {settingLabel(e.key)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary} disabled={busy} ref={opener}>
          {t("review")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={() => setOpen(false)}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}
