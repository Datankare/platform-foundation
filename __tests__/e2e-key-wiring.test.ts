/**
 * __tests__/e2e-key-wiring.test.ts — an E2E spec that skips without a setting runs where CI gives
 * it that setting (TASK-212)
 *
 * @guard an E2E journey that skips in CI because the workflow never passes the key it needs
 *
 * platform-foundation's model journey (e2e/assistant.spec.ts, test 4: `test.skip` when
 * ANTHROPIC_API_KEY is unset) was always skipped in CI: the build step received the key, the E2E
 * step did not, and nothing said so (register NEW-1). Each setting an E2E spec's `test.skip`
 * condition reads — directly (`process.env.X`) or through a constant set from it — must reach
 * every workflow step that runs the E2E layer (`npm run test:e2e`): in that step's own `env:` as
 * `X: ${{ secrets.X }}` (or `vars.X`), in its job's `env:`, or written to `$GITHUB_ENV` by an
 * earlier step of the same job.
 *
 * Runs in every repository that takes the platform's tests, over its own e2e/ and workflows.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from "yaml";

const ROOT = process.cwd();

/** The settings each spec's test.skip conditions read: spec → names. */
function skipSettings(specText: string): string[] {
  const constants = new Map<string, string>();
  for (const m of specText.matchAll(
    /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*process\.env\.([A-Z][A-Z0-9_]*)\b/g
  )) {
    constants.set(m[1], m[2]);
  }
  const names = new Set<string>();
  for (const m of specText.matchAll(/\btest\.skip\(([^,]*),/g)) {
    const condition = m[1];
    for (const e of condition.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g))
      names.add(e[1]);
    for (const id of condition.matchAll(/[a-z_$][\w$]*/gi)) {
      const set = constants.get(id[0]);
      if (set) names.add(set);
    }
  }
  return [...names].sort();
}

interface E2EStep {
  readonly where: string;
  /** Settings this step receives: its env, its job's env, and earlier $GITHUB_ENV writes. */
  readonly receives: ReadonlySet<string>;
}

const envKeys = (node: unknown): string[] =>
  isMap(node) ? node.items.map((i) => String(isScalar(i.key) ? i.key.value : i.key)) : [];

/** Every step that runs `npm run test:e2e`, with what it receives. */
function e2eSteps(files: Record<string, string>): E2EStep[] {
  const out: E2EStep[] = [];
  for (const [file, text] of Object.entries(files)) {
    const doc = parseDocument(text);
    const jobs = doc.get("jobs");
    if (!isMap(jobs)) continue;
    for (const job of jobs.items) {
      const jobName = String(isScalar(job.key) ? job.key.value : job.key);
      const body = job.value as YAMLMap | null;
      if (!isMap(body)) continue;
      const jobEnv = envKeys(body.get("env"));
      const written = new Set<string>();
      const steps = body.get("steps");
      if (!isSeq(steps)) continue;
      steps.items.forEach((step, index) => {
        if (!isMap(step)) return;
        const run = String(step.get("run") ?? "");
        if (/npm run test:e2e\b/.test(run)) {
          out.push({
            where: `${file} job ${jobName} step ${String(step.get("name") ?? index + 1)}`,
            receives: new Set([...jobEnv, ...written, ...envKeys(step.get("env"))]),
          });
        }
        for (const m of run.matchAll(
          /\b([A-Z][A-Z0-9_]*)=[^\n]*>>\s*"?\$GITHUB_ENV"?/g
        )) {
          written.add(m[1]);
        }
      });
    }
  }
  return out;
}

const workflows = (): Record<string, string> => {
  const dir = join(ROOT, ".github/workflows");
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")])
  );
};

const specs = (): Record<string, string> => {
  const dir = join(ROOT, "e2e");
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith(".spec.ts"))
      .map((f) => [f, readFileSync(join(dir, f), "utf8")])
  );
};

describe("E2E key wiring (TASK-212)", () => {
  it("every setting a spec's test.skip reads reaches every step that runs the E2E layer", () => {
    const steps = e2eSteps(workflows());
    expect(steps.length).toBeGreaterThan(0);
    const needed = Object.entries(specs()).flatMap(([spec, text]) =>
      skipSettings(text).map((name) => ({ spec, name }))
    );
    // The model journey's key is among them in both repositories (e2e/assistant.spec.ts).
    expect(needed).toContainEqual({
      spec: "assistant.spec.ts",
      name: "ANTHROPIC_API_KEY",
    });
    const missing = steps.flatMap((s) =>
      needed
        .filter(({ name }) => !s.receives.has(name))
        .map(({ spec, name }) => `${s.where}: ${name} (needed by e2e/${spec})`)
    );
    expect(missing).toEqual([]);
  });

  it("[self-test] reads a skip's setting directly and through a constant", () => {
    expect(
      skipSettings(`
        const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
        test.skip(!OWNER_URL, "needs the database");
        test("x", () => {
          test.skip(
            !process.env.SOME_KEY,
            "needs a key, see TASK-060."
          );
        });
        test.skip(({ browserName }) => browserName === "webkit", "no webkit");
      `)
    ).toEqual(["E2E_DATABASE_OWNER_URL", "SOME_KEY"]);
  });

  it("[self-test] a step without the key is caught; its env, its job's or $GITHUB_ENV supply it", () => {
    const wf = (stepEnv: string, jobEnv = "", earlier = "echo hi") => ({
      "ci.yml": `
jobs:
  test:
    runs-on: ubuntu-24.04
${jobEnv}
    steps:
      - name: prepare
        run: |
          ${earlier}
      - name: E2E
        run: npm run test:e2e -- --fail-on-flaky-tests
${stepEnv}
`,
    });
    const receives = (files: Record<string, string>) => [...e2eSteps(files)[0].receives];
    expect(receives(wf(""))).toEqual([]);
    expect(
      receives(wf("        env:\n          SOME_KEY: ${{ secrets.SOME_KEY }}"))
    ).toEqual(["SOME_KEY"]);
    expect(receives(wf("", "    env:\n      SOME_KEY: x"))).toEqual(["SOME_KEY"]);
    expect(receives(wf("", "", 'echo "SOME_KEY=v" >> "$GITHUB_ENV"'))).toEqual([
      "SOME_KEY",
    ]);
    // Written by a step after the E2E step: too late, not counted.
    const later = `
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - name: E2E
        run: npm run test:e2e
      - name: after
        run: echo "SOME_KEY=v" >> "$GITHUB_ENV"
`;
    expect(receives({ "ci.yml": later })).toEqual([]);
  });
});
