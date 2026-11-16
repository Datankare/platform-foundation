/**
 * @jest-environment node
 */
/**
 * __tests__/admin-shared-components-guard.test.ts — an admin screen is built from the console's
 * shared parts, never by hand (TASK-216)
 *
 * @guard an admin screen that builds a table, a panel state, an outcome, a confirmation, an API
 * call or a form control by hand, or shows a stored code or id as text
 *
 * The owner found the console hard to use: tables wider than the window, hex ids where a name
 * belongs, results that vanish, changes not said. The review (SCREEN-FINDINGS, 2026-11-12) found
 * why — every screen built the same things separately: 16 tables, 5 outcome displays, 8 ways of
 * asking for a reason, ids in 11 places. Batch 56d-1 built the shared parts
 * (components/admin/ui/) and moved the console's core onto them; this guard keeps a screen from
 * drifting back. Every source file of the console's screens (app/admin, components/admin,
 * components/ReviewDashboard — but the shared parts themselves) is read, comments removed, and
 * refused when it:
 *
 *   raw-table        writes a `<table>`                          → AdminTable
 *   own-panel-state  says "loading" or "unavailable" itself      → PanelState / usePanelRead
 *   own-outcome      keeps a live region of its own              → OutcomeList
 *   own-confirm      builds its own confirmation                 → ConfirmStep + the registry
 *   own-call         calls the API itself                        → adminCall
 *   raw-control      writes an input, select or textarea         → Field and its controls
 *   raw-code-or-id   shows a stored code or an id as text        → labels / PersonRef / IdDetail
 *
 * These are patterns in the source, so a proxy: they prove a screen does not write these
 * things, not that it uses the shared part well — the screens' own tests and the walk do that.
 *
 * KNOWN was the list of screens not yet converted, each with the pass that converted it and
 * exactly the rules it still broke; it only shrank. Pass 56d-2 (TASK-220) took the governance
 * screens off it; pass 56d-3 (TASK-221) emptied it, and it now takes no entry at all.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const SCREEN_DIRS = ["app/admin", "components/admin", "components/ReviewDashboard"];

/** The shared parts: where these things are written once. */
const SHARED_PARTS = [
  "components/admin/ui/",
  // The cut-and-show-whole cell the one table writes long values with.
  "components/admin/ExpandableText.tsx",
];

type RuleId =
  | "raw-table"
  | "own-panel-state"
  | "own-outcome"
  | "own-confirm"
  | "own-call"
  | "raw-control"
  | "raw-code-or-id";

const RULES: Readonly<
  Record<RuleId, { readonly pattern: RegExp; readonly use: string }>
> = {
  "raw-table": { pattern: /<table[\s>]/, use: "AdminTable" },
  "own-panel-state": {
    // The unavailable marker and its notice, or a "loading" sentence written as JSX text — not
    // one handed to the shared Reading.
    pattern:
      /\b(?:PanelUnavailable|isPanelUnavailable|PANEL_UNAVAILABLE)\b|>\s*\{[^{}]*["'`.]loading["'`]\s*\)\s*\}|unavailable_title/,
    use: "PanelState / usePanelRead",
  },
  "own-outcome": {
    pattern: /role=["'](?:status|alert)["']|aria-live=/,
    use: "OutcomeList (ReadFailed and Reading for a read)",
  },
  "own-confirm": {
    pattern:
      /role=["']alertdialog["']|window\.confirm\(|\[\s*confirm\w*\s*,\s*setConfirm\w*\s*\]/,
    use: "ConfirmStep and the confirmation registry",
  },
  "own-call": { pattern: /\bapiFetch\s*\(|(?<![.\w])fetch\s*\(/, use: "adminCall" },
  "raw-control": {
    pattern: /<(?:input|select|textarea)[\s>]/,
    use: "Field with TextInput, Select, TextArea or Checkbox",
  },
  "raw-code-or-id": {
    pattern:
      /<code[\s>]|\bfont-mono\b|>\s*\{\s*(?:[\w$]+\??\.)*(?:id|[a-z]\w*Id|uuid|code|key|kind|tool|roleName|configKey|permission)\s*\}/,
    use: "labels, PersonRef or IdDetail",
  },
};

/** Source without its comments (a comment may name what the code must not write). */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The rules `source` breaks. */
export function brokenRules(source: string): RuleId[] {
  const code = withoutComments(source);
  return (Object.keys(RULES) as RuleId[]).filter((id) => RULES[id].pattern.test(code));
}

interface Known {
  /** The pass that converts the screen. */
  readonly pass: string;
  /** Exactly the rules it still breaks. */
  readonly rules: readonly RuleId[];
}

/**
 * The screens not yet built from the shared parts: none. Pass 56d-2 converted the governance
 * screens (TASK-220); pass 56d-3 (TASK-221) converted the last — Tenancy, Jobs, Erasures, the kill
 * switch, the review queue and staff two-step enrolment — and removed the old "unavailable"
 * notice with them. The list is empty and stays empty: its type takes no entry (a screen listed
 * here does not compile), and the test below refuses one — a new screen is built from the shared
 * parts from its first line.
 */
const KNOWN: Readonly<Record<string, never>> = {};

/** What is wrong with one file, given its known entry (none: it must be clean). */
export function judge(
  file: string,
  broken: readonly RuleId[],
  known: Known | undefined
): string[] {
  const allowed = known?.rules ?? [];
  const problems: string[] = [];
  for (const rule of broken)
    if (!allowed.includes(rule))
      problems.push(
        `${file}: ${rule} — use ${RULES[rule].use}${
          known ? ` (not among what pass ${known.pass} still has to convert here)` : ""
        }`
      );
  for (const rule of allowed)
    if (!broken.includes(rule))
      problems.push(
        `${file}: no longer breaks ${rule} — remove it from the known list${
          allowed.length === 1 ? " (and the file with it)" : ""
        }`
      );
  if (known && allowed.length === 0)
    problems.push(`${file}: a known entry with no rule — remove it`);
  return problems;
}

function sources(dir: string): string[] {
  const at = join(ROOT, dir);
  if (!existsSync(at)) return [];
  return readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    const rel = relative(ROOT, path).split(sep).join("/");
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(rel);
    return /\.tsx?$/.test(name) && !/\.(?:test|spec)\./.test(name) ? [rel] : [];
  });
}

const isShared = (file: string) => SHARED_PARTS.some((part) => file.startsWith(part));

/** Every problem in the console's screens, against a known list. */
export function scan(known: Readonly<Record<string, Known>> = KNOWN): string[] {
  const files = SCREEN_DIRS.flatMap(sources).filter((file) => !isShared(file));
  const problems = files.flatMap((file) =>
    judge(file, brokenRules(readFileSync(join(ROOT, file), "utf8")), known[file])
  );
  for (const file of Object.keys(known))
    if (!files.includes(file))
      problems.push(`${file}: in the known list, but not a screen file — remove it`);
  return problems;
}

describe("admin screens are built from the shared parts", () => {
  it("no screen builds one by hand, beyond the known list — and the list is exact", () => {
    expect(scan()).toEqual([]);
  });

  it("the known list is empty, and takes no entry: every screen is built from the shared parts (TASK-221)", () => {
    expect(Object.keys(KNOWN)).toEqual([]);
  });

  it("the console's core is not in the known list: it is converted", () => {
    for (const file of [
      "app/admin/page.tsx",
      "components/admin/AdminShell.tsx",
      "components/admin/SectionConsole.tsx",
      "components/admin/AdminPromptBar.tsx",
      "components/admin/ActionConfirmPanel.tsx",
      "components/admin/ExecutionResultsPanel.tsx",
      "components/admin/UsersPanel.tsx",
      "components/admin/ResultList.tsx",
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(true);
      expect(KNOWN[file]).toBeUndefined();
    }
  });

  it("the governance screens are not in the known list: pass 56d-2 converted them (TASK-220)", () => {
    for (const file of [
      "components/admin/HeldActionsPanel.tsx",
      "components/admin/PlatformConfigPanel.tsx",
      "components/admin/DualControlKeysPanel.tsx",
      "components/admin/TrustedAgentsPanel.tsx",
      "components/admin/AdminDataViews.tsx",
      "components/admin/views/RolesView.tsx",
      "components/admin/views/EntitlementsView.tsx",
      "components/admin/views/AuditView.tsx",
      "components/admin/views/PasswordPolicyView.tsx",
      "components/admin/views/PerAccountView.tsx",
      "components/admin/views/ApprovalPolicyView.tsx",
      "components/admin/views/CapabilitiesView.tsx",
      "components/admin/views/CapabilityMapView.tsx",
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(true);
      expect(KNOWN[file]).toBeUndefined();
    }
  });

  it("the operator and moderation screens are not in the known list: pass 56d-3 converted them (TASK-221)", () => {
    for (const file of [
      "components/admin/TenancyPanels.tsx",
      "components/admin/views/TenantSettings.tsx",
      "components/admin/JobsPanels.tsx",
      "components/admin/ErasuresPanel.tsx",
      "components/admin/AgentKillSwitchPanel.tsx",
      "components/admin/MfaEnrollment.tsx",
      "components/ReviewDashboard/ReviewDashboard.tsx",
      "components/ReviewDashboard/recorded.tsx",
    ]) {
      expect(existsSync(join(ROOT, file))).toBe(true);
      expect(brokenRules(readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
    }
    // The old "unavailable" notice went with the last screen that showed it.
    expect(existsSync(join(ROOT, "components/admin/PanelUnavailable.tsx"))).toBe(false);
  });

  const PLANTED: readonly [RuleId, string][] = [
    ["raw-table", `return <table className="w-full"><tbody /></table>;`],
    ["own-panel-state", `if (!data) return <p>{t("loading")}</p>;`],
    ["own-panel-state", `return <PanelUnavailable panel={title} />;`],
    ["own-outcome", `return <p role="status">{message}</p>;`],
    ["own-outcome", `return <div aria-live="polite">{text}</div>;`],
    ["own-confirm", `return <div role="alertdialog" tabIndex={-1} />;`],
    ["own-confirm", `const [confirmDelete, setConfirmDelete] = useState(false);`],
    ["own-confirm", `if (!window.confirm(question)) return;`],
    ["own-call", `const res = await apiFetch("/api/admin/roles");`],
    ["own-call", `const res = await fetch(url);`],
    ["raw-control", `return <input value={v} onChange={change} />;`],
    ["raw-control", `return <select value={v}>{options}</select>;`],
    ["raw-code-or-id", `return <code>{row.name}</code>;`],
    ["raw-code-or-id", `return <td className="font-mono text-xs">{value}</td>;`],
    ["raw-code-or-id", `return <td>{row.proposalId}</td>;`],
    ["raw-code-or-id", `return <span>{job.kind}</span>;`],
  ];

  it.each(PLANTED)(
    "[self-test] %s is reported for a planted violation: %s",
    (rule, source) => {
      expect(brokenRules(source)).toContain(rule);
      expect(judge("components/admin/New.tsx", brokenRules(source), undefined)).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`components/admin/New.tsx: ${rule}`),
        ])
      );
    }
  );

  it("[self-test] a screen built from the shared parts is clean; a comment naming a table is not a table", () => {
    const clean = `
      // It was a hand-built <table> with its own role="status" line.
      /* apiFetch( was called here; <code>{id}</code> was shown. */
      export function View({ rows }) {
        const { read, reload } = usePanelRead("/api/admin/x");
        return (
          <PanelState read={read} panel={title} onReload={reload}>
            {() => <AdminTable caption={title} columns={columns} rows={rows} rowKey={key} />}
          </PanelState>
        );
      }`;
    expect(brokenRules(clean)).toEqual([]);
    expect(judge("components/admin/View.tsx", brokenRules(clean), undefined)).toEqual([]);
  });

  it("[self-test] the list only shrinks: a fixed rule, an emptied entry and a gone file each fail", () => {
    const table = brokenRules(`<table />`);
    // Still broken as listed: nothing to say.
    expect(judge("a.tsx", table, { pass: "56d-3", rules: ["raw-table"] })).toEqual([]);
    // A rule it no longer breaks stays in its entry: stale.
    expect(
      judge("a.tsx", table, { pass: "56d-3", rules: ["raw-table", "own-call"] })
    ).toEqual([expect.stringContaining("no longer breaks own-call")]);
    // A new kind of violation in a known file is still a violation.
    expect(
      judge("a.tsx", brokenRules(`<table /><input />`), {
        pass: "56d-3",
        rules: ["raw-table"],
      })
    ).toEqual([expect.stringContaining("a.tsx: raw-control")]);
    // Converted, and still listed.
    expect(judge("a.tsx", [], { pass: "56d-3", rules: ["raw-table"] })).toEqual([
      expect.stringContaining("no longer breaks raw-table"),
    ]);
    // A listed file that is not a screen file.
    expect(
      scan({ "components/admin/Gone.tsx": { pass: "56d-3", rules: ["raw-table"] } })
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("components/admin/Gone.tsx: in the known list"),
      ])
    );
  });
});
