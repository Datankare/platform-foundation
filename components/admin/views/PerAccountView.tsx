"use client";

/**
 * components/admin/views/PerAccountView.tsx — Per-account restrictions (TASK-220; SF-admin-053,
 * 057, 058, 063)
 *
 * The screen listed blocks by row index, without when each was made (the route sends it), offered
 * no "Lift", and added a second heading under another name ("Per-account feature control" under
 * "Per-account restrictions"). Now:
 *
 *   - one heading (the section's); the one table, each block keyed by its account and feature:
 *     the account and who blocked it by address, the feature by name, the reason, and since when;
 *   - Lift, on each block, for an administrator who holds admin_manage_account_restrictions — an
 *     ordinary change: lifting gives back what the block took;
 *   - "Block a feature": the account by its address (found through the Users list's own search,
 *     so it needs admin_manage_users too), the feature from the known list by name, and a reason
 *     the record keeps — confirmed.
 *
 * @module components/admin/views
 */

import React, { useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { Field, Select, TextInput } from "@/components/admin/ui/Field";
import { IdDetail, PersonRef } from "@/components/admin/ui/Ref";
import { featureLabel } from "@/components/admin/ui/labels";
import { refusedOutcome } from "@/components/admin/ui/Outcome";
import { runAdminAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import { personText, type PersonRef as Person } from "@/components/admin/people";
import {
  FIND_ACCOUNT_PERMISSION,
  NewBadge,
  findAccountByAddress,
  useChange,
  useNewKeys,
  useOutcomes,
  ListUnreadable,
} from "./kit";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.per_account.${key}`, values);

/** The permission a block and a lift need (the tools' own). */
export const RESTRICTIONS_PERMISSION = "admin_manage_account_restrictions";

export interface BlockRow {
  readonly user_id: string;
  readonly user?: Person | null;
  readonly feature: string;
  readonly reason?: string | null;
  readonly created_by?: string | null;
  readonly created_by_account?: Person | null;
  readonly created_at?: string;
}

/** A block's stable key: its account and its feature (the table's primary key). */
export const blockKey = (r: BlockRow) => `${r.user_id}:${r.feature}`;

type Run = ReturnType<typeof useChange>["run"];

function BlockForm({
  features,
  run,
  busy,
  add,
  onDone,
}: {
  readonly features: readonly string[];
  readonly run: Run;
  readonly busy: boolean;
  readonly add: ReturnType<typeof useOutcomes>["add"];
  readonly onDone: () => void;
}) {
  const [address, setAddress] = useState("");
  const [feature, setFeature] = useState(features[0] ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  const [finding, setFinding] = useState(false);
  const [account, setAccount] = useState<{ id: string; email: string } | null>(null);
  const review = async () => {
    setProblem(null);
    if (!address.trim()) return setProblem(t("address_missing"));
    if (!feature) return setProblem(t("feature_missing"));
    setFinding(true);
    const found = await findAccountByAddress(address);
    setFinding(false);
    if (found.found) setAccount({ id: found.id, email: found.email });
    else if (found.refusal)
      add(refusedOutcome(found.refusal, { action: t("find_action") }));
    else setProblem(t("address_unknown", { address: address.trim() }));
  };
  if (account)
    return (
      <ConfirmStep
        action="block_user_feature"
        title={t("confirm_block", {
          account: account.email,
          feature: featureLabel(feature),
        })}
        confirmLabel={t("block_submit")}
        busy={busy}
        onCancel={() => setAccount(null)}
        onConfirm={(given) =>
          void run(
            () =>
              runAdminAction("block_user_feature", {
                user_id: account.id,
                feature,
                ...(given.reason ? { reason: given.reason } : {}),
              }),
            t("what_block", { feature: featureLabel(feature) }),
            { who: account.email }
          ).then((answer) => {
            setAccount(null);
            if (answer.standing !== "refused") onDone();
          })
        }
      />
    );
  return (
    <form
      noValidate
      aria-label={t("block_title")}
      className={`${SURFACE.panel} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        void review();
      }}
    >
      <h3 className={`text-sm font-semibold ${TEXT.strong}`}>{t("block_title")}</h3>
      <Field label={t("field_address")} help={t("field_address_help")} error={problem}>
        {(control) => (
          <TextInput
            {...control}
            type="email"
            autoComplete="off"
            value={address}
            disabled={busy || finding}
            onChange={(e) => setAddress(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("field_feature")}>
        {(control) => (
          <Select
            {...control}
            value={feature}
            disabled={busy || finding}
            onChange={(e) => setFeature(e.target.value)}
          >
            {features.map((f) => (
              <option key={f} value={f}>
                {featureLabel(f)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary} disabled={busy || finding}>
          {finding ? t("finding") : t("block_review")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

export function PerAccountRestrictionsDataView({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const rows: BlockRow[] = Array.isArray(data?.restrictions) ? data.restrictions : [];
  const features: string[] = Array.isArray(data?.features) ? data.features : [];
  const mayChange = hasPermission(RESTRICTIONS_PERMISSION);
  const mayFind = hasPermission(FIND_ACCOUNT_PERMISSION);
  const fresh = useNewKeys(data, rows.map(blockKey));
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [blocking, setBlocking] = useState(false);

  const columns: Column<BlockRow>[] = [
    {
      id: "account",
      header: t("col_account"),
      sortBy: (r) => personText(r.user),
      cell: (r) => (
        <span data-account="true">
          <PersonRef person={r.user} id={r.user_id} showId={showIds} />
          {fresh.has(blockKey(r)) ? <NewBadge /> : null}
        </span>
      ),
    },
    {
      id: "feature",
      header: t("col_feature"),
      sortBy: (r) => featureLabel(r.feature),
      value: (r) => featureLabel(r.feature),
    },
    {
      id: "reason",
      header: t("col_reason"),
      secondary: true,
      value: (r) => r.reason ?? null,
    },
    {
      id: "by",
      header: t("col_by"),
      secondary: true,
      cell: (r) =>
        r.created_by_account ? (
          <PersonRef person={r.created_by_account} />
        ) : r.created_by ? (
          <>
            {t("by_unknown")} <IdDetail id={r.created_by} show={showIds} />
          </>
        ) : (
          t("by_none")
        ),
    },
    {
      id: "since",
      header: t("col_since"),
      kind: "date",
      sortBy: (r) => r.created_at ?? null,
      value: (r) => r.created_at,
    },
    {
      id: "lift",
      header: t("col_change"),
      cell: (r) => (
        <GatedButton
          allowed={mayChange}
          reason={null}
          disabled={busy}
          className={BUTTON.quiet}
          aria-label={t("lift_label", {
            account: personText(r.user),
            feature: featureLabel(r.feature),
          })}
          onClick={() =>
            void run(
              () =>
                runAdminAction("unblock_user_feature", {
                  user_id: r.user_id,
                  feature: r.feature,
                }),
              t("what_lift", { feature: featureLabel(r.feature) }),
              { who: personText(r.user) }
            )
          }
        >
          {t("lift")}
        </GatedButton>
      ),
    },
  ];

  const blockRefused = !mayChange
    ? needsPermission(RESTRICTIONS_PERMISSION)
    : !mayFind
      ? needsPermission(FIND_ACCOUNT_PERMISSION)
      : null;
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.restrictions))
    return <ListUnreadable panel={sectionTitle("per-account")} onRetry={onReload} />;
  return (
    <div className="space-y-4">
      {list}
      {blocking ? (
        <BlockForm
          features={features}
          run={run}
          busy={busy}
          add={add}
          onDone={() => setBlocking(false)}
        />
      ) : (
        <GatedButton
          allowed={blockRefused === null && features.length > 0}
          reason={blockRefused ?? t("no_features")}
          className={BUTTON.primary}
          onClick={() => setBlocking(true)}
        >
          {t("block")}
        </GatedButton>
      )}
      <AdminTable
        caption={t("caption")}
        columns={mayChange ? columns : columns.filter((c) => c.id !== "lift")}
        rows={rows}
        rowKey={blockKey}
        empty={t("empty")}
        showIds={showIds}
      />
    </div>
  );
}
