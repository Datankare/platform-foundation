/**
 * e2e/sign-in-screens.spec.ts — every sign-in step, as a person moves through it, at 1280 and
 * 390 px (TASK-222: the sign-in screens' review, SF-app-040 to 051, E-110, E-112, E-113)
 *
 * On each step: axe (WCAG 2.2 AA) finds nothing, the page does not scroll sideways, the step's
 * heading has focus once the page moved to it, a refusal is announced and tied to its field, and
 * Back moves between steps inside the page.
 *
 * The sign-in budget: the whole run shares 10 sign-ins per 15 minutes per address
 * (DEFAULT_RULES.AUTH_LOGIN — the two-step and new-password answers count too), and account
 * steps (sign-up, verification, reset) 10 per hour (AUTH_ACCOUNT). This spec signs nobody in:
 * the two-step and new-password steps are reached with the sign-in route's own answers
 * (__tests__/fixtures/route-responses.json, made by the real route), served to the page in place
 * of a request. At 1280 the account journey's sign-up, verification and code request go to the
 * real routes (3 of AUTH_ACCOUNT); at 390 the same answers are served from the fixtures. The
 * password reset's confirmation is always served from its fixture: on the server it ends every
 * session of the account (ADR-057 D6), and the test double's account is every journey's.
 * E-113's return is proved on a session the run already has (signInPage joins it: no sign-in).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { checkA11y } from "./helpers/a11y";
import { E2E_USER, signInPage } from "./helpers/session";

const CATALOGUE = JSON.parse(
  readFileSync(join(__dirname, "..", "messages", "en.json"), "utf8")
) as { screens: { auth: Record<string, Record<string, string> | string> } };
const FIXTURES = JSON.parse(
  readFileSync(
    join(__dirname, "..", "__tests__", "fixtures", "route-responses.json"),
    "utf8"
  )
) as Record<string, { status: number; body: unknown }>;

/** A sign-in screen's text (screens.auth.<group>.<key>), its one {email} filled. */
function say(key: string, email?: string): string {
  const [group, name] = key.split(".");
  const value = (CATALOGUE.screens.auth[group] as Record<string, string>)[name];
  return email === undefined ? value : value.replace("{email}", email);
}

/** Serve `path`'s POST from the route's own recorded answer, for this page only. */
async function answerFrom(page: Page, path: string, fixture: string): Promise<void> {
  const f = FIXTURES[fixture];
  if (!f) throw new Error(`no route fixture "${fixture}"`);
  await page.route(`**${path}`, (route) =>
    route.request().method() === "POST"
      ? route.fulfill({ status: f.status, contentType: "application/json", json: f.body })
      : route.fallback()
  );
}

const STRONG = "Correct-Horse-Battery-9";
const WIDTHS = [1280, 390] as const;

/** axe, no sideways scroll, and — once the page moved — the step's heading focused. */
async function stepIsSound(page: Page, heading: string, moved = true): Promise<void> {
  const h = page.getByRole("heading", { level: 2, name: heading });
  await expect(h).toBeVisible();
  if (moved) await expect(h).toBeFocused();
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(sideways, `${heading}: sideways scroll`).toBeLessThanOrEqual(0);
  await checkA11y(page);
}

/** The field's refusal: announced, the field marked invalid and described by it. */
async function refusalIsTied(page: Page, label: string, message: string): Promise<void> {
  const field = page.getByLabel(label, { exact: true });
  const alert = page.getByRole("alert").filter({ hasText: message });
  await expect(alert).toBeVisible();
  await expect(field).toHaveAttribute("aria-invalid", "true");
  const id = await alert.getAttribute("id");
  expect(await field.getAttribute("aria-describedby")).toContain(id);
}

for (const width of WIDTHS) {
  test(`the account steps at ${width} px: date of birth, account form, verification, then sign-in saying so (SF-app-040, 041, 042, 043, 046, E-112)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width !== 1280) {
      await answerFrom(
        page,
        "/api/auth/sign-up",
        "POST /api/auth/sign-up — the address to verify"
      );
      await answerFrom(
        page,
        "/api/auth/verify-email",
        "POST /api/auth/verify-email — verified"
      );
    }
    // E-112: the page reads the rules a new password must meet from the server.
    const policyRead = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/auth/password-policy" &&
        r.request().method() === "GET"
    );
    await page.goto("/auth");
    const policy = await policyRead;
    expect(policy.status(), "GET /api/auth/password-policy").toBe(200);
    expect(
      ((await policy.json()) as { policy: { minLength: number } }).policy.minLength
    ).toBeGreaterThanOrEqual(8);
    await stepIsSound(page, say("login.sign_in"), false);
    // E-110: nothing names the code base on the sign-in page.
    await expect(page.locator("body")).not.toContainText(
      /Foundation as Fabric|Continuous Confidence/
    );

    await page.getByRole("button", { name: say("login.create_one") }).click();
    await expect(page).toHaveURL(/[?&]view=create-account/);
    await stepIsSound(page, say("age_gate.verify_your_age"));
    // SF-app-046: a form — Enter continues; empty, the field says why.
    await page.getByLabel(say("age_gate.date_of_birth")).press("Enter");
    await refusalIsTied(
      page,
      say("age_gate.date_of_birth"),
      say("age_gate.enter_your_date_of_birth")
    );
    await checkA11y(page);
    await page.getByLabel(say("age_gate.date_of_birth")).fill("1990-01-01");
    await page.getByLabel(say("age_gate.date_of_birth")).press("Enter");

    await stepIsSound(page, say("register.create_account"));
    await page.getByLabel(say("register.email"), { exact: true }).fill(E2E_USER.email);
    const password = page.getByLabel(say("register.password"), { exact: true });
    await password.fill("short");
    // E-112 / SF-app-043: the server's rules, each said met or not met in words.
    const rules = page.locator("[data-password-rules]");
    await expect(rules).toContainText(say("password_rules.not_met"));
    await page
      .getByLabel(say("register.confirm_password"), { exact: true })
      .fill("shorx");
    await refusalIsTied(
      page,
      say("register.confirm_password"),
      say("password_rules.do_not_match")
    );
    await checkA11y(page);
    await password.fill(STRONG);
    await page.getByLabel(say("register.confirm_password"), { exact: true }).fill(STRONG);
    await expect(rules.locator("[data-met='false']")).toHaveCount(0);

    const signedUp = page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/sign-up") && r.request().method() === "POST"
    );
    await page.getByRole("button", { name: say("register.create_account") }).click();
    expect((await signedUp).status()).toBe(200);
    await expect(page).toHaveURL(/[?&]view=verify-email/);
    await stepIsSound(page, say("email_verification.verify_your_email"));
    await page.getByLabel(say("email_verification.code_label")).fill("123456");
    const verified = page.waitForResponse(
      (r) => r.url().endsWith("/api/auth/verify-email") && r.request().method() === "POST"
    );
    await page
      .getByRole("button", { name: say("email_verification.verify_email") })
      .click();
    expect((await verified).status()).toBe(200);

    // SF-app-040: sign-in, saying the address is verified, the address filled in.
    await stepIsSound(page, say("login.sign_in"));
    await expect(page.getByRole("status")).toHaveText(say("page.email_verified"));
    await expect(page.getByLabel(say("login.email"), { exact: true })).toHaveValue(
      E2E_USER.email
    );
    await expect(page.getByLabel(say("login.password"), { exact: true })).toHaveValue("");
    await checkA11y(page);

    // SF-app-041: Back goes to the step before, inside the page.
    await page.goBack();
    await expect(page).toHaveURL(/[?&]view=verify-email/);
    await expect(
      page.getByRole("heading", {
        level: 2,
        name: say("email_verification.verify_your_email"),
      })
    ).toBeVisible();
  });

  test(`the reset steps at ${width} px: address, code naming the address, a new code, then sign-in saying so (SF-app-044, E-112)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    if (width !== 1280)
      await answerFrom(
        page,
        "/api/auth/forgot-password",
        "POST /api/auth/forgot-password — sent, or not: the same answer either way"
      );
    await answerFrom(
      page,
      "/api/auth/confirm-forgot-password",
      "POST /api/auth/confirm-forgot-password — reset"
    );
    await page.goto("/auth?view=reset-password");
    await stepIsSound(page, say("forgot_password.reset_password"), false);
    await page
      .getByLabel(say("forgot_password.email"), { exact: true })
      .fill(E2E_USER.email);
    const sent = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/forgot-password") && r.request().method() === "POST"
    );
    await page
      .getByRole("button", { name: say("forgot_password.send_reset_code") })
      .click();
    expect((await sent).status()).toBe(200);
    await stepIsSound(page, say("forgot_password.reset_password"));
    // Never says the address has an account (audit A-15): "If … belongs to an account".
    await expect(
      page.getByText(say("forgot_password.sent_code_to", E2E_USER.email))
    ).toBeVisible();
    const waitWords = say("forgot_password.resend_in").split("{")[0].trim();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${waitWords}`) })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: say("forgot_password.use_another_address") })
    ).toBeVisible();

    await page.getByLabel(say("forgot_password.reset_code")).fill("123456");
    await page
      .getByLabel(say("forgot_password.new_password"), { exact: true })
      .fill(STRONG);
    await page
      .getByLabel(say("forgot_password.confirm_new_password"), { exact: true })
      .fill(STRONG);
    await checkA11y(page);
    await page
      .getByRole("button", { name: say("forgot_password.reset_password") })
      .click();
    await stepIsSound(page, say("login.sign_in"));
    await expect(page.getByRole("status")).toHaveText(say("page.password_was_reset"));
    await expect(page.getByLabel(say("login.email"), { exact: true })).toHaveValue(
      E2E_USER.email
    );
  });

  test(`two-step verification and a new password at ${width} px, reached with the sign-in route's own answers — no sign-in spent (S8 accessibility, SF-app-045, SF-app-050)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await answerFrom(
      page,
      "/api/auth/sign-in",
      "POST /api/auth/sign-in — two-step verification asked"
    );
    await page.goto("/auth");
    await page
      .getByLabel(say("login.email"), { exact: true })
      .fill("someone@example.test");
    await page.getByLabel(say("login.password"), { exact: true }).fill("any-password");
    await page.getByRole("button", { name: say("login.sign_in"), exact: true }).click();
    await expect(page).toHaveURL(/[?&]view=two-step/);
    await stepIsSound(page, say("mfa_challenge.two_factor_authentication"));
    await expect(page.getByLabel(say("mfa_challenge.code_label"))).toHaveAttribute(
      "autocomplete",
      "one-time-code"
    );
    await page.getByRole("button", { name: say("mfa_challenge.cancel_sign_in") }).click();
    await stepIsSound(page, say("login.sign_in"));

    await page.unroute("**/api/auth/sign-in");
    await answerFrom(
      page,
      "/api/auth/sign-in",
      "POST /api/auth/sign-in — a new password asked"
    );
    await page.getByLabel(say("login.password"), { exact: true }).fill("any-password");
    await page.getByRole("button", { name: say("login.sign_in"), exact: true }).click();
    await stepIsSound(page, say("new_password.set_a_new_password"));
    // SF-app-045: labels a sighted person reads.
    for (const key of [
      "new_password.new_password",
      "new_password.confirm_new_password",
    ]) {
      const label = page.locator("label").getByText(say(key), { exact: true });
      await expect(label).toBeVisible();
    }
  });

  test(`a single sign-on cancelled at the provider at ${width} px is said as a cancellation, and leaves the address once dismissed (SF-app-048, 049)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/auth/callback?error=access_denied&error_description=cancelled");
    await expect(page).toHaveURL(/\/auth\?sso=cancelled$/);
    await expect(page.getByRole("status")).toHaveText(say("sso.cancelled"));
    // Next.js's route announcer is an always-present role="alert" outside the page's main.
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await checkA11y(page);
    await page.getByRole("button", { name: say("login.forgot_password") }).click();
    await expect(page).toHaveURL(/\/auth\?view=reset-password$/);
    // Dismissed, it left the address: Back is the plain sign-in page, and shows nothing again.
    await page.goBack();
    await expect(page).toHaveURL(/\/auth$/);
    await expect(page.getByRole("status")).toHaveCount(0);
  });
}

test("E-113: signed in, the sign-in page goes on to the page asked for — never to another site (a session the run has: no sign-in spent)", async ({
  page,
}) => {
  await signInPage(page, E2E_USER);
  await page.goto("/auth?redirect=%2Faccount");
  await expect(page).toHaveURL(/\/account$/, { timeout: 30_000 });
  await page.goto("/auth?redirect=https%3A%2F%2Fevil.example%2F");
  await expect(page).toHaveURL(/\/$/, { timeout: 30_000 });
  await page.goto("/auth?redirect=%2F%2Fevil.example%2F");
  await expect(page).toHaveURL(/^http:\/\/localhost:\d+\/$/, { timeout: 30_000 });
});
