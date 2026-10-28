/**
 * @jest-environment node
 */
/**
 * scripts/risk-tier.mjs (TASK-183) — the review risk tier, set from what a change touches, run as
 * CI's review-tier job runs it. The patterns are the repository's own (scripts/risk-tiers.json,
 * and a consuming app's scripts/risk-tiers.app.json when present); the hostile cases are the ways
 * a change could read as a lower tier than it is.
 */
import { execFileSync, spawnSync } from "child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts/risk-tier.mjs");

interface Reason {
  tier: string;
  area: string;
  file: string;
  why: string;
}
interface Result {
  tier: "Low" | "Medium" | "High";
  files: string[];
  reasons: Reason[];
  contentChecked: boolean;
}

function run(args: string[], input?: string, cwd = ROOT) {
  const r = spawnSync("node", [SCRIPT, ...args], { cwd, input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The tier of the given paths (stdin), from the repository's own patterns. */
function tierOf(paths: string[], cwd = ROOT): Result {
  const r = run(["--format", "json"], paths.join("\n") + "\n", cwd);
  if (r.code !== 0) throw new Error(`exit ${r.code}: ${r.err}`);
  return JSON.parse(r.out) as Result;
}

/** A scratch directory holding the platform's pattern file, and anything else given. */
function scratch(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "risk-tier-"));
  mkdirSync(join(dir, "scripts"));
  copyFileSync(
    join(ROOT, "scripts/risk-tiers.json"),
    join(dir, "scripts/risk-tiers.json")
  );
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const PLATFORM_AREAS = [
  "auth",
  "tenancy",
  "migrations",
  "jobs",
  "workflows",
  "secrets-config",
  "billing-consent",
  "moderation",
];

describe("the risk tier of a change (paths)", () => {
  it.each([
    [["docs/TASKS.md"], "Low"],
    [["README.md", "messages/en.json"], "Low"],
    [["platform/modules/platform-paths.json"], "Low"],
    [["components/auth/AuthPage.tsx"], "Medium"],
    [["docs/TASKS.md", "components/admin/MfaEnrollment.tsx"], "Medium"],
    [["package.json", "package-lock.json"], "Medium"],
    [["platform/auth/middleware.ts"], "High"],
    [["app/api/auth/sign-out/route.ts"], "High"],
    [["platform/tenancy/request.ts"], "High"],
    [["supabase/migrations/056_example.sql"], "High"],
    [["platform/jobs/runner.ts"], "High"],
    [[".github/workflows/ci.yml"], "High"],
    [["docs/templates/sync-from-foundation.yml"], "High"],
    [["REVIEW.md"], "High"],
    [["scripts/risk-tiers.json"], "High"],
    [[".env.example"], "High"],
    [["app/api/account/delete/route.ts"], "High"],
    [["platform/rate-limit/daily-quota.ts"], "High"],
    [["platform/moderation/audit.ts"], "High"],
    [["app/api/moderation/review/[id]/assist/route.ts"], "High"],
  ])("%j is %s", (paths, tier) => {
    expect(tierOf(paths as string[]).tier).toBe(tier);
  });

  it("no changed files is Low, and says so", () => {
    const r = tierOf([]);
    expect(r.tier).toBe("Low");
    expect(r.reasons[0].why).toBe("no changed files");
  });

  it("gives every reason: one file in two areas is listed under both", () => {
    const r = tierOf(["platform/auth/coppa-gate.ts", "docs/TASKS.md"]);
    expect(r.tier).toBe("High");
    expect(r.reasons.map((x) => x.area).sort()).toEqual(["auth", "billing-consent"]);
  });

  it("a High area outranks the docs pattern: docs/templates is a workflow", () => {
    const r = tierOf(["docs/templates/sync-config.json"]);
    expect(r.reasons).toEqual([
      expect.objectContaining({ tier: "High", area: "workflows" }),
    ]);
  });

  it("a glob is anchored and segment-bound: platform/authx is not platform/auth", () => {
    expect(tierOf(["platform/authx/a.ts"]).tier).toBe("Medium");
    expect(tierOf(["xplatform/auth/a.ts"]).tier).toBe("Medium");
    expect(tierOf(["proxy.ts.bak"]).tier).toBe("Medium");
    expect(tierOf(["docs.md/x.ts"]).tier).toBe("Medium");
  });

  it("from stdin, says the content patterns were not applied", () => {
    const r = run([], "platform/x.ts\n");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^tier: Medium\n/);
    expect(r.out).toMatch(/paths only, content not checked/);
  });

  it("writes a markdown summary for the job summary", () => {
    const r = run(["--format", "markdown"], "platform/auth/age.ts\n");
    expect(r.out).toMatch(/^## Review risk tier: High\n/);
    expect(r.out).toMatch(
      /\| auth \| `platform\/auth\/age\.ts` \| path platform\/auth\/\*\* \|/
    );
    expect(r.out).toMatch(/docs\/AI_ENGINEERING\.md §4/);
  });
});

describe("the hard rule: the review process's own files are High whatever the patterns say", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ".github/workflows/review-tier.yml",
    ".github/CODEOWNERS",
    "scripts/risk-tier.mjs",
    "scripts/risk-tiers.json",
    "scripts/risk-tiers.app.json",
    "REVIEW.md",
    "CLAUDE.md",
    ".gitattributes",
    "lib/.gitattributes",
  ])("%s, with every high area removed from the patterns", (path) => {
    // A PR that empties the pattern files still reads as High: the rule is in the script.
    dir = mkdtempSync(join(tmpdir(), "risk-tier-hard-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "scripts/risk-tiers.json"),
      JSON.stringify({ low: ["**"], high: [] })
    );
    const r = tierOf([path], dir);
    expect(r.tier).toBe("High");
    expect(r.reasons).toEqual([
      expect.objectContaining({
        area: "workflows",
        why: expect.stringMatching(/^hard rule/),
      }),
    ]);
  });

  it("is anchored: docs/REVIEW.md, lib/.github/x.ts, scripts/risk-tiers/x.ts and lib/x.gitattributes are not the hard rule", () => {
    dir = scratch();
    expect(tierOf(["docs/REVIEW.md"], dir).tier).toBe("Low");
    expect(tierOf(["lib/.github/x.ts"], dir).tier).toBe("Medium");
    expect(tierOf(["scripts/risk-tiers/x.ts"], dir).tier).toBe("Medium");
    expect(tierOf(["lib/x.gitattributes"], dir).tier).toBe("Medium");
  });
});

describe("--patterns: the pattern files are read from the given directory (CI: the base's)", () => {
  let dir: string;
  let base: string;
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it("classifies with the base's patterns, not the working directory's", () => {
    // The working directory's patterns call platform/auth Low; the base's call it High.
    dir = mkdtempSync(join(tmpdir(), "risk-tier-pr-"));
    mkdirSync(join(dir, "scripts"));
    writeFileSync(
      join(dir, "scripts/risk-tiers.json"),
      JSON.stringify({ low: ["**"], high: [] })
    );
    base = scratch();
    expect(tierOf(["platform/auth/session.ts"], dir).tier).toBe("Low");
    const r = run(
      ["--patterns", base, "--format", "json"],
      "platform/auth/session.ts\n",
      dir
    );
    expect(r.code).toBe(0);
    expect((JSON.parse(r.out) as Result).tier).toBe("High");
  });

  it("a directory without the patterns file is refused", () => {
    dir = mkdtempSync(join(tmpdir(), "risk-tier-pr-"));
    base = mkdtempSync(join(tmpdir(), "risk-tier-nobase-"));
    const r = run(["--patterns", base], "a\n", dir);
    expect([r.code, r.out]).toEqual([2, ""]);
  });
});

describe("the patterns file", () => {
  const config = JSON.parse(
    readFileSync(join(ROOT, "scripts/risk-tiers.json"), "utf8")
  ) as { high: { area: string; failure: string; paths: string[] }[] };

  it("holds every platform area, each with its failure and at least one path", () => {
    const areas = config.high.map((a) => a.area);
    expect(areas).toEqual(expect.arrayContaining(PLATFORM_AREAS));
    for (const a of config.high) {
      expect([a.area, a.failure.length > 0, a.paths.length > 0]).toEqual([
        a.area,
        true,
        true,
      ]);
    }
  });

  it("REVIEW.md names the patterns file and every area the repository's patterns define", () => {
    const review = readFileSync(join(ROOT, "REVIEW.md"), "utf8");
    expect(review).toMatch(/scripts\/risk-tiers\.json/);
    const app = join(ROOT, "scripts/risk-tiers.app.json");
    const appAreas = existsSync(app)
      ? (
          JSON.parse(readFileSync(app, "utf8")) as {
            high: { area: string }[];
          }
        ).high.map((a) => a.area)
      : [];
    const missing = [...config.high.map((a) => a.area), ...appAreas].filter(
      (a) => !review.includes(`\`${a}\``)
    );
    expect(missing).toEqual([]);
  });
});

describe("the risk tier of a change (git diff, content)", () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  const write = (name: string, text: string) => {
    mkdirSync(dirname(join(repo, name)), { recursive: true });
    writeFileSync(join(repo, name), text);
  };

  beforeEach(() => {
    repo = scratch({
      "lib/store.ts": "export const a = 1;\n",
      "db/notes.sql": "-- create policy tenant_read on t\nselect 1;\n",
      "platform/auth/old.ts": "export const x = 1;\n",
      "__tests__/store.test.ts": "it('x', () => {});\n",
    });
    git("init", "-q", "-b", "main");
    git("add", ".");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "change");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const tierAt = (): Result => {
    git("add", "-A");
    git("commit", "-q", "-m", "change");
    const r = run(
      ["--base", "main", "--head", "HEAD", "--format", "json"],
      undefined,
      repo
    );
    if (r.code !== 0) throw new Error(r.err);
    return JSON.parse(r.out) as Result;
  };

  it("an ordinary file that starts using the owner connection is High (tenancy, by content)", () => {
    write("lib/store.ts", "export const a = await withOwnerTx('x', run);\n");
    const r = tierAt();
    expect(r.contentChecked).toBe(true);
    expect(r.tier).toBe("High");
    expect(r.reasons).toEqual([
      expect.objectContaining({
        area: "tenancy",
        file: "lib/store.ts",
        why: expect.stringMatching(/^content/),
      }),
    ]);
  });

  it("a removed line counts: dropping a guard call is High (auth)", () => {
    write("lib/store.ts", "const guard = await requireAdmin(req);\n");
    git("add", "-A");
    git("commit", "-q", "-m", "guarded");
    git("branch", "-f", "main", "HEAD");
    write("lib/store.ts", "export const a = 1;\n");
    expect(tierAt().reasons).toEqual([
      expect.objectContaining({ area: "auth", file: "lib/store.ts" }),
    ]);
  });

  it("a removed SQL comment is a changed line, not a diff header", () => {
    write("db/notes.sql", "select 1;\n");
    const r = tierAt();
    // "--- create policy …" is the removed line; read as a header it would hide the change.
    expect(r.reasons).toEqual([
      expect.objectContaining({ area: "tenancy", file: "db/notes.sql" }),
    ]);
  });

  it("a test's content does not raise the tier (contentSkip); its path still counts", () => {
    write(
      "__tests__/store.test.ts",
      "it('x', async () => { await requireAdmin(req); });\n"
    );
    expect(tierAt().tier).toBe("Medium");
  });

  it("moving a file out of a High area keeps the tier High (renames are not followed)", () => {
    git("mv", "platform/auth/old.ts", "lib/old.ts");
    const r = tierAt();
    expect(r.tier).toBe("High");
    expect(r.files).toEqual(["lib/old.ts", "platform/auth/old.ts"]);
  });

  it("tenancy SQL in upper case is High: the repository writes CREATE POLICY", () => {
    write(
      "db/policies.sql",
      "CREATE POLICY tenant_read ON t USING (true);\nALTER TABLE t ENABLE ROW LEVEL SECURITY;\n"
    );
    const r = tierAt();
    expect(r.tier).toBe("High");
    expect(r.reasons).toEqual([
      expect.objectContaining({ area: "tenancy", file: "db/policies.sql" }),
    ]);
  });

  it("an upper-case auth guard name is not the guard (auth stays case-sensitive)", () => {
    write("lib/store.ts", "export const REQUIREADMIN = 1;\n");
    expect(tierAt().tier).toBe("Medium");
  });

  it.each([
    ["a space", "lib/my store.ts"],
    ["a double quote", 'lib/say "hi".ts'],
    ["brackets and a star", "lib/a [1]*.ts"],
    ["a non-ASCII name", "lib/größe.ts"],
  ])("a name with %s is read as it is, content included", (_name, file) => {
    write(file, "const g = await requireAdmin(req);\n");
    const r = tierAt();
    expect(r.files).toEqual([file]);
    expect(r.reasons).toEqual([
      expect.objectContaining({
        area: "auth",
        file,
        why: expect.stringMatching(/^content/),
      }),
    ]);
  });

  it("a name that is also a glob reads only its own lines, not its matches'", () => {
    write("lib/a.ts", "export const a = 1;\n");
    write("lib/*.ts", "export const b = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "both");
    git("branch", "-f", "main", "HEAD");
    write("lib/*.ts", "export const b = 2;\n");
    write("lib/a.ts", "const g = await requireAdmin(req);\n");
    // Read as a glob, "lib/*.ts" would take lib/a.ts's lines and be listed under auth too.
    expect(tierAt().reasons).toEqual([
      expect.objectContaining({ area: "auth", file: "lib/a.ts" }),
    ]);
  });

  it.each([["*.ts -diff"], ["*.ts binary"], ["*.ts diff=hide"]])(
    "an attributes file (%s) cannot hide a guard call: High by content and by the hard rule",
    (attr) => {
      write(".gitattributes", `${attr}\n`);
      write("lib/store.ts", "const g = await requireAdmin(req);\n");
      // A diff driver that would print nothing, if it were ever run.
      git("config", "diff.hide.textconv", "true");
      const r = tierAt();
      expect(r.tier).toBe("High");
      expect(r.reasons).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            area: "workflows",
            file: ".gitattributes",
            why: "hard rule .gitattributes",
          }),
          expect.objectContaining({
            area: "auth",
            file: "lib/store.ts",
            why: expect.stringMatching(/^content/),
          }),
        ])
      );
    }
  );

  it("an attributes file already on the base still cannot hide a guard call (content)", () => {
    write(".gitattributes", "*.ts -diff\n");
    git("add", "-A");
    git("commit", "-q", "-m", "attrs");
    git("branch", "-f", "main", "HEAD");
    write("lib/store.ts", "const g = await requireAdmin(req);\n");
    expect(tierAt().reasons).toEqual([
      expect.objectContaining({
        area: "auth",
        file: "lib/store.ts",
        why: expect.stringMatching(/^content/),
      }),
    ]);
  });

  it("a docs-only change stays Low even when the text names a guard", () => {
    write("docs/guide.md", "Call requireAdmin(req) and withOwnerTx first.\n");
    expect(tierAt().tier).toBe("Low");
  });
});

describe("this repository's own app areas, against its real tree", () => {
  const app = join(ROOT, "scripts/risk-tiers.app.json");
  const has = existsSync(app);
  const tracked = has
    ? execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
        .split("\0")
        .filter(Boolean)
    : [];

  (has ? it : it.skip)(
    "every path pattern in scripts/risk-tiers.app.json names a file that exists",
    () => {
      const areas = (
        JSON.parse(readFileSync(app, "utf8")) as {
          high: { area: string; paths: string[] }[];
        }
      ).high;
      const dead = areas.flatMap((a) =>
        a.paths
          .filter((p) => {
            // The glob as the script reads it: "**/" any segments, "**" the rest, "*" one segment.
            const body = p
              .split(/(\*\*\/|\*\*|\*)/)
              .map((t) =>
                t === "**/"
                  ? "(?:[^/]+/)*"
                  : t === "**"
                    ? ".*"
                    : t === "*"
                      ? "[^/]*"
                      : t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
              )
              .join("");
            const re = new RegExp(`^${body}$`);
            return !tracked.some((f) => re.test(f));
          })
          .map((p) => `${a.area}: ${p}`)
      );
      expect(dead).toEqual([]);
    }
  );

  (has ? it.each : it.skip.each)([
    ["lib/translate.ts", "ai-provider"],
    ["e2e-live/user-journey.live.spec.ts", "live-journey"],
    ["app/api/agent/delegation/token/route.ts", "auth"],
    ["app/agent/authorize/page.tsx", "auth"],
    ["lib/agent-delegation-data.ts", "auth"],
    ["lib/pkce.ts", "auth"],
    ["lib/identity-conflict.ts", "auth"],
    ["lib/safety.ts", "moderation"],
    ["platform/moderation/audit.ts", "moderation"],
    ["platform/rate-limit/daily-quota.ts", "billing-consent"],
  ])("%s is High (%s), and exists", (file, area) => {
    expect(tracked).toContain(file);
    const r = tierOf([file]);
    expect(r.tier).toBe("High");
    expect(r.reasons.map((x) => x.area)).toContain(area);
  });
});

describe("a consuming app's own areas (scripts/risk-tiers.app.json)", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds new areas, and extends an existing one by name", () => {
    dir = scratch({
      "scripts/risk-tiers.app.json": JSON.stringify({
        high: [
          {
            area: "ai-provider",
            failure: "sends text without consent",
            paths: ["lib/translate.ts"],
          },
          { area: "auth", paths: ["lib/route-guard.ts"] },
        ],
      }),
    });
    expect(tierOf(["lib/translate.ts"], dir).reasons).toEqual([
      expect.objectContaining({ area: "ai-provider" }),
    ]);
    const auth = tierOf(["lib/route-guard.ts"], dir);
    expect(auth.reasons).toEqual([expect.objectContaining({ area: "auth" })]);
    expect(tierOf(["lib/other.ts"], dir).tier).toBe("Medium");
  });

  it("refuses a new area that states no failure", () => {
    dir = scratch({
      "scripts/risk-tiers.app.json": JSON.stringify({
        high: [{ area: "x", paths: ["a"] }],
      }),
    });
    const r = run([], "a\n", dir);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toMatch(/area x states no failure/);
  });
});

describe("large output through a pipe", () => {
  it("is written in full (over 64 KB), and the exit code is kept", () => {
    const paths = Array.from(
      { length: 2500 },
      (_, i) => `lib/a-fairly-long-module-name-for-padding-${i}.ts`
    );
    const r = run(["--format", "json"], paths.join("\n") + "\n");
    expect(r.code).toBe(0);
    expect(r.out.length).toBeGreaterThan(65536);
    const parsed = JSON.parse(r.out) as Result;
    expect([parsed.tier, parsed.files.length]).toEqual(["Medium", 2500]);
  });
});

describe("refusals: nothing on stdout, exit 2", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["an unknown argument", ["--tier", "Low"]],
    ["a ref that is not a ref", ["--base", "main;touch x"]],
    ["a ref starting with an option", ["--base", "--output=/tmp/x"]],
    ["an unknown format", ["--format", "html"]],
  ])("%s", (_name, args) => {
    const r = run(args, "");
    expect([r.code, r.out]).toEqual([2, ""]);
  });

  it.each([
    ["a parent segment", "docs/../platform/auth/x.ts"],
    ["an absolute path", "/etc/passwd"],
    ["an empty segment", "docs//x.md"],
    ["a control character", "docs/x\u0007.md"],
    ["git's quoted form", '"platform/auth/caf\\303\\251.ts"'],
  ])("a path git would never print: %s", (_name, path) => {
    const r = run([], `${path}\n`);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toMatch(/not a repository path/);
  });

  it("no patterns file (not at the repository root)", () => {
    dir = mkdtempSync(join(tmpdir(), "risk-tier-none-"));
    const r = run([], "a\n", dir);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toMatch(/scripts\/risk-tiers\.json not found/);
  });

  it.each([
    ["invalid JSON", "{"],
    [
      "an invalid pattern",
      JSON.stringify({ high: [{ area: "a", failure: "f", paths: ["/abs"] }] }),
    ],
    [
      "an invalid regular expression",
      JSON.stringify({
        high: [{ area: "a", failure: "f", paths: ["a"], content: ["("] }],
      }),
    ],
    ["no high list", JSON.stringify({ low: [] })],
    [
      "a content flag other than i",
      JSON.stringify({
        high: [{ area: "a", failure: "f", paths: ["a"], flags: "g", content: ["x"] }],
      }),
    ],
  ])("a malformed app file: %s", (_name, text) => {
    dir = scratch({ "scripts/risk-tiers.app.json": text });
    const r = run([], "a\n", dir);
    expect([r.code, r.out]).toEqual([2, ""]);
  });

  it("a base git cannot resolve", () => {
    dir = scratch();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const r = run(["--base", "nope"], undefined, dir);
    expect([r.code, r.out]).toEqual([2, ""]);
    expect(r.err).toMatch(/git diff nope\.\.\.HEAD failed/);
  });
});
