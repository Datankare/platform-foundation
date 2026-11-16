/**
 * @jest-environment node
 */
/**
 * __tests__/catalogue-plain-words.test.ts — what a screen shows is written for the person reading
 * it, not for the engineer who wrote it (TASK-220, SF-admin-160)
 *
 * @guard a screen's text (a `screens.*` value of the catalogue) that names code: a function call,
 * a source file, a design record or a task, a stored name in snake_case or camelCase, a provider's
 * API call, the jargon "fail-closed", or a panel that does not exist
 *
 * The 2026-11-12 screen review found administrators reading "setKnownFeaturesFallback() in
 * instrumentation.ts", "min(requested_ttl, per-agent maxTokenTtl, this)", "(ADR-041)", "(TASK-203)",
 * "DescribeUserPool answered another pool", "fail-closed (config unavailable)" and "Use the tool
 * panel…" — for a panel that is not there. The literal-text guards count text in JSX only; text
 * that is itself developer wording passed them. This one reads every catalogue's `screens.*`
 * values, parsed as the ICU messages they are (intl-messageformat, the engine the catalogue is
 * rendered with): only what a person reads is judged — never an argument's name or a select's
 * case key (`{table, select, role_permissions {…}}` names a code on purpose and shows words).
 *
 * The rules are patterns, so a proxy: they find the shapes developer wording takes, not every
 * unclear sentence — the walk and the screens' own tests read the rest.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IntlMessageFormat } from "intl-messageformat";

const ROOT = join(__dirname, "..");
/** Every catalogue a screen reads: the platform's, and a consuming app's own when it has one. */
const CATALOGUES = ["messages/en.json", "messages/app/en.json"].filter((file) =>
  existsSync(join(ROOT, file))
);

export const RULES: readonly (readonly [string, RegExp])[] = [
  ["a function call", /\w\(\)/],
  ["a source file", /\b[\w/-]+\.(?:ts|tsx|js|mjs|cjs|sql)\b/],
  ["a design record or task", /\b(?:ADR|TASK)-\d/],
  ["a stored name in snake_case", /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/],
  ["a name in camelCase", /\b[a-z]+[A-Z][A-Za-z0-9]*\b/],
  ["a provider's API call", /\b[A-Z][a-z]+(?:[A-Z][a-z]+){2,}\b/],
  ["the jargon “fail-closed”", /\bfail[- ]closed\b/i],
  ["a panel that does not exist", /\btool panel\b/i],
];

type Node = {
  readonly type: number;
  readonly value?: unknown;
  readonly options?: Record<string, { readonly value: Node[] }>;
  readonly children?: Node[];
};

/** The text a person reads in an ICU message: its literals, in every branch. */
export function readText(message: string): string {
  let ast: Node[];
  try {
    ast = new IntlMessageFormat(message, "en").getAst() as unknown as Node[];
  } catch {
    // Not a message the engine reads: judged as it stands.
    return message;
  }
  const out: string[] = [];
  const walk = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      // 0: a literal; select/plural options and a tag's children hold more of them.
      if (node.type === 0 && typeof node.value === "string") out.push(node.value);
      for (const option of Object.values(node.options ?? {})) walk(option.value);
      if (node.children) walk(node.children);
    }
  };
  walk(ast);
  return out.join(" ");
}

/** What is wrong with one value (empty: nothing). */
export function plainWordProblems(message: string): string[] {
  const text = readText(message);
  return RULES.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

/** Every `screens.*` value of a catalogue, by its dotted key. */
function screenValues(catalogue: unknown): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") {
      if (path.startsWith("screens.")) out.push([path, node]);
      return;
    }
    if (node && typeof node === "object")
      for (const [key, value] of Object.entries(node))
        walk(value, path ? `${path}.${key}` : key);
  };
  walk(catalogue, "");
  return out;
}

describe("a screen's text is plain words (SF-admin-160)", () => {
  it.each(CATALOGUES)("%s: no screen text names code", (file) => {
    const catalogue = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as unknown;
    const values = screenValues(catalogue);
    expect(values.length).toBeGreaterThan(0);
    const problems = values.flatMap(([key, value]) =>
      plainWordProblems(value).map((rule) => `${file} ${key}: ${rule} — “${value}”`)
    );
    expect(problems).toEqual([]);
  });

  const PLANTED: readonly (readonly [string, string])[] = [
    ["a function call", "Kept in sync with setKnownFeaturesFallback() at start-up."],
    ["a source file", "Its built-in list is in lib/agent-identity.ts."],
    ["a design record or task", "Clamped to its bounds (ADR-041 D1)."],
    ["a design record or task", "Days it is kept (TASK-203)."],
    ["a stored name in snake_case", "Features blocked for account_status = restricted."],
    ["a name in camelCase", "The lifetime is min(requested, maxTokenTtl)."],
    ["a provider's API call", "DescribeUserPool answered another pool"],
    ["the jargon “fail-closed”", "Config unavailable — using fail-closed thresholds."],
    ["a panel that does not exist", "Use the tool panel to search."],
  ];

  it.each(PLANTED)("[self-test] %s is reported: %s", (rule, message) => {
    expect(plainWordProblems(message)).toContain(rule);
  });

  it("[self-test] an argument's name and a select's case keys are not what a person reads", () => {
    expect(
      plainWordProblems(
        "{count, plural, one {# row} other {# rows}} of {table, select, role_permissions {role permissions} audit_log {the audit log} other {a table}} for {account_email}"
      )
    ).toEqual([]);
    expect(
      readText("{table, select, role_permissions {role permissions} other {x}}")
    ).toBe("role permissions x");
  });

  it("[self-test] plain sentences pass, numbers and words with hyphens included", () => {
    expect(
      plainWordProblems(
        "The most, in US dollars, any one agent may spend in a day. Default 24 hours; at most 1,000 steps and 16 MiB."
      )
    ).toEqual([]);
  });
});
