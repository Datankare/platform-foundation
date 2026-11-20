/**
 * __tests__/docker-context.test.ts — what the image builds is complete without the files the
 * image leaves out (TASK-237)
 *
 * @guard a file the image's build context keeps that imports a file .dockerignore drops, or test code the context keeps for `next build` to type-check
 *
 * The Dockerfile copies the build context (`COPY . .`) and runs `npm run build`, whose type check
 * reads every file tsconfig.json includes (`**\/*.ts`, `**\/*.tsx`, `**\/*.mts`). `.dockerignore`
 * keeps tests out of the context (`**\/__tests__`, `e2e`, …). On 2026-11-19 Playform's CI failed
 * at "Container image → Build the image" (run 44646122500, develop c6b531d): batch 56e-3a made the
 * three `e2e-live/*.live.spec.ts` import `__tests__/helpers/app-shell-text`, `.dockerignore` dropped
 * `**\/__tests__` but not `e2e-live/`, so the type check inside the image read the specs and could
 * not find the helper (TS2307). Nothing outside that job builds from the context, so no other gate
 * saw it.
 *
 * This scan applies `.dockerignore` the way Docker does (moby/patternmatcher: patterns relative to
 * the context root, `*` and `?` within one path segment, `**` across segments, a pattern that
 * matches a parent directory drops everything beneath it, `!` takes a path back, the last matching
 * pattern decides) and refuses:
 *
 *   - a kept source file that loads (import, `export … from`, `import()`, `require()`) a repository
 *     file the context drops — relative or through tsconfig's one alias, `@/`;
 *   - a tsconfig path alias other than `@/*` → `./*` (the scan would not resolve it);
 *   - a kept file tsconfig includes that lies under a test directory (`__tests__`, `e2e`,
 *     `e2e-<name>`): test code has no place in the image, and its imports are not kept for it.
 *
 * Credits: the matching rules are Docker's, from "Dockerfile reference — .dockerignore file" by
 * Docker Inc. and the moby/patternmatcher source (Apache-2.0) by the Moby project authors.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join, posix } from "path";
import { ROOT, sourceFiles, specifiersIn } from "./helpers/import-graph";

interface Pattern {
  readonly text: string;
  readonly exclusion: boolean;
  readonly re: RegExp;
}

/** A .dockerignore pattern as moby/patternmatcher compiles it (Clean, leading "/" dropped). */
function compile(raw: string): Pattern {
  let p = raw.trim();
  const exclusion = p.startsWith("!");
  if (exclusion) p = p.slice(1).trim();
  p = p.replace(/^\/+/, "").replace(/\/+/g, "/").replace(/\/$/, "");
  p = p
    .split("/")
    .filter((s) => s !== ".")
    .join("/");
  let re = "^";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        while (p[i + 1] === "*") i++;
        if (i + 1 >= p.length) re += ".*";
        else if (p[i + 1] === "/") {
          re += "(.*/)?";
          i++;
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "\\" && i + 1 < p.length) re += "\\" + p[++i];
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return { text: raw, exclusion, re: new RegExp(`${re}$`) };
}

/** The patterns of a .dockerignore text (comments and blank lines skipped). */
export function dockerignorePatterns(text: string): Pattern[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .map(compile);
}

/** Whether Docker leaves a context-relative path out (patternmatcher's MatchesOrParentMatches). */
export function dropped(patterns: readonly Pattern[], file: string): boolean {
  const parts = file.split("/");
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.exclusion !== matched) continue;
    let match = pattern.re.test(file);
    for (let i = 1; !match && i < parts.length; i++) {
      match = pattern.re.test(parts.slice(0, i).join("/"));
    }
    if (match) matched = !pattern.exclusion;
  }
  return matched;
}

const TEST_DIR = /(?:^|\/)(?:__tests__|e2e(?:-[\w-]+)?)\//;
const TYPE_CHECKED = /\.(?:ts|tsx|mts)$/;

/** The repository file a specifier names (relative, or `@/` from the root), or null for a package. */
function resolve(
  from: string,
  specifier: string,
  exists: (rel: string) => boolean
): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith("."))
    base = posix.normalize(posix.join(posix.dirname(from), specifier));
  else return null;
  const stem = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  const candidates = [base];
  for (const b of stem === base ? [base] : [base, stem]) {
    for (const ext of [
      ".ts",
      ".tsx",
      ".mts",
      ".cts",
      ".d.ts",
      ".js",
      ".jsx",
      ".mjs",
      ".cjs",
      ".json",
    ]) {
      candidates.push(`${b}${ext}`, `${b}/index${ext}`);
    }
  }
  return candidates.find(exists) ?? null;
}

export interface ContextInput {
  readonly dockerignore: string;
  readonly tsconfigPaths: Record<string, readonly string[]>;
  /** Every source file of the context, repository-relative, with a reader for its text. */
  readonly files: readonly string[];
  readonly read: (rel: string) => string;
  readonly exists: (rel: string) => boolean;
}

/** Every problem the scan finds, one line each. */
export function contextProblems(input: ContextInput): string[] {
  const patterns = dockerignorePatterns(input.dockerignore);
  const problems: string[] = [];
  for (const [alias, targets] of Object.entries(input.tsconfigPaths)) {
    if (alias !== "@/*" || targets.length !== 1 || targets[0] !== "./*") {
      problems.push(
        `tsconfig.json path alias ${alias} → ${targets.join(", ")}: this scan resolves only "@/*" → "./*" — teach it the alias`
      );
    }
  }
  for (const file of input.files) {
    if (dropped(patterns, file)) continue;
    if (TYPE_CHECKED.test(file) && TEST_DIR.test(file)) {
      problems.push(
        `${file}: test code the image's build context keeps (next build type-checks it) — add its directory to .dockerignore`
      );
    }
    for (const specifier of specifiersIn(file, input.read(file))) {
      const to = resolve(file, specifier, input.exists);
      if (to !== null && dropped(patterns, to)) {
        problems.push(
          `${file} loads "${specifier}" (${to}), which .dockerignore drops from the image's build context`
        );
      }
    }
  }
  return problems;
}

function repositoryInput(): ContextInput {
  const tsconfig = JSON.parse(readFileSync(join(ROOT, "tsconfig.json"), "utf8")) as {
    compilerOptions?: { paths?: Record<string, string[]> };
  };
  return {
    dockerignore: readFileSync(join(ROOT, ".dockerignore"), "utf8"),
    tsconfigPaths: tsconfig.compilerOptions?.paths ?? {},
    files: sourceFiles(),
    read: (rel) => readFileSync(join(ROOT, rel), "utf8"),
    exists: (rel) => existsSync(join(ROOT, rel)) && statSync(join(ROOT, rel)).isFile(),
  };
}

describe("docker-context — the image builds from what .dockerignore keeps", () => {
  it("no kept file loads a dropped one, and the context keeps no test code", () => {
    expect(contextProblems(repositoryInput())).toEqual([]);
  });

  it("the scan sees the repository (the context keeps app/ and drops __tests__/)", () => {
    const input = repositoryInput();
    const patterns = dockerignorePatterns(input.dockerignore);
    expect(input.files.filter((f) => f.startsWith("app/")).length).toBeGreaterThan(10);
    expect(input.files.some((f) => !dropped(patterns, f) && f.startsWith("app/"))).toBe(
      true
    );
    expect(dropped(patterns, "__tests__/docker-context.test.ts")).toBe(true);
  });

  it("[self-test] matches as Docker does: anchored at the root, ** across segments, parents, ! and the last match", () => {
    const p = dockerignorePatterns(
      [
        "# comment",
        "**/__tests__",
        "e2e",
        "*.md",
        "!README.md",
        "jest.config.*",
        ".env*",
        "/k6",
      ].join("\n")
    );
    expect(dropped(p, "__tests__/a.ts")).toBe(true);
    expect(dropped(p, "platform/x/__tests__/b.ts")).toBe(true);
    expect(dropped(p, "e2e/audio/spec.ts")).toBe(true);
    expect(dropped(p, "e2e-live/spec.ts")).toBe(false);
    expect(dropped(p, "app/e2e/page.tsx")).toBe(false);
    expect(dropped(p, "NOTES.md")).toBe(true);
    expect(dropped(p, "docs/NOTES.md")).toBe(false);
    expect(dropped(p, "README.md")).toBe(false);
    expect(dropped(p, "jest.config.cjs")).toBe(true);
    expect(dropped(p, ".env.local")).toBe(true);
    expect(dropped(p, "k6/load.js")).toBe(true);
    expect(dropped(p, "app/page.tsx")).toBe(false);
  });

  it("[self-test] reports a kept spec importing a dropped helper, and the kept test directory (Playform's c6b531d)", () => {
    const files: Record<string, string> = {
      "e2e-live/user-journey.live.spec.ts":
        'import { signedInLine } from "../__tests__/helpers/app-shell-text";\n',
      "__tests__/helpers/app-shell-text.ts": "export const signedInLine = 1;\n",
      "app/page.tsx": 'const x = await import("@/__tests__/helpers/app-shell-text");\n',
      "lib/ok.ts": 'export { y } from "./y";\nconst z = require("../platform/z");\n',
      "lib/y.ts": "export const y = 1;\n",
      "platform/z.ts": "module.exports = 1;\n",
    };
    const input = (dockerignore: string): ContextInput => ({
      dockerignore,
      tsconfigPaths: { "@/*": ["./*"] },
      files: Object.keys(files),
      read: (rel) => files[rel],
      exists: (rel) => rel in files,
    });
    const before = contextProblems(input("**/__tests__\ne2e\n"));
    expect(before).toEqual([
      "e2e-live/user-journey.live.spec.ts: test code the image's build context keeps (next build type-checks it) — add its directory to .dockerignore",
      'e2e-live/user-journey.live.spec.ts loads "../__tests__/helpers/app-shell-text" (__tests__/helpers/app-shell-text.ts), which .dockerignore drops from the image\'s build context',
      'app/page.tsx loads "@/__tests__/helpers/app-shell-text" (__tests__/helpers/app-shell-text.ts), which .dockerignore drops from the image\'s build context',
    ]);
    const after = contextProblems(input("**/__tests__\ne2e\ne2e-live\n"));
    expect(after).toEqual([before[2]]);
  });

  it("[self-test] refuses a path alias it cannot resolve", () => {
    expect(
      contextProblems({
        dockerignore: "",
        tsconfigPaths: { "@/*": ["./*"], "~lib/*": ["./lib/*"] },
        files: [],
        read: () => "",
        exists: () => false,
      })
    ).toEqual([
      'tsconfig.json path alias ~lib/* → ./lib/*: this scan resolves only "@/*" → "./*" — teach it the alias',
    ]);
  });
});
