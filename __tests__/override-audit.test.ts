/**
 * scripts/override-audit.mjs (TASK-070; audit H-12) — run as CI runs it, in a scratch tree.
 *
 * A key was "documented" when its name appeared anywhere in SECURITY_DEBT.md, so prose, a longer
 * package name or another section passed it; and an app could not keep its own register. Now
 * only a row of the Dependency Overrides table whose first cell is exactly the key counts, in
 * the platform's register or the app's docs/APP_SECURITY_DEBT.md.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const SCRIPT = join(process.cwd(), "scripts/override-audit.mjs");

const table = (...keys: string[]) =>
  [
    "## Dependency Overrides (TASK-070)",
    "",
    "| Override | Pinned | Reason | Removal condition |",
    "| -------- | ------ | ------ | ----------------- |",
    ...keys.map((k) => `| ${k} | 1 | r | c |`),
    "",
    "---",
  ].join("\n");

function run(
  overrides: Record<string, string>,
  files: Record<string, string>
): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "override-audit-"));
  try {
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ overrides }));
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text);
    try {
      const out = execFileSync("node", [SCRIPT], {
        cwd: dir,
        encoding: "utf8",
        stdio: "pipe",
      });
      return { ok: true, out };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("override audit (H-12)", () => {
  it("passes the repository's own overrides", () => {
    const out = execFileSync("node", [SCRIPT], { encoding: "utf8" });
    expect(out).toMatch(/Override audit: OK/);
  });

  it("passes keys with an exact register row", () => {
    expect(
      run(
        { postcss: "1", "brace-expansion@5": "5" },
        {
          "docs/SECURITY_DEBT.md": table("postcss", "`brace-expansion@5`"),
        }
      ).ok
    ).toBe(true);
  });

  it.each([
    ["a longer package name", table("postcss-loader")],
    ["prose outside the table", `postcss is mentioned here.\n\n${table("other")}`],
    ["another section's table", `## Other\n\n| postcss | x |\n\n${table("other")}`],
    ["a prefix in the cell", table("postcss@8")],
    ["no register table at all", "postcss postcss postcss"],
  ])("fails a key documented only by %s", (_label, doc) => {
    const r = run({ postcss: "1" }, { "docs/SECURITY_DEBT.md": doc });
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/undocumented overrides[\s\S]*postcss/);
  });

  it("reads the app's own register too", () => {
    expect(
      run(
        { postcss: "1", "app-only": "2" },
        {
          "docs/SECURITY_DEBT.md": table("postcss"),
          "docs/APP_SECURITY_DEBT.md": table("app-only"),
        }
      ).ok
    ).toBe(true);
    const r = run(
      { postcss: "1", "app-only": "2" },
      {
        "docs/SECURITY_DEBT.md": table("postcss"),
      }
    );
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/app-only/);
  });
});
