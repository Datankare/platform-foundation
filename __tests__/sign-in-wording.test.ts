/**
 * @jest-environment node
 */
/**
 * __tests__/sign-in-wording.test.ts — the sign-in screens speak in one style and call each thing
 * by one name (TASK-222, SF-app-050)
 *
 * @guard a sign-in screen's text (or a sign-in or sign-out label anywhere) in Title Case, with
 * "..." for an ellipsis, or calling two-step verification by another name
 *
 * The review found "Sign In" beside "Sign in", "Sign Out" beside "Sign out", "Create Account",
 * "Verify Your Age", "Refresh Page"; "..." beside "…"; and the same protection called
 * "Two-Factor Authentication" at sign-in and "two-step verification" in the console. The text is
 * sentence case — only a sentence's first word and a name are capitalised — with the one
 * ellipsis character, and the protection is "two-step verification" on every screen.
 *
 * Judged as the catalogue's ICU messages are read (as catalogue-plain-words.test.ts reads them):
 * only what a person reads, never an argument's name.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { IntlMessageFormat } from "intl-messageformat";

const ROOT = join(__dirname, "..");
const CATALOGUES = ["messages/en.json", "messages/app/en.json"].filter((f) =>
  existsSync(join(ROOT, f))
);

type Node = {
  readonly type: number;
  readonly value?: unknown;
  readonly options?: Record<string, { readonly value: Node[] }>;
  readonly children?: Node[];
};

/** The text a person reads in an ICU message: its literals, in every branch. */
export function readText(message: string): string {
  let ast: Node[];
  try {
    ast = new IntlMessageFormat(message, "en").getAst() as unknown as Node[];
  } catch {
    return message;
  }
  const out: string[] = [];
  const walk = (nodes: readonly Node[]) => {
    for (const node of nodes) {
      if (node.type === 0 && typeof node.value === "string") out.push(node.value);
      for (const option of Object.values(node.options ?? {})) walk(option.value);
      if (node.children) walk(node.children);
    }
  };
  walk(ast);
  return out.join(" ");
}

/** The sign-in screens' text, and every sign-in and sign-out label on any screen. */
export function inScope(key: string): boolean {
  return (
    key.startsWith("screens.auth.") ||
    key.startsWith("screens.app.auth_page.") ||
    /^screens\.app\.meta\.auth_/.test(key) ||
    key === "screens.error_boundary.refresh_page" ||
    /\.(?:sign_in|sign_out|signing_in|signing_out)$/.test(key)
  );
}

/** Words that are names, capitalised wherever they stand. */
const NAMES = new Set([
  "Google",
  "Apple",
  "Microsoft",
  "Playform",
  "Platform",
  "Foundation",
  "PLAY",
  "FORM",
  "I",
]);

/** What is wrong with one value's text (empty: nothing). */
export function wordingProblems(text: string): string[] {
  const out: string[] = [];
  if (/\.\.\./.test(text)) out.push('"..." — write the one ellipsis character "…"');
  // A capitalised word that does not start a sentence (or follow a colon or dash), and is no name.
  const sentences = text.split(/(?<=[.!?:—–])\s+|\s+[—–]\s+/);
  for (const s of sentences) {
    const words = s.split(/\s+/).filter(Boolean);
    for (const w of words.slice(1)) {
      const bare = w.replace(/^\P{L}+|\P{L}+$/gu, "");
      if (/^\p{Lu}\p{Ll}/u.test(bare) && !NAMES.has(bare)) {
        out.push(`"${bare}" capitalised inside a sentence — sentence case`);
        break;
      }
    }
  }
  return out;
}

/** Another name for two-step verification, on any screen. */
export const OTHER_NAME = /two[- ]factor|\b2FA\b|\bMFA\b|\bTOTP\b|multi[- ]factor/i;

function values(catalogue: unknown): [string, string][] {
  const out: [string, string][] = [];
  const walk = (node: unknown, path: string) => {
    if (typeof node === "string") out.push([path, node]);
    else if (node && typeof node === "object")
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(catalogue, "");
  return out;
}

describe("sign-in screens: one style, one name (SF-app-050)", () => {
  it.each(CATALOGUES)(
    "%s: sentence case and one ellipsis on the sign-in screens",
    (file) => {
      const all = values(JSON.parse(readFileSync(join(ROOT, file), "utf8")));
      const scoped = all.filter(([k]) => inScope(k));
      if (file === "messages/en.json") expect(scoped.length).toBeGreaterThan(50);
      const problems = scoped.flatMap(([k, v]) =>
        wordingProblems(readText(v)).map((p) => `${file} ${k}: ${p} — “${v}”`)
      );
      expect(problems).toEqual([]);
    }
  );

  it.each(CATALOGUES)(
    "%s: two-step verification by that name on every screen",
    (file) => {
      const all = values(JSON.parse(readFileSync(join(ROOT, file), "utf8")));
      const problems = all
        .filter(([k]) => k.startsWith("screens."))
        .filter(([, v]) => OTHER_NAME.test(readText(v)))
        .map(([k, v]) => `${file} ${k}: “${v}”`);
      expect(problems).toEqual([]);
    }
  );
});

describe("the wording guard's self-tests", () => {
  it.each([
    ["Sign In"],
    ["Create Account"],
    ["Verify Your Age"],
    ["Refresh Page"],
    ["Signing in..."],
    ["Back to Sign In"],
  ])("[self-test] %s is reported", (text) => {
    expect(wordingProblems(text)).not.toEqual([]);
  });

  it.each([
    ["Sign in"],
    ["Continue with Google"],
    ["Signing in…"],
    ["Sign in — Playform"],
    ["Your password has been reset. Sign in with your new password."],
    ["Don’t have an account?"],
  ])("[self-test] %s passes", (text) => {
    expect(wordingProblems(text)).toEqual([]);
  });

  it("[self-test] other names for two-step verification are found", () => {
    for (const t of ["Two-Factor Authentication", "Set up MFA", "2FA code", "TOTP"])
      expect(OTHER_NAME.test(t)).toBe(true);
    expect(OTHER_NAME.test("Two-step verification")).toBe(false);
  });

  it("[self-test] a sign-in or sign-out label anywhere is in scope; other screens' text is not", () => {
    expect(inScope("screens.home.sign_out")).toBe(true);
    expect(inScope("screens.admin_console.sign_in")).toBe(true);
    expect(inScope("screens.auth.login.email")).toBe(true);
    expect(inScope("screens.jobs.title")).toBe(false);
  });
});
