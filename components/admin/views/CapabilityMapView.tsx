"use client";

/**
 * components/admin/views/CapabilityMapView.tsx — the Capability map screen (TASK-220;
 * SF-admin-053, 057, 061, 063)
 *
 * The map showed raw capability and feature codes, under a second heading with another name
 * ("Capability → feature mapping" under "Capability map"), and could be changed only through the
 * command bar. Now one heading and the one table — each capability and the features an account
 * needs for it, by name — and, for an administrator who holds admin_manage_config, the map
 * changed here: a capability's features (from the known list, by name), a capability added, a
 * mapping removed — each confirmed and sent as the command bar's set_capability_mapping, on the
 * governed path. Removing a mapping says what follows: an agent acting for an account can no
 * longer use that capability (an unmapped capability is refused).
 *
 * @module components/admin/views
 */

import React, { useRef, useState } from "react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { AdminTable, type Column } from "@/components/admin/ui/AdminTable";
import { ConfirmStep } from "@/components/admin/ui/ConfirmStep";
import { GatedButton, needsPermission } from "@/components/admin/ui/PermissionGate";
import { Checkbox, Field, FormProblem, TextInput } from "@/components/admin/ui/Field";
import {
  DetailFacts,
  DetailLayout,
  DetailPanel,
} from "@/components/admin/ui/DetailPanel";
import { IdDetail } from "@/components/admin/ui/Ref";
import { capabilityLabel, featureLabel } from "@/components/admin/ui/labels";
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
  renderMessage(`screens.admin_console.views.capability_map.${key}`, values);

/** The permission a change needs (the tool's own). */
export const MAPPING_PERMISSION = "admin_manage_config";

type Pair = readonly [string, readonly string[]];
type Run = ReturnType<typeof useChange>["run"];

const featuresText = (features: readonly string[]) =>
  features.length
    ? t("features", { features: features.map(featureLabel) })
    : t("no_features");

function FeatureChecklist({
  known,
  chosen,
  onChange,
  busy,
  legend,
}: {
  readonly known: readonly string[];
  readonly chosen: ReadonlySet<string>;
  readonly onChange: (next: Set<string>) => void;
  readonly busy: boolean;
  readonly legend: string;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className={`text-xs font-medium ${TEXT.quiet}`}>{legend}</legend>
      {known.map((f) => (
        <Checkbox
          key={f}
          label={featureLabel(f)}
          checked={chosen.has(f)}
          disabled={busy}
          onChange={(e) => {
            const next = new Set(chosen);
            if (e.target.checked) next.add(f);
            else next.delete(f);
            onChange(next);
          }}
          className={`text-sm ${TEXT.body}`}
        />
      ))}
    </fieldset>
  );
}

/** A capability's features changed (or a new capability's set): the checklist, then a confirm. */
function SetFeatures({
  capability,
  current,
  known,
  isNew,
  run,
  busy,
  onDone,
}: {
  readonly capability: string;
  readonly current: readonly string[];
  readonly known: readonly string[];
  readonly isNew: boolean;
  readonly run: Run;
  readonly busy: boolean;
  readonly onDone: () => void;
}) {
  const [name, setName] = useState(capability);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(current));
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const cap = (isNew ? name : capability).trim();
  if (asking)
    return (
      <ConfirmStep
        action="set_capability_mapping"
        title={t("confirm_set", { capability: capabilityLabel(cap) })}
        confirmLabel={t("save")}
        busy={busy}
        onCancel={() => setAsking(false)}
        onConfirm={() =>
          void run(
            () =>
              runAdminAction("set_capability_mapping", {
                capability: cap,
                features: [...chosen],
              }),
            t("what_set", { capability: capabilityLabel(cap) })
          ).then((answer) => {
            setAsking(false);
            if (answer.standing !== "refused") onDone();
          })
        }
      >
        <p>
          {t("from_to", { from: featuresText(current), to: featuresText([...chosen]) })}
        </p>
      </ConfirmStep>
    );
  return (
    <form
      noValidate
      aria-label={
        isNew ? t("add_title") : t("edit_title", { capability: capabilityLabel(cap) })
      }
      className={`${SURFACE.inset} space-y-3 p-3`}
      onSubmit={(e) => {
        e.preventDefault();
        if (isNew && !/^[a-z][a-z0-9._-]{0,63}$/.test(cap))
          return setProblem(t("name_invalid"));
        if (!isNew && [...chosen].sort().join() === [...current].sort().join())
          return setProblem(t("unchanged"));
        setProblem(null);
        setAsking(true);
      }}
    >
      {isNew ? (
        <Field
          label={t("field_capability")}
          help={t("field_capability_help")}
          error={problem}
        >
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
      ) : (
        <FormProblem problem={problem} />
      )}
      <FeatureChecklist
        known={known}
        chosen={chosen}
        onChange={setChosen}
        busy={busy}
        legend={t("field_features")}
      />
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={BUTTON.primary} disabled={busy}>
          {t("review")}
        </button>
        <button type="button" className={BUTTON.quiet} onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

function MappingDetail({
  pair,
  known,
  showIds,
  mayChange,
  run,
  busy,
  onClose,
  opener,
}: {
  readonly pair: Pair;
  readonly known: readonly string[];
  readonly showIds: boolean;
  readonly mayChange: boolean;
  readonly run: Run;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly opener: () => HTMLElement | null;
}) {
  const [capability, features] = pair;
  const [mode, setMode] = useState<"edit" | "remove" | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  return (
    <DetailPanel
      title={capabilityLabel(capability)}
      onClose={onClose}
      returnFocus={opener}
    >
      <div className="space-y-4">
        <DetailFacts
          facts={[
            ...(showIds
              ? ([[t("field_code"), <IdDetail key="c" id={capability} show />]] as [
                  string,
                  React.ReactNode,
                ][])
              : []),
            [t("col_features"), featuresText(features)],
          ]}
        />
        {mode === "edit" ? (
          <SetFeatures
            capability={capability}
            current={features}
            known={known}
            isNew={false}
            run={run}
            busy={busy}
            onDone={() => setMode(null)}
          />
        ) : mode === "remove" ? (
          <ConfirmStep
            action="capability_mapping.remove"
            title={t("confirm_remove", { capability: capabilityLabel(capability) })}
            confirmLabel={t("remove")}
            returnFocus={removeButton}
            busy={busy}
            onCancel={() => setMode(null)}
            onConfirm={() =>
              void run(
                () =>
                  runAdminAction("set_capability_mapping", { capability, remove: true }),
                t("what_remove", { capability: capabilityLabel(capability) })
              ).then(() => setMode(null))
            }
          />
        ) : (
          <div className="flex flex-wrap gap-2">
            <GatedButton
              allowed={mayChange}
              reason={needsPermission(MAPPING_PERMISSION)}
              className={BUTTON.quiet}
              onClick={() => setMode("edit")}
            >
              {t("edit")}
            </GatedButton>
            <GatedButton
              allowed={mayChange}
              reason={null}
              ref={removeButton}
              className={BUTTON.quiet}
              onClick={() => setMode("remove")}
            >
              {t("remove")}
            </GatedButton>
          </div>
        )}
      </div>
    </DetailPanel>
  );
}

export function CapabilityMappingDataView({
  data,
  hasPermission = () => false,
  onReload,
  showIds = false,
}: SectionViewProps) {
  const pairs: Pair[] = Array.isArray(data?.mappings) ? data.mappings : [];
  const known: string[] = Array.isArray(data?.features) ? data.features : [];
  const mayChange = hasPermission(MAPPING_PERMISSION);
  const fresh = useNewKeys(
    data,
    pairs.map(([c]) => c)
  );
  const { add, list } = useOutcomes(t("results_label"));
  const { busy, run } = useChange(add, onReload);
  const [openCap, setOpenCap] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const open = pairs.find(([c]) => c === openCap) ?? null;
  const columns: Column<Pair>[] = [
    {
      id: "capability",
      header: t("col_capability"),
      sortBy: ([c]) => capabilityLabel(c),
      cell: ([c]) => (
        <span className="min-w-0 break-words">
          <button
            type="button"
            data-capability-open={c}
            aria-expanded={openCap === c}
            className={BUTTON.link}
            onClick={(e) => {
              e.stopPropagation();
              setOpenCap(c);
            }}
          >
            {capabilityLabel(c)}
          </button>
          {fresh.has(c) ? <NewBadge /> : null}
        </span>
      ),
    },
    { id: "features", header: t("col_features"), value: ([, f]) => featuresText(f) },
    { id: "code", header: t("field_code"), kind: "id", value: ([c]) => c },
  ];
  // A body without its list is not an empty list (review 14 L-1): said as a failed read.
  if (!Array.isArray(data?.mappings))
    return (
      <ListUnreadable panel={sectionTitle("capability-mapping")} onRetry={onReload} />
    );
  return (
    <div className="space-y-4">
      {list}
      {adding ? (
        <SetFeatures
          capability=""
          current={[]}
          known={known}
          isNew
          run={run}
          busy={busy}
          onDone={() => setAdding(false)}
        />
      ) : (
        <GatedButton
          allowed={mayChange}
          reason={needsPermission(MAPPING_PERMISSION)}
          className={BUTTON.primary}
          onClick={() => setAdding(true)}
        >
          {t("add")}
        </GatedButton>
      )}
      <DetailLayout
        detail={
          open ? (
            <MappingDetail
              key={open[0]}
              pair={open}
              known={known}
              showIds={showIds}
              mayChange={mayChange}
              run={run}
              busy={busy}
              onClose={() => setOpenCap(null)}
              opener={() => elementWith("data-capability-open", open[0])}
            />
          ) : null
        }
      >
        <AdminTable
          caption={t("caption")}
          columns={columns}
          rows={pairs}
          rowKey={([c]) => c}
          empty={t("empty")}
          showIds={showIds}
          compact={open !== null}
          selectedKey={openCap}
          onRowClick={([c]) => setOpenCap(c)}
        />
      </DetailLayout>
    </div>
  );
}
