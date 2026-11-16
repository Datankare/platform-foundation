"use client";

/**
 * components/admin/views/EntitlementsView.tsx — the Entitlements screen (TASK-220; SF-admin-053,
 * 055, 062, 063)
 *
 * Turning a group on or off had no path at all: the route existed (PATCH /api/admin/entitlements,
 * held under dual control) but nothing called it, and the planner had no tool for it. A group's
 * holders read "0" when they could not be counted. Now:
 *
 *   - the one table: a group by its name (its code only with "Show details"), what it grants by
 *     name, its holders in this tenant — "Unknown" when they could not be counted (the route sends
 *     null) — and whether it is on, in words; a group the latest read added is marked "New";
 *   - each group's detail, with Turn on / Turn off for an administrator who holds
 *     admin_manage_entitlements: confirmed, saying that everyone granted the group gains or loses
 *     its permissions at once; held for a second administrator under dual control;
 *   - "Create a group" (the command bar's create_entitlement_group).
 *
 * @module components/admin/views
 */

import React, { useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { Field, TextInput } from "@/components/admin/ui/Field";
import { IdDetail } from "@/components/admin/ui/Ref";
import { permissionLabel } from "@/components/admin/ui/labels";
import { runAdminAction, runRouteChange } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import {
  NewBadge,
  useChange,
  useNewKeys,
  useOutcomes,
  ListUnreadable,
  elementWith,
} from "./kit";
import { PermissionChecklist, type ListedPermission } from "./RolesView";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.entitlements.${key}`, values);

/** The permission the Entitlements changes need (the route's and the tool's own). */
export const ENTITLEMENTS_PERMISSION = "admin_manage_entitlements";

export interface GroupRow {
  readonly id: string;
  readonly code: string;
  readonly displayName: string;
  readonly isActive: boolean;
  /** This tenant's holders; null when they could not be counted (SF-admin-055). */
  readonly userCount: number | null;
  readonly permissions?: readonly ListedPermission[];
}

const groupName = (g: GroupRow) => g.displayName?.trim() || g.code;

/** Holders in words: a count, or "Unknown" — never a 0 that was not counted. */
export function holdersText(count: number | null | undefined): string {
  return typeof count === "number" ? t("holders", { count }) : t("holders_unknown");
}

const grantsText = (g: GroupRow) =>
  g.permissions?.length
    ? t("grants", {
        permissions: g.permissions.map((p) => permissionLabel(p.code)),
      })
    : t("grants_none");

type Run = ReturnType<typeof useChange>["run"];

function GroupDetail({
  group,
  showIds,
  mayChange,
  run,
  busy,
  onClose,
  opener,
}: {
  readonly group: GroupRow;
  readonly showIds: boolean;
  readonly mayChange: boolean;
  readonly run: Run;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly opener: () => HTMLElement | null;
}) {
  const [asking, setAsking] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const turnOn = !group.isActive;
  const facts: [string, React.ReactNode][] = [
    ...(showIds
      ? ([[t("field_code"), <IdDetail key="c" id={group.code} show />]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    [t("col_status"), group.isActive ? t("on") : t("off")],
    [t("col_holders"), holdersText(group.userCount)],
    [t("col_grants"), grantsText(group)],
  ];
  return (
    <DetailPanel title={groupName(group)} onClose={onClose} returnFocus={opener}>
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        {asking ? (
          <ConfirmStep
            action="set_entitlement_group_active"
            title={
              turnOn
                ? t("confirm_on", { group: groupName(group) })
                : t("confirm_off", { group: groupName(group) })
            }
            confirmLabel={turnOn ? t("turn_on") : t("turn_off")}
            returnFocus={toggle}
            busy={busy}
            onCancel={() => setAsking(false)}
            onConfirm={() =>
              void run(
                () =>
                  runRouteChange("/api/admin/entitlements", "PATCH", {
                    groupId: group.id,
                    isActive: turnOn,
                  }),
                turnOn
                  ? t("what_on", { group: groupName(group) })
                  : t("what_off", { group: groupName(group) })
              ).then(() => setAsking(false))
            }
          >
            <p>{holdersText(group.userCount)}</p>
          </ConfirmStep>
        ) : (
          <GatedButton
            allowed={mayChange}
            reason={needsPermission(ENTITLEMENTS_PERMISSION)}
            ref={toggle}
            className={turnOn ? BUTTON.primary : BUTTON.quiet}
            onClick={() => setAsking(true)}
          >
            {turnOn ? t("turn_on") : t("turn_off")}
          </GatedButton>
        )}
      </div>
    </DetailPanel>
  );
}

function CreateGroup({
  available,
  run,
  busy,
  onDone,
}: {
  readonly available: readonly ListedPermission[];
  readonly run: Run;
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      noValidate
      aria-label={t("create_title")}
      className={`${SURFACE.panel} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!code.trim() || !name.trim()) return setProblem(t("create_missing"));
        void run(
          () =>
            runAdminAction("create_entitlement_group", {
              code: code.trim(),
              display_name: name.trim(),
              permissions: [...chosen],
            }),
          t("what_create", { group: name.trim() })
        ).then((answer) => {
          if (answer.standing !== "refused") onDone();
        });
      }}
    >
      <h3 className={`text-sm font-semibold ${TEXT.strong}`}>{t("create_title")}</h3>
      <Field label={t("field_name")} error={problem}>
        {(control) => (
          <TextInput
            {...control}
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("field_code")} help={t("field_code_help")}>
        {(control) => (
          <TextInput
            {...control}
            value={code}
            disabled={busy}
            autoCapitalize="none"
            onChange={(e) => setCode(e.target.value)}
          />
        )}
      </Field>
      {available.length ? (
        <PermissionChecklist
          available={available}
          chosen={chosen}
          onChange={setChosen}
          disabled={busy}
          legend={t("create_permissions_legend")}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary} disabled={busy}>
          {t("create_submit")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

export function EntitlementsDataView({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const groups: GroupRow[] = Array.isArray(data?.groups) ? data.groups : [];
  const available: ListedPermission[] = Array.isArray(data?.availablePermissions)
    ? data.availablePermissions
    : [];
  const mayChange = hasPermission(ENTITLEMENTS_PERMISSION);
  const fresh = useNewKeys(
    data,
    groups.map((g) => g.id)
  );
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = groups.find((g) => g.id === openId) ?? null;

  const columns: Column<GroupRow>[] = [
    {
      id: "group",
      header: t("col_group"),
      sortBy: (g) => groupName(g).toLowerCase(),
      cell: (g) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-group-open={g.id}
            aria-expanded={openId === g.id}
            className={BUTTON.link}
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(g.id);
            }}
          >
            {groupName(g)}
          </button>
          {fresh.has(g.id) ? <NewBadge /> : null}
        </span>
      ),
    },
    { id: "grants", header: t("col_grants"), secondary: true, value: grantsText },
    {
      id: "holders",
      header: t("col_holders"),
      sortBy: (g) => g.userCount,
      value: (g) => holdersText(g.userCount),
    },
    {
      id: "status",
      header: t("col_status"),
      sortBy: (g) => (g.isActive ? 1 : 0),
      value: (g) => (g.isActive ? t("on") : t("off")),
    },
    { id: "code", header: t("field_code"), kind: "id", value: (g) => g.code },
  ];

  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.groups))
    return <ListUnreadable panel={sectionTitle("entitlements")} onRetry={onReload} />;
  return (
    <div className="space-y-4">
      {list}
      {creating ? (
        <CreateGroup
          available={available}
          run={run}
          busy={busy}
          onDone={() => setCreating(false)}
        />
      ) : (
        <GatedButton
          allowed={mayChange}
          reason={needsPermission(ENTITLEMENTS_PERMISSION)}
          className={BUTTON.primary}
          onClick={() => setCreating(true)}
        >
          {t("create")}
        </GatedButton>
      )}
      <DetailLayout
        detail={
          open ? (
            <GroupDetail
              key={open.id}
              group={open}
              showIds={showIds}
              mayChange={mayChange}
              run={run}
              busy={busy}
              onClose={() => setOpenId(null)}
              opener={() => elementWith("data-group-open", open.id)}
            />
          ) : null
        }
      >
        <AdminTable
          caption={t("caption")}
          columns={columns}
          rows={groups}
          rowKey={(g) => g.id}
          empty={t("empty")}
          showIds={showIds}
          compact={open !== null}
          selectedKey={openId}
          onRowClick={(g) => setOpenId(g.id)}
        />
      </DetailLayout>
    </div>
  );
}
