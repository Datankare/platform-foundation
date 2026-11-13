/**
 * __tests__/workflow-hygiene.test.ts — the repository's GitHub workflows (audit H-9, H-10, H-12)
 *
 * @guard a workflow that weakens a gate: an expression in a script, a bare exclude, an unpinned action
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
 *   - Every job runs on the pinned runner image, `ubuntu-24.04` (TASK-201, S2-C1) — or, in
 *     .github/workflows/macos.yml only, the pinned macOS image `macos-26` (TASK-213): GitHub began
 *     moving `ubuntu-latest` to Ubuntu 26.04 on 2026-10-19, which changes every job at once. A
 *     `-latest` label, an expression, a missing `runs-on` or another image is refused; and the
 *     Postgres apt source names the image's release (`PGDG_CODENAME: noble`), checked against the
 *     runner, never `lsb_release -cs`.
 *
 * Each failure says what to change (TASK-160). platform-foundation's sync template
 * (docs/templates/sync-from-foundation.yml, docs/templates/sync-config.json) is held to the same
 * checks, so the form a consumer copies is the compliant one.
 */

import { spawnSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
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

/** What to write instead of an unanchored sync exclude (H-3; TASK-204, R-80). */
function excludeFix(pattern: string): string {
  return (
    `sync-config exclude "${pattern}" does not start with "/", so rsync matches it against the end ` +
    `of every path (a bare name at any depth; "types/**" inside "shared/types/" too) and keeps ` +
    `platform files out that it was not meant to. Write "/${pattern}", anchored at the root.`
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
      /^sync-config exclude "jest\.setup\.ts" does not start with "\/", .* Write "\/jest\.setup\.ts", anchored at the root\.$/
    );
  });

  it("[self-test] finds expressions in run blocks, and only there", () => {
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
      "    runs-on: ubuntu-24.04",
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

describe("sync excludes (H-3; TASK-204, R-80)", () => {
  const config = join(process.cwd(), ".github/sync-config.json");
  /**
   * Patterns rsync does not anchor at the transfer root: every one without a leading "/". rsync
   * matches such a pattern against the end of each path — a bare name at any depth, and one with
   * a "/" inside it too ("types/**" also matched shared/types/README.md: R-80).
   */
  const unanchored = (patterns: readonly string[]) =>
    patterns.filter((p) => !p.startsWith("/"));

  it("[self-test] refuses every exclude without a leading '/', a directory pattern included", () => {
    expect(
      unanchored([
        "/package.json",
        "package.json",
        "cognito-*",
        "types/**",
        "app/",
        "/types/**",
        "__tests__/cognito-*",
      ])
    ).toEqual(["package.json", "cognito-*", "types/**", "app/", "__tests__/cognito-*"]);
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
  readonly on?: unknown;
  readonly permissions?: unknown;
  readonly defaults?: { readonly run?: { readonly shell?: unknown } };
  readonly jobs?: Record<
    string,
    {
      readonly steps?: Step[];
      readonly env?: Record<string, unknown>;
      readonly permissions?: unknown;
      readonly "continue-on-error"?: unknown;
      readonly if?: unknown;
      readonly defaults?: { readonly run?: { readonly shell?: unknown } };
    }
  >;
}

/** Whether a script line runs the engineering-process check (not an echo or a comment). */
const runsCheckLine = (l: string) =>
  !/^\s*(?:echo|#)/.test(l) && /\bnode scripts\/process-check\.mjs --base\b/.test(l);

/**
 * Whether a workflow runs the engineering-process check (TASK-200): a job with a deep checkout
 * (`fetch-depth: 0`, the history the check reads) and a later step running
 * `node scripts/process-check.mjs --base …`, with no `continue-on-error` or `if:` on the step or
 * its job. It catches our own mistake of dropping or disabling the step; it is no tamper-proofing
 * (TASK-200, "Deliberately not built").
 */
export function runsProcessCheck(workflow: Workflow): boolean {
  const soft = (v: unknown) => v !== undefined && v !== false && v !== "false";
  return Object.values(workflow.jobs ?? {}).some((job) => {
    if (soft(job["continue-on-error"]) || job.if !== undefined) return false;
    const steps = job.steps ?? [];
    const deep = steps.findIndex(
      (st) =>
        /actions\/checkout@/.test(st.uses ?? "") &&
        String(st.with?.["fetch-depth"]) === "0"
    );
    const at = steps.findIndex((st) => (st.run ?? "").split("\n").some(runsCheckLine));
    if (deep < 0 || at <= deep) return false;
    const step = steps[at] as Step & { "continue-on-error"?: unknown };
    return !soft(step["continue-on-error"]) && step.if === undefined;
  });
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
        // TASK-213: the macOS job is the owner's run — npm test with no database and no cache, as
        // on his Mac; CI's Linux jobs run those suites. There, the flags must be absent.
        if (file === MACOS_WORKFLOW) {
          if ((step.env?.[flag] ?? job.env?.[flag]) !== undefined)
            out.push(
              `${label} sets ${flag}: the macOS job is the owner's run, with no database or cache (TASK-213)`
            );
          continue;
        }
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

  it("[self-test] the macOS job (the owner's run) must not require a database or cache; any other must (TASK-213)", () => {
    const owners = (env?: Record<string, string>): Workflow => ({
      jobs: {
        macos: {
          steps: [
            {
              name: "Seed",
              run: 'echo "FC_SEED=1" >> "$GITHUB_ENV" # GITHUB_SHA GITHUB_STEP_SUMMARY',
            },
            {
              name: "npm test",
              run: "env -u CI npm test -- --json --outputFile=jest-results-macos.json",
              env,
            },
            {
              name: "Results",
              if: "failure()",
              uses: "actions/upload-artifact@x",
              with: { path: "jest-results-*.json" },
            },
          ],
        },
      },
    });
    expect(jestPassProblems(MACOS_WORKFLOW, owners(), scripts)).toEqual([]);
    expect(
      jestPassProblems(MACOS_WORKFLOW, owners({ REQUIRE_DB_TESTS: "1" }), scripts)
    ).toEqual([
      expect.stringMatching(/sets REQUIRE_DB_TESTS: the macOS job is the owner's run/),
    ]);
    // The same job anywhere else is held to D-20.
    expect(jestPassProblems("ci.yml", owners(), scripts)).toEqual([
      expect.stringMatching(/without REQUIRE_DB_TESTS: "1"/),
      expect.stringMatching(/without REQUIRE_VALKEY_TESTS: "1"/),
    ]);
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

  it("CI runs the engineering-process check with the history (TASK-200)", () => {
    expect(runsProcessCheck(load(".github/workflows/ci.yml"))).toBe(true);
  });

  it("[self-test] a CI workflow without the process check, or without the history, is refused", () => {
    const checkout = { uses: "actions/checkout@abc", with: { "fetch-depth": 0 } };
    const step = { run: 'set -e\nnode scripts/process-check.mjs --base "$base"' };
    expect(runsProcessCheck({ jobs: { ci: { steps: [checkout, step] } } })).toBe(true);
    expect(runsProcessCheck({ jobs: { ci: { steps: [checkout] } } })).toBe(false);
    expect(
      runsProcessCheck({
        jobs: { ci: { steps: [{ uses: "actions/checkout@abc" }, step] } },
      })
    ).toBe(false);
    expect(
      runsProcessCheck({
        jobs: {
          ci: {
            steps: [checkout, { run: "echo node scripts/process-check.mjs --base x" }],
          },
        },
      })
    ).toBe(false);
    expect(
      runsProcessCheck({
        jobs: {
          ci: { steps: [checkout, { run: "# node scripts/process-check.mjs --base x" }] },
        },
      })
    ).toBe(false);
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

describe("the engineering-process workflows (TASK-200)", () => {
  it("[self-test] a disabled process-check step is refused: continue-on-error or an if", () => {
    const checkout = { uses: "actions/checkout@abc", with: { "fetch-depth": 0 } };
    const run = 'set -e\nnode scripts/process-check.mjs --base "$base"';
    const step = (st: Partial<Step> & Record<string, unknown>, job: object = {}) =>
      runsProcessCheck({
        jobs: { ci: { ...job, steps: [checkout, { run, ...st } as Step] } },
      });
    expect([
      step({ "continue-on-error": true }),
      step({}, { "continue-on-error": true }),
      step({ if: "false" }),
      step({}, { if: "false" }),
    ]).toEqual([false, false, false, false]);
    expect([step({}), step({ "continue-on-error": false })]).toEqual([true, true]);
  });
});

describe("the engineering-process step: no title read, a force-push survived (TASK-200)", () => {
  it("Layer 0f judges a pull request at its head, never its title; after a force-push, since the last promotion", () => {
    expect(
      existsSync(join(process.cwd(), ".github/workflows/process-check-base.yml"))
    ).toBe(false);
    const ciText = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(ciText).not.toMatch(/--pr-title|pull_request\.title/);
    expect(ciText).toMatch(
      /if ! git rev-parse --verify -q "\$base\^\{commit\}"[^\n]*\n[^\n]*\n\s*base=\$\(git merge-base HEAD origin\/staging\)/
    );
    expect(ciText).toMatch(
      /::warning::the push's base is gone \(a force-push\): judging every commit since the last promotion/
    );
  });
});

/**
 * TASK-204 (N-2): the files a workflow's scripts write — `>` and `>>` redirections, `--output`,
 * `--outputFile`, `--output-file` — go to the runner's own places ($RUNNER_TEMP, the $GITHUB_*
 * files, /dev/*), to a variable the script set under $RUNNER_TEMP, or to a path git ignores. A
 * file left in the checkout (the fuzz job's server.log, semgrep.sarif, the security action's
 * error log) dirties the tree a later step checks, and can be swept into a commit.
 */
const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");

export function writtenTargets(script: string): string[] {
  const text = script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    // Quoted text is an echo's words, not a redirection.
    .map((l) => l.replace(/'[^']*'/g, "''"))
    .join("\n");
  const temps = new Set(
    [...text.matchAll(/(?:^|[\s;])([a-z_]\w*)=("?)\$\{?RUNNER_TEMP\b/gim)].map(
      (m) => m[1]
    )
  );
  const out: string[] = [];
  const seen = (target: string) => {
    const t = target.replace(/^"|"$/g, "");
    if (!t || t.startsWith("&")) return;
    if (
      /^\$\{?(?:RUNNER_TEMP|GITHUB_OUTPUT|GITHUB_ENV|GITHUB_STEP_SUMMARY|GITHUB_PATH)\b/.test(
        t
      )
    )
      return;
    if (t.startsWith("/dev/")) return;
    const v = t.match(/^\$\{?([a-z_]\w*)\}?/i);
    if (v && temps.has(v[1])) return;
    out.push(t);
  };
  for (const m of text.matchAll(/(?:^|[\s;|&(])\d?>>?[ \t]*("?[^\s;|&)"]+"?)/gm))
    seen(m[1]);
  for (const m of text.matchAll(/--output(?:File|-file)?(?:=|[ \t]+)("?[^\s;|&)"]+"?)/g))
    seen(m[1]);
  return out;
}

describe("files the workflows write stay out of the checkout (TASK-204, N-2)", () => {
  it("[self-test] finds a redirect or --output into the checkout; passes the runner's places", () => {
    expect(
      writtenTargets(
        [
          "npx next start > server.log 2>&1 &",
          "semgrep --sarif --output semgrep.sarif .",
          "npx jest --outputFile=jest-results-x.json",
          'echo ok >> "$GITHUB_STEP_SUMMARY"',
          'echo "a -> main" > /dev/null',
          'x > "$RUNNER_TEMP/server.log"',
          'dir="$RUNNER_TEMP/base"; ls > "$dir/files.txt"',
          "# echo > commented.txt",
          "echo 'the line > quoted.txt'",
        ].join("\n")
      )
    ).toEqual(["server.log", "semgrep.sarif", "jest-results-x.json"]);
  });

  it("every file a workflow's script writes is under the runner's temp, or ignored by git", () => {
    const targets = [
      ...new Set(
        WORKFLOWS.flatMap((f) =>
          scriptsOf(read(f)).flatMap((sc) => writtenTargets(sc.text))
        )
      ),
    ];
    const status = (f: string) =>
      spawnSync("git", ["check-ignore", "-q", "--no-index", f], { cwd: process.cwd() })
        .status;
    expect(targets.filter((f) => ![0, 1].includes(status(f) ?? -1))).toEqual([]);
    expect(targets.filter((f) => status(f) === 1)).toEqual([]);
  });
});

/** TASK-204 (N-9): Semgrep's blocking rules are pinned to a commit, never the live registry. */
describe("Semgrep's rules are pinned (TASK-204, N-9)", () => {
  const semgrep = WORKFLOWS.filter(
    (f) => /semgrep/.test(read(f)) && /semgrep scan/.test(read(f))
  );

  it("every scan reads the pinned rules, never a registry pack, with metrics off", () => {
    expect(semgrep.length).toBeGreaterThan(0);
    for (const f of semgrep) {
      for (const sc of scriptsOf(read(f)).filter((x) => /semgrep scan/.test(x.text))) {
        expect([f, sc.text]).not.toEqual([
          f,
          expect.stringMatching(/--config[ =]+(?:p|r)\//),
        ]);
        expect([f, sc.text]).toEqual([
          f,
          expect.stringMatching(
            /--metrics=off --config "\$RUNNER_TEMP\/semgrep-rules\.yml"/
          ),
        ]);
      }
    }
  });

  it("the pin is a 40-hex commit of semgrep-rules, with directories and a floor", () => {
    const spec = JSON.parse(read(".semgrep/rules.json")) as {
      repository: string;
      commit: string;
      dirs: string[];
      min_rules: number;
    };
    expect(spec.repository).toBe("https://github.com/semgrep/semgrep-rules");
    expect(spec.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(spec.dirs.length).toBeGreaterThan(0);
    expect(spec.min_rules).toBeGreaterThan(0);
  });
});

describe("the sync never opens a pull request that would roll the app back (TASK-204)", () => {
  const files = [
    "docs/templates/sync-from-foundation.yml",
    ".github/workflows/sync-from-foundation.yml",
  ].filter((f) => existsSync(join(process.cwd(), f)));
  const steps = (file: string) =>
    ((parseDocument(readFileSync(join(process.cwd(), file), "utf8")).toJS() as Workflow)
      .jobs?.sync?.steps ?? []) as (Step & { id?: string })[];
  const named = (file: string, name: string) =>
    steps(file).find((st) => st.name === name);

  it("both guards gate the sync and the pull request; both checkouts have their history", () => {
    for (const f of files) {
      const both =
        "steps.guard.outputs.proceed == 'true' && steps.carried.outputs.proceed == 'true'";
      expect([f, named(f, "Sync files")?.if]).toEqual([f, both]);
      expect([f, named(f, "Open the pull request")?.if]).toEqual([f, both]);
      expect(named(f, "History guard")?.run).toMatch(
        /^bash target\/\.github\/scripts\/sync-carried-guard\.sh source target >> "\$GITHUB_OUTPUT"$/
      );
      expect(named(f, "History guard")?.if).toBe("steps.guard.outputs.proceed == 'true'");
      const checkouts = steps(f).filter((st) => st.uses?.startsWith("actions/checkout@"));
      expect(checkouts).toHaveLength(2);
      for (const c of checkouts) expect([f, c.with?.["fetch-depth"]]).toEqual([f, 0]);
      expect(named(f, "Fetch the platform's develop")?.run).toContain(
        "+refs/heads/develop:refs/remotes/origin/develop"
      );
    }
  });

  it("[self-test] a guard that says no closes every open sync pull request, and nothing else", () => {
    const step = named(files[0], "Close sync pull requests that would roll back");
    expect(step?.if).toBe(
      "steps.guard.outputs.proceed == 'false' || steps.carried.outputs.proceed == 'false'"
    );
    for (const f of files)
      expect(named(f, "Close sync pull requests that would roll back")?.run).toBe(
        step?.run
      );
    const dir = mkdtempSync(join(tmpdir(), "sync-close-"));
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/bash",
        'echo "$*" >> "$GH_LOG"',
        'if [ "$1 $2" = "api --paginate" ]; then printf "%b" "$GH_OPEN"; fi',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    const close = (open: string) => {
      const log = join(dir, "gh.log");
      writeFileSync(log, "");
      const r = spawnSync("bash", ["-c", step?.run ?? "exit 9"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_LOG: log,
          GH_OPEN: open,
          GH_REPO: "o/r",
        },
      });
      return {
        status: r.status,
        calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
      };
    };
    try {
      expect(close("")).toEqual({
        status: 0,
        calls: [expect.stringMatching(/^api --paginate repos\/o\/r\/pulls\?state=open/)],
      });
      const both = close("7\tauto-sync/foundation-1\n9\tauto-sync/foundation-2\n");
      expect(both.status).toBe(0);
      expect(both.calls.slice(1)).toEqual([
        expect.stringMatching(
          /^api -X POST repos\/o\/r\/issues\/7\/comments -f body=Closed: /
        ),
        "api -X PATCH repos/o/r/pulls/7 -f state=closed",
        "api -X DELETE repos/o/r/git/refs/heads/auto-sync/foundation-1",
        expect.stringMatching(
          /^api -X POST repos\/o\/r\/issues\/9\/comments -f body=Closed: /
        ),
        "api -X PATCH repos/o/r/pulls/9 -f state=closed",
        "api -X DELETE repos/o/r/git/refs/heads/auto-sync/foundation-2",
      ]);
      // The list asked for is the sync branches' only (the --jq filter), so nothing else is closed.
      expect(both.calls[0]).toContain('startswith("auto-sync/")');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the sync opens one pull request at a time (TASK-200, round 8)", () => {
  /** The sync workflows here: the template, and an app's own copy when it has one. */
  const files = [
    "docs/templates/sync-from-foundation.yml",
    ".github/workflows/sync-from-foundation.yml",
  ].filter((f) => existsSync(join(process.cwd(), f)));
  const openStep = (file: string) => {
    const wf = parseDocument(
      readFileSync(join(process.cwd(), file), "utf8")
    ).toJS() as Workflow;
    const step = (wf.jobs?.sync?.steps ?? []).find(
      (s) => s.name === "Open the pull request"
    );
    return step;
  };

  it("finds the template (and an app's copy), the same step in each, with the rights it needs", () => {
    expect(files).toContain("docs/templates/sync-from-foundation.yml");
    const runs = files.map((f) => openStep(f)?.run ?? "");
    expect(runs[0]).not.toBe("");
    expect(new Set(runs).size).toBe(1);
    for (const f of files) {
      const wf = parseDocument(
        readFileSync(join(process.cwd(), f), "utf8")
      ).toJS() as Workflow;
      expect([f, wf.permissions]).toMatchObject([
        f,
        { contents: "write", "pull-requests": "write" },
      ]);
      // REST only: gh api, and gh pr for the new pull request; no GraphQL.
      expect(openStep(f)?.run).not.toMatch(/\bgraphql\b/);
    }
  });

  it("[self-test] an open sync pull request for the same sha: nothing new; a new one supersedes the rest", () => {
    const run = openStep(files[0])?.run ?? "";
    const dir = mkdtempSync(join(tmpdir(), "sync-pr-"));
    const bin = join(dir, "bin");
    const target = join(dir, "target");
    const origin = join(dir, "origin.git");
    mkdirSync(bin);
    // A stub gh: records each call; the open pull requests list is GH_OPEN (as --jq prints it).
    writeFileSync(
      join(bin, "gh"),
      [
        "#!/bin/bash",
        'echo "$*" >> "$GH_LOG"',
        'if [ "$1 $2" = "pr create" ]; then echo "https://github.com/o/r/pull/42"; fi',
        'if [ "$1 $2" = "api --paginate" ]; then printf "%b" "$GH_OPEN"; fi',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) =>
      spawnSync("git", ["-C", target, ...args], { encoding: "utf8", env });
    spawnSync("git", ["init", "-q", "--bare", origin]);
    mkdirSync(target);
    git("init", "-q", "-b", "develop");
    writeFileSync(join(target, "a.txt"), "a\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("remote", "add", "origin", origin);
    const sha = "abcdef1".padEnd(40, "0");
    const sync = (open: string, changed = true) => {
      git("checkout", "-q", "-f", "develop");
      git("clean", "-qfd");
      if (changed) writeFileSync(join(target, "b.txt"), "b\n");
      const log = join(dir, "gh.log");
      const summary = join(dir, "summary.md");
      writeFileSync(log, "");
      writeFileSync(summary, "");
      const r = spawnSync("bash", ["-c", run], {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...env,
          PATH: `${bin}:${process.env.PATH}`,
          GH_LOG: log,
          GH_OPEN: open,
          GH_REPO: "o/r",
          SOURCE: "o/pf",
          REF: "main",
          SHA: sha,
          GITHUB_STEP_SUMMARY: summary,
        },
      });
      return {
        status: r.status,
        calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
        summary: readFileSync(summary, "utf8"),
      };
    };
    try {
      // Nothing changed: up to date, no call at all.
      expect(sync("", false)).toEqual({
        status: 0,
        calls: [],
        summary: `Up to date with o/pf main @ ${sha}\n`,
      });
      // An open sync pull request for this sha (full or short in its title): nothing new.
      for (const title of [`@ ${sha}`, "@ abcdef1"]) {
        const same = sync(
          `7\tauto-sync/foundation-1\tchore(sync): inherit platform-foundation main ${title}\n`
        );
        expect(same.status).toBe(0);
        expect(same.calls).toHaveLength(1);
        expect(same.calls[0]).toMatch(/^api --paginate repos\/o\/r\/pulls\?state=open/);
        expect(same.summary).toBe(
          "Sync pull request #7 is already open for o/pf @ abcdef1: nothing new opened\n"
        );
      }
      // Older sync pull requests (another sha), and another branch's that is no sync's: the new
      // one is opened, each older sync closed with a comment and its branch deleted.
      const older = [
        `7\tauto-sync/foundation-1\tchore(sync): inherit platform-foundation main @ ${"1".repeat(40)}`,
        `8\tauto-sync/foundation-2\tchore(sync): inherit platform-foundation main @ 2222222`,
      ].join("\n");
      const fresh = sync(`${older}\n`);
      expect(fresh.status).toBe(0);
      expect(fresh.calls.slice(1, 2)[0]).toMatch(
        /^pr create --base develop --head auto-sync\/foundation-/
      );
      expect(fresh.calls.slice(2)).toEqual([
        "api -X POST repos/o/r/issues/7/comments -f body=Superseded by #42.",
        "api -X PATCH repos/o/r/pulls/7 -f state=closed",
        "api -X DELETE repos/o/r/git/refs/heads/auto-sync/foundation-1",
        "api -X POST repos/o/r/issues/8/comments -f body=Superseded by #42.",
        "api -X PATCH repos/o/r/pulls/8 -f state=closed",
        "api -X DELETE repos/o/r/git/refs/heads/auto-sync/foundation-2",
      ]);
      expect(fresh.summary).toContain(
        "Opened sync pull request #42 for o/pf main @ abcdef1\n"
      );
      expect(fresh.summary).toContain(
        "Closed #8 (auto-sync/foundation-2): superseded by #42\n"
      );
      // None open: the new one alone.
      expect(sync("").calls.filter((c) => /^api -X/.test(c))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * TASK-201 (S2-C1): the runner image every job runs on, and the Ubuntu release the Postgres apt
 * source (apt.postgresql.org) names for it. Changed together, in one commit, to a release PGDG
 * publishes.
 */
export const RUNNER_IMAGE = "ubuntu-24.04";
export const RUNNER_CODENAME = "noble";
/**
 * TASK-213 (T-1): the one other image — macOS, pinned like the Ubuntu one (macos-26 is macos-latest's
 * image today: Apple silicon, bash 3.2.57) — and the one workflow allowed to use it. The owner runs
 * every commit script on a Mac; this job runs the tests there (__tests__/shell-portability.test.ts
 * checks what it runs). Anywhere else a macOS label is refused: macOS minutes are billed at a
 * multiple on a private repository.
 */
export const MACOS_RUNNER_IMAGE = "macos-26";
export const MACOS_WORKFLOW = ".github/workflows/macos.yml";
/** How the apt source names the release: the step's own PGDG_CODENAME (built: not a template). */
const PGDG_SUITE = ["$", "{PGDG_CODENAME}-pgdg"].join("");

/** A job's `runs-on` that is not the pinned image, as messages (a reusable workflow's has none). */
export function runnerProblems(file: string, wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    const j = job as { "runs-on"?: unknown; uses?: unknown };
    if (j.uses !== undefined && j["runs-on"] === undefined) continue;
    const runsOn = j["runs-on"];
    const labels =
      typeof runsOn === "string"
        ? [runsOn]
        : Array.isArray(runsOn)
          ? runsOn
          : runsOn !== null && typeof runsOn === "object"
            ? [runsOn]
            : [];
    const label = `${file} job ${id}`;
    if (runsOn === undefined || labels.length === 0) {
      out.push(`${label} has no runs-on: write runs-on: ${RUNNER_IMAGE}`);
      continue;
    }
    for (const l of labels) {
      if (typeof l !== "string") {
        out.push(
          `${label}: runs-on ${JSON.stringify(l)} names no image — write runs-on: ${RUNNER_IMAGE}`
        );
      } else if (/\$\{\{/.test(l)) {
        out.push(
          `${label}: runs-on "${l}" is an expression, so its image cannot be checked — write runs-on: ${RUNNER_IMAGE}`
        );
      } else if (/-latest$/.test(l)) {
        out.push(
          `${label}: runs-on "${l}" moves to a new image when GitHub moves the label (ubuntu-latest began moving to Ubuntu 26.04 on 2026-10-19) — write runs-on: ${RUNNER_IMAGE}`
        );
      } else if (l === MACOS_RUNNER_IMAGE) {
        if (file !== MACOS_WORKFLOW)
          out.push(
            `${label}: runs-on "${l}" — macOS runs only in ${MACOS_WORKFLOW} (TASK-213); write runs-on: ${RUNNER_IMAGE}`
          );
      } else if (l !== RUNNER_IMAGE) {
        out.push(
          `${label}: runs-on "${l}" is not a pinned image — write runs-on: ${RUNNER_IMAGE} (or move every job, RUNNER_IMAGE and PGDG_CODENAME together; macOS: ${MACOS_RUNNER_IMAGE}, in ${MACOS_WORKFLOW} only)`
        );
      }
    }
  }
  return out;
}

/**
 * A step that adds the apt.postgresql.org source, as messages, unless it names the release from
 * its own `PGDG_CODENAME` (the pinned image's) and fails on a runner of another release.
 */
export function pgdgProblems(file: string, wf: Workflow): string[] {
  const out: string[] = [];
  for (const [id, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const run = step.run ?? "";
      const lines = run
        .split("\n")
        .filter(
          (l) => /apt\.postgresql\.org\/pub\/repos\/apt\b/.test(l) && /\bdeb\b/.test(l)
        );
      if (lines.length === 0) continue;
      const label = `${file} job ${id}, step "${step.name ?? ""}"`;
      if (
        /lsb_release|\/etc\/os-release[^\n]*-pgdg/.test(lines.join("\n")) ||
        lines.some((l) => /\$\(/.test(l))
      )
        out.push(
          `${label}: the apt source reads the release from the runner — name it with ${PGDG_SUITE}`
        );
      else if (!lines.every((l) => /\$\{?PGDG_CODENAME\}?-pgdg\b/.test(l)))
        out.push(`${label}: the apt source must name ${PGDG_SUITE}`);
      if (String(step.env?.PGDG_CODENAME ?? "") !== RUNNER_CODENAME)
        out.push(
          `${label}: env PGDG_CODENAME must be ${RUNNER_CODENAME} (the release of ${RUNNER_IMAGE})`
        );
      if (
        !/\/etc\/os-release/.test(run) ||
        !/VERSION_CODENAME/.test(run) ||
        !/!=\s*"\$PGDG_CODENAME"[\s\S]*exit 1/.test(run)
      )
        out.push(
          `${label}: compare the runner's VERSION_CODENAME (/etc/os-release) with $PGDG_CODENAME and exit 1 when they differ`
        );
    }
  }
  return out;
}

describe("runner images are pinned (TASK-201, S2-C1)", () => {
  const load = (file: string): Workflow =>
    parseDocument(readFileSync(join(process.cwd(), file), "utf8")).toJS() as Workflow;
  const files = WORKFLOWS.filter((f) => !f.startsWith(".github/actions/"));

  it("[self-test] refuses ubuntu-latest, an expression, no runs-on, another image; passes the pinned one and a reusable workflow", () => {
    const wf = parseDocument(
      [
        "jobs:",
        "  latest:",
        "    runs-on: ubuntu-latest",
        "  arm:",
        "    runs-on: [self-hosted, ubuntu-latest]",
        "  expr:",
        "    runs-on: ${{ matrix.os }}",
        "  none:",
        "    steps: [{ run: x }]",
        "  older:",
        "    runs-on: ubuntu-22.04",
        "  group:",
        "    runs-on: { group: big }",
        "  pinned:",
        "    runs-on: ubuntu-24.04",
        "  reuse:",
        "    uses: ./.github/workflows/other.yml",
        "  mac:",
        "    runs-on: macos-26",
        "  maclatest:",
        "    runs-on: macos-latest",
        "  macold:",
        "    runs-on: macos-15",
      ].join("\n")
    ).toJS() as Workflow;
    expect(runnerProblems("w.yml", wf)).toEqual([
      expect.stringMatching(
        /^w\.yml job latest: runs-on "ubuntu-latest" moves to a new image/
      ),
      expect.stringMatching(
        /^w\.yml job arm: runs-on "self-hosted" is not a pinned image/
      ),
      expect.stringMatching(/^w\.yml job arm: runs-on "ubuntu-latest" moves/),
      expect.stringMatching(/^w\.yml job expr: runs-on ".*" is an expression/),
      "w.yml job none has no runs-on: write runs-on: ubuntu-24.04",
      expect.stringMatching(
        /^w\.yml job older: runs-on "ubuntu-22\.04" is not a pinned image/
      ),
      expect.stringMatching(
        /^w\.yml job group: runs-on \{"group":"big"\} names no image/
      ),
      'w.yml job mac: runs-on "macos-26" — macOS runs only in .github/workflows/macos.yml (TASK-213); write runs-on: ubuntu-24.04',
      expect.stringMatching(
        /^w\.yml job maclatest: runs-on "macos-latest" moves to a new image/
      ),
      expect.stringMatching(
        /^w\.yml job macold: runs-on "macos-15" is not a pinned image/
      ),
    ]);
    // In the macOS workflow, macos-26 (and only it) is pinned.
    expect(
      runnerProblems(MACOS_WORKFLOW, wf).filter((p) => /job mac(?:latest|old)?:/.test(p))
    ).toEqual([
      expect.stringMatching(/job maclatest: runs-on "macos-latest" moves/),
      expect.stringMatching(/job macold: runs-on "macos-15" is not a pinned image/),
    ]);
  });

  it("[self-test] refuses a Postgres apt source read from the runner, or not checked against it", () => {
    const deb = (release: string) =>
      `echo "deb [signed-by=k] https://apt.postgresql.org/pub/repos/apt ${release}-pgdg main" | sudo tee x`;
    const check =
      'c=$(. /etc/os-release && echo "$VERSION_CODENAME")\nif [ "$c" != "$PGDG_CODENAME" ]; then\n  exit 1\nfi';
    const job = (run: string, env?: Record<string, unknown>): Workflow => ({
      jobs: { db: { steps: [{ name: "pg", run, env }] } },
    });
    expect(pgdgProblems("ci.yml", job(deb("$(lsb_release -cs)")))).toEqual([
      expect.stringMatching(/reads the release from the runner/),
      expect.stringMatching(/env PGDG_CODENAME must be noble/),
      expect.stringMatching(/compare the runner's VERSION_CODENAME/),
    ]);
    expect(
      pgdgProblems("ci.yml", job(`${check}\n${deb("noble")}`, { PGDG_CODENAME: "noble" }))
    ).toEqual([expect.stringMatching(/must name \$\{PGDG_CODENAME\}-pgdg/)]);
    expect(
      pgdgProblems(
        "ci.yml",
        job(`${check}\n${deb("${PGDG_CODENAME}")}`, { PGDG_CODENAME: "resolute" })
      )
    ).toEqual([expect.stringMatching(/env PGDG_CODENAME must be noble/)]);
    expect(
      pgdgProblems("ci.yml", job(deb("${PGDG_CODENAME}"), { PGDG_CODENAME: "noble" }))
    ).toEqual([expect.stringMatching(/compare the runner's VERSION_CODENAME/)]);
    expect(
      pgdgProblems(
        "ci.yml",
        job(`${check}\n${deb("${PGDG_CODENAME}")}`, { PGDG_CODENAME: "noble" })
      )
    ).toEqual([]);
    expect(pgdgProblems("ci.yml", job("sudo apt-get install -y x"))).toEqual([]);
  });

  it("every job of every workflow (and template) runs on the pinned image", () => {
    const jobs = files.flatMap((f) => Object.keys(load(f).jobs ?? {}));
    expect(jobs.length).toBeGreaterThan(10);
    expect(files.flatMap((f) => runnerProblems(f, load(f)))).toEqual([]);
  });

  it("every Postgres apt source names the pinned release and checks it against the runner", () => {
    const steps = files.flatMap((f) =>
      Object.values(load(f).jobs ?? {}).flatMap((j) =>
        (j.steps ?? []).filter((s) =>
          /apt\.postgresql\.org\/pub\/repos\/apt/.test(s.run ?? "")
        )
      )
    );
    expect(steps.length).toBeGreaterThan(0);
    expect(files.flatMap((f) => pgdgProblems(f, load(f)))).toEqual([]);
  });
});

/** TASK-204 (N-8, N-21): what CI runs agrees with the handover gate, and the config is not stale. */
describe("the gates' configuration (TASK-204)", () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
    scripts: Record<string, string>;
    jest: { coveragePathIgnorePatterns?: string[] };
  };

  it("lint refuses warnings, as CLAUDE.md's gate does (N-8)", () => {
    expect(pkg.scripts.lint).toMatch(/^eslint \. .*--max-warnings 0\b/);
    const ci = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/run: npm run lint\b/);
  });

  it("every coverage ignore that names a file names one that exists (N-21)", () => {
    const named = (pkg.jest.coveragePathIgnorePatterns ?? []).filter((p) =>
      /\.[cm]?[jt]sx?$/.test(p)
    );
    expect(named.filter((p) => !existsSync(join(process.cwd(), p)))).toEqual([]);
  });
});
