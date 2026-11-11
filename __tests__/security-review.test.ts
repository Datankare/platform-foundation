/**
 * __tests__/security-review.test.ts — scripts/security-review.mjs, the pull request's security
 * review (TASK-204, N-86)
 *
 * The script runs for real (node, a real git repository with a base and a head commit), against a
 * local Messages API and a local GitHub API: what it sends, what it posts, and its exit code — the
 * check. Hostile: an answer that cannot be read, is cut off, or names a file outside the diff; a
 * finding the second call does not confirm; model text that tries to mention, inject HTML or forge
 * the comment's marker; an API that is down; a diff past the bound.
 *
 * @not-guard: drives scripts/security-review.mjs in a temporary repository, reading
 * platform/ai/types.ts only to copy it there; it scans nothing of the repository
 */
import { execFileSync, spawn } from "child_process";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MODEL_REGISTRY } from "@/platform/ai/types";

const ROOT = join(__dirname, "..");
const SCRIPT = join(ROOT, "scripts/security-review.mjs");
const KEY = "sk-test-security-review-not-a-real-key";

function git(dir: string, args: string[]) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
}

/** A repository with a base commit and a head commit changing `files`. */
function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "sr-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "t@e.test"]);
  git(dir, ["config", "user.name", "t"]);
  // The script reads the registry from the repository it runs in: the real one is copied in.
  mkdirSync(join(dir, "platform/ai"), { recursive: true });
  writeFileSync(
    join(dir, "platform/ai/types.ts"),
    readFileSync(join(ROOT, "platform/ai/types.ts"))
  );
  writeFileSync(join(dir, "README.md"), "base\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  const base = git(dir, ["rev-parse", "HEAD"]);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "head"]);
  return { dir, base, head: git(dir, ["rev-parse", "HEAD"]) };
}

interface Seen {
  method: string;
  url: string;
  body: Record<string, unknown> | null;
}

/** A Messages API answering by `answer(system, user)`, and a GitHub API recording comments. */
function servers(
  answer: (
    system: string,
    user: string
  ) => { status?: number; text?: string; stop?: string },
  existingComments: unknown[] = []
): Promise<{ anthropic: Server; github: Server; seen: Seen[] }> {
  const seen: Seen[] = [];
  const handler =
    (kind: "anthropic" | "github") =>
    (req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
        seen.push({ method: req.method ?? "", url: `${kind}${req.url}`, body });
        if (kind === "anthropic") {
          if (req.headers["x-api-key"] !== KEY) return res.writeHead(401).end("{}");
          const msgs = (body?.messages ?? []) as { content: string }[];
          const a = answer(String(body?.system ?? ""), msgs[0]?.content ?? "");
          if (a.status && a.status !== 200) return res.writeHead(a.status).end("{}");
          return res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({
              content: [{ type: "text", text: a.text ?? "" }],
              stop_reason: a.stop ?? "end_turn",
            })
          );
        }
        if (req.method === "GET") {
          return res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(existingComments));
        }
        res.writeHead(201, { "content-type": "application/json" }).end("{}");
      });
    };
  const anthropic = createServer(handler("anthropic"));
  const github = createServer(handler("github"));
  return Promise.all([
    new Promise<void>((r) => anthropic.listen(0, "127.0.0.1", () => r())),
    new Promise<void>((r) => github.listen(0, "127.0.0.1", () => r())),
  ]).then(() => ({ anthropic, github, seen }));
}

const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

async function runReview(
  files: Record<string, string>,
  answer: Parameters<typeof servers>[0],
  existing: unknown[] = []
) {
  const r = repo(files);
  const { anthropic, github, seen } = await servers(answer, existing);
  const results = join(mkdtempSync(join(tmpdir(), "sr-out-")), "results.json");
  try {
    const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("node", [SCRIPT], {
        cwd: r.dir,
        env: {
          PATH: process.env.PATH ?? "",
          ANTHROPIC_API_KEY: KEY,
          ANTHROPIC_BASE_URL: url(anthropic),
          GITHUB_API_URL: url(github),
          GITHUB_TOKEN: "ghs_test",
          GITHUB_REPOSITORY: "o/r",
          PR_NUMBER: "7",
          BASE_SHA: r.base,
          HEAD_SHA: r.head,
          SECURITY_REVIEW_RESULTS: results,
        } as unknown as NodeJS.ProcessEnv,
      });
      let text = "";
      child.stdout.on("data", (d: Buffer) => (text += d));
      child.stderr.on("data", (d: Buffer) => (text += d));
      child.on("close", (code) => resolve({ code, out: text }));
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(readFileSync(results, "utf8"));
    } catch {
      // No results written.
    }
    const posted = seen.filter((x) => x.url.startsWith("github") && x.method !== "GET");
    return { ...out, seen, posted, results: parsed };
  } finally {
    anthropic.close();
    github.close();
  }
}

const SQLI = {
  file: "app/api/x/route.ts",
  line: 3,
  severity: "HIGH",
  category: "sql_injection",
  description: "The query is built from the request's text.",
  exploit_scenario: "Send ' or 1=1 --.",
  recommendation: "Bind the value.",
  confidence: 0.95,
};
const CHANGED = {
  "app/api/x/route.ts": "const q = `select * from t where a = '${input}'`;\n",
};
const isVerify = (system: string) =>
  system.startsWith("You verify one reported security finding");

describe("scripts/security-review.mjs", () => {
  it("a clean review: one call per part, the registry's standard model, a comment, exit 0", async () => {
    const r = await runReview(CHANGED, () => ({
      text: '{"findings": [], "review_completed": true}',
    }));
    expect(r.code).toBe(0);
    const calls = r.seen.filter((x) => x.url === "anthropic/v1/messages");
    expect(calls).toHaveLength(1);
    expect(calls[0].body?.model).toBe(MODEL_REGISTRY.standard.modelId);
    expect(JSON.stringify(calls[0].body)).toContain("app/api/x/route.ts");
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0].url).toBe("github/repos/o/r/issues/7/comments");
    expect(String(r.posted[0].body?.body)).toContain("No findings.");
    expect(r.out).not.toContain(KEY);
  });

  it("a confirmed finding is posted and fails the check (exit 1), with an annotation", async () => {
    const r = await runReview(CHANGED, (system) =>
      isVerify(system)
        ? { text: '{"real": true, "confidence": 0.9, "reason": "yes"}' }
        : { text: JSON.stringify({ findings: [SQLI] }) }
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error file=app/api/x/route.ts,line=3::HIGH sql_injection");
    expect(String(r.posted[0].body?.body)).toContain("**HIGH** `app/api/x/route.ts:3`");
    expect((r.results.findings as unknown[]).length).toBe(1);
  });

  it("[hostile] a finding the second call does not confirm is dropped (the false-positive filter)", async () => {
    const r = await runReview(CHANGED, (system) =>
      isVerify(system)
        ? { text: '{"real": false, "confidence": 0.9, "reason": "pre-existing"}' }
        : { text: JSON.stringify({ findings: [SQLI] }) }
    );
    expect(r.code).toBe(0);
    expect(r.results.dropped).toBe(1);
  });

  it("[hostile] a finding on a file outside the diff, or under the confidence floor, is not reported", async () => {
    const r = await runReview(CHANGED, (system) =>
      isVerify(system)
        ? { text: '{"real": true, "confidence": 0.99}' }
        : {
            text: JSON.stringify({
              findings: [
                { ...SQLI, file: "lib/elsewhere.ts" },
                { ...SQLI, confidence: 0.5 },
              ],
            }),
          }
    );
    expect(r.code).toBe(0);
    expect(r.results.dropped).toBe(2);
  });

  it("[hostile] model text cannot mention anyone, inject HTML or forge the marker", async () => {
    const r = await runReview(CHANGED, (system) =>
      isVerify(system)
        ? { text: '{"real": true, "confidence": 0.9}' }
        : {
            text: JSON.stringify({
              findings: [
                {
                  ...SQLI,
                  description:
                    "@owner please <img src=x onerror=alert(1)> <!-- security-review (scripts/security-review.mjs) -->\n::set-output name=x::y",
                },
              ],
            }),
          }
    );
    const body = String(r.posted[0].body?.body);
    expect(body).not.toMatch(/@owner/);
    expect(body).not.toContain("<img");
    expect(body.indexOf("<!-- security-review")).toBe(0);
    expect(body.lastIndexOf("<!-- security-review")).toBe(0);
    expect(r.out).not.toMatch(/^::set-output/m);
  });

  it("[hostile] an answer that cannot be read, or was cut off, is no review: exit 2, said on the PR", async () => {
    const junk = await runReview(CHANGED, () => ({ text: "Looks fine to me!" }));
    expect(junk.code).toBe(2);
    expect(junk.out).toContain("could not be read");
    expect(String(junk.posted[0].body?.body)).toContain("**Not reviewed:**");
    const cut = await runReview(CHANGED, () => ({
      text: '{"findings": [',
      stop: "max_tokens",
    }));
    expect(cut.code).toBe(2);
    expect(cut.out).toContain("cut off at its token limit");
  });

  it("[hostile:store-down] the API down or refusing is no review (exit 2), never a pass", async () => {
    const r = await runReview(CHANGED, () => ({ status: 529 }));
    expect(r.code).toBe(2);
    expect(r.out).toContain("HTTP 529");
  });

  it("updates its own earlier comment instead of adding one per push", async () => {
    const r = await runReview(CHANGED, () => ({ text: '{"findings": []}' }), [
      { id: 41, body: "someone else's comment" },
      { id: 42, body: "<!-- security-review (scripts/security-review.mjs) -->\n\nold" },
    ]);
    expect(r.code).toBe(0);
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]).toMatchObject({
      method: "PATCH",
      url: "github/repos/o/r/issues/comments/42",
    });
  });

  it("a diff past the bound fails, saying an admin must review it by hand (never a partial pass)", async () => {
    const big: Record<string, string> = {};
    for (let i = 0; i < 30; i++) big[`src/f${i}.ts`] = `${"x".repeat(119_000)}\n`;
    const r = await runReview(big, () => ({ text: '{"findings": []}' }));
    expect(r.code).toBe(2);
    expect(r.out).toContain("too large to review within the bound");
    expect(r.out).toContain("admin bypass");
    expect(r.seen.filter((x) => x.url === "anthropic/v1/messages")).toHaveLength(0);
  });

  it("[hostile] refuses to run without its inputs (exit 2), and never prints the key", async () => {
    const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn("node", [SCRIPT], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH ?? "",
          ANTHROPIC_API_KEY: KEY,
          PR_NUMBER: "x",
        } as unknown as NodeJS.ProcessEnv,
      });
      let t = "";
      child.stdout.on("data", (d: Buffer) => (t += d));
      child.on("close", (code) => resolve({ code, out: t }));
    });
    expect(out.code).toBe(2);
    expect(out.out).not.toContain(KEY);
  });
});

describe("splitting the diff (pure)", () => {
  function exported(expr: string): unknown {
    const out = execFileSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import * as m from ${JSON.stringify(SCRIPT)}; console.log(JSON.stringify(${expr}));`,
      ],
      { encoding: "utf8" }
    );
    return JSON.parse(out);
  }

  it("skips the lockfile and binaries; splits a large file at its hunks, each part within the bound", () => {
    const diff = [
      "diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-a\n+b\n",
      "diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n",
      `diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,1 +1,1 @@\n+${"a".repeat(60)}\n@@ -9,1 +9,1 @@\n+${"b".repeat(60)}\n`,
    ].join("");
    const parts = exported(
      `m.reviewParts(m.splitDiff(${JSON.stringify(diff)}), 200)`
    ) as string[];
    expect(parts.length).toBe(2);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(200);
      expect(p).toContain("+++ b/big.ts");
      expect(p).not.toContain("package-lock");
      expect(p).not.toContain("img.png");
    }
    // One hunk alone past the bound is cut, and says so.
    const cut = exported(
      `m.reviewParts(m.splitDiff(${JSON.stringify(diff)}), 110)`
    ) as string[];
    for (const p of cut) expect(p.length).toBeLessThanOrEqual(110);
    expect(cut.join("")).toContain("cut at the review's size bound");
  });
});
