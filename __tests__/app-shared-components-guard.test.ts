/**
 * @jest-environment node
 */
/**
 * __tests__/app-shared-components-guard.test.ts — a page of the signed-in app is built from the
 * app's shared parts, never by hand (TASK-224)
 *
 * @guard a user's screen that draws its own header or main landmark, signs out or sends to
 * sign-in by itself, calls the API by hand, follows the device's light or dark setting, or puts a
 * light box on the dark app
 *
 * The 2026-11-12 review found the user's screens each building the same things separately: a
 * white bar above the dark home and a second bar on the translate screen (SF-app-001), white and
 * unannounced loading pages (003), sign-in that forgot the page asked for (E-113), screens that
 * followed the device's light setting (081) or put light boxes on the dark app (061), and calls
 * whose failure rejected unhandled or whose error page read as a network failure (092, P6, P13).
 * Batch 56e-2 built the app's parts (components/app/ui/) and moved every screen onto them; this
 * guard keeps a screen from drifting back, as the console's and sign-in's guards do for theirs.
 * Every source file of the user's screens is read, comments removed, and refused when it:
 *
 *   own-frame        writes a `main` landmark                       → AppShell (one per page)
 *   no-shell         is a page's client component without AppShell  → AppShell
 *   own-sign-out     calls signOut() itself                         → AppShell's Sign out
 *   own-sign-in      sends to /auth by router, or builds `?redirect=` → useSignedIn / signInPath
 *   own-call         calls fetch, apiFetch or playformApiFetch      → adminCall (the one call path)
 *   device-theme     uses a `dark:` class                           → the app's tokens (always dark)
 *   light-surface    a white or pale box (`bg-white`, `bg-*-50/100`) → the app's tokens
 *
 * The parts themselves (components/app/ui/, components/refusal/) are where these are written once.
 * An app adds its own screens beside the platform's in `app-screens.app.json` at its root,
 * `{ "screens": [file, …] }` — a file of its own the sync never writes; they are scanned the same
 * way. There is no list of known exceptions: every screen meets every rule.
 *
 * These are patterns in the source, so a proxy: they prove a screen does not write these things,
 * not that it uses the parts well — the screens' own tests, axe and the walk do that.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");

/** The user's screens: the app's pages but sign-in's and the console's, and their components. */
const SCREEN_DIRS = [
  "app",
  "components/account",
  "components/assistant",
  "components/AppealForm",
  "components/AdaptiveInput",
] as const;
const SCREEN_FILES = ["components/SpikeApp.tsx"] as const;

/** Not the user's screens: sign-in (its own guard), the console (its own), the API, the parts. */
const NOT_SCANNED = ["app/api/", "app/auth/", "app/admin/"] as const;

/** The shared parts: where these things are written once. */
export const SHARED_PARTS = ["components/app/ui/", "components/refusal/"] as const;

/** The app's own screens (app-screens.app.json), each a file that exists; none when it has none. */
export function appScreens(text: string | null): string[] {
  if (text === null) return [];
  const read = (JSON.parse(text) as { screens?: unknown }).screens;
  if (!Array.isArray(read) || read.some((f) => typeof f !== "string"))
    throw new Error("app-screens.app.json: screens must be a list of files");
  for (const file of read as string[]) {
    if (SHARED_PARTS.some((part) => file.startsWith(part)))
      throw new Error(`app-screens.app.json: ${file} is a shared part, not a screen`);
    if (!existsSync(join(ROOT, file)))
      throw new Error(`app-screens.app.json: ${file} is not there`);
  }
  return read as string[];
}

const APP_LIST = join(ROOT, "app-screens.app.json");

type RuleId =
  | "own-frame"
  | "no-shell"
  | "own-sign-out"
  | "own-sign-in"
  | "own-call"
  | "device-theme"
  | "light-surface";

const RULES: Readonly<
  Record<Exclude<RuleId, "no-shell">, { readonly pattern: RegExp; readonly use: string }>
> = {
  "own-frame": { pattern: /<main[\s>]/, use: "AppShell" },
  "own-sign-out": { pattern: /\bsignOut\(/, use: "AppShell's Sign out" },
  "own-sign-in": {
    pattern: /router\.(?:replace|push)\(\s*["'`]\/auth\b|["'`]\/auth\?redirect=/,
    use: "useSignedIn or signInPath",
  },
  "own-call": {
    pattern: /\b(?:apiFetch|playformApiFetch|fetch)\(/,
    use: "adminCall (components/admin/ui/admin-call.ts)",
  },
  "device-theme": { pattern: /\bdark:[a-z]/, use: "the app's tokens" },
  "light-surface": {
    pattern:
      /\bbg-(?:white|gray-50|gray-100|slate-50|(?:red|green|blue|amber|yellow|violet)-(?:50|100))\b/,
    use: "the app's tokens",
  },
};

/** Source without its comments (a comment may name what the code must not write). */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** A page's client component: the file a page renders, which must be in the app's frame. */
export function isPageClient(file: string): boolean {
  return (
    /^app\/(?:.+\/)?[A-Z]\w*Client\.tsx$/.test(file) || file === "app/HomeClient.tsx"
  );
}

/** The rules `source` (the file `file`) breaks. */
export function brokenRules(source: string, file = "components/x.tsx"): RuleId[] {
  const code = withoutComments(source);
  const broken: RuleId[] = (Object.keys(RULES) as Exclude<RuleId, "no-shell">[]).filter(
    (id) => RULES[id].pattern.test(code)
  );
  if (isPageClient(file) && !/from\s+["']@\/components\/app\/ui\/AppShell["']/.test(code))
    broken.push("no-shell");
  return broken;
}

function sources(dir: string): string[] {
  const at = join(ROOT, dir);
  if (!existsSync(at)) return [];
  return readdirSync(at).flatMap((name) => {
    const path = join(at, name);
    const rel = relative(ROOT, path).split(sep).join("/");
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(rel);
    return /\.tsx?$/.test(name) && !/\.(?:test|spec)\./.test(name) ? [rel] : [];
  });
}

/** Every user screen's source file. */
export function screenFiles(): string[] {
  const listed = appScreens(existsSync(APP_LIST) ? readFileSync(APP_LIST, "utf8") : null);
  const all = [
    ...SCREEN_DIRS.flatMap(sources),
    ...SCREEN_FILES.filter((f) => existsSync(join(ROOT, f))),
    ...listed,
  ];
  return [...new Set(all)].filter(
    (file) =>
      !NOT_SCANNED.some((dir) => file.startsWith(dir)) &&
      !SHARED_PARTS.some((part) => file.startsWith(part))
  );
}

/** Every problem in the user's screens. */
export function scan(files: readonly string[] = screenFiles()): string[] {
  const problems: string[] = [];
  for (const file of files) {
    for (const rule of brokenRules(readFileSync(join(ROOT, file), "utf8"), file))
      problems.push(
        `${file}: ${rule} — use ${rule === "no-shell" ? "AppShell" : RULES[rule].use}`
      );
  }
  return problems;
}

describe("the user's screens are built from the app's shared parts (TASK-224)", () => {
  it("no user screen draws its own frame, signs out, sends to sign-in, calls by hand or leaves the dark theme", () => {
    expect(scan()).toEqual([]);
  });

  it("the shared parts are there, and the platform's screens are scanned", () => {
    for (const part of [
      "components/app/ui/AppShell.tsx",
      "components/app/ui/useSignedIn.ts",
      "components/app/ui/ProblemPage.tsx",
      "components/app/ui/AuthenticatorKey.tsx",
    ])
      expect(existsSync(join(ROOT, part))).toBe(true);
    expect(screenFiles()).toEqual(
      expect.arrayContaining([
        "app/HomeClient.tsx",
        "app/account/AccountClient.tsx",
        "app/assistant/AssistantClient.tsx",
        "components/account/SignInSecurity.tsx",
        "components/account/YourData.tsx",
        "components/account/ModerationDecisions.tsx",
        "components/assistant/AssistantPanel.tsx",
        "components/AppealForm/AppealForm.tsx",
        "components/SpikeApp.tsx",
      ])
    );
  });
});

describe("the app guard's self-tests (TASK-224)", () => {
  const PLANTED: readonly (readonly [RuleId, string])[] = [
    ["own-frame", '<main className="min-h-screen">'],
    ["own-sign-out", "const ok = await signOut();"],
    ["own-sign-in", 'router.replace("/auth");'],
    ["own-sign-in", "router.push(`/auth?error=x`)"],
    ["own-sign-in", 'const to = "/auth?redirect=/account";'],
    ["own-call", 'const r = await apiFetch("/api/x");'],
    ["own-call", 'await playformApiFetch("/api/x", { method: "POST" })'],
    ["own-call", 'await fetch("/api/x")'],
    ["device-theme", 'className="bg-white dark:bg-[#111827]"'],
    ["light-surface", 'className="bg-green-50 text-green-800"'],
    ["light-surface", 'className="rounded bg-white p-2"'],
  ];

  it.each(PLANTED)("[self-test] %s is found in: %s", (rule, source) => {
    expect(brokenRules(source)).toContain(rule);
  });

  it("[self-test] a page's client component without the shell is found; with it, it is not", () => {
    expect(
      brokenRules("export default function X() { return null; }", "app/x/XClient.tsx")
    ).toContain("no-shell");
    expect(
      brokenRules(
        'import { AppShell } from "@/components/app/ui/AppShell";',
        "app/x/XClient.tsx"
      )
    ).not.toContain("no-shell");
    expect(
      brokenRules("export default function X() { return null; }", "components/x.tsx")
    ).not.toContain("no-shell");
  });

  it("[self-test] the parts' use, and what a comment names, are not findings", () => {
    expect(
      brokenRules(
        [
          '// a <main> written by hand, router.replace("/auth") and fetch( were the problem',
          "/* signOut() and dark:bg-x and bg-white */",
          "<AppShell>{children}</AppShell>",
          "const ok = await signOutEverywhere();",
          'const answer = await adminCall("/api/x", { method: "POST" });',
          'href={signInPath("/account")}',
          'className="bg-[#0a0f1e] bg-red-950/40 bg-blue-900/20"',
          "onSignOut={onSignOut}",
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("[self-test] an app's own list names files that exist, and no shared part", () => {
    expect(appScreens(null)).toEqual([]);
    expect(appScreens(JSON.stringify({ screens: ["components/SpikeApp.tsx"] }))).toEqual([
      "components/SpikeApp.tsx",
    ]);
    expect(() =>
      appScreens(JSON.stringify({ screens: ["components/Gone.tsx"] }))
    ).toThrow(/is not there/);
    expect(() =>
      appScreens(JSON.stringify({ screens: ["components/app/ui/AppShell.tsx"] }))
    ).toThrow(/shared part/);
    expect(() => appScreens(JSON.stringify({ screens: "x" }))).toThrow();
  });
});
