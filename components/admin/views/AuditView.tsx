"use client";

/**
 * components/admin/views/AuditView.tsx — the Audit log (TASK-220; SF-admin-050, 051, 052, 063)
 *
 * The log showed the newest 50 entries only — no next page, no search, no filter, though the route
 * already pages (`offset`, `limit`, `hasMore`) and searches (`q`); each action was a raw code in
 * mono ("user.role_changed"), and the details one JSON string cut at 80 characters. Now:
 *
 *   - the log reads its own pages (Previous / Next, "1–50", the route's own `hasMore`);
 *   - a filter by action, each action by its name; or by account — its address, found through the
 *     Users list's own search (a POST: an address never travels in a URL, TASK-215), and the
 *     log then asked for that account's id, which a URL may carry. The route takes one filter, so
 *     choosing one clears the other, and the screen says which is in force;
 *   - each entry's action by name, who acted and on whom by address (an id only with "Show
 *     details"), and its details as named pairs, each value whole behind "more".
 *
 * @module components/admin/views
 */

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AUDIT_ACTIONS } from "@/platform/auth/audit-actions";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { PanelState, usePanelRead } from "@/components/admin/ui/PanelState";
import { Field, Select, TextInput } from "@/components/admin/ui/Field";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { IdDetail, PersonRef } from "@/components/admin/ui/Ref";
import {
  auditActionLabel,
  detailKeyLabel,
  featureLabel,
  permissionLabel,
  readableCode,
  roleLabel,
  settingLabel,
} from "@/components/admin/ui/labels";
import { refusedOutcome } from "@/components/admin/ui/Outcome";
import { ExpandableText } from "@/components/admin/ExpandableText";
import { BUTTON, TEXT } from "@/components/admin/ui/tokens";
import { sectionTitle } from "@/components/admin/ui/sections";
import type { PersonRef as Person } from "@/components/admin/people";
import { FIND_ACCOUNT_PERMISSION, findAccountByAddress, useOutcomes } from "./kit";
import type { SectionViewProps } from "@/components/admin/section-views";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.audit.${key}`, values);

/** Entries a page holds. */
export const AUDIT_PAGE = 50;

export interface AuditEntry {
  readonly id: string;
  readonly action: string;
  readonly actorId?: string | null;
  readonly targetId?: string | null;
  readonly actor?: Person | null;
  readonly target?: Person | null;
  readonly details?: string;
  readonly createdAt: string;
}

/** The address of one page of the log: its offset, and the one filter (an action, an account). */
export function auditPage(offset: number, q: string | null): string {
  return `/api/admin/audit?offset=${offset}&limit=${AUDIT_PAGE}${
    q ? `&q=${encodeURIComponent(q)}` : ""
  }`;
}

/** Detail keys whose value is a setting's stored name: the setting is named instead. */
const SETTING_KEYS: ReadonlySet<string> = new Set(["key", "configKey", "config_key"]);
/** Detail keys whose value is a role's stored name. */
const ROLE_KEYS: ReadonlySet<string> = new Set([
  "role",
  "fromRole",
  "toRole",
  "from_role",
  "to_role",
  "oldRole",
  "newRole",
  "old_role",
  "new_role",
  "previousRole",
  "previous_role",
]);
/** Detail keys whose value is a feature, or a permission (one or a list). */
const FEATURE_KEYS: ReadonlySet<string> = new Set(["feature", "features"]);
const PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "permission",
  "permissions",
  "added",
  "removed",
  "add",
  "remove",
]);
/** A stored code ("first_authenticated_request"): two or more lowercase words joined by "_". */
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

/** One word of a detail: a code made readable, Yes or No, else as itself. */
function word(key: string, value: unknown): string {
  if (typeof value === "boolean") return t(value ? "detail_yes" : "detail_no");
  if (typeof value !== "string") return String(value);
  if (SETTING_KEYS.has(key)) return settingLabel(value);
  if (ROLE_KEYS.has(key)) return roleLabel(value);
  if (FEATURE_KEYS.has(key)) return featureLabel(value);
  if (PERMISSION_KEYS.has(key)) return permissionLabel(value);
  return CODE.test(value) ? readableCode(value) : value;
}

/**
 * A detail's value in words (SF-admin-052): a setting, a role, a feature or a permission by its
 * name; a stored code made readable; Yes or No; a list of these joined; anything else as JSON.
 */
export function detailValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return t("detail_none");
  if (typeof value !== "object") return word(key, value);
  if (Array.isArray(value) && value.every((v) => v === null || typeof v !== "object"))
    return value.length ? value.map((v) => word(key, v)).join(", ") : t("detail_none");
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** An entry's details as named pairs (SF-admin-052: one JSON string cut at 80 characters). */
export function AuditDetails({ details }: { readonly details?: string }) {
  let parsed: unknown = null;
  try {
    parsed = details ? (JSON.parse(details) as unknown) : null;
  } catch {
    parsed = details ?? null;
  }
  if (parsed === null || (typeof parsed === "object" && Object.keys(parsed).length === 0))
    return <>{t("detail_none")}</>;
  if (typeof parsed !== "object" || Array.isArray(parsed))
    return <ExpandableText text={detailValue("", parsed)} column={t("col_details")} />;
  return (
    <dl className="grid grid-cols-[minmax(0,max-content)_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
      {Object.entries(parsed as Record<string, unknown>).map(([key, value]) => (
        <React.Fragment key={key}>
          <dt className={TEXT.faint}>{detailKeyLabel(key)}</dt>
          <dd className="min-w-0 break-words">
            <ExpandableText text={detailValue(key, value)} column={detailKeyLabel(key)} />
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

function Who({
  person,
  id,
  showIds,
}: {
  readonly person?: Person | null;
  readonly id?: string | null;
  readonly showIds: boolean;
}) {
  if (person) return <PersonRef person={person} id={id} showId={showIds} />;
  if (!id) return <>{t("nobody")}</>;
  // An id that names no account of this tenant (a setting, a role, an agent): said so, the id a
  // detail.
  return (
    <>
      {t("not_an_account")} <IdDetail id={id} show={showIds} />
    </>
  );
}

function Filters({
  action,
  account,
  mayFind,
  onAction,
  onAccount,
}: {
  readonly action: string;
  readonly account: { readonly email: string } | null;
  readonly mayFind: boolean;
  readonly onAction: (action: string) => void;
  readonly onAccount: (address: string) => Promise<string | null>;
}) {
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  return (
    <div className="grid gap-3 md:grid-cols-2" data-audit-filters="true">
      <Field label={t("filter_action")}>
        {(control) => (
          <Select {...control} value={action} onChange={(e) => onAction(e.target.value)}>
            <option value="">{t("filter_action_all")}</option>
            {[...AUDIT_ACTIONS]
              .sort((a, b) => auditActionLabel(a).localeCompare(auditActionLabel(b)))
              .map((a) => (
                <option key={a} value={a}>
                  {auditActionLabel(a)}
                </option>
              ))}
          </Select>
        )}
      </Field>
      <form
        noValidate
        className="flex min-w-0 flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setFinding(true);
          void onAccount(address).then((bad) => {
            setFinding(false);
            setProblem(bad);
          });
        }}
      >
        <Field
          label={t("filter_account")}
          help={
            account ? t("filter_account_on", { account: account.email }) : t("filter_one")
          }
          error={problem}
          className="min-w-[12rem] flex-1"
        >
          {(control) => (
            <TextInput
              {...control}
              type="email"
              autoComplete="off"
              value={address}
              disabled={!mayFind || finding}
              onChange={(e) => setAddress(e.target.value)}
            />
          )}
        </Field>
        {mayFind ? (
          <button type="submit" className={BUTTON.quiet} disabled={finding}>
            {finding ? t("finding") : t("filter_account_apply")}
          </button>
        ) : (
          <GatedButton
            allowed={false}
            reason={needsPermission(FIND_ACCOUNT_PERMISSION)}
            className={BUTTON.quiet}
          >
            {t("filter_account_apply")}
          </GatedButton>
        )}
      </form>
    </div>
  );
}

export function AuditDataView({
  hasPermission = () => false,
  showIds = false,
}: SectionViewProps) {
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState("");
  const [account, setAccount] = useState<{ id: string; email: string } | null>(null);
  const { add, list } = useOutcomes(t("results_label"));
  const q = account?.id ?? (action || null);
  const { read, reload } = usePanelRead(auditPage(offset, q));
  const columns: Column<AuditEntry>[] = [
    { id: "time", header: t("col_time"), kind: "datetime", value: (e) => e.createdAt },
    { id: "action", header: t("col_action"), value: (e) => auditActionLabel(e.action) },
    {
      id: "actor",
      header: t("col_actor"),
      cell: (e) => <Who person={e.actor} id={e.actorId} showIds={showIds} />,
    },
    {
      id: "target",
      header: t("col_target"),
      cell: (e) => <Who person={e.target} id={e.targetId} showIds={showIds} />,
    },
    {
      id: "details",
      header: t("col_details"),
      secondary: true,
      cell: (e) => <AuditDetails details={e.details} />,
    },
  ];
  return (
    <div className="space-y-4">
      {list}
      <Filters
        action={action}
        account={account}
        mayFind={hasPermission(FIND_ACCOUNT_PERMISSION)}
        onAction={(next) => {
          setAction(next);
          setAccount(null);
          setOffset(0);
        }}
        onAccount={async (address) => {
          if (!address.trim()) {
            setAccount(null);
            setOffset(0);
            return null;
          }
          const found = await findAccountByAddress(address);
          if (found.found) {
            setAccount({ id: found.id, email: found.email });
            setAction("");
            setOffset(0);
            return null;
          }
          if (found.refusal) {
            add(refusedOutcome(found.refusal, { action: t("find_action") }));
            return null;
          }
          return t("address_unknown", { address: address.trim() });
        }}
      />
      <PanelState read={read} panel={sectionTitle("audit")} onReload={reload}>
        {(body) => {
          const entries: AuditEntry[] = Array.isArray(body.entries)
            ? (body.entries as AuditEntry[])
            : [];
          return (
            <AdminTable
              caption={t("caption")}
              columns={columns}
              rows={entries}
              rowKey={(e) => e.id}
              empty={q ? t("empty_filtered") : t("empty")}
              page={{
                offset,
                size: AUDIT_PAGE,
                shown: entries.length,
                hasMore: body.hasMore === true,
                busy: read.phase === "ready" && read.refreshing,
                onPage: setOffset,
              }}
            />
          );
        }}
      </PanelState>
    </div>
  );
}
