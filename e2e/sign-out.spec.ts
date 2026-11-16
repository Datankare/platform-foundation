/**
 * e2e/sign-out.spec.ts — every sign-out a screen offers ends the session on the server, also
 * while the page's own read of its session is slow; and one the server did not perform is never
 * claimed (TASK-219)
 *
 * Playform's Deploy smoke run 43722206512 (Journey B, the first run after a deploy: cold
 * functions) — the console's Sign out answered 403 and the page went to sign-in with the session
 * still live on the server. The console shows itself once GET /api/admin/session answers, and the
 * auth context sent the sign-out's forgery token only if its own GET /api/auth/session had already
 * answered: clicked before that, no token, refused. Now every state-changing request waits for
 * that read (sessionChange, as apiFetch does), and a sign-out the server refused or never received
 * leaves the page signed in, saying so, with "Sign out again".
 *
 * Each sign-out a screen offers, at 1280 and at 390 px, the page's session read held back 3 s
 * (the slow case): the console's own (admin shell) and the home screen's, each with the sign-out
 * request failing — the request still waited for the read and carried the token; the page stays
 * signed in, saying so —, then "Sign out again", which ends the session on the server. The account
 * page's "Sign out everywhere" with its session read slow is e2e/session.spec.ts's (its own
 * person, whose every session it ends). The others share the same call: the console's
 * refusal and MFA enrolment screens and its no-section screen (app/admin/page.tsx, each
 * signOut()), the idle warning's Sign out (components/auth/SessionIdleWarning.tsx), and the
 * sign-out on an erased account's refusal (components/refusal/useRefusalSessionEnd.ts) — all
 * through the context's signOut, covered by __tests__/auth-context.test.tsx and
 * __tests__/sign-out-surfaces.test.tsx.
 *
 * The journey signs in ONE session of its own (signIn on the page's context), which it ends: the
 * run's shared sessions (sessionOf) are never touched. One sign-in for both widths: sign-in is
 * limited to 10 in 15 minutes per network address (DEFAULT_RULES.AUTH_LOGIN), which the whole run
 * shares — a sign-in per width took the run past it (the second width was refused, 429).
 */
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { signIn, type Identity } from "./helpers/session";

const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
const TENANT = "00000000-0000-4000-8000-000000000001";
/** The test double's second administrator (platform/auth/mock-provider.ts). */
const ADMIN: Identity & { id: string } = {
  id: "e2e00000-0000-4000-8000-00000000000b",
  email: "admin-b@e2e.test",
};

test.skip(!OWNER_URL, "needs the harness's database (E2E_DATABASE_OWNER_URL)");

test.beforeAll(async () => {
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    await db.query(
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
       select $1::uuid, $1, $2, 'admin-b', r.id, $3::uuid, true from roles r where r.name = 'super_admin'
       on conflict (id) do update set role_id = excluded.role_id, deleted_at = null`,
      [ADMIN.id, ADMIN.email, TENANT]
    );
  } finally {
    await db.end();
  }
});

/** Hold the page's reads of its session back `ms` (a cold deployment). */
async function slowSessionRead(page: Page, ms: number): Promise<void> {
  await page.route("**/api/auth/session", async (route) => {
    if (route.request().method() === "GET") await new Promise((r) => setTimeout(r, ms));
    await route.continue().catch(() => undefined);
  });
}

/** Whether the server still holds this browser's session (read with the cookie, unrouted). */
async function serverSession(page: Page): Promise<boolean> {
  const res = await page.request.get("/api/auth/session");
  return ((await res.json()) as { authenticated?: boolean }).authenticated === true;
}

const posted = (page: Page, path: string) =>
  page.waitForResponse(
    (r) => new URL(r.url()).pathname === path && r.request().method() === "POST"
  );

/** Every sign-out request the page sends fails (the network); each one's forgery token is kept. */
async function failSignOut(page: Page, tokens: (string | undefined)[]): Promise<void> {
  await page.route("**/api/auth/sign-out", async (route) => {
    tokens.push(route.request().headers()["x-csrf-token"]);
    await route.abort("failed");
  });
}

const TOKEN = /^[\w-]{43}$/;

/** At `width`: the console's and the home screen's Sign out, each failing — never claimed. */
async function failedSignOuts(
  page: Page,
  width: number,
  tokens: (string | undefined)[]
): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  const before = tokens.length;

  // The console's own Sign out: the shell shows once the console's read answers — before the
  // page's session read does — and is clicked at once.
  await page.goto("/admin");
  const consoleSignOut = page
    .getByRole("button", { name: "Sign out", exact: true })
    .first();
  await expect(consoleSignOut).toBeVisible();
  await consoleSignOut.click();
  const notice = page.getByTestId("sign-out-failed");
  // The read (3 s), the failed request, then a fresh read (3 s) to see whether it ended anyway.
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice).toContainText("You are still signed in");
  expect(
    tokens.slice(before),
    `at ${width} px the console's sign-out waited for the read and sent its token`
  ).toEqual([expect.stringMatching(TOKEN)]);
  await expect(page).toHaveURL(/\/admin/);
  expect(await serverSession(page), "still signed in on the server").toBe(true);

  // The home screen's Sign out, the same.
  await page.goto("/");
  const homeSignOut = page.getByRole("button", { name: "Sign out", exact: true });
  await expect(homeSignOut).toBeVisible({ timeout: 15_000 });
  await homeSignOut.click();
  await expect(page.getByTestId("sign-out-failed")).toBeVisible({ timeout: 15_000 });
  expect(
    tokens.slice(before),
    `at ${width} px the home screen's sign-out waited for the read and sent its token`
  ).toEqual([expect.stringMatching(TOKEN), expect.stringMatching(TOKEN)]);
  await expect(page).not.toHaveURL(/\/auth/);
  expect(await serverSession(page)).toBe(true);
}

test("every sign-out at 1280 and 390 px waits for the session read, sends its token, and never claims a sign-out the server did not perform", async ({
  page,
}) => {
  await signIn(page.context().request, ADMIN);
  await slowSessionRead(page, 3000);
  const tokens: (string | undefined)[] = [];
  await failSignOut(page, tokens);

  await failedSignOuts(page, 1280, tokens);
  await failedSignOuts(page, 390, tokens);
  await page.unroute("**/api/auth/sign-out");

  // At 390 px, "Sign out again", now answered: the session ends on the server, then sign-in.
  const done = posted(page, "/api/auth/sign-out");
  await page
    .getByTestId("sign-out-failed")
    .getByRole("button", { name: "Sign out again" })
    .click();
  const res = await done;
  expect(res.request().headers()["x-csrf-token"]).toMatch(TOKEN);
  expect(res.status(), "POST /api/auth/sign-out").toBe(200);
  await expect(page).toHaveURL(/\/auth(?:[?#]|$)/);
  await page.unroute("**/api/auth/session");
  expect(await serverSession(page), "the server's session").toBe(false);
});
