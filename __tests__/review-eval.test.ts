/**
 * __tests__/review-eval.test.ts — scripts/review-eval.mjs, the scorer of the reviewer's eval set
 * (TASK-183 §6, TASK-204 N-44)
 *
 * @guard a case the scorer cannot read (its review input or its location), or a score that breaks
 * the rubric's hard rule
 *
 * Deterministic: the scorer runs against a local Messages API. Every case on disk is read by the
 * scorer's own parsers ([self-test]); the scoring rule a model cannot override — a 2 needs the
 * Important tag — is held in code.
 */
import { execFileSync, spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/review-eval.mjs");
const KEY = "sk-test-review-eval-not-a-real-key";

function exported(expr: string): unknown {
  const out = execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import * as m from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(${expr}));`,
    ],
    { encoding: "utf8", cwd: ROOT }
  );
  return JSON.parse(out);
}

describe("the eval set as the scorer reads it", () => {
  it("[self-test] every case has a review input of a known form and a location with its file", () => {
    const rows = exported(
      `m.listCases().map((c) => ({ id: c.id, spec: m.inputSpec(m.field(c.text, "Review input")), where: m.expectedWhere(m.section(c.text, "Where")) }))`
    ) as { id: string; spec: { kind: string } | null; where: { file: string } | null }[];
    expect(rows.length).toBeGreaterThanOrEqual(22);
    expect(rows.filter((r) => !r.spec || !r.where).map((r) => r.id)).toEqual([]);
    expect(new Set(rows.map((r) => r.spec?.kind))).toEqual(
      new Set(["files", "patch", "show", "pr"])
    );
  });

  it("a reconstructed patch is the case's input, never the case file", () => {
    const input = exported(
      `m.buildInput(m.inputSpec(m.field(m.listCases().find((c) => c.id === "02").text, "Review input")))`
    ) as string;
    expect(input).toBe(
      readFileSync(
        join(
          ROOT,
          "docs/review-evals/inputs/02-r17-m2-a-kit-case-that-cannot-fail.patch"
        ),
        "utf8"
      )
    );
    expect(input).not.toContain("## The finding a reviewer should have produced");
  });
});

describe("the score (pure)", () => {
  const findings = [
    { tag: "Nit", file: "a.ts", line: 3, finding: "x" },
    { tag: "Important", file: "a.ts", line: 9, finding: "y" },
    { tag: "Low", file: "b.ts", line: 1, finding: "z" },
  ];
  const score = (verdict: unknown) =>
    exported(`m.finalScore(${JSON.stringify(verdict)}, ${JSON.stringify(findings)})`);

  it("a 2 needs the Important tag (capped at 1 in code), and a matched finding", () => {
    expect(score({ score: 2, matched: 1, noise: [] })).toEqual({ score: 2, noise: 0 });
    expect(score({ score: 2, matched: 0, noise: [] })).toEqual({ score: 1, noise: 0 });
    expect(score({ score: 2, matched: null, noise: [] })).toEqual({ score: 0, noise: 0 });
    expect(score({ score: 1, matched: 7, noise: [] })).toEqual({ score: 0, noise: 0 });
  });

  it("[hostile] noise counts real indexes once, never the matched one; a bad verdict is no score", () => {
    expect(score({ score: 2, matched: 1, noise: [0, 0, 1, 2, 9, "x"] })).toEqual({
      score: 2,
      noise: 2,
    });
    expect(score({ score: 3, matched: 1 })).toBeNull();
    expect(score(null)).toBeNull();
  });

  it("[hostile] the reviewer's malformed findings are dropped, not scored", () => {
    expect(
      exported(
        `m.readReviewerFindings(${JSON.stringify(
          JSON.stringify({
            findings: [
              { tag: "Important", file: "a.ts", line: 2, finding: "ok" },
              { tag: "Critical", file: "a.ts", finding: "bad tag" },
              { tag: "Nit", finding: "no file" },
              "junk",
            ],
          })
        )})`
      )
    ).toEqual([{ tag: "Important", file: "a.ts", line: 2, finding: "ok" }]);
    expect(exported(`m.readReviewerFindings("no json here")`)).toBeNull();
  });
});

function api(
  reply: (system: string) => string
): Promise<{ server: Server; systems: string[] }> {
  const systems: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c));
    req.on("end", () => {
      if (req.headers["x-api-key"] !== KEY) return res.writeHead(401).end("{}");
      const body = JSON.parse(raw) as { system: string; messages: { content: string }[] };
      systems.push(body.system);
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ content: [{ type: "text", text: reply(body.system) }] }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, systems })));
}

function run(env: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv,
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stderr.on("data", (d: Buffer) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("scripts/review-eval.mjs", () => {
  it("scores a case: the reviewer gets CLAUDE.md and REVIEW.md, the verifier the rubric; the Runs row", async () => {
    const { server, systems } = await api((system) =>
      system.startsWith("You score a code reviewer")
        ? '{"score": 2, "matched": 0, "noise": [1], "why": "w"}'
        : JSON.stringify({
            findings: [
              { tag: "Important", file: "x.ts", line: 334, finding: "passes either way" },
              { tag: "Nit", file: "y.ts", line: 1, finding: "style" },
            ],
          })
    );
    const out = join(mkdtempSync(join(tmpdir(), "re-")), "r.json");
    try {
      const r = await run(
        {
          ANTHROPIC_API_KEY: KEY,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        ["--cases", "02", "--out", out]
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain("case 02: 2 (noise 1)");
      expect(r.out).not.toContain(KEY);
      expect(systems[0]).toContain("<REVIEW.md>");
      expect(systems[0]).toContain("<CLAUDE.md>");
      const result = JSON.parse(readFileSync(out, "utf8"));
      expect(result).toMatchObject({ total: 2, max: 2, noise: 1 });
      expect(result.row).toMatch(
        /^\| \d{4}-\d{2}-\d{2} \| claude-[\w.-]+, AI_ENGINEERING §3, CLAUDE\.md\/REVIEW\.md `[0-9a-f]+` \| 2 \/ 2 \| 1 \| — \|$/
      );
    } finally {
      server.close();
    }
  });

  it("[hostile] an unreadable reviewer answer leaves the case unscored and fails the run", async () => {
    const { server } = await api(() => "I think it is fine.");
    try {
      const r = await run(
        {
          ANTHROPIC_API_KEY: KEY,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        },
        ["--cases", "02"]
      );
      expect(r.code).toBe(1);
      expect(r.out).toContain(
        "case 02: not scored — the reviewer's answer could not be read"
      );
    } finally {
      server.close();
    }
  });

  it("without a key it says it skipped (never silently); required, that fails", async () => {
    const skipped = await run({});
    expect(skipped.code).toBe(0);
    expect(skipped.out).toContain(
      "::notice::review-eval skipped: ANTHROPIC_API_KEY is not set"
    );
    const required = await run({ REQUIRE_REVIEW_EVAL: "true" });
    expect(required.code).toBe(1);
  });
});
