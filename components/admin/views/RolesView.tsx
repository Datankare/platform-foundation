"use client";

/**
 * components/admin/views/RolesView.tsx — the Roles screen (TASK-220; SF-admin-053, 054, 062, 063)
 *
 * Roles was read-only — every change typed into the command bar — and showed each role's stored
 * code as its first column and each permission's code beside its name. Now:
 *
 *   - the one table: a role by its name, how many permissions it grants, when it was made and
 *     last changed; its stored name only with "Show details"; a role the latest read added is
 *     marked "New" until the next read;
 *   - a role's detail beside the list (in its place on a phone): its permissions by category and
 *     by name, what it lacks of the feature permissions — by name — and, for an administrator who
 *     holds admin_manage_roles, its changes: change its permissions (confirmed, naming what is
 *     added and removed), copy it, delete it (irreversible: confirmed, saying what is lost);
 *   - "Create a role" above the list.
 *
 * Every change is the command bar's own action on the governed path (runAdminAction): checked,
 * recorded and held under dual control exactly as a typed one.
 *
 * @module components/admin/views
 */

import React, { useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { missingFeaturePermissions } from "@/platform/auth/feature-permissions";
import { groupPermissions } from "@/platform/auth/catalog-order";
import { isShownText, renderShown } from "@/platform/errors/shown-text";
import {
  formatDateTime,
  fullTimestamp,
  permissionCategoryLabel,
} from "@/components/admin/admin-format";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { Checkbox, Field, FormProblem, TextInput } from "@/components/admin/ui/Field";
import { IdDetail } from "@/components/admin/ui/Ref";
import { labelled, permissionLabel, roleLabel } from "@/components/admin/ui/labels";
import { runAdminAction } from "@/components/admin/ui/governed";
import { BUTTON, SURFACE, TEXT } from "@/components/admin/ui/tokens";
import {
  NewBadge,
  useChange,
  useNewKeys,
  useOutcomes,
  ListUnreadable,
  elementWith,
} from "./kit";
import type { SectionViewProps } from "@/components/admin/section-views";
import { sectionTitle } from "@/components/admin/ui/sections";

const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.roles.${key}`, values);

/** The permission Roles' changes need (ADMIN_TOOL_PERMISSIONS, the route's own). */
export const ROLES_PERMISSION = "admin_manage_roles";

export interface ListedPermission {
  readonly code: string;
  readonly displayName: string;
  readonly category: string;
}

export interface RoleRow {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description?: string | null;
  readonly descriptionNote?: unknown;
  readonly permissionCount?: number;
  readonly permissions?: readonly ListedPermission[];
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

/**
 * A role's description as the Roles screen shows it: the platform's note (a duplicate's source), in
 * the catalog's words, then what an administrator wrote (TASK-207, N-107).
 */
export function roleDescription(
  note: unknown,
  description: unknown,
  /** A role's name by its stored name (a duplicate's source is named, never its code). */
  nameOf: (stored: string) => string = (stored) => roleLabel(stored)
): string {
  const written = typeof description === "string" ? description.trim() : "";
  if (!isShownText(note)) return written;
  const source = (note.params as { source?: unknown } | undefined)?.source;
  const said =
    note.key === DUPLICATED_FROM && typeof source === "string"
      ? renderMessage(DUPLICATED_FROM, { source: nameOf(source) })
      : renderShown(note);
  return written ? `${said} ${written}` : said;
}

const DUPLICATED_FROM = "screens.admin_console.roles.duplicated_from";

/** A role's name as a person reads it. */
const roleName = (r: RoleRow) => r.displayName?.trim() || r.name;

/** The feature permissions a role lacks, by name (TASK-194 round 1, A7; SF-admin-054). */
export function featureGapText(permissions: readonly ListedPermission[] | undefined) {
  if (!Array.isArray(permissions)) return null;
  const missing = missingFeaturePermissions(permissions.map((p) => p.code));
  return missing.length
    ? renderMessage("screens.admin_console.roles.lacks_feature_permissions", {
        permissions: labelled(missing, permissionLabel),
      })
    : null;
}

/** Permissions by category and name; their codes only with "Show details". */
function PermissionList({
  permissions,
  showIds,
}: {
  readonly permissions: readonly ListedPermission[];
  readonly showIds: boolean;
}) {
  if (permissions.length === 0)
    return <p className={`text-sm ${TEXT.faint}`}>{t("no_permissions")}</p>;
  return (
    <div className="space-y-3" data-role-permissions="true">
      {groupPermissions([...permissions]).map((g) => (
        <section key={g.category} aria-label={permissionCategoryLabel(g.category)}>
          <h4 className={`mb-1 text-xs font-semibold ${TEXT.quiet}`}>
            {permissionCategoryLabel(g.category)}
          </h4>
          <ul className="space-y-1 text-sm">
            {g.permissions.map((p) => (
              <li key={p.code} className={`min-w-0 break-words ${TEXT.body}`}>
                {permissionLabel(p.code)}
                {showIds ? (
                  <>
                    {" "}
                    <IdDetail id={p.code} show />
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Checkboxes of every permission, by category, by name. */
export function PermissionChecklist({
  available,
  chosen,
  onChange,
  disabled,
  legend,
}: {
  readonly available: readonly ListedPermission[];
  readonly chosen: ReadonlySet<string>;
  readonly onChange: (next: Set<string>) => void;
  readonly disabled?: boolean;
  readonly legend: string;
}) {
  return (
    <fieldset className="min-w-0 space-y-3">
      <legend className={`text-xs font-medium ${TEXT.quiet}`}>{legend}</legend>
      {groupPermissions([...available]).map((g) => (
        <div key={g.category} className="space-y-1">
          <p className={`text-xs font-semibold ${TEXT.faint}`}>
            {permissionCategoryLabel(g.category)}
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {g.permissions.map((p) => (
              <Checkbox
                key={p.code}
                label={permissionLabel(p.code)}
                checked={chosen.has(p.code)}
                disabled={disabled}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(p.code);
                  else next.delete(p.code);
                  onChange(next);
                }}
                className="text-sm text-gray-200"
              />
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}

type Run = ReturnType<typeof useChange>["run"];

/** A role's permissions changed: the checklist, then a confirm naming what is added and removed. */
function ChangePermissions({
  role,
  available,
  run,
  busy,
  onDone,
}: {
  readonly role: RoleRow;
  readonly available: readonly ListedPermission[];
  readonly run: Run;
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const had = new Set((role.permissions ?? []).map((p) => p.code));
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(had));
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const add = [...chosen].filter((c) => !had.has(c));
  const remove = [...had].filter((c) => !chosen.has(c));
  const name = (code: string) => permissionLabel(code);
  return (
    <div className={`${SURFACE.inset} space-y-3 p-3`}>
      <PermissionChecklist
        available={available}
        chosen={chosen}
        onChange={(next) => {
          setChosen(next);
          setProblem(null);
        }}
        disabled={busy || asking}
        legend={t("permissions_legend", { role: roleName(role) })}
      />
      <FormProblem problem={problem} />
      {asking ? (
        <ConfirmStep
          action="assign_permissions"
          title={t("confirm_permissions", { role: roleName(role) })}
          confirmLabel={t("permissions_save")}
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() =>
            void run(
              () =>
                runAdminAction("assign_permissions", {
                  role_name: role.name,
                  ...(add.length ? { add } : {}),
                  ...(remove.length ? { remove } : {}),
                }),
              t("what_permissions", { role: roleName(role) })
            ).then((answer) => {
              setAsking(false);
              if (answer.standing !== "refused") onDone();
            })
          }
        >
          {add.length ? <p>{t("adds", { permissions: add.map(name) })}</p> : null}
          {remove.length ? (
            <p>{t("removes", { permissions: remove.map(name) })}</p>
          ) : null}
        </ConfirmStep>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={BUTTON.primary}
            disabled={busy}
            onClick={() =>
              add.length || remove.length ? setAsking(true) : setProblem(t("unchanged"))
            }
          >
            {t("permissions_review")}
          </button>
          <button type="button" className={BUTTON.quiet} onClick={onDone}>
            {t("cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

/** A role copied under a new name (ordinary: nothing is taken from anyone). */
function CopyRole({
  role,
  run,
  busy,
  onDone,
}: {
  readonly role: RoleRow;
  readonly run: Run;
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [display, setDisplay] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      noValidate
      className={`${SURFACE.inset} space-y-3 p-3`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !display.trim()) return setProblem(t("copy_missing"));
        void run(
          () =>
            runAdminAction("duplicate_role", {
              source_role: role.name,
              new_name: name.trim(),
              new_display_name: display.trim(),
            }),
          t("what_copy", { role: roleName(role), name: display.trim() })
        ).then((answer) => {
          if (answer.standing !== "refused") onDone();
        });
      }}
    >
      <Field label={t("field_display_name")} error={problem}>
        {(control) => (
          <TextInput
            {...control}
            value={display}
            disabled={busy}
            onChange={(e) => setDisplay(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("field_name")} help={t("field_name_help")}>
        {(control) => (
          <TextInput
            {...control}
            value={name}
            disabled={busy}
            autoCapitalize="none"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary} disabled={busy}>
          {t("copy_submit")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

type Mode = "permissions" | "copy" | "delete" | null;

/** A role's detail: what it grants, and — for an administrator who may — its changes. */
function RoleDetail({
  role,
  nameOf,
  available,
  showIds,
  mayChange,
  run,
  busy,
  onClose,
  opener,
}: {
  readonly role: RoleRow;
  readonly nameOf: (stored: string) => string;
  readonly available: readonly ListedPermission[];
  readonly showIds: boolean;
  readonly mayChange: boolean;
  readonly run: Run;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly opener: () => HTMLElement | null;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const gap = featureGapText(role.permissions);
  const description = roleDescription(role.descriptionNote, role.description, nameOf);
  const refused = mayChange ? null : needsPermission(ROLES_PERMISSION);
  const facts: [string, React.ReactNode][] = [
    ...(showIds
      ? ([[t("field_stored_name"), <IdDetail key="n" id={role.name} show />]] as [
          string,
          React.ReactNode,
        ][])
      : []),
    [t("field_description"), description || t("no_description")],
    [t("col_created"), <DateText key="c" iso={role.createdAt} />],
    [t("col_modified"), <DateText key="m" iso={role.updatedAt} />],
  ];
  return (
    <DetailPanel title={roleName(role)} onClose={onClose} returnFocus={opener}>
      <div className="space-y-4">
        <DetailFacts facts={facts} />
        {gap ? (
          <p data-feature-gap="true" className="text-sm text-amber-200">
            {gap}
          </p>
        ) : null}
        <PermissionList permissions={role.permissions ?? []} showIds={showIds} />
        {mode === "permissions" ? (
          <ChangePermissions
            role={role}
            available={available}
            run={run}
            busy={busy}
            onDone={() => setMode(null)}
          />
        ) : mode === "copy" ? (
          <CopyRole role={role} run={run} busy={busy} onDone={() => setMode(null)} />
        ) : mode === "delete" ? (
          <ConfirmStep
            action="delete_role"
            title={t("confirm_delete", { role: roleName(role) })}
            confirmLabel={t("delete")}
            returnFocus={deleteButton}
            busy={busy}
            onCancel={() => setMode(null)}
            onConfirm={() =>
              void run(
                () => runAdminAction("delete_role", { role_name: role.name }),
                t("what_delete", { role: roleName(role) })
              ).then(() => setMode(null))
            }
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <GatedButton
              allowed={mayChange}
              reason={refused}
              className={BUTTON.quiet}
              onClick={() => setMode("permissions")}
            >
              {t("change_permissions")}
            </GatedButton>
            <GatedButton
              allowed={mayChange}
              reason={null}
              className={BUTTON.quiet}
              onClick={() => setMode("copy")}
            >
              {t("copy")}
            </GatedButton>
            <GatedButton
              allowed={mayChange}
              reason={null}
              ref={deleteButton}
              className={BUTTON.danger}
              onClick={() => setMode("delete")}
            >
              {t("delete")}
            </GatedButton>
          </div>
        )}
      </div>
    </DetailPanel>
  );
}

/** A date and time, the console's one way, with the whole timestamp on hover. */
function DateText({ iso }: { readonly iso?: string }) {
  return iso ? (
    <time dateTime={iso} title={fullTimestamp(iso)}>
      {formatDateTime(iso)}
    </time>
  ) : (
    <>{t("never")}</>
  );
}

/** A new role: its names and permissions (ordinary: nothing is taken from anyone). */
function CreateRole({
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
  const [name, setName] = useState("");
  const [display, setDisplay] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      noValidate
      aria-label={t("create_title")}
      className={`${SURFACE.panel} space-y-3 p-4`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !display.trim()) return setProblem(t("create_missing"));
        void run(
          () =>
            runAdminAction("create_role", {
              name: name.trim(),
              display_name: display.trim(),
              ...(description.trim() ? { description: description.trim() } : {}),
              permissions: [...chosen],
            }),
          t("what_create", { role: display.trim() })
        ).then((answer) => {
          if (answer.standing !== "refused") onDone();
        });
      }}
    >
      <h3 className={`text-sm font-semibold ${TEXT.strong}`}>{t("create_title")}</h3>
      <Field label={t("field_display_name")} error={problem}>
        {(control) => (
          <TextInput
            {...control}
            value={display}
            disabled={busy}
            onChange={(e) => setDisplay(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("field_name")} help={t("field_name_help")}>
        {(control) => (
          <TextInput
            {...control}
            value={name}
            disabled={busy}
            autoCapitalize="none"
            onChange={(e) => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label={t("field_description")}>
        {(control) => (
          <TextInput
            {...control}
            value={description}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        )}
      </Field>
      <PermissionChecklist
        available={available}
        chosen={chosen}
        onChange={setChosen}
        disabled={busy}
        legend={t("create_permissions_legend")}
      />
      <p className={`text-xs ${TEXT.faint}`}>{t("create_feature_note")}</p>
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

export function RolesDataView({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const roles: RoleRow[] = Array.isArray(data?.roles) ? data.roles : [];
  const available: ListedPermission[] = Array.isArray(data?.availablePermissions)
    ? data.availablePermissions
    : [];
  const mayChange = hasPermission(ROLES_PERMISSION);
  const fresh = useNewKeys(
    data,
    roles.map((r) => r.id)
  );
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const open = roles.find((r) => r.id === openId) ?? null;
  const opener = (id: string) => () => elementWith("data-role-open", id);

  const columns: Column<RoleRow>[] = [
    {
      id: "role",
      header: t("col_role"),
      sortBy: (r) => roleName(r).toLowerCase(),
      cell: (r) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-role-open={r.id}
            aria-expanded={openId === r.id}
            className={BUTTON.link}
            onClick={(e) => {
              e.stopPropagation();
              setOpenId(r.id);
            }}
          >
            {roleName(r)}
          </button>
          {fresh.has(r.id) ? <NewBadge /> : null}
        </span>
      ),
    },
    {
      id: "permissions",
      header: t("col_permissions"),
      sortBy: (r) => Number(r.permissionCount) || 0,
      cell: (r) => (
        <span>
          {t("permission_count", { count: Number(r.permissionCount) || 0 })}
          {featureGapText(r.permissions) ? (
            <span className="block text-xs text-amber-200">{t("lacks_short")}</span>
          ) : null}
        </span>
      ),
    },
    {
      id: "created",
      header: t("col_created"),
      kind: "date",
      secondary: true,
      value: (r) => r.createdAt,
    },
    {
      id: "modified",
      header: t("col_modified"),
      kind: "date",
      secondary: true,
      value: (r) => r.updatedAt,
    },
    { id: "stored", header: t("field_stored_name"), kind: "id", value: (r) => r.name },
  ];

  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.roles))
    return <ListUnreadable panel={sectionTitle("roles")} onRetry={onReload} />;
  return (
    <div className="space-y-4">
      {list}
      {creating ? (
        <CreateRole
          available={available}
          run={run}
          busy={busy}
          onDone={() => setCreating(false)}
        />
      ) : (
        <GatedButton
          allowed={mayChange}
          reason={needsPermission(ROLES_PERMISSION)}
          className={BUTTON.primary}
          onClick={() => setCreating(true)}
        >
          {t("create")}
        </GatedButton>
      )}
      <DetailLayout
        detail={
          open ? (
            <RoleDetail
              key={open.id}
              role={open}
              nameOf={(stored) => {
                const found = roles.find((r) => r.name === stored);
                return found ? roleName(found) : roleLabel(stored);
              }}
              available={available}
              showIds={showIds}
              mayChange={mayChange}
              run={run}
              busy={busy}
              onClose={() => setOpenId(null)}
              opener={opener(open.id)}
            />
          ) : null
        }
      >
        <AdminTable
          caption={t("caption")}
          columns={columns}
          rows={roles}
          rowKey={(r) => r.id}
          empty={t("empty")}
          showIds={showIds}
          compact={open !== null}
          selectedKey={openId}
          onRowClick={(r) => setOpenId(r.id)}
        />
      </DetailLayout>
    </div>
  );
}
