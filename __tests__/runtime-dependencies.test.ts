/**
 * __tests__/runtime-dependencies.test.ts — every runtime dependency is used (TASK-213)
 *
 * @guard a production dependency nothing imports, or an exception whose reason no longer holds
 *
 * A package under `dependencies` ships with the app and is audited as its runtime attack surface
 * (`npm audit --omit=dev`, the hard gate). Playform carried `@anthropic-ai/sdk` there from the
 * validation spike (March 2026) to November with nothing importing it — platform-foundation had
 * removed it as unused — and Dependabot kept proposing majors of it (Playform #598, 0.98 → 1.3,
 * whose 1.0 changed the API version it sends). An unused runtime dependency costs an audit surface
 * and a review for nothing.
 *
 * So each one must be imported — `import … from`, `export … from`, `import()`, `require()` of its
 * name or a subpath — by the code that ships (outside tests), or be listed in EXCEPTIONS with why;
 * each exception's reason is checked to still hold, and one that is imported after all must go.
 */
import { readFileSync } from "fs";
import { join, relative, sep } from "path";
import { walkFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");

/** Dependencies no source imports by name, each with why it stays and a check that it holds. */
export const EXCEPTIONS: Record<
  string,
  { why: string; holds: (root: string) => boolean }
> = {
  "@sentry/nextjs": {
    why: "platform/observability/error-reporting.ts loads it by a computed name (so the bundler does not resolve it at build time)",
    holds: (root) =>
      readFileSync(
        join(root, "platform/observability/error-reporting.ts"),
        "utf8"
      ).includes('"@sentry/" + "nextjs"'),
  },
  "react-dom": {
    why: "next renders with it: a peer dependency next declares, installed beside it",
    holds: (root) =>
      "react-dom" in
      ((
        JSON.parse(
          readFileSync(join(root, "node_modules/next/package.json"), "utf8")
        ) as {
          peerDependencies?: Record<string, string>;
        }
      ).peerDependencies ?? {}),
  },
  "@supabase/supabase-js": {
    why: "ADR-053 §5 keeps it for Realtime: an app builds the client platform/realtime/supabase-realtime.ts takes",
    holds: (root) =>
      readFileSync(join(root, "docs/adr/ADR-053-tenancy.md"), "utf8").includes(
        "supabase-js stays for Realtime only."
      ) &&
      readFileSync(join(root, "platform/realtime/supabase-realtime.ts"), "utf8").includes(
        "export function createSupabaseRealtimeProvider("
      ),
  },
};

/** The package names a source text imports (bare specifiers, reduced to the package). */
export function importedPackages(text: string): Set<string> {
  const out = new Set<string>();
  const re =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"'./][^"']*)["']/gm;
  for (const m of text.matchAll(re)) {
    const spec = m[1].replace(/^node:/, "");
    const parts = spec.split("/");
    out.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]);
  }
  return out;
}

/** The sources that ship: code outside tests, test helpers, fixtures, E2E and generated output. */
export function shippedSources(root: string): string[] {
  return walkFiles(root, (n) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(n))
    .map((p) => relative(root, p).split(sep).join("/"))
    .filter(
      (f) =>
        !/(?:^|\/)__tests__\//.test(f) &&
        !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(f) &&
        !/^(?:e2e|e2e-live|vendor|stryker-tmp|reports)\//.test(f)
    )
    .sort();
}

/** Problems: dependencies nothing imports and no exception covers, and stale exceptions. */
export function dependencyProblems(
  deps: string[],
  sources: Record<string, string>,
  exceptions: Record<string, { why: string; holds: (root: string) => boolean }>,
  root: string
): string[] {
  const used = new Set<string>();
  for (const text of Object.values(sources))
    for (const p of importedPackages(text)) used.add(p);
  const out: string[] = [];
  for (const d of deps) {
    const ex = exceptions[d];
    if (used.has(d)) {
      if (ex) out.push(`${d} is imported: remove its exception (${ex.why})`);
    } else if (!ex) {
      out.push(
        `${d} is under dependencies but nothing that ships imports it: remove it (npm uninstall ${d}), move it to devDependencies, or add an exception with why`
      );
    } else if (!ex.holds(root)) {
      out.push(`${d}: its exception no longer holds — ${ex.why}`);
    }
  }
  return out;
}

describe("every runtime dependency is used (TASK-213)", () => {
  it("each production dependency is imported by code that ships, or excepted with a reason that holds", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies ?? {});
    expect(deps.length).toBeGreaterThan(5);
    const files = shippedSources(ROOT);
    const sources = Object.fromEntries(
      files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")])
    );
    expect(dependencyProblems(deps, sources, EXCEPTIONS, ROOT)).toEqual([]);
  });

  it("[self-test] an unused dependency, a stale exception and an exception that no longer holds are refused", () => {
    const sources = {
      "lib/a.ts":
        'import { x } from "used-a";\nconst y = await import("@scope/used-b/sub");',
      "lib/b.cjs": 'const z = require("node:fs"); const w = require("used-c");',
      "lib/c.ts": 'export { q } from "used-d";\nimport "used-e/register";',
    };
    const yes = { why: "a reason", holds: () => true };
    const no = { why: "a gone reason", holds: () => false };
    expect(
      dependencyProblems(
        [
          "used-a",
          "@scope/used-b",
          "used-c",
          "used-d",
          "used-e",
          "unused",
          "kept",
          "lapsed",
          "used-a2",
        ],
        sources,
        { kept: yes, lapsed: no, "used-c": yes },
        "/"
      )
    ).toEqual([
      "used-c is imported: remove its exception (a reason)",
      expect.stringMatching(
        /^unused is under dependencies but nothing that ships imports it/
      ),
      "lapsed: its exception no longer holds — a gone reason",
      expect.stringMatching(
        /^used-a2 is under dependencies but nothing that ships imports it/
      ),
    ]);
  });

  it("[self-test] a test, an E2E spec or a helper does not count as use", () => {
    const files = shippedSources(ROOT);
    expect(files.some((f) => f.includes("__tests__/"))).toBe(false);
    expect(files.some((f) => f.startsWith("e2e/"))).toBe(false);
    expect(files).toContain("platform/observability/error-reporting.ts");
    expect(
      dependencyProblems(
        ["only-in-tests"],
        { "lib/x.ts": "export const a = 1;" },
        {},
        ROOT
      )
    ).toEqual([expect.stringMatching(/^only-in-tests is under dependencies/)]);
  });
});
