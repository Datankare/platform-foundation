/**
 * The scheduled sync's history guard (TASK-204): docs/templates/sync-carried-guard.sh, and an
 * app's copy (.github/scripts/sync-carried-guard.sh) when it has one.
 *
 * @guard a sync pull request that would roll an app back past a platform commit it already carries
 *
 * In October 2026 Playform's daily sync took platform-foundation's main (v5.1.1) while Playform
 * already carried develop's work (to TASK-202): seven pull requests, each a rollback. The version
 * guard compares versions only; this guard reads, from the app's own history, the newest platform
 * commit it carries — a sync commit's sha, or a carried "(platform TASK-nnn)" — and lets the sync
 * proceed only when the source strictly descends from it. Real git repositories, built here:
 * hostile cases are a source missing the carried commit (main behind develop), the same commit,
 * a carried task no platform commit names, shallow checkouts, no history to read, wrong arguments.
 * That the script runs on macOS's bash 3.2 (no `case` inside `$( )`, the 55d failure) is checked
 * for every script by __tests__/shell-portability.test.ts (TASK-213), and run there by the macOS job.
 */
import { execFileSync, spawnSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPTS = [
  "docs/templates/sync-carried-guard.sh",
  ".github/scripts/sync-carried-guard.sh",
].filter((f) => existsSync(join(process.cwd(), f)));

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-carried-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};
function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: ENV }).trim();
}
function commit(dir: string, subject: string): string {
  writeFileSync(join(dir, "f.txt"), `${subject}\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", subject);
  return git(dir, "rev-parse", "HEAD");
}
function repo(name: string): string {
  const dir = join(root, name);
  execFileSync("git", ["init", "-q", "-b", "develop", dir], { env: ENV });
  return dir;
}

/** The platform: main at TASK-1; develop TASK-1 → TASK-2 → TASK-3 (two rounds). */
function platform() {
  const pf = repo("pf");
  const t1 = commit(pf, "fix: one (TASK-1)");
  git(pf, "branch", "main");
  const t2 = commit(pf, "fix: two (TASK-2)");
  const t3a = commit(pf, "fix: three (TASK-3)");
  const t3b = commit(pf, "fix: three, round 2 (TASK-3)");
  // The workflow's fetch of develop, as a remote-tracking ref.
  git(pf, "update-ref", "refs/remotes/origin/develop", t3b);
  return { pf, t1, t2, t3a, t3b };
}
let appCount = 0;
function app(...subjects: string[]): string {
  const a = repo(`app-${(appCount += 1)}`);
  commit(a, "feat(app): its own start");
  for (const s of subjects) commit(a, s);
  return a;
}

function guard(script: string, ...args: string[]) {
  const r = spawnSync("bash", [join(process.cwd(), script), ...args], {
    encoding: "utf8",
    env: ENV,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe.each(SCRIPTS)("%s", (script) => {
  it("[self-test] the source (main) lacks the carried commit: no sync, a notice — the October rollback", () => {
    const { pf } = platform();
    git(pf, "checkout", "-q", "main");
    const a = app("fix(app): carried (platform TASK-2)");
    const r = guard(script, pf, a);
    expect(r).toMatchObject({ code: 0, out: "proceed=false\n" });
    expect(r.err).toContain("does not contain platform commit");
    expect(r.err).toContain("a sync would roll the app back");
  });

  it("the source is the carried commit: nothing to sync", () => {
    const { pf, t3b } = platform();
    git(pf, "checkout", "-q", t3b);
    const r = guard(script, pf, app("fix(app): carried (platform TASK-3)"));
    expect(r).toMatchObject({ code: 0, out: "proceed=false\n" });
    expect(r.err).toContain("already carries the source's platform commit");
  });

  it("a carried task is its newest round: a source with only round 1 does not sync", () => {
    const { pf, t3a } = platform();
    git(pf, "checkout", "-q", t3a);
    const r = guard(script, pf, app("fix(app): carried (platform TASK-3)"));
    expect(r.out).toBe("proceed=false\n");
  });

  it("a source that strictly descends from the carried commit syncs", () => {
    const { pf } = platform();
    git(pf, "checkout", "-q", "develop");
    commit(pf, "fix: four (TASK-4)");
    const r = guard(script, pf, app("fix(app): carried (platform TASK-3)"));
    expect(r).toMatchObject({ code: 0, out: "proceed=true\n" });
  });

  it("the newest marker wins: an older carried task further back does not loosen it", () => {
    const { pf } = platform();
    git(pf, "checkout", "-q", "main");
    const r = guard(
      script,
      pf,
      app(
        "fix(app): (platform TASK-1)",
        "fix(app): own work (TASK-5001)",
        "fix(app): (platform TASK-2)"
      )
    );
    expect(r.out).toBe("proceed=false\n");
  });

  it("a sync commit names its sha: contained → sync; not contained → no sync", () => {
    const { pf, t1, t2 } = platform();
    git(pf, "checkout", "-q", "develop");
    const synced = app(`chore(sync): inherit platform-foundation main @ ${t1}`);
    expect(guard(script, pf, synced).out).toBe("proceed=true\n");
    git(pf, "checkout", "-q", "main");
    const ahead = app(`chore(sync): inherit platform-foundation v2 @ ${t2}`);
    expect(guard(script, pf, ahead).out).toBe("proceed=false\n");
    // A sha the platform does not have at all is not contained either.
    const unknown = app(
      `chore(sync): inherit platform-foundation v9 @ ${"f".repeat(40)}`
    );
    expect(guard(script, pf, unknown).out).toBe("proceed=false\n");
  });

  it("an app that never carried a platform commit: proceeds, saying the version guard decides", () => {
    const { pf } = platform();
    const r = guard(script, pf, app("feat(app): own (TASK-5001)"));
    expect(r).toMatchObject({ code: 0, out: "proceed=true\n" });
    expect(r.err).toContain("the version guard alone decides");
  });

  it("[hostile] a carried task no platform commit names fails closed (exit 1)", () => {
    const { pf } = platform();
    const r = guard(script, pf, app("fix(app): (platform TASK-999)"));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("no platform-foundation commit names (TASK-999)");
  });

  it("[hostile] a shallow checkout, a directory without history, or wrong arguments fail (exit 1)", () => {
    const { pf } = platform();
    const a = app("fix(app): (platform TASK-2)");
    const shallow = join(root, "shallow");
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${pf}`, shallow], {
      env: ENV,
    });
    expect(guard(script, shallow, a).code).toBe(1);
    expect(guard(script, join(root, "nope"), a).code).toBe(1);
    expect(guard(script, pf).code).toBe(1);
  });
});

it("an app's copy differs from the template only in its header comment", () => {
  if (SCRIPTS.length < 2) return;
  const body = (f: string) =>
    readFileSync(join(process.cwd(), f), "utf8").replace(/^(?:#.*\n)+/, "");
  expect(body(SCRIPTS[1])).toBe(body(SCRIPTS[0]));
});
