"use client";

import React, { useState, useEffect, useId, useRef } from "react";
import {
  ADMIN_HIGHLIGHT_DURATION_SECONDS,
  ADMIN_HIGHLIGHT_MIN_SECONDS,
  ADMIN_HIGHLIGHT_MAX_SECONDS,
} from "@/shared/config/limits";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { missingFeaturePermissions } from "@/platform/auth/feature-permissions";
import {
  isPanelUnavailable,
  PanelUnavailable,
} from "@/components/admin/PanelUnavailable";
import {
  formatDate,
  formatDateTime,
  fullTimestamp,
  permissionCategoryLabel,
} from "@/components/admin/admin-format";
import { groupPermissions } from "@/platform/auth/catalog-order";
import { ExpandableText } from "@/components/admin/ExpandableText";
import { personText } from "@/components/admin/people";
import { isShownText, renderShown } from "@/platform/errors/shown-text";

/** This screen's text, from the message catalog (ADR-051 D4, TASK-205). */
const t = (key: string, values?: MessageValues) =>
  renderMessage(`screens.admin_console.views.${key}`, values);

const thClass =
  "text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800";
const tdClass =
  "py-3 px-4 text-gray-300 border-b border-gray-800/50 align-top break-words";

function clampHighlight(seconds: number): number {
  return Math.max(
    ADMIN_HIGHLIGHT_MIN_SECONDS,
    Math.min(ADMIN_HIGHLIGHT_MAX_SECONDS, seconds)
  );
}

function DataTable({
  headers,
  children,
  emptyMessage,
  isEmpty,
}: {
  headers: string[];
  children: React.ReactNode;
  emptyMessage: string;
  isEmpty: boolean;
}) {
  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-x-auto">
      <table className="w-full text-sm text-left border-collapse">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} className={thClass}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {isEmpty && (
        <p className="text-center text-gray-400 py-8 text-sm">{emptyMessage}</p>
      )}
    </div>
  );
}

function useHighlight(
  ids: string[],
  durationSeconds: number = ADMIN_HIGHLIGHT_DURATION_SECONDS
): Set<string> {
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const prevIdsRef = useRef<string | null>(null);
  const clamped = clampHighlight(durationSeconds);

  const idsKey = ids.join(",");

  useEffect(() => {
    // First render: record IDs without highlighting
    if (prevIdsRef.current === null) {
      prevIdsRef.current = idsKey;
      return;
    }

    // No change
    if (idsKey === prevIdsRef.current) return;

    const prevSet = new Set(prevIdsRef.current.split(",").filter(Boolean));
    // From the key, not the list: a list is a new array on every render, so depending on it ran
    // this again on the highlight's own render — clearing its timer, and the row stayed marked
    // (TASK-204, N-41).
    const newIds = idsKey.split(",").filter((id) => id && !prevSet.has(id));
    prevIdsRef.current = idsKey;

    if (newIds.length > 0) {
      setHighlighted(new Set(newIds));
      const timer = setTimeout(() => setHighlighted(new Set()), clamped * 1000);
      return () => clearTimeout(timer);
    }
  }, [idsKey, clamped]);

  return highlighted;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Roles Data View with Drill-Down ─────────────────────────────────────

interface RolePermission {
  code: string;
  displayName: string;
  category: string;
}

/**
 * A date as the admin console writes it (TASK-192, as TASK-190's Users screen): "29 Oct 2026" — or
 * with its time, "29 Oct 2026, 14:05" — and the whole timestamp in UTC in the tooltip.
 */
function AdminDate({
  iso,
  withTime = false,
}: {
  iso?: string | null;
  withTime?: boolean;
}) {
  if (!iso) return <>{formatDate(null)}</>;
  return (
    <time dateTime={iso} title={fullTimestamp(iso)}>
      {withTime ? formatDateTime(iso) : formatDate(iso)}
    </time>
  );
}

/**
 * A role that lacks a feature permission is said so (TASK-194 round 1, A7): its holders cannot
 * translate, or see or edit their profile — a role made after migration 061 without them, or one
 * an administrator took them from.
 */
function FeatureGap({ permissions }: { permissions?: readonly RolePermission[] }) {
  if (!Array.isArray(permissions)) return null;
  const missing = missingFeaturePermissions(permissions.map((p) => p.code));
  if (missing.length === 0) return null;
  return (
    <span data-feature-gap="true" className="block text-xs text-amber-300">
      {renderMessage("screens.admin_console.roles.lacks_feature_permissions", {
        permissions: missing.join(", "),
      })}
    </span>
  );
}

/**
 * A role's description as the Roles screen shows it: the platform's note (a duplicate's source), in
 * the catalog's words, then what an administrator wrote (TASK-207, N-107).
 */
export function roleDescription(note: unknown, description: unknown): string {
  const written = typeof description === "string" ? description.trim() : "";
  if (!isShownText(note)) return written;
  return written ? `${renderShown(note)} ${written}` : renderShown(note);
}

export function RolesDataView({ data }: { data: any }) {
  const roles = data?.roles || [];
  const [expandedRole, setExpandedRole] = useState<string | null>(null);
  const highlighted = useHighlight(roles.map((r: any) => r.id));
  const uid = useId();

  if (roles.length === 0) {
    return <p className="text-gray-400 text-sm">{t("no_roles_found_use_the")}</p>;
  }

  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-x-auto">
      <table className="w-full text-sm text-left border-collapse">
        <thead>
          <tr>
            <th className={thClass}>{t("role")}</th>
            <th className={thClass}>{t("display_name")}</th>
            <th className={thClass}>{t("permissions")}</th>
            <th className={thClass}>{t("created")}</th>
            <th className={thClass}>{t("modified")}</th>
          </tr>
        </thead>
        <tbody>
          {roles.map((r: any, i: number) => {
            const isExpanded = expandedRole === r.id;
            const isHighlighted = highlighted.has(r.id);
            const toggle = () => setExpandedRole(isExpanded ? null : r.id);
            const detailId = `${uid}-role-${i}`;
            return (
              <React.Fragment key={r.id}>
                <tr
                  // A pointer's shortcut; the disclosure button below is the control (TASK-192).
                  onClick={toggle}
                  className={`cursor-pointer transition-colors ${
                    isHighlighted
                      ? "bg-green-900/30"
                      : isExpanded
                        ? "bg-blue-900/10"
                        : "hover:bg-gray-800/30"
                  }`}
                >
                  <td className={tdClass}>
                    <code className="text-xs">{r.name}</code>
                  </td>
                  <td className={tdClass}>{r.displayName}</td>
                  <td className={tdClass}>
                    {/* Keyboard and screen readers: a disclosure button (TASK-192 round 1). */}
                    <button
                      type="button"
                      className="text-blue-400 cursor-pointer"
                      aria-expanded={isExpanded}
                      aria-controls={isExpanded ? detailId : undefined}
                      aria-label={renderMessage(
                        "screens.admin_console.roles.permissions_toggle",
                        {
                          count: Number(r.permissionCount) || 0,
                          role: String(r.displayName ?? r.name),
                        }
                      )}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle();
                      }}
                    >
                      {r.permissionCount}{" "}
                      <span className="text-xs text-gray-400" aria-hidden="true">
                        {isExpanded ? "▲" : "▼"}
                      </span>
                    </button>
                    <FeatureGap permissions={r.permissions} />
                  </td>
                  <td className={`${tdClass} text-xs text-gray-400`}>
                    <AdminDate iso={r.createdAt} />
                  </td>
                  <td className={`${tdClass} text-xs text-gray-400`}>
                    <AdminDate iso={r.updatedAt} />
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td id={detailId} colSpan={5} className="px-4 py-3 bg-[#0d1320]">
                      {(isShownText(r.descriptionNote) || r.description) && (
                        <p className="text-xs text-gray-400 mb-3">
                          {roleDescription(r.descriptionNote, r.description)}
                        </p>
                      )}
                      {r.permissions && r.permissions.length > 0 ? (
                        // By category, each under its heading, by display name within it (TASK-192).
                        <div className="space-y-3">
                          {groupPermissions(r.permissions as RolePermission[]).map(
                            (g, j) => (
                              <section
                                key={g.category}
                                aria-labelledby={`${detailId}-group-${j}`}
                              >
                                <h3
                                  id={`${detailId}-group-${j}`}
                                  className="text-xs font-semibold text-gray-300 mb-1"
                                >
                                  {permissionCategoryLabel(g.category)}
                                </h3>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  {g.permissions.map((p) => (
                                    <div
                                      key={p.code}
                                      className="flex items-center gap-2 text-xs"
                                    >
                                      <span className="text-green-400">✓</span>
                                      <code className="text-gray-400">{p.code}</code>
                                      <span className="text-gray-400">
                                        {p.displayName}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </section>
                            )
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-gray-400">
                          {t("no_permissions_assigned")}
                        </p>
                      )}
                      <div className="mt-3 text-xs text-gray-400 flex gap-4">
                        <span>
                          {t("created_label")} <AdminDate iso={r.createdAt} withTime />
                        </span>
                        <span>
                          {t("modified_label")} <AdminDate iso={r.updatedAt} withTime />
                        </span>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Entitlements Data View ──────────────────────────────────────────────

export function EntitlementsDataView({ data }: { data: any }) {
  const groups = data?.groups || [];
  const highlighted = useHighlight(groups.map((g: any) => g.id));

  return (
    <DataTable
      headers={[t("col_code"), t("col_name"), t("col_users"), t("col_status")]}
      isEmpty={groups.length === 0}
      emptyMessage={t("no_entitlement_groups")}
    >
      {groups.map((g: any) => (
        <tr
          key={g.id}
          className={highlighted.has(g.id) ? "bg-green-900/30 transition-colors" : ""}
        >
          <td className={tdClass}>
            <code className="text-xs">{g.code}</code>
          </td>
          <td className={tdClass}>{g.displayName}</td>
          <td className={tdClass}>{g.userCount}</td>
          <td className={tdClass}>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                g.isActive
                  ? "bg-green-900/30 text-green-400"
                  : "bg-gray-700 text-gray-400"
              }`}
            >
              {g.isActive ? t("active") : t("inactive")}
            </span>
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

// ── Audit Data View ─────────────────────────────────────────────────────

/** An audit row's actor or target (GET /api/admin/audit names each account; TASK-202, N-63). */
interface AuditPerson {
  readonly email: string | null;
  readonly role?: string | null;
  readonly erased?: boolean;
}

const at = (key: string) => renderMessage(`screens.admin_console.audit.${key}`);

/**
 * Who, by address — never by id (N-63): an account of this tenant by its address; an id that
 * names no account (a setting, a role, an agent) as a detail; none as a dash.
 */
function AuditWho({ person, id }: { person?: AuditPerson | null; id?: string | null }) {
  if (person) return <span className="break-words">{personText(person)}</span>;
  if (!id) return <>{at("none")}</>;
  return (
    <span className="break-all text-gray-400">
      {renderMessage("screens.admin_console.people.id", { id })}
    </span>
  );
}

export function AuditDataView({ data }: { data: any }) {
  const entries = data?.entries || [];
  return (
    <DataTable
      headers={[
        at("col_time"),
        at("col_action"),
        at("col_actor"),
        at("col_target"),
        at("col_details"),
      ]}
      isEmpty={entries.length === 0}
      emptyMessage={at("empty")}
    >
      {entries.map((e: any) => (
        <tr key={e.id}>
          <td className={`${tdClass} text-xs whitespace-nowrap`}>
            <AdminDate iso={e.createdAt} withTime />
          </td>
          <td className={`${tdClass} whitespace-nowrap`}>
            <code className="text-xs">{e.action}</code>
          </td>
          <td className={`${tdClass} text-xs`} data-actor="true">
            <AuditWho person={e.actor} id={e.actorId} />
          </td>
          <td className={`${tdClass} text-xs`} data-target="true">
            <AuditWho person={e.target} id={e.targetId} />
          </td>
          <td className={`${tdClass} text-xs text-gray-400 min-w-[12rem]`}>
            <ExpandableText
              text={String(e.details ?? "")}
              column={at("col_details")}
              mono
            />
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

// ── Config Views ────────────────────────────────────────────────────────

function ConfigRow({
  label,
  value,
}: {
  label: string;
  value: string | number | boolean;
}) {
  const display = typeof value === "boolean" ? (value ? "✓" : "✕") : String(value);
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="text-white font-mono">{display}</span>
    </div>
  );
}

export function PasswordPolicyDataView({ data }: { data: any }) {
  const policy = data?.policy;
  if (!policy) return <p className="text-gray-400 text-sm">{t("loading")}</p>;
  return (
    <div className="bg-[#111827] rounded-xl border border-gray-800 p-5 max-w-lg">
      <div className="space-y-3 text-sm">
        <ConfigRow label={t("min_length")} value={policy.minLength} />
        <ConfigRow label={t("rotation_days")} value={policy.rotationDays} />
        <ConfigRow label={t("history_count")} value={policy.passwordHistoryCount} />
        <ConfigRow label={t("uppercase")} value={policy.requireUppercase} />
        <ConfigRow label={t("lowercase")} value={policy.requireLowercase} />
        <ConfigRow label={t("number")} value={policy.requireNumber} />
        <ConfigRow label={t("special_char")} value={policy.requireSpecial} />
      </div>
    </div>
  );
}

// ── Agent governance (Sprint 3c U4/U6) ──────────────────────────────────

/**
 * Where a governance panel's data stands (review 14 L-1): not read yet; read and holding a list
 * under `field`; or unavailable — answered 503 (the page's marker), or not a list at all. Only
 * "ready" with no entries is an empty list.
 */
function panelState(data: unknown, field: string): "loading" | "unavailable" | "ready" {
  if (data === undefined) return "loading";
  if (isPanelUnavailable(data)) return "unavailable";
  return Array.isArray((data as Record<string, unknown> | null)?.[field])
    ? "ready"
    : "unavailable";
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The Trusted agents screen, with its forms (TASK-202, N-66): TrustedAgentsPanel. */
export { TrustedAgentsPanel as TrustedAgentsDataView } from "@/components/admin/TrustedAgentsPanel";

const pa = (key: string) => renderMessage(`screens.admin_console.per_account.${key}`);

/** A blocked account and who blocked it, by address (TASK-202, N-63). */
export function PerAccountRestrictionsDataView({ data }: { data: any }) {
  const rows: any[] = Array.isArray(data?.restrictions) ? data.restrictions : [];
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">{pa("title")}</h2>
      {rows.length === 0 ? (
        <p className="text-gray-400 text-sm">{pa("empty")}</p>
      ) : (
        <DataTable
          headers={[pa("col_user"), pa("col_feature"), pa("col_reason"), pa("col_by")]}
          isEmpty={false}
          emptyMessage={pa("empty")}
        >
          {rows.map((r, i) => (
            <tr key={i}>
              <td className={`${tdClass} text-gray-200`} data-account="true">
                <AuditWho person={r.user} id={r.user_id} />
              </td>
              <td className={`${tdClass} font-mono text-xs`}>{r.feature}</td>
              <td className={tdClass}>
                {r.reason ? (
                  <ExpandableText text={String(r.reason)} column={pa("col_reason")} />
                ) : (
                  pa("none")
                )}
              </td>
              <td className={tdClass}>
                <AuditWho person={r.created_by_account} id={r.created_by} />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </div>
  );
}

// ── Approval policy (U1) + Capabilities (U2, read-only) ─────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

export function ApprovalPolicyDataView({ data }: { data: any }) {
  const policy = data?.policy;
  const rules: any[] = Array.isArray(policy?.rules) ? policy.rules : [];
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">{t("approval_policy")}</h2>
      {!policy ? (
        <p className="text-gray-400 text-sm">{t("no_policy_loaded")}</p>
      ) : (
        <>
          <p className="text-sm text-gray-400 mb-4">
            {(() => {
              // One message, the approver styled where the translation puts it.
              const mark = "\u0001";
              const [before, after = ""] = t("policy_version", {
                version: String(policy.version),
                approver: mark,
              }).split(mark);
              return (
                <>
                  {before}
                  <span className="text-gray-200">{policy.default}</span>
                  {after}
                </>
              );
            })()}
          </p>
          {rules.length === 0 ? (
            <p className="text-gray-400 text-sm">{t("no_rules_the_default_approver")}</p>
          ) : (
            <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-x-auto">
              <table className="w-full text-sm text-left border-collapse">
                <thead>
                  <tr>
                    <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                      {t("max_risk")}
                    </th>
                    <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                      {t("effects")}
                    </th>
                    <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                      {t("required_approver")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r, i) => (
                    <tr key={i}>
                      <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                        {r.maxRisk}
                      </td>
                      <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                        {(r.effects || []).join(", ") || t("any")}
                      </td>
                      <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                        {r.requiredApprover}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function CapabilitiesDataView({ data }: { data: any }) {
  const goals: any[] = Array.isArray(data?.goals) ? data.goals : [];
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-2">{t("capabilities")}</h2>
      <p className="text-sm text-gray-400 mb-6">
        {t("read_only_capabilities_are_derived")}
      </p>
      {goals.length === 0 ? (
        <p className="text-gray-400 text-sm">{t("no_capabilities_registered")}</p>
      ) : (
        <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("goal")}
                </th>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("endpoint")}
                </th>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("steps")}
                </th>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("est_cost")}
                </th>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("requires")}
                </th>
              </tr>
            </thead>
            <tbody>
              {goals.map((g, i) => (
                <tr key={i}>
                  <td className="py-3 px-4 text-gray-200 border-b border-gray-800/50 font-mono text-xs">
                    {g.goal}
                  </td>
                  <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50 font-mono text-xs">
                    {g.endpoint}
                  </td>
                  <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                    {(g.steps || []).map((s: any) => s.intent).join(" → ")}
                  </td>
                  <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                    ${(g.estimatedCostUSD ?? 0).toFixed(4)}
                  </td>
                  <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                    {g.requiredCapability || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Capability→feature mapping (U3) ─────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */

export function CapabilityMappingDataView({ data }: { data: any }) {
  // Review 14 L-1: not read yet, or not readable, is never shown as "no mappings".
  const state = panelState(data, "mappings");
  const pairs: [string, string[]][] = state === "ready" ? data.mappings : [];
  return (
    <div>
      <h2 className="text-xl font-bold text-white mb-6">
        {t("capability_feature_mapping")}
      </h2>
      {state === "loading" ? (
        <p className="text-gray-400 text-sm">
          {renderMessage("screens.admin_console.loading")}
        </p>
      ) : state === "unavailable" ? (
        <PanelUnavailable panel={t("capability_feature_mapping")} />
      ) : pairs.length === 0 ? (
        <p className="text-gray-400 text-sm">
          {renderMessage("screens.admin_console.no_mappings")}
        </p>
      ) : (
        <div className="bg-[#111827] rounded-xl border border-gray-800 overflow-x-auto">
          <table className="w-full text-sm text-left border-collapse">
            <thead>
              <tr>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("capability")}
                </th>
                <th className="text-xs text-gray-400 uppercase tracking-wider py-3 px-4 border-b border-gray-800">
                  {t("required_features")}
                </th>
              </tr>
            </thead>
            <tbody>
              {pairs.map(([cap, feats]) => (
                <tr key={cap}>
                  <td className="py-3 px-4 text-gray-200 border-b border-gray-800/50 font-mono text-xs">
                    {cap}
                  </td>
                  <td className="py-3 px-4 text-gray-300 border-b border-gray-800/50">
                    {(feats || []).join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
