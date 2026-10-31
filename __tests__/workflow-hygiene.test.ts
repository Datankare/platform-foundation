/**
 * __tests__/workflow-hygiene.test.ts — the repository's GitHub workflows (audit H-9, H-10, H-12)
 *
 * Runs in every repository that takes the platform's tests, over that repository's own
 * workflows (a consumer's sync workflow included).
 *
 *   - No `${{ … }}` expression inside a `run:` script, except a static matrix value: a value an
 *     outsider can choose (a workflow input, a branch name, a pull request's title, a step's
 *     output built from them) is shell-interpolated before the script runs, which is command
 *     injection (H-9: the sync workflow interpolated its `source_ref` input). Pass it through
 *     `env:` and quote the variable instead.
 *   - Every scanner installed from a package index is pinned (H-12: semgrep was unpinned) — by
 *     pip, pipx, uv or a global npm install (review 7 L3).
 *   - The same holds for an actions/github-script `script:` input (JavaScript), and for a script
 *     under any block-scalar header (`|2`, `>2-`), and for an expression holding a `}`
 *     (`format('{0}', github.head_ref)`) — each slipped past the scan before (review 7 L3).
 *   - Workflows are parsed as YAML (review 8 L4), not scanned line by line: a step written as a
 *     flow mapping (`- { run: "…" }`), a plain scalar continuing a `run:` over several lines, an
 *     alias (`run: *script`) to an anchored value, and a composite action's steps
 *     (.github/actions/<name>/action.yml) each slipped past the line scan.
 *   - The promotion guard checks what is promoted, not only the branch's name (H-10).
 *   - A consumer's sync excludes are anchored (H-3): a pattern with no "/" — `package.json`,
 *     `instrumentation.ts`, `cognito-*` — matches at any depth, so it silently keeps the platform's
 *     `platform/ai/instrumentation.ts` (or any future file of that name) out of the consumer.
 *     A root file is written `/package.json`.
 *
 * Each failure says what to change (TASK-160). platform-foundation's sync template
 * (docs/templates/sync-from-foundation.yml, docs/templates/sync-config.json) is held to the same
 * checks, so the form a consumer copies is the compliant one.
 */

import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import {
  LineCounter,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type Node,
} from "yaml";

const DIR = join(process.cwd(), ".github/workflows");
const TEMPLATES = join(process.cwd(), "docs/templates");
const yamlIn = (dir: string, prefix: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => `${prefix}${f}`)
    : [];
/** Every composite action's definition under `dir`, at any depth (paths from the root). */
function actionsIn(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return actionsIn(full, `${prefix}${name}/`);
    return /^action\.ya?ml$/.test(name) ? [`${prefix}${name}`] : [];
  });
}
/**
 * The repository's workflows, its composite actions (review 8 L4) and the platform's workflow
 * templates (paths from the root).
 */
const WORKFLOWS = [
  ...yamlIn(DIR, ".github/workflows/"),
  ...actionsIn(join(process.cwd(), ".github/actions"), ".github/actions/"),
  ...yamlIn(TEMPLATES, "docs/templates/"),
];

/** What to write instead of an expression inside a script (H-9). */
function runExpressionFix(file: string, line: number, expr: string): string {
  const name =
    expr
      .split(".")
      .pop()
      ?.replace(/[^a-z0-9]+/gi, "_")
      .toUpperCase() || "VALUE";
  const expression = ["$", "{{ ", expr, " }}"].join("");
  return (
    `${file}:${line}: "${expression}" is inside a run: script, where the shell sees its value as code. ` +
    `Move it to the step's env: (env: { ${name}: ${expression} }) and write "$${name}" in the script.`
  );
}

/** What to write instead of an unanchored sync exclude (H-3). */
function excludeFix(pattern: string): string {
  const bare = pattern.replace(/\/+$/, "");
  return (
    `sync-config exclude "${pattern}" has no "/", so rsync matches it at any depth (it also keeps out ` +
    `platform files named ${bare} in subdirectories). Write "/${pattern}" for the root ${pattern.endsWith("/") ? "directory" : "file"}, ` +
    `or "<dir>/${pattern}" for one elsewhere.`
  );
}

/**
 * The `${{ … }}` expressions in `text`, with the offset each starts at. An expression ends at the
 * first `}}` outside a quoted string (review 7 L3: `[^}]*` missed `format('{0}', github.head_ref)`,
 * whose `}` ended the match early, and so never saw the outside value).
 */
function expressionsIn(text: string): { at: number; expr: string }[] {
  const out: { at: number; expr: string }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf("${{", from);
    if (start < 0) return out;
    let k = start + 3;
    let quoted = false;
    while (k < text.length) {
      if (text[k] === "'") {
        // '' inside a string is an escaped quote.
        if (quoted && text[k + 1] === "'") k++;
        else quoted = !quoted;
      } else if (!quoted && text.startsWith("}}", k)) break;
      k++;
    }
    out.push({ at: start, expr: text.slice(start + 3, k).trim() });
    from = k + 2;
  }
}

/** One script: its text (as YAML gives it) and the line of each of its lines' start. */
interface Script {
  readonly text: string;
  /** The line the script's first line is on. */
  readonly line: number;
  /** A block scalar: each line of the text is one line of the file. */
  readonly block: boolean;
}

/** `text` parsed as YAML — aliases resolved, merge keys honoured — or the parse errors thrown. */
function parsed(text: string): { doc: Document; lineOf: (offset: number) => number } {
  const counter = new LineCounter();
  const doc = parseDocument(text, {
    lineCounter: counter,
    merge: true,
    uniqueKeys: false,
    prettyErrors: false,
  });
  if (doc.errors.length > 0)
    throw new Error(`not valid YAML: ${doc.errors.map((e) => e.message).join("; ")}`);
  return { doc, lineOf: (offset) => counter.linePos(offset).line };
}

/** The script a value node holds (an alias resolved to what it names), or none. */
function scriptOf(
  doc: Document,
  lineOf: (offset: number) => number,
  value: unknown
): Script | null {
  const at = value as Node | null;
  const node = isAlias(at) ? at.resolve(doc) : at;
  if (!isScalar(node) || typeof node.value !== "string") return null;
  const block = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
  // Where it is used: an alias is reported at the alias, the script being the anchored value.
  const start = (isAlias(at) ? at.range : node.range)?.[0] ?? 0;
  return {
    text: node.value,
    line: lineOf(start) + (block && !isAlias(at) ? 1 : 0),
    block,
  };
}

/** `node` with an alias resolved to what it names (review 9 L8: aliases everywhere). */
function resolved(doc: Document, node: unknown): unknown {
  let at = node;
  // An alias may name another alias's target; a cycle cannot be built in YAML, but be bounded.
  for (let i = 0; i < 16 && isAlias(at); i++)
    at = (at as { resolve(d: Document): unknown }).resolve(doc);
  return at;
}

/** A merge key (`<<`): the parser gives it as a symbol with merge on, as text without. */
function isMergeKey(key: unknown): boolean {
  if (!isScalar(key)) return false;
  const v = key.value;
  return v === "<<" || (typeof v === "symbol" && v.description === "<<");
}

/**
 * A mapping's value for `key` (a plain key): the mapping itself an alias resolved, a merge key
 * (`<<: *base`, or a list of them) followed when the key is not set directly, and the value an
 * alias resolved — review 9 L8: `with: *alias` hid a github-script's `script:`.
 */
function valueAt(doc: Document, map: unknown, key: string, depth = 0): unknown {
  const m = resolved(doc, map);
  if (!isMap(m) || depth > 16) return undefined;
  const pair = m.items.find((p) => isScalar(p.key) && p.key.value === key);
  if (pair) return resolved(doc, pair.value);
  for (const merge of m.items.filter((p) => isMergeKey(p.key))) {
    const from = resolved(doc, merge.value);
    const sources = isSeq(from) ? from.items : [from];
    for (const source of sources) {
      const found = valueAt(doc, source, key, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Whether a `uses:` value names actions/github-script — its owner and name compared without
 * case, as GitHub resolves them (review 9 L8: `Actions/GitHub-Script@v7` slipped past).
 */
function isGithubScript(uses: unknown): boolean {
  return (
    isScalar(uses) &&
    typeof uses.value === "string" &&
    /^actions\/github-script@/i.test(uses.value.trim())
  );
}

/**
 * Every `run:` script of a workflow or composite action, and every actions/github-script
 * `script:` input (JavaScript, where an interpolated value is code just as in a shell — review 7
 * L3), from the parsed document: block or flow style, plain, quoted or block scalars, aliases.
 */
function scriptsOf(text: string): Script[] {
  const { doc, lineOf } = parsed(text);
  const out: Script[] = [];
  visit(doc, {
    Pair(_, pair) {
      if (isScalar(pair.key) && pair.key.value === "run") {
        const script = scriptOf(doc, lineOf, pair.value);
        if (script) out.push(script);
      }
    },
    Map(_, map) {
      if (isGithubScript(valueAt(doc, map, "uses"))) {
        const script = scriptOf(
          doc,
          lineOf,
          valueAt(doc, valueAt(doc, map, "with"), "script")
        );
        if (script) out.push(script);
      }
    },
  });
  return out.sort((a, b) => a.line - b.line);
}

/** The expressions in the given scripts, each with its line (one may span several lines). */
function expressionsOfScripts(
  scripts: readonly Script[]
): { line: number; expr: string }[] {
  return scripts.flatMap((script) =>
    expressionsIn(script.text).map((e) => ({
      // A block scalar keeps the file's line breaks; a flow or plain one folds them away.
      line:
        script.line +
        (script.block ? script.text.slice(0, e.at).split("\n").length - 1 : 0),
      expr: e.expr,
    }))
  );
}

/** The expressions inside each script of a workflow, with their line numbers. */
function runExpressions(text: string): { line: number; expr: string }[] {
  return expressionsOfScripts(scriptsOf(text));
}

/** Options whose next word is a value, not a package. */
const VALUE_OPTIONS = new Set([
  "-r",
  "--requirement",
  "-c",
  "--constraint",
  "-i",
  "--index-url",
  "--extra-index-url",
  "--python",
  "--prefix",
  "--registry",
  "--cache",
]);

/**
 * The packages each install command names, with the command, so each can be checked for a pin:
 * pip (pip, pip3, python -m pip), pipx, uv (uv pip install, uv tool install) and global npm
 * (npm install -g / i -g / --global) — review 7 L3: only `pip install` was looked at.
 */
function installs(text: string): { command: string; pkg: string; pinned: boolean }[] {
  const out: { command: string; pkg: string; pinned: boolean }[] = [];
  const forms: {
    re: RegExp;
    command: string;
    pin: (pkg: string) => boolean;
    npm?: true;
  }[] = [
    {
      re: /(?:^|[\s;&|(])(?:python3? -m )?pip3? install\s+([^\n#;&|]+)/g,
      command: "pip install",
      pin: (p) => /==/.test(p),
    },
    {
      re: /(?:^|[\s;&|(])pipx install\s+([^\n#;&|]+)/g,
      command: "pipx install",
      pin: (p) => /==/.test(p),
    },
    {
      re: /(?:^|[\s;&|(])uv (?:pip|tool) install\s+([^\n#;&|]+)/g,
      command: "uv install",
      pin: (p) => /==/.test(p),
    },
    {
      re: /(?:^|[\s;&|(])npm (?:install|i|add)\s+([^\n#;&|]+)/g,
      command: "npm install -g",
      // An exact version: name@1.2.3 (a scope's @ is not the version's).
      pin: (p) => /^(?:@[^/]+\/)?[^@]+@\d+\.\d+\.\d+(?:[-+][\w.]+)?$/.test(p),
      npm: true,
    },
  ];
  for (const form of forms) {
    for (const m of text.matchAll(form.re)) {
      const words = m[1].trim().split(/\s+/);
      if (form.npm && !words.some((w) => w === "-g" || w === "--global")) continue;
      for (let k = 0; k < words.length; k++) {
        const w = words[k];
        if (VALUE_OPTIONS.has(w)) {
          k++;
          continue;
        }
        if (w.startsWith("-") || (w.includes("=") && !w.includes("=="))) continue;
        out.push({ command: form.command, pkg: w, pinned: form.pin(w) });
      }
    }
  }
  return out;
}

/** A static value the workflow itself defines. */
const SAFE = /^matrix\.[\w.-]+$/;

describe("workflow hygiene", () => {
  it("self-test: sees the workflows and the sync template", () => {
    expect(WORKFLOWS.length).toBeGreaterThan(0);
    if (existsSync(TEMPLATES))
      expect(WORKFLOWS).toContain("docs/templates/sync-from-foundation.yml");
  });

  it("self-test: a failure says exactly what to change", () => {
    expect(runExpressionFix("sync.yml", 12, "steps.config.outputs.source")).toBe(
      'sync.yml:12: "' +
        ["$", "{{ steps.config.outputs.source }}"].join("") +
        "\" is inside a run: script, where the shell sees its value as code. Move it to the step's env: (env: { SOURCE: " +
        ["$", "{{ steps.config.outputs.source }}"].join("") +
        ' }) and write "$SOURCE" in the script.'
    );
    expect(excludeFix("jest.setup.ts")).toMatch(
      /^sync-config exclude "jest\.setup\.ts" has no "\/", .* Write "\/jest\.setup\.ts" for the root file, or "<dir>\/jest\.setup\.ts" for one elsewhere\.$/
    );
  });

  it("self-test: finds expressions in run blocks, and only there", () => {
    const sample = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - name: x",
      "        env:",
      "          REF: ${{ inputs.ref }}",
      "        run: |",
      '          echo "${{ inputs.source_ref }}"',
      '          echo "$REF ${{ matrix.environment }}"',
      "      - run: git checkout ${{ github.head_ref }}",
    ].join("\n");
    expect(runExpressions(sample).map((e) => e.expr)).toEqual([
      "inputs.source_ref",
      "matrix.environment",
      "github.head_ref",
    ]);
  });

  // Review 7 L3: what the scan missed.
  it("self-test: sees a script under any block header (|2, >2-, |+, |-1, with a comment)", () => {
    for (const header of ["|2", ">2-", "|+", "|-1", ">", "| # a comment"]) {
      const sample = [
        "    steps:",
        `      - run: ${header}`,
        "          git checkout ${{ github.head_ref }}",
      ].join("\n");
      expect([header, runExpressions(sample).map((e) => e.expr)]).toEqual([
        header,
        ["github.head_ref"],
      ]);
    }
  });

  it("self-test: sees an expression holding a }", () => {
    const sample =
      "      - run: echo ${{ format('{0}', github.head_ref) }} ${{ matrix.os }}";
    expect(runExpressions(sample).map((e) => e.expr)).toEqual([
      "format('{0}', github.head_ref)",
      "matrix.os",
    ]);
    expect(expressionsIn("${{ format('}}{0}', inputs.x) }}").map((e) => e.expr)).toEqual([
      "format('}}{0}', inputs.x)",
    ]);
  });

  it("self-test: sees an actions/github-script script: input, and no other step's", () => {
    const sample = [
      "    steps:",
      "      - uses: actions/github-script@v7",
      "        with:",
      "          script: |",
      "            core.info('${{ github.event.pull_request.title }}')",
      "      - name: other",
      "        uses: some/action@v1",
      "        with:",
      "          script: ${{ inputs.harmless_for_this_action }}",
      "      - name: inline",
      "        uses: actions/github-script@v7",
      "        with:",
      "          script: console.log(${{ inputs.x }})",
    ].join("\n");
    expect(runExpressions(sample).map((e) => [e.line, e.expr])).toEqual([
      [5, "github.event.pull_request.title"],
      [13, "inputs.x"],
    ]);
  });

  // Review 9 L8: what the YAML scan still missed — `with:` as an alias, and a mixed-case
  // `uses:` (GitHub resolves owner and name without case).
  it("self-test: sees a github-script script: behind with: *alias, a merge key, and a mixed-case uses:", () => {
    const sample = [
      "x-with: &w",
      "  script: core.info('${{ github.event.pull_request.title }}')",
      "x-base: &base",
      "  uses: actions/github-script@v7",
      "jobs:",
      "  a:",
      "    steps:",
      "      - uses: actions/github-script@v7",
      "        with: *w",
      "      - uses: Actions/GitHub-Script@v7",
      "        with:",
      "          script: console.log(${{ inputs.mixed }})",
      "      - <<: *base",
      "        with:",
      "          <<: *w",
      "      - uses: ACTIONS/GITHUB-SCRIPT@60a0d83039c74a4aee543508d2ffcb1c3799cdea",
      "        with:",
      "          script: ${{ inputs.upper }}",
      "      - uses: actions/github-scripts@v1",
      "        with:",
      "          script: ${{ inputs.not_github_script }}",
    ].join("\n");
    const found = runExpressions(sample).map((e) => e.expr);
    expect(found).toContain("inputs.mixed");
    expect(found).toContain("inputs.upper");
    expect(found.filter((e) => e === "github.event.pull_request.title")).toHaveLength(2);
    expect(found).not.toContain("inputs.not_github_script");
  });

  // Review 8 L4: what the line scan missed — the reviewer's workflow, and each form alone.
  it("self-test: sees a flow-mapping step, a multi-line plain scalar and an alias (the reviewer's workflow)", () => {
    const reviewer = [
      "on: pull_request_target",
      "jobs:",
      "  a:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      '      - { name: flow, run: "echo ${{ github.head_ref }}" }',
      "      - name: plain multi-line",
      "        run: echo start",
      "          ${{ github.event.pull_request.title }}",
      "      - name: anchor",
      "        env:",
      "          X: &s echo ${{ github.head_ref }}",
      "        run: *s",
    ].join("\n");
    expect(runExpressions(reviewer).map((e) => [e.line, e.expr])).toEqual([
      [6, "github.head_ref"],
      [8, "github.event.pull_request.title"],
      [13, "github.head_ref"],
    ]);
  });

  it("self-test: an alias to a block script, a merge key, and a quoted multi-line scalar", () => {
    const sample = [
      "x-script: &script |",
      "  git checkout ${{ inputs.ref }}",
      "x-step: &step",
      "  run: 'echo ${{ github.actor }}'",
      "jobs:",
      "  a:",
      "    steps:",
      "      - run: *script",
      "      - <<: *step",
      "        name: merged",
      '      - run: "first line',
      '          ${{ github.event.issue.title }}"',
    ].join("\n");
    expect(runExpressions(sample).map((e) => e.expr)).toEqual([
      "github.actor",
      "inputs.ref",
      "github.event.issue.title",
    ]);
  });

  it("self-test: a composite action's steps, and an installer in a flow step, are scanned", () => {
    const action = [
      "name: setup",
      "runs:",
      "  using: composite",
      "  steps:",
      '    - { shell: bash, run: "pip install checkov && echo ${{ inputs.version }}" }',
    ].join("\n");
    expect(runExpressions(action).map((e) => e.expr)).toEqual(["inputs.version"]);
    expect(
      installs(
        scriptsOf(action)
          .map((x) => x.text)
          .join("\n")
      )
        .filter((i) => !i.pinned)
        .map((i) => i.pkg)
    ).toEqual(["checkov"]);
    expect(actionsIn(join(process.cwd(), "__tests__"), "__tests__/")).toEqual([]);
  });

  it("self-test: a workflow that is not valid YAML fails, rather than passing unread", () => {
    expect(() => runExpressions("jobs: [unclosed")).toThrow(/not valid YAML/);
  });

  it("self-test: an expression outside any script (env:, with:, if:) is not a finding", () => {
    const sample = [
      "jobs:",
      "  a:",
      "    if: ${{ github.event_name == 'push' }}",
      "    steps:",
      "      - uses: some/action@v1",
      "        with:",
      "          ref: ${{ github.head_ref }}",
      "        env:",
      "          REF: ${{ github.head_ref }}",
      '      - run: echo "$REF"',
    ].join("\n");
    expect(runExpressions(sample)).toEqual([]);
  });

  it("self-test: finds unpinned installs by pip, pipx, uv and global npm", () => {
    const sample = [
      "run: pip install semgrep==1.2.3 bandit",
      "run: python -m pip install -r requirements.txt checkov",
      "run: pipx install zizmor && pipx install actionlint-py==1.0",
      "run: uv tool install ruff",
      "run: uv pip install --index-url https://x.example/simple pkg==2.0",
      "run: npm install -g @scope/tool@1.2.3 snyk",
      "run: npm i --global eslint@latest",
      "run: npm install --save-dev local-only",
    ].join("\n");
    expect(
      installs(sample)
        .filter((i) => !i.pinned)
        .map((i) => `${i.command} ${i.pkg}`)
    ).toEqual([
      "pip install bandit",
      "pip install checkov",
      "pipx install zizmor",
      "uv install ruff",
      "npm install -g snyk",
      "npm install -g eslint@latest",
    ]);
  });

  it.each(WORKFLOWS.length ? WORKFLOWS : ["(none)"])(
    "%s interpolates no outside value into a script (H-9)",
    (file) => {
      if (file === "(none)") return;
      const text = readFileSync(join(process.cwd(), file), "utf8");
      const unsafe = runExpressions(text).filter((e) => !SAFE.test(e.expr));
      expect(unsafe.map((e) => runExpressionFix(file, e.line, e.expr))).toEqual([]);
    }
  );

  it.each(WORKFLOWS.length ? WORKFLOWS : ["(none)"])(
    "%s pins every scanner it installs (H-12)",
    (file) => {
      if (file === "(none)") return;
      const text = readFileSync(join(process.cwd(), file), "utf8");
      // Every script as YAML gives it: flow steps, folded lines and aliases included (L4).
      const scripts = scriptsOf(text)
        .map((script) => script.text)
        .join("\n");
      expect(
        installs(scripts)
          .filter((i) => !i.pinned)
          .map(
            (i) =>
              `${file}: ${i.command} ${i.pkg} is unpinned — write ${i.pkg}${i.command.startsWith("npm") ? "@<version>" : "==<version>"}`
          )
      ).toEqual([]);
    }
  );

  const guard = join(DIR, "promotion-guard.yml");
  // Required, not skipped when absent (TASK-198, D-20): deleting the guard must fail here.
  it("the promotion guard checks the source repository and what is promoted (H-10)", () => {
    expect(existsSync(guard)).toBe(true);
    {
      const text = readFileSync(guard, "utf8");
      expect(text).toMatch(/head\.repo\.full_name/);
      expect(text).toMatch(/origin\/staging\^\{tree\}/);
      expect(text).toMatch(/merge-base --is-ancestor origin\/main/);
    }
  });
});

describe("sync excludes (H-3)", () => {
  const config = join(process.cwd(), ".github/sync-config.json");
  /** Patterns that match at any depth (no "/" except a trailing one). */
  const unanchored = (patterns: readonly string[]) =>
    patterns.filter((p) => !p.replace(/\/+$/, "").includes("/"));

  it("self-test", () => {
    expect(
      unanchored(["/package.json", "package.json", "cognito-*", "types/**", "app/"])
    ).toEqual(["package.json", "cognito-*", "app/"]);
  });

  const configs = [config, join(TEMPLATES, "sync-config.json")].filter((f) =>
    existsSync(f)
  );
  it.each(configs.length ? configs : ["(none)"])(
    "every exclude in %s is anchored",
    (file) => {
      if (file === "(none)") return;
      const { exclude = [], exclude_patterns = [] } = JSON.parse(
        readFileSync(file, "utf8")
      ) as { exclude?: string[]; exclude_patterns?: string[] };
      expect(unanchored([...exclude, ...exclude_patterns]).map(excludeFix)).toEqual([]);
    }
  );
});

/**
 * Fail on absence (TASK-198, D-16, D-20; TASK-191). A check that can skip silently, a test pass
 * that leaves a required suite optional, a failure whose seed and results die with the log, an
 * install that fails the layer on one network blip — each made TASK-191's one-off failure
 * undiagnosable or let a gate pass on nothing. Over every workflow of the repository (and the
 * platform's templates), a consumer's included.
 */
interface Step {
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly if?: string;
  readonly env?: Record<string, unknown>;
  readonly with?: Record<string, unknown>;
}
interface Workflow {
  readonly jobs?: Record<
    string,
    { readonly steps?: Step[]; readonly env?: Record<string, unknown> }
  >;
}

/** The package.json scripts that run jest (`test`, `test:coverage`, …), by name. */
function jestScripts(root = process.cwd()): Set<string> {
  const file = join(root, "package.json");
  if (!existsSync(file)) return new Set();
  const scripts = (
    JSON.parse(readFileSync(file, "utf8")) as { scripts?: Record<string, string> }
  ).scripts;
  return new Set(
    Object.entries(scripts ?? {})
      .filter(
        ([, command]) => /\bjest\b/.test(command) && !/\bplaywright\b/.test(command)
      )
      .map(([name]) => name)
  );
}

/**
 * Whether a step's script runs the jest suite: `npx jest`, `jest`, or `npm test` / `npm run <s>`
 * for a package.json script that runs jest. A line that only echoes is not a run.
 */
export function runsJest(
  run: string,
  scripts: ReadonlySet<string> = jestScripts()
): boolean {
  return run
    .split("\n")
    .filter((l) => !/^\s*(?:echo|#)/.test(l))
    .some((l) => {
      if (/(?:^|[\s;&|(])(?:npx\s+)?jest\b/.test(l)) return true;
      if (/\bnpm\s+test\b/.test(l) && scripts.has("test")) return true;
      return [...l.matchAll(/\bnpm\s+run\s+([\w:.-]+)/g)].some((m) => scripts.has(m[1]));
    });
}

/** What a workflow's jest passes lack, as messages (empty: nothing). */
export function jestPassProblems(
  file: string,
  wf: Workflow,
  scripts: ReadonlySet<string> = jestScripts()
): string[] {
  const out: string[] = [];
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    const steps = job.steps ?? [];
    const jestAt = steps.flatMap((step, i) =>
      step.run && runsJest(step.run, scripts) ? [i] : []
    );
    for (const i of jestAt) {
      const step = steps[i];
      const run = step.run!;
      const label = `${file} job ${id}, step "${step.name ?? run.slice(0, 40)}"`;
      for (const flag of ["REQUIRE_DB_TESTS", "REQUIRE_VALKEY_TESTS"]) {
        if (String(step.env?.[flag] ?? job.env?.[flag] ?? "") !== "1")
          out.push(
            `${label} runs jest without ${flag}: "1" — a missing service would skip its suites (D-20)`
          );
      }
      if (!/--json\b[^\n]*--outputFile=jest-results-/.test(run))
        out.push(
          `${label} keeps no results: add --json --outputFile=jest-results-<pass>.json (D-16)`
        );
      const seeded = steps
        .slice(0, i)
        .some(
          (s) =>
            /\bGITHUB_SHA\b/.test(s.run ?? "") &&
            /FC_SEED=[^\n]*>>\s*"?\$GITHUB_ENV"?/.test(s.run ?? "") &&
            /GITHUB_STEP_SUMMARY/.test(s.run ?? "")
        );
      if (!seeded)
        out.push(
          `${label} runs with an unrecorded fast-check seed: set FC_SEED from $GITHUB_SHA in an earlier step, into $GITHUB_ENV and the step summary (D-16)`
        );
    }
    if (jestAt.length === 0) continue;
    const last = Math.max(...jestAt);
    const uploaded = steps.some(
      (s, k) =>
        k > last &&
        /actions\/upload-artifact@/.test(s.uses ?? "") &&
        /failure\(\)/.test(s.if ?? "") &&
        /jest-results-/.test(String(s.with?.path ?? ""))
    );
    if (!uploaded)
      out.push(
        `${file} job ${id}: no step after its jest passes uploads jest-results-*.json when the job fails (D-16)`
      );
  }
  return out;
}

/** Installs in a workflow that a network blip fails outright, as messages. */
export function installRetryProblems(file: string, wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const run = step.run ?? "";
      const label = `${file} job ${id}, step "${step.name ?? run.slice(0, 40)}"`;
      if (/\bnpm ci\b/.test(run) && !/for attempt in[\s\S]*npm ci &&/.test(run))
        out.push(`${label}: npm ci without a retry loop (TASK-191)`);
      for (const line of run.split("\n")) {
        if (/^\s*(?:#|echo\b)/.test(line)) continue;
        // A download from outside — not a probe of a server (the job's own, or a deployment's
        // health endpoint, polled in a loop of its own).
        if (
          /\bcurl\b/.test(line) &&
          !/localhost|127\.0\.0\.1|\/api\/health/.test(line) &&
          !/--retry\b/.test(line)
        )
          out.push(`${label}: curl without --retry (TASK-191)`);
        if (
          /\bapt-get\s(?:[^\n]*\s)?(?:update|install)\b/.test(line) &&
          !/Acquire::Retries=/.test(line)
        )
          out.push(`${label}: apt-get without -o Acquire::Retries=<n> (TASK-191)`);
      }
    }
  }
  return out;
}

/** A notice or warning that a check, or part of one, did not run. */
const SKIP_ANNOUNCED = /::(?:notice|warning)::/;
const SKIP_WORDS =
  /\bskip(?:ped|ping|s)?\b|\bnot run\b|\bdoes not run\b|\bdid not run\b/i;

/** Steps that announce a skipped check with no switch to make the skip a failure. */
export function silentSkips(file: string, wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const run = step.run ?? "";
      const skips = run
        .split("\n")
        .filter((l) => SKIP_ANNOUNCED.test(l) && SKIP_WORDS.test(l));
      if (skips.length === 0) continue;
      const switched =
        Object.keys({ ...job.env, ...step.env }).some((k) => /_REQUIRED$/.test(k)) &&
        /\$\{?\w+_REQUIRED\}?/.test(run);
      if (!switched) out.push(`${file} job ${id}, step "${step.name ?? ""}"`);
    }
  }
  return out;
}

/** Skips that are not a missing secret, by workflow and step name: the reason. */
const SKIPS_BY_DESIGN: Readonly<Record<string, string>> = {
  '.github/workflows/ci.yml job container-image, step "Deploy smoke test against the image"':
    "the image runs mock providers with no translation key on purpose (no AI credential goes into CI's image); the translation step is proved with real providers against every deployment by the deploy smoke workflow",
};

describe("fail on absence (TASK-198, D-16, D-20)", () => {
  const load = (file: string): Workflow =>
    parseDocument(readFileSync(join(process.cwd(), file), "utf8")).toJS() as Workflow;
  const files = WORKFLOWS;
  const scripts = new Set(["test", "test:coverage", "test:core"]);

  it("self-test: the jest-pass, install and skip checks find what they look for", () => {
    const bare: Workflow = {
      jobs: {
        unit: {
          steps: [
            { name: "Install", run: "npm ci" },
            { run: "sudo curl -fsSL -o k https://x\nsudo apt-get update -qq" },
            {
              name: "seed",
              run: 'echo "FC_SEED=1" >> "$GITHUB_ENV"\necho x >> "$GITHUB_STEP_SUMMARY"',
            },
            {
              uses: "actions/upload-artifact@abc # v7",
              if: "failure()",
              with: { path: "jest-results-*.json" },
            },
            { name: "core", run: "npm run test:core", env: { REQUIRE_DB_TESTS: "1" } },
            { name: "e2e", run: "npm run test:e2e" },
            { name: "probe", run: 'curl -sf -o /dev/null "$TARGET/api/health/ready"' },
          ],
        },
        live: {
          steps: [
            {
              name: "secrets",
              run: 'echo "::notice::Journey A skipped: E2E_USER_EMAIL is not set"\necho "::warning::the scan does not run on forks"',
            },
          ],
        },
      },
    };
    expect(jestPassProblems("ci.yml", bare, scripts)).toEqual([
      expect.stringMatching(/step "core" runs jest without REQUIRE_VALKEY_TESTS/),
      expect.stringMatching(/step "core" keeps no results/),
      expect.stringMatching(/step "core" runs with an unrecorded fast-check seed/),
      expect.stringMatching(/job unit: no step after its jest passes uploads/),
    ]);
    expect(installRetryProblems("ci.yml", bare)).toEqual([
      expect.stringMatching(/step "Install": npm ci without a retry loop/),
      expect.stringMatching(/curl without --retry/),
      expect.stringMatching(/apt-get without -o Acquire::Retries/),
    ]);
    expect(silentSkips("w.yml", bare)).toEqual(['w.yml job live, step "secrets"']);
    expect(runsJest("npx jest --silent", scripts)).toBe(true);
    expect(runsJest("npm test", scripts)).toBe(true);
    expect(runsJest("TZ=x npm run test:core -- --json", scripts)).toBe(true);
    expect(runsJest("npm run test:e2e", scripts)).toBe(false);
    expect(runsJest('echo "replay with npx jest <file>"', scripts)).toBe(false);
    const fixed: Workflow = {
      jobs: {
        unit: {
          steps: [
            { run: "for attempt in 1 2 3; do\n  npm ci && exit 0\ndone\nexit 1" },
            {
              run: 'seed=$((16#${GITHUB_SHA:0:7}))\necho "FC_SEED=$seed" >> "$GITHUB_ENV"\necho "seed" >> "$GITHUB_STEP_SUMMARY"',
            },
            {
              name: "core",
              run: "npm run test:core -- --json --outputFile=jest-results-core.json",
              env: { REQUIRE_DB_TESTS: "1", REQUIRE_VALKEY_TESTS: "1" },
            },
            {
              uses: "actions/upload-artifact@abc # v7",
              if: "failure()",
              with: { path: "jest-results-*.json" },
            },
          ],
        },
        live: {
          steps: [
            {
              name: "secrets",
              env: { JOURNEY_REQUIRED: "${{ vars.JOURNEY_REQUIRED }}" },
              run: 'if [ "$JOURNEY_REQUIRED" = true ]; then exit 1; fi\necho "::notice::Journey A skipped"',
            },
          ],
        },
      },
    };
    expect(jestPassProblems("ci.yml", fixed, scripts)).toEqual([]);
    expect(installRetryProblems("ci.yml", fixed)).toEqual([]);
    expect(silentSkips("w.yml", fixed)).toEqual([]);
  });

  it("the CI workflow exists (a consumer's own included)", () => {
    expect(existsSync(join(process.cwd(), ".github/workflows/ci.yml"))).toBe(true);
  });

  it("every jest pass in every workflow requires its databases and caches, records its seed and keeps its results", () => {
    expect(files.flatMap((f) => jestPassProblems(f, load(f)))).toEqual([]);
    const passes = files.flatMap((f) =>
      Object.values(load(f).jobs ?? {}).flatMap((j) =>
        (j.steps ?? []).filter((s) => s.run && runsJest(s.run))
      )
    );
    expect(passes.length).toBeGreaterThan(3);
  });

  // A results file a jest pass writes stays in the working tree for the job's later steps. One git
  // does not ignore is an untracked file the next pass's tree checks count as the platform's own
  // (module-app-manifest: platform-paths.json lists every file shipped): the core pass failed on
  // the coverage pass's jest-results-coverage.json (TASK-198 follow-up).
  it("every jest results file a workflow writes is ignored by git", () => {
    const written = [
      ...new Set(
        files.flatMap((f) =>
          Object.values(load(f).jobs ?? {}).flatMap((j) =>
            (j.steps ?? []).flatMap((s) =>
              [
                ...(s.run ?? "").matchAll(/--outputFile(?:=|\s+)(["']?)([^\s"']+)\1/g),
              ].map((m) => m[2])
            )
          )
        )
      ),
    ];
    expect(written.length).toBeGreaterThan(0);
    const status = (f: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", f], { cwd: process.cwd() })
        .status;
    // 0: ignored; 1: not ignored; anything else: git could not answer (not a checkout, no git) —
    // a failure that says so, never read as "not ignored".
    const unanswered = written.filter((f) => ![0, 1].includes(status(f) ?? -1));
    expect(unanswered).toEqual([]);
    expect(written.filter((f) => status(f) === 1)).toEqual([]);
  });

  it("every install in every workflow is retried", () => {
    expect(files.flatMap((f) => installRetryProblems(f, load(f)))).toEqual([]);
  });

  it("the fuzz job runs the soak suites whatever the property step did, and alerts a scheduled failure", () => {
    const fuzz = ".github/workflows/fuzz.yml";
    expect(existsSync(join(process.cwd(), fuzz))).toBe(true);
    const steps = Object.values(load(fuzz).jobs ?? {}).flatMap((j) => j.steps ?? []);
    const soak = steps.find((s) => /__tests__\/soak\//.test(s.run ?? ""));
    expect(soak?.name).toMatch(/^Soak/);
    expect(soak?.if).toMatch(/!cancelled\(\)|always\(\)/);
    const alert = steps.find((s) => /gh issue (?:create|comment)/.test(s.run ?? ""));
    expect(alert?.if).toMatch(/failure\(\)[\s\S]*schedule/);
  });

  it("CI compares the journey exemptions with the base branch, before its jest passes (TASK-198 round 1)", () => {
    const jobs = Object.values(load(".github/workflows/ci.yml").jobs ?? {});
    const found = jobs.filter((j) => {
      const steps = j.steps ?? [];
      const at = steps.findIndex((st) =>
        /JOURNEY_BASE=[^\n]*>>\s*"?\$GITHUB_ENV"?/.test(st.run ?? "")
      );
      const firstJest = steps.findIndex((st) => st.run !== undefined && runsJest(st.run));
      const deep = steps.some(
        (st) =>
          /actions\/checkout@/.test(st.uses ?? "") &&
          String(st.with?.["fetch-depth"]) === "0"
      );
      return at >= 0 && firstJest > at && deep;
    });
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(files.filter((f) => f.startsWith(".github/workflows/")))(
    "%s skips no check silently: a skip has a *_REQUIRED switch that makes it a failure",
    (file) => {
      const skips = silentSkips(file, load(file));
      expect(skips.filter((s) => !SKIPS_BY_DESIGN[s])).toEqual([]);
    }
  );

  it("every skip allowed by design is still a skip, with its reason", () => {
    const workflows = files.filter((f) => f.startsWith(".github/workflows/"));
    const all = workflows.flatMap((f) => silentSkips(f, load(f)));
    // Every step of this repository's workflows, named as silentSkips names them: an allowance for
    // a step this repository does not have (a consumer's workflows differ) is not this one's to
    // judge (round 2).
    const steps = new Set(
      workflows.flatMap((f) =>
        Object.entries(load(f).jobs ?? {}).flatMap(([id, job]) =>
          (job.steps ?? []).map((st) => `${f} job ${id}, step "${st.name ?? ""}"`)
        )
      )
    );
    for (const [step, reason] of Object.entries(SKIPS_BY_DESIGN)) {
      expect(reason.length).toBeGreaterThan(40);
      if (!steps.has(step)) continue;
      expect([step, all.includes(step)]).toEqual([step, true]);
    }
  });
});
