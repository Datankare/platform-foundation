/**
 * @jest-environment node
 */
/**
 * __tests__/auth-shared-components-guard.test.ts — a sign-in screen is built from the sign-in
 * screens' shared parts, never by hand (TASK-222)
 *
 * @guard a sign-in screen that writes a form control, a refusal or notice, a step heading, a
 * wait or a password rule by hand
 *
 * The 2026-11-12 review found the sign-in screens each building the same things separately:
 * fields labelled by a placeholder or for a screen reader only, code fields with no label at
 * all, errors tied to no field, "Passwords do not match" in grey that nobody heard, three
 * different password rules on three screens and none the server's (SF-app-042 to 046, E-112).
 * Batch 56e-1 built the shared parts (components/auth/ui/) and moved every sign-in screen onto
 * them; this guard keeps a screen from drifting back, as __tests__/admin-shared-components-guard
 * does for the console. Every source file of the sign-in screens (components/auth, app/auth —
 * but the shared parts themselves) is read, comments removed, and refused when it:
 *
 *   raw-control     writes an input, select or textarea      → AuthField with AuthInput / CodeInput
 *   own-message     keeps a live region of its own           → FormError / FormNotice / AuthLoading
 *   own-heading     writes a step's h2                        → AuthHeading (focus when the step opens)
 *   own-rule        judges a password itself                  → PasswordRules / NewPasswordFields
 *                   (a length, a kind of character)             (the server's policy, its function)
 *   own-features    reads the feature list for its providers  → the page's server render
 *
 * These are patterns in the source, so a proxy: they prove a screen does not write these things,
 * not that it uses the shared parts well — the screens' own tests and the walk do that.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..");
const SCREEN_DIRS = ["components/auth", "app/auth"];

/** The shared parts: where these things are written once. */
const SHARED_PARTS = ["components/auth/ui/"];

/** The sign-in steps: always scanned, never listed as not a step. */
const SIGN_IN_STEPS = [
  "components/auth/AuthPage.tsx",
  "components/auth/LoginForm.tsx",
  "components/auth/RegisterForm.tsx",
  "components/auth/ForgotPasswordForm.tsx",
  "components/auth/NewPasswordForm.tsx",
  "components/auth/MfaChallengeForm.tsx",
  "components/auth/EmailVerificationForm.tsx",
  "components/auth/AgeGate.tsx",
  "components/auth/SsoButtons.tsx",
  "components/auth/AuthLayout.tsx",
  "app/auth/AuthPageClient.tsx",
  "app/auth/callback/SsoCallbackClient.tsx",
] as const;

/**
 * Files in those folders that are not a sign-in step, each with why. A new one is a reviewed
 * change. An app keeps its own (its screens beside the platform's in components/auth, such as a
 * profile page) in `auth-screens.app.json` at its root, `{ "notASignInStep": { file: why } }` —
 * a file of its own the sync never writes; the platform has none.
 */
const PLATFORM_NOT_A_STEP: Readonly<Record<string, string>> = {
  "components/auth/SessionIdleWarning.tsx":
    "a signed-in staff member's idle notice over any page (ADR-057 D5): a dialog with its own tests, not a sign-in step",
};

/** The app's own entries (auth-screens.app.json), each with a reason; none when it has no file. */
export function appNotASignInStep(text: string | null): Record<string, string> {
  if (text === null) return {};
  const read = (JSON.parse(text) as { notASignInStep?: unknown }).notASignInStep;
  if (typeof read !== "object" || read === null || Array.isArray(read))
    throw new Error("auth-screens.app.json: notASignInStep must be { file: why }");
  const out: Record<string, string> = {};
  for (const [file, why] of Object.entries(read)) {
    if (typeof why !== "string" || why.trim().length < 20)
      throw new Error(`auth-screens.app.json: ${file} needs its reason (a sentence)`);
    if ((SIGN_IN_STEPS as readonly string[]).includes(file))
      throw new Error(`auth-screens.app.json: ${file} is a sign-in step`);
    if (file.startsWith("components/auth/ui/") || file in PLATFORM_NOT_A_STEP)
      throw new Error(`auth-screens.app.json: ${file} is the platform's to list`);
    out[file] = why;
  }
  return out;
}

const APP_LIST = join(ROOT, "auth-screens.app.json");
const NOT_A_STEP: Readonly<Record<string, string>> = {
  ...PLATFORM_NOT_A_STEP,
  ...appNotASignInStep(existsSync(APP_LIST) ? readFileSync(APP_LIST, "utf8") : null),
};

type RuleId = "raw-control" | "own-message" | "own-heading" | "own-rule" | "own-features";

const RULES: Readonly<
  Record<RuleId, { readonly pattern: RegExp; readonly use: string }>
> = {
  "raw-control": {
    pattern: /<(?:input|select|textarea)[\s>]/,
    use: "AuthField with AuthInput or CodeInput",
  },
  "own-message": {
    pattern: /role=["'](?:status|alert)["']|aria-live=/,
    use: "FormError, FormNotice or AuthLoading",
  },
  "own-heading": { pattern: /<h2[\s>]/, use: "AuthHeading" },
  "own-rule": {
    pattern:
      /\/\[A-Z\]\/\.test|\/\[a-z\]\/\.test|\/\[0-9\]\/\.test|\/\[\^A-Za-z0-9\]\/|minPasswordLength|(?:password|newPassword)\.length\s*(?:>=|<|>)\s*[1-9]/,
    use: "PasswordRules / NewPasswordFields (the server's policy)",
  },
  "own-features": {
    pattern: /["'`]\/api\/features["'`]/,
    use: "the page's server render",
  },
};

/** Source without its comments (a comment may name what the code must not write). */
export function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** The rules `source` breaks. */
export function brokenRules(source: string): RuleId[] {
  const code = withoutComments(source);
  return (Object.keys(RULES) as RuleId[]).filter((id) => RULES[id].pattern.test(code));
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

const isShared = (file: string) => SHARED_PARTS.some((part) => file.startsWith(part));

/** Every problem in the sign-in screens. */
export function scan(exempt: Readonly<Record<string, string>> = NOT_A_STEP): string[] {
  const files = SCREEN_DIRS.flatMap(sources).filter((file) => !isShared(file));
  const problems: string[] = [];
  for (const file of files) {
    if (file in exempt) continue;
    for (const rule of brokenRules(readFileSync(join(ROOT, file), "utf8")))
      problems.push(`${file}: ${rule} — use ${RULES[rule].use}`);
  }
  for (const file of Object.keys(exempt))
    if (!files.includes(file))
      problems.push(`${file}: listed as not a step, but not there — remove it`);
  return problems;
}

describe("sign-in screens are built from the shared parts (TASK-222)", () => {
  it("no sign-in screen builds a field, a message, a heading, a rule or a provider list by hand", () => {
    expect(scan()).toEqual([]);
  });

  it("the shared parts are there, and every sign-in step is scanned", () => {
    for (const part of [
      "components/auth/ui/AuthField.tsx",
      "components/auth/ui/AuthHeading.tsx",
      "components/auth/ui/PasswordRules.tsx",
      "components/auth/ui/NewPasswordFields.tsx",
      "components/auth/ui/AuthLoading.tsx",
    ])
      expect(existsSync(join(ROOT, part))).toBe(true);
    const scanned = SCREEN_DIRS.flatMap(sources).filter((f) => !isShared(f));
    expect(scanned).toEqual(expect.arrayContaining([...SIGN_IN_STEPS]));
  });
});

describe("the sign-in guard's self-tests (TASK-222)", () => {
  const PLANTED: readonly (readonly [RuleId, string])[] = [
    ["raw-control", '<input id="x" value={v} />'],
    ["raw-control", "<select>\n<option/></select>"],
    ["own-message", '<div role="alert">{error}</div>'],
    ["own-message", '<p aria-live="polite">{n}</p>'],
    ["own-heading", '<h2 className="x">{t("title")}</h2>'],
    ["own-rule", "const ok = /[A-Z]/.test(password);"],
    ["own-rule", "const long = password.length >= 8;"],
    ["own-rule", "minPasswordLength = 12"],
    ["own-features", 'fetch("/api/features")'],
  ];

  it.each(PLANTED)("[self-test] %s is found in: %s", (rule, source) => {
    expect(brokenRules(source)).toContain(rule);
  });

  it("[self-test] the shared parts' use, and what a comment names, are not findings", () => {
    expect(
      brokenRules(
        [
          '// a <input> written by hand was the problem; role="alert" too',
          "/* <h2> and /[A-Z]/.test(password) */",
          '<AuthField id="login-email" label={t("email")}>',
          "{(c) => <AuthInput {...c} />}",
          '<AuthHeading>{t("sign_in")}</AuthHeading>',
          '<FormError id="e" message={error} />',
          "<PasswordRules password={pw} policy={policy} />",
          "const ready = /^\\d{6}$/.test(code);",
        ].join("\n")
      )
    ).toEqual([]);
  });

  it("[self-test] an app's own list needs a reason per file, and cannot take the platform's", () => {
    expect(appNotASignInStep(null)).toEqual({});
    expect(
      appNotASignInStep(
        JSON.stringify({
          notASignInStep: {
            "components/auth/ProfilePage.tsx":
              "the signed-in person's profile page, not a sign-in step",
          },
        })
      )
    ).toEqual({
      "components/auth/ProfilePage.tsx":
        "the signed-in person's profile page, not a sign-in step",
    });
    expect(() =>
      appNotASignInStep(
        JSON.stringify({ notASignInStep: { "components/auth/X.tsx": "" } })
      )
    ).toThrow(/needs its reason/);
    expect(() =>
      appNotASignInStep(
        JSON.stringify({
          notASignInStep: { "components/auth/LoginForm.tsx": "x".repeat(30) },
        })
      )
    ).toThrow(/is a sign-in step/);
    expect(() =>
      appNotASignInStep(
        JSON.stringify({
          notASignInStep: { "components/auth/ui/AuthField.tsx": "x".repeat(30) },
        })
      )
    ).toThrow(/the platform's to list/);
    expect(() => appNotASignInStep(JSON.stringify({ notASignInStep: [] }))).toThrow();
  });

  it("[self-test] no sign-in step is listed as not one", () => {
    for (const step of SIGN_IN_STEPS) expect(NOT_A_STEP).not.toHaveProperty(step);
  });

  it("[self-test] an exempt file that is gone is reported", () => {
    expect(scan({ ...NOT_A_STEP, "components/auth/Gone.tsx": "x" })).toContain(
      "components/auth/Gone.tsx: listed as not a step, but not there — remove it"
    );
  });
});
