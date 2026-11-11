/**
 * @jest-environment node
 */
/**
 * The AI-engineering review process (TASK-183, docs/AI_ENGINEERING.md) — what can be held by a
 * test is held here, in every repository that takes the platform's tests:
 *
 * @guard a review process file or workflow that drifts from what the process requires
 *
 *   - CLAUDE.md carries the standing rules, and stays short;
 *   - REVIEW.md states each area's failure and the review rules;
 *   - every reviewer eval case is indexed and has the parts a score needs;
 *   - the review workflows run on pull_request only (never pull_request_target, so a fork's PR
 *     gets no secret), pin every action to a commit, check out without credentials and hold no
 *     permission beyond the ones they need;
 *   - the PR template asks for the evidence;
 *   - the article is acknowledged, and the formal-verification source is cross-referenced, not
 *     copied.
 *
 * The per-change protocol itself is run by the AI engineer, not by CI; nothing here claims to
 * prove it ran (AI_ENGINEERING §3).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

describe("CLAUDE.md", () => {
  const text = read("CLAUDE.md");

  it("is short: an index of rules and pointers, not a manual", () => {
    expect(text.split("\n").length).toBeLessThanOrEqual(90);
  });

  // TASK-204 (N-10): the gate it gives runs what CI runs — every script it names exists, the lint
  // refuses warnings, and the database suites run (`npm test` alone skips every one of them).
  it("its gate names only scripts that exist, and runs the database suites", () => {
    const gate = /```zsh\n(npm run [^\n]+)\n/.exec(text)?.[1] ?? "";
    const scripts = (
      JSON.parse(read("package.json")) as { scripts: Record<string, string> }
    ).scripts;
    const named = [...gate.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(named).toEqual(expect.arrayContaining(["lint", "test:db"]));
    expect(named.filter((n) => !(n in scripts))).toEqual([]);
    expect(scripts.lint).toMatch(/--max-warnings 0\b/);
    expect(gate).not.toMatch(/&& npm test\b/);
    expect(read("scripts/test-db.sh")).toMatch(/REQUIRE_DB_TESTS=1/);
  });

  // TASK-204 (N-14): a rule that holds only beside a baseline says so, naming the baseline.
  it("names the baselines its text-and-errors rule holds beside", () => {
    // platform-foundation's "Errors and text", Playform's "Data, errors, text".
    const rule =
      /\*\*(?:Errors and text|Data, errors, text):\*\*[\s\S]*?(?=\n- \*\*)/.exec(
        text
      )?.[0] ?? "";
    expect(rule).toMatch(/screen-literal-baseline\.json/);
    expect(rule).toMatch(/\bR-75\b/);
    expect(rule).toMatch(/\bR-77\b/);
  });

  it.each([
    [
      "the branch flow and who promotes",
      /develop → staging → main\. The owner promotes, in the GitHub GUI/,
    ],
    [
      "secrets only through hidden prompts",
      /never display, request or echo a secret[\s\S]*hidden prompt/,
    ],
    ["zsh-paste-safe commands", /zsh-paste-safe/],
    ["hostile tests with every change", /Every change ships with hostile tests/],
    ["a screen for every refusal", /Every refusal has a screen/],
    ["migrations from files, in the SQL Editor", /Supabase SQL Editor, from the files/],
    [
      "no hand edits but the documented bootstraps (TASK-203: each one named)",
      /No hand edits of data[\s\S]*first-super-admin\s+bootstrap[\s\S]*first\s+safety\s+approver[\s\S]*second\s+super\s+admin[\s\S]*reconciling\s+the\s+migration\s+record/,
    ],
    ["verify before claiming", /Verify before claiming/],
    ["match effort to stakes", /Match effort to stakes[\s\S]*pre-launch/],
    ["the review protocol before handover", /AI_ENGINEERING\.md\) §3/],
    [
      "the enforced engineering process (TASK-200)",
      /enforced, not optional \(TASK-200\)[\s\S]*Design check[\s\S]*Self-review[\s\S]*process-check\.mjs/,
    ],
    [
      "the task group a subject ends with, and the threat model (TASK-200)",
      /ends its subject with[\s\S]*\(TASK-nnn\)[\s\S]*Threat model/,
    ],
    ["how a gate is reviewed (TASK-200)", /REVIEW\.md 18–24/],
    [
      "a threat model names only actors that exist (TASK-200 round 7)",
      /only actors that exist[\s\S]*absent actor is out of scope/,
    ],
  ])("states %s", (_name, re) => {
    expect(text).toMatch(re);
  });

  (existsSync(join(ROOT, "e2e-live")) ? it : it.skip)(
    "in an app with a live journey: every user-facing feature adds its e2e-live step",
    () => {
      expect(text).toMatch(/user-facing feature adds its `e2e-live\/` step/);
    }
  );
});

describe("REVIEW.md", () => {
  const text = read("REVIEW.md");

  it.each([
    "lets the wrong person in or locks the right one out",
    "leaks across tenants",
    "can't be replayed or loses data",
    "runs twice, never, or deadlocks",
    "it lies",
    "dead-ends or hides the reason",
    "misroutes or weakens a gate",
    "an unbounded query or a per-request fan-out",
  ])("says what failure looks like: %s", (failure) => {
    expect(text).toContain(failure);
  });

  it("sets the rules: tags, every nit listed, file:line, a counted summary, skipped paths", () => {
    for (const tag of ["**Important**", "**Low**", "**Nit**", "**Pre-existing**"])
      expect(text).toContain(tag);
    // TASK-204 (N-13): no cap — every finding, every Nit, is listed and fixed.
    expect(text).toMatch(/Every finding is listed — every Nit too/);
    expect(text).not.toMatch(/Nits are capped|three per review/);
    expect(text).toMatch(/names a file and line/);
    expect(text).toMatch(/summary opens with a count/);
    expect(text).toContain('"Nothing to fix."');
    // TASK-197 round 3: a PR too large to diff is reviewed by an admin, merged by the bypass.
    expect(text).toMatch(/has not been reviewed\*\*[\s\S]*admin\s+bypass/);
    // TASK-200: the engineering process's blocking rules, the ones no machine checks.
    for (const rule of [
      "Every caller moves with its response",
      "The design check is true",
      "No existing tenant is weakened",
      "Hostile tests can fail",
      "Tested against real responses",
      "Guards can fail",
      "Inputs are the schema's",
      "The self-review was done",
      // TASK-200 round 5: how a gate or a security boundary is reviewed.
      "A threat model before code",
      "Three lenses a round",
      "Fix the class",
      "The stop rule",
    ])
      expect(text).toContain(`**${rule}.**`);
    for (const rule of [
      "A coverage table from each reviewer:",
      "The fixer attacks its own fix**",
      "Mutation testing runs on gate and security code**",
    ])
      expect(text).toContain(rule);
    // TASK-200 round 7: a threat model names only actors that exist for the repository.
    expect(text).toMatch(
      /actors that really\s+exist[\s\S]*out of scope, not a\s+residual/
    );
    for (const skipped of [
      "fake-fetch-baseline.json",
      "body-schema-baseline.json",
      "platform/modules/platform-paths.json",
      "package-lock.json",
      "coverage-baseline.json",
      "docs/API_ERRORS.md",
    ])
      expect(text).toContain(`\`${skipped}\``);
  });
});

describe("the reviewer eval set", () => {
  const DIR = join(ROOT, "docs/review-evals");
  /** Every folder of cases: docs/review-evals and each folder under it holding markdown. */
  const folders = [DIR, ...readdirSync(DIR).map((n) => join(DIR, n))].filter(
    (d) => statSync(d).isDirectory() && readdirSync(d).some((f) => f.endsWith(".md"))
  );
  const cases = folders.flatMap((d) =>
    readdirSync(d)
      .filter((f) => /^\d{2}-[a-z0-9-]+\.md$/.test(f))
      .map((f) => ({ folder: d, file: f }))
  );

  it("finds the platform's cases (self-test)", () => {
    expect(cases.filter((c) => c.folder === DIR).length).toBeGreaterThanOrEqual(10);
  });

  it("every folder of cases has a README that lists each of its cases", () => {
    const unlisted = folders.flatMap((d) => {
      const index = existsSync(join(d, "README.md"))
        ? readFileSync(join(d, "README.md"), "utf8")
        : "";
      return cases
        .filter((c) => c.folder === d && !index.includes(`](${c.file})`))
        .map((c) => `${d}/${c.file}`);
    });
    expect(unlisted).toEqual([]);
  });

  it("every case has the parts a score needs, and names where the defect was", () => {
    const sections = [
      "## What the diff did",
      "## The defect",
      "## Where",
      "## How it was caught",
      "## The finding a reviewer should have produced",
      "## Scoring",
    ];
    const bad = cases.flatMap(({ folder, file }) => {
      const text = readFileSync(join(folder, file), "utf8");
      const missing = sections.filter((s) => !text.includes(`\n${s}\n`));
      const where = text.split("## Where")[1]?.split("##")[0] ?? "";
      const fields = ["| Source ", "| Review input ", "| Fixed in "].filter(
        (f) => !text.includes(f)
      );
      return [
        ...missing.map((s) => `${file}: no "${s}"`),
        ...fields.map((f) => `${file}: no ${f.trim()} field`),
        ...(/`[^`]*\.[a-z][^`]*`/.test(where) ? [] : [`${file}: "Where" names no file`]),
        ...(/\*\*Important\*\* — `/.test(text)
          ? []
          : [`${file}: the expected finding is not an Important one with its location`]),
      ];
    });
    expect(bad).toEqual([]);
  });

  it("the README states the scoring rubric and the keep rule", () => {
    const readme = readFileSync(join(DIR, "README.md"), "utf8");
    expect(readme).toMatch(/## Scoring rubric/);
    expect(readme).toMatch(/2 — caught[\s\S]*1 — partial[\s\S]*0 — missed/);
    expect(readme).toMatch(/\*\*Keep rule:\*\*/);
  });
});

type Step = { uses?: string; with?: Record<string, unknown>; run?: string };
type Job = { permissions?: Record<string, string>; steps: Step[] };
type Workflow = {
  on: Record<string, unknown>;
  permissions?: unknown;
  jobs: Record<string, Job>;
};

/** The security review workflow (TASK-183; our own step since TASK-204, N-86). */
const wf = parse(read(".github/workflows/security-review.yml")) as Workflow & {
  jobs: { "security-review": Job & { env: Record<string, string> } };
};
const job = wf.jobs["security-review"];

/** What the security review workflow must not do (TASK-204, N-86): each problem found, by name. */
export function securityReviewProblems(text: string): string[] {
  const code = text.replace(/^\s*#.*$/gm, "");
  const out: string[] = [];
  if (/claude-code-security-review@/.test(code)) out.push("uses the third-party action");
  if (/claude-[a-z]+-\d/.test(code)) out.push("names a model");
  if (!/SECURITY_REVIEW_RESULTS="\$RUNNER_TEMP\//.test(code))
    out.push("writes its results into the checkout");
  if (/security-review\.mjs[^\n]*(?:\|\|\s*true|; *exit 0)/.test(code))
    out.push("swallows the review's exit code");
  return out;
}

describe("the review workflows", () => {
  const WORKFLOWS = ["review-tier.yml", "security-review.yml"].map(
    (f) => `.github/workflows/${f}`
  );
  const ALLOWED = new Set(["contents:read", "pull-requests:write"]);

  it.each(WORKFLOWS)("%s exists", (file) => {
    expect(existsSync(join(ROOT, file))).toBe(true);
  });

  it.each(WORKFLOWS)(
    "%s runs on pull_request only, pins every action, checks out without credentials, and holds only what it needs",
    (file) => {
      const text = read(file);
      const wf = parse(text) as Workflow;
      expect(Object.keys(wf.on)).toEqual(["pull_request"]);
      // Anywhere outside a comment (the header explains why it is not used).
      expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/pull_request_target/);
      expect(wf.permissions).toEqual({});
      for (const [name, job] of Object.entries(wf.jobs)) {
        const perms = Object.entries(job.permissions ?? {}).map(([k, v]) => `${k}:${v}`);
        expect([name, perms.filter((p) => !ALLOWED.has(p))]).toEqual([name, []]);
        for (const step of job.steps) {
          if (!step.uses) continue;
          expect(step.uses).toMatch(/^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/);
          if (/^actions\/checkout@/.test(step.uses))
            expect(step.with?.["persist-credentials"]).toBe(false);
        }
      }
    }
  );

  it("[self-test] the security review's rules find a re-added action, a named model, an in-tree results file and a swallowed exit", () => {
    const real = read(".github/workflows/security-review.yml");
    expect(securityReviewProblems(real)).toEqual([]);
    const planted = real
      .replace(
        "      - name: Security review (scripts/security-review.mjs)",
        "      - uses: anthropics/claude-code-security-review@0c6a49f1fa56a1d472575da86a94dbc1edb78eda\n        with:\n          claude-model: claude-opus-4-1-20250805\n      - name: Security review (scripts/security-review.mjs)"
      )
      .replace('"$RUNNER_TEMP/security-review-results.json"', "results.json")
      .replace(
        "node scripts/security-review.mjs",
        "node scripts/security-review.mjs || true"
      );
    expect(securityReviewProblems(planted)).toEqual([
      "uses the third-party action",
      "names a model",
      "writes its results into the checkout",
      "swallows the review's exit code",
    ]);
  });

  it("the security review: our own step, its key only from the secret, a skip without it, and the script's exit as the check", () => {
    const text = read(".github/workflows/security-review.yml");
    // TASK-204 (N-86): the third-party action is gone, from the steps and from every `uses:`.
    expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/claude-code-security-review/);
    const review = job.steps.find((st) =>
      /scripts\/security-review\.mjs/.test(st.run ?? "")
    );
    expect(review).toBeDefined();
    const env = (review as { env?: Record<string, string> }).env ?? {};
    expect(env.ANTHROPIC_API_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY }}");
    expect(env.BASE_SHA).toBe("${{ github.event.pull_request.base.sha }}");
    expect(env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    // No model is named in the workflow: the script reads the registry's standard tier.
    expect(text.replace(/^\s*#.*$/gm, "")).not.toMatch(/claude-[a-z]+-\d/);
    // The results go to the runner's temp directory, never into the checkout (N-2).
    expect(review?.run).toMatch(/SECURITY_REVIEW_RESULTS="\$RUNNER_TEMP\//);
    // The checkout has the history the base...head diff needs, and keeps no credentials.
    const checkout = job.steps.find((st) => st.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(job.env.SAME_REPO).toBe(
      "${{ github.event.pull_request.head.repo.full_name == github.repository }}"
    );
    expect(job.env.HAS_KEY).toBe("${{ secrets.ANTHROPIC_API_KEY != '' }}");
    const gated = job.steps.filter((st) => st !== job.steps[0]);
    for (const step of gated)
      expect((step as { if?: string }).if).toBe(
        "env.HAS_KEY == 'true' && env.SAME_REPO == 'true'"
      );
    expect(job.steps[0].run).toMatch(/::notice::Security review skipped/);
    // The script's exit code is the check: no `|| true`, no swallowed status.
    expect(review?.run).not.toMatch(/\|\|\s*true|; *exit 0/);
  });

  it("the security review: a skip is never a pass for a fork, or when the review is required", () => {
    const wf = parse(read(".github/workflows/security-review.yml")) as Workflow & {
      jobs: { "security-review": Job & { env: Record<string, string> } };
    };
    const job = wf.jobs["security-review"];
    const skip = job.steps[0].run ?? "";
    // The variable reaches the shell through env, never as an expression inside run.
    expect(job.env.SECURITY_REVIEW_REQUIRED).toBe("${{ vars.SECURITY_REVIEW_REQUIRED }}");
    expect(job.env.IS_DEPENDABOT).toBe(
      "${{ github.event.pull_request.user.login == 'dependabot[bot]' }}"
    );
    for (const step of job.steps) expect(step.run ?? "").not.toMatch(/\$\{\{/);
    expect(skip).toMatch(
      /if \[ "\$SAME_REPO" != "true" \]; then[^\n]*\n[^\n]*fork[^\n]*\n\s*fail=1/
    );
    expect(skip).toMatch(/if \[ "\$SECURITY_REVIEW_REQUIRED" = "true" \]; then\s*fail=1/);
    expect(skip).toMatch(/Dependabot PRs do not receive repository secrets/);
    expect(skip).toMatch(/::notice::Security review skipped/);
    expect(skip).toMatch(/if \[ "\$fail" -ne 0 \]; then[\s\S]*exit 1/);
  });

  it("the review tier: runs the base's classifier and patterns, with a time limit", () => {
    const wf = parse(read(".github/workflows/review-tier.yml")) as Workflow & {
      jobs: { "review-tier": Job & { "timeout-minutes"?: number } };
    };
    const job = wf.jobs["review-tier"];
    expect(job["timeout-minutes"]).toBeGreaterThan(0);
    const base = job.steps.find(
      (s) => s.uses?.startsWith("actions/checkout@") && s.with?.path === ".risk-tier-base"
    );
    expect(base?.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
    const classify = job.steps.find((s) => /risk-tier\.mjs/.test(s.run ?? ""))?.run ?? "";
    // Every run of the classifier is the base's copy, with the base's patterns.
    const runs = classify.match(/node \S+risk-tier\.mjs[^\n]*/g) ?? [];
    expect(runs.length).toBe(2);
    for (const line of runs)
      expect(line).toMatch(
        /^node "\$BASE_DIR\/scripts\/risk-tier\.mjs" --patterns "\$BASE_DIR" /
      );
    // No base classifier yet: High, never Low.
    expect(classify).toMatch(/no classifier yet[\s\S]*tier=High/);
    // A refusal (exit 2) fails safe: High in the summary and the label, never a missing tier.
    expect(classify).toMatch(
      /if \[ "\$code" -eq 2 \]; then[\s\S]*tier: High \(unreadable path: classification refused\)[\s\S]*tier=High/
    );
    expect(classify).toMatch(/elif \[ "\$code" -ne 0 \]; then[\s\S]*exit 1/);
  });
});

describe("the security review gate (TASK-197, TASK-204)", () => {
  // Review round 3 (the owner's decision): no in-workflow acknowledgement of any kind.
  it("has no acknowledgement mechanism: no label events, no label, no status or issue-events lookup", () => {
    const text = read(".github/workflows/security-review.yml").replace(/^\s*#.*$/gm, "");
    expect(
      (wf as unknown as { on: { pull_request: { types: string[] } } }).on.pull_request
        .types
    ).toEqual(["opened", "reopened", "synchronize"]);
    expect(text).not.toMatch(/labeled|security-review-not-reviewable|statuses|issues\//);
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });
});

describe("the PR template asks for the evidence", () => {
  const text = read(".github/pull_request_template.md");
  it.each([
    "Design check and self-review",
    "Risk tier",
    "Testing",
    "Security",
    "Performance",
    "How to revert",
    "Review rounds",
  ])("## %s", (section) => {
    expect(text).toMatch(new RegExp(`^## ${section}$`, "m"));
  });
});

describe("the acknowledgements", () => {
  const text = read("docs/AI_ENGINEERING.md");
  it("credits the code-review article: title, authors, publication, date and address", () => {
    expect(text).toMatch(/How the Claude Code team does code review/);
    expect(text).toMatch(/Addy Osmani, Morgan\s+Westlee Lunt and Qing Wang/);
    expect(text).toMatch(/claude\.dev Blog, 15 October 2026/);
    expect(text).toContain("https://claude.dev/blog/solving-code-review-at-anthropic/");
  });
  it("credits the practices the engineering process adopts (TASK-200): title and author", () => {
    for (const credit of [
      /Gary Klein\*\*, _Performing a Project Premortem_ \(Harvard Business Review, September 2007\)/,
      /Atul Gawande\*\*, _The Checklist\s+Manifesto_/,
      /Ian Robinson\*\*, _Consumer-Driven Contracts: A Service Evolution Pattern_/,
      /Alexis King\*\*, _Parse, don't validate_ \(2019/,
      /Kent Beck\*\*, _Test-Driven Development: By Example_ \(Addison-Wesley, 2002\)/,
    ])
      expect(text).toMatch(credit);
    expect(text).toMatch(
      /## 3a\. The engineering process: enforced, not optional \(TASK-200\)/
    );
    // TASK-200 round 7: the lesson, and the check as a catcher of our own mistakes.
    expect(text).toMatch(/actors that really exist[\s\S]*out of scope, not a residual/);
    expect(text).toMatch(/catches \*\*our own mistakes\*\*/);
  });

  it("points to ASSURANCE §7 for the formal-verification source rather than copying it", () => {
    expect(text).toMatch(/\[ASSURANCE\]\(ASSURANCE\.md\) §7/);
    expect(text).not.toMatch(/Keane Lucas/);
    expect(read("docs/ASSURANCE.md")).toMatch(/Keane Lucas/);
  });
});
