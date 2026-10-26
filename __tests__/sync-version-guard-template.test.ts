/**
 * docs/templates/sync-version-guard.sh — the scheduled sync's version guard. An app may adopt
 * platform-foundation from develop ahead of its release, so the sync's source (main) can be older
 * than what the app has; a pull request syncing it would revert that work. The guard lets the
 * sync proceed only for a strictly newer platform, and fails closed (exit 1, so the run's failure
 * alert fires) on a missing or malformed version. Hostile cases: older, equal, numerically larger
 * but lexically smaller (6.10.0 vs 6.9.0), leading zeros, two version lines, a pre-release suffix,
 * no file, and wrong arguments.
 */
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(process.cwd(), "docs/templates/sync-version-guard.sh");
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sync-guard-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function checkout(name: string, body: string | null): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "platform"), { recursive: true });
  if (body !== null) writeFileSync(join(dir, "platform/version.ts"), body);
  return dir;
}
const v = (x: string) => `/** version */\nexport const PLATFORM_VERSION = "${x}";\n`;

function guard(...args: string[]): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const x = e as { status: number; stdout: string; stderr: string };
    return { code: x.status, out: String(x.stdout), err: String(x.stderr) };
  }
}

describe("sync-version-guard.sh", () => {
  it("proceeds only when the source is strictly newer", () => {
    expect(guard(checkout("s", v("6.1.0")), checkout("t", v("6.0.0"))).out).toBe(
      "proceed=true\n"
    );
    expect(guard(checkout("s2", v("7.0.0")), checkout("t2", v("6.9.9"))).out).toBe(
      "proceed=true\n"
    );
    expect(guard(checkout("s3", v("6.0.1")), checkout("t3", v("6.0.0"))).out).toBe(
      "proceed=true\n"
    );
  });

  it("an older source (main behind develop) does not sync: exit 0, proceed=false, a notice", () => {
    const r = guard(checkout("s", v("5.4.0")), checkout("t", v("6.0.0")));
    expect(r).toMatchObject({ code: 0, out: "proceed=false\n" });
  });

  it("the same version does not sync", () => {
    expect(guard(checkout("s", v("6.0.0")), checkout("t", v("6.0.0"))).out).toBe(
      "proceed=false\n"
    );
  });

  it("compares numerically, not as text: 6.10.0 is newer than 6.9.0, and leading zeros are numbers", () => {
    expect(guard(checkout("s", v("6.10.0")), checkout("t", v("6.9.0"))).out).toBe(
      "proceed=true\n"
    );
    expect(guard(checkout("s2", v("6.9.0")), checkout("t2", v("6.10.0"))).out).toBe(
      "proceed=false\n"
    );
    expect(guard(checkout("s3", v("6.08.0")), checkout("t3", v("6.9.0"))).out).toBe(
      "proceed=false\n"
    );
  });

  it.each([
    ["no version file", null],
    ["a pre-release suffix", v("6.1.0-rc.1")],
    ["no version line", "export const OTHER = 1;\n"],
    ["two version lines", v("6.1.0") + v("6.2.0")],
    ["an unquoted value", "export const PLATFORM_VERSION = 6.1.0;\n"],
  ])("fails closed on %s in the source (exit 1, nothing on stdout)", (_label, body) => {
    const r = guard(checkout("s", body), checkout("t", v("6.0.0")));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });

  it("fails closed on a malformed target version too", () => {
    const r = guard(checkout("s", v("6.1.0")), checkout("t", v("x.y.z")));
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
  });

  it("refuses the wrong number of arguments", () => {
    expect(guard().code).toBe(1);
    expect(guard(checkout("s", v("6.1.0"))).code).toBe(1);
  });

  it("the template runs the guard before the sync, and both later steps depend on it", () => {
    const wf = readFileSync(
      join(process.cwd(), "docs/templates/sync-from-foundation.yml"),
      "utf8"
    );
    const guardAt = wf.indexOf("name: Version guard");
    const syncAt = wf.indexOf("name: Sync files");
    const prAt = wf.indexOf("name: Open the pull request");
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(syncAt);
    expect(wf).toContain(
      'bash target/.github/scripts/sync-version-guard.sh source target >> "$GITHUB_OUTPUT"'
    );
    for (const at of [syncAt, prAt]) {
      expect(wf.slice(at, at + 200)).toContain(
        "if: steps.guard.outputs.proceed == 'true'"
      );
    }
  });

  it("the platform's own version is in the shape the guard reads", () => {
    const r = guard(process.cwd(), process.cwd());
    expect(r).toMatchObject({ code: 0, out: "proceed=false\n" });
  });
});
