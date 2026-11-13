/**
 * e2e/session.spec.ts — the sign-in session, in a real browser on the production build (ADR-057,
 * TASK-214, SEC-016)
 *
 * The browser holds an opaque session id in an HttpOnly cookie and nothing else: no token in the
 * sign-in answer, in storage, or in a cookie script can read. The journeys:
 *
 *   sign-in, a change of nothing, sign-out
 *                  through the form (POST /api/auth/sign-in): the answer and what the page can
 *                  reach hold no credential; then out through the page (POST
 *                  /api/auth/sign-out): the session ends on the server — the old cookie
 *                  replayed is refused (hostile);
 *   a guest        POST /api/auth/guest: a guest session, and still nothing readable;
 *   a change       a state-changing request needs the session's own token (GET
 *                  /api/auth/session gives it); without it, or from another origin, it is refused
 *                  (auth.csrf_failed) — hostile; a bearer is no credential on a user route;
 *   expiry         a staff session idle past its 30 minutes is ended at its next request, and
 *                  the page goes to sign-in (the idle time is set in the database: a journey
 *                  cannot wait);
 *   everywhere     from the account page (POST /api/auth/sign-out-everywhere): another device's
 *                  session ends too;
 *   the move       a browser signed in before ADR-057 — a token in localStorage, the refresh
 *                  token in the legacy cookie — is moved onto a session without signing in again
 *                  (POST /api/auth/session/migrate), and what its storage held is gone.
 *
 * Sign-in is limited per address, so the suite signs each person in once (e2e/helpers/session.ts):
 * here only the form's own sign-in and the two devices of this spec's own person are new
 * sessions.
 *
 * The test double's users sign in by their address (platform/auth/mock-provider.ts). The move
 * needs the server to hold the harness's legacy cookie key (playwright.config.ts sets
 * REFRESH_COOKIE_KEY to e2e/helpers/legacy-cookie.ts's; a server started by hand needs the same)
 * — never skipped: a move that stopped working must fail here.
 */
import { createHash } from "node:crypto";
import {
  expect,
  request as playwrightRequest,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Client } from "pg";
import { legacyRefreshCookieValue } from "./helpers/legacy-cookie";
import {
  E2E_USER,
  forgetSession,
  sessionFetch,
  signIn,
  signInPage,
} from "./helpers/session";

const OWNER_URL = process.env.E2E_DATABASE_OWNER_URL;
const TENANT = "00000000-0000-4000-8000-000000000001";
/** A staff member of the test double (platform/auth/mock-provider.ts; the admin journeys' admin-a). */
const STAFF = { id: "e2e00000-0000-4000-8000-00000000000a", email: "admin-a@e2e.test" };
/** A person with two devices, this spec's own (platform/auth/mock-provider.ts). */
const DEVICES = {
  id: "e2e00000-0000-4000-8000-0000000000d2",
  email: "devices-d@e2e.test",
};
const IS_SESSION_COOKIE = /^(?:__Host-)?pf_session$/;
const TOKEN_KEY = /token|bearer|secret|pf_user/i;

// Each journey makes what it needs and depends on no other: not serial, so a retry runs the one
// journey that failed — never the whole file again, signing everyone in a second time.

async function sessionCookie(context: BrowserContext) {
  return (await context.cookies()).find((c) => IS_SESSION_COOKIE.test(c.name));
}

/** What page script can reach: both storages' keys and values, and the cookies it can read. */
async function scriptReachable(page: Page) {
  return page.evaluate(() => ({
    local: Object.entries(localStorage).map(([k, v]) => `${k}=${String(v)}`),
    session: Object.entries(sessionStorage).map(([k, v]) => `${k}=${String(v)}`),
    cookie: document.cookie,
  }));
}

/** The session cookie is one script cannot read and another site cannot set; nothing else holds a credential. */
async function expectNoCredentialInThePage(page: Page): Promise<string> {
  const cookie = await sessionCookie(page.context());
  expect(cookie, "the session cookie").toBeDefined();
  expect(cookie!.httpOnly).toBe(true);
  expect(cookie!.sameSite).toBe("Lax");
  expect(cookie!.path).toBe("/");
  expect(cookie!.value).toMatch(/^[\w-]{43}$/);
  // A production build's cookie is the __Host- one, Secure (browsers accept it on localhost).
  if (cookie!.name.startsWith("__Host-")) expect(cookie!.secure).toBe(true);
  const reachable = await scriptReachable(page);
  expect(reachable.local.filter((e) => TOKEN_KEY.test(e))).toEqual([]);
  expect(reachable.session.filter((e) => TOKEN_KEY.test(e))).toEqual([]);
  expect(reachable.cookie).not.toContain("pf_session");
  // The session id itself is nowhere script can read it.
  expect(JSON.stringify(reachable)).not.toContain(cookie!.value);
  return cookie!.value;
}

const tokenKeys = (body: unknown): string[] =>
  body && typeof body === "object"
    ? Object.entries(body as Record<string, unknown>).flatMap(([k, v]) => [
        ...(/token|bearer/i.test(k) && k !== "csrfToken" ? [k] : []),
        ...tokenKeys(v),
      ])
    : [];

test("signing in through the form leaves no token in the page; signing out ends the session on the server — the old cookie, replayed, is refused", async ({
  page,
  baseURL,
}) => {
  await page.goto("/auth");
  await page.getByLabel("Email").fill(E2E_USER.email);
  await page.getByLabel("Password", { exact: true }).fill("a-journey-password");
  const answered = page.waitForResponse(
    (r) => r.url().endsWith("/api/auth/sign-in") && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Sign In", exact: true }).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toMatchObject({ success: true, userId: E2E_USER.id });
  expect(tokenKeys(body)).toEqual([]);

  // Signed in: the home page, with the way out.
  await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page).toHaveURL(/\/$/);
  await expectNoCredentialInThePage(page);
  const cookie = await sessionCookie(page.context());
  const status = (await (await page.request.get("/api/auth/session")).json()) as {
    csrfToken?: string;
  };

  // Out, through the page.
  const signedOut = page.waitForResponse(
    (r) => r.url().endsWith("/api/auth/sign-out") && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Sign Out" }).click();
  expect((await signedOut).status()).toBe(200);
  await expect(page).toHaveURL(/\/auth/);
  expect(await sessionCookie(page.context())).toBeUndefined();

  // Hostile: whoever copied the cookie (and the token) before the sign-out holds nothing.
  const thief = await playwrightRequest.newContext({ baseURL });
  try {
    const headers = {
      cookie: `${cookie!.name}=${cookie!.value}`,
      origin: baseURL!,
      "x-csrf-token": status.csrfToken ?? "",
    };
    const read = await thief.get("/api/auth/session", { headers });
    expect(((await read.json()) as { authenticated?: boolean }).authenticated).toBe(
      false
    );
    const change = await thief.post("/api/account/age", {
      headers,
      data: { dateOfBirth: "1990-01-01" },
    });
    expect(change.status()).toBe(401);
    expect(((await change.json()) as { code?: string }).code).toBe("auth.token_invalid");
  } finally {
    await thief.dispose();
  }
  // And a page asked for without a session goes to sign-in.
  await page.goto("/account");
  await expect(page).toHaveURL(/\/auth/);
});

test("continuing as a guest: a guest session, and still no token in the page", async ({
  page,
}) => {
  await page.goto("/auth");
  const answered = page.waitForResponse(
    (r) => r.url().endsWith("/api/auth/guest") && r.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Continue as Guest" }).click();
  const res = await answered;
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.guestId).toEqual(expect.any(String));
  expect(tokenKeys(body)).toEqual([]);
  await expect(page).toHaveURL(/\/$/);
  await expectNoCredentialInThePage(page);
  const status = (await (await page.request.get("/api/auth/session")).json()) as {
    user?: { isGuest?: boolean };
  };
  expect(status.user?.isGuest).toBe(true);
});

test("a change needs the session's own token, from this origin — the page's own calls carry it; a forged one is refused", async ({
  page,
  baseURL,
}) => {
  const signedIn = await signInPage(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible({
    timeout: 30_000,
  });

  // In the page, as a script would: the cookie rides along, but without the token nothing changes.
  const inPage = await page.evaluate(async (token) => {
    const post = async (headers: Record<string, string>) => {
      const r = await fetch("/api/auth/session", { method: "POST", headers });
      const body = (await r.json().catch(() => ({}))) as { code?: string };
      return { status: r.status, code: body.code ?? null };
    };
    return {
      without: await post({}),
      wrong: await post({ "x-csrf-token": "A".repeat(43) }),
      right: await post({ "x-csrf-token": token }),
    };
  }, signedIn.csrfToken);
  expect(inPage.without).toEqual({ status: 403, code: "auth.csrf_failed" });
  expect(inPage.wrong).toEqual({ status: 403, code: "auth.csrf_failed" });
  expect(inPage.right.status).toBe(200);

  // Another site, even holding the right token (it cannot read it, but suppose): refused by its origin.
  const cookie = await sessionCookie(page.context());
  const elsewhere = await playwrightRequest.newContext({ baseURL });
  try {
    const forged = await elsewhere.post("/api/auth/session", {
      headers: {
        cookie: `${cookie!.name}=${cookie!.value}`,
        origin: "https://another-site.example",
        "x-csrf-token": signedIn.csrfToken,
      },
    });
    expect(forged.status()).toBe(403);
    expect(((await forged.json()) as { code?: string }).code).toBe("auth.csrf_failed");
    // A bearer is no credential on a user route (ADR-057 D8): without the cookie, refused.
    const bearer = await elsewhere.post("/api/account/age", {
      headers: { authorization: "Bearer mock-access-token", origin: baseURL! },
      data: { dateOfBirth: "1990-01-01" },
    });
    expect(bearer.status()).toBe(401);
  } finally {
    await elsewhere.dispose();
  }
  // The session is untouched by the forgeries.
  expect((await page.request.get("/api/auth/session")).status()).toBe(200);
  expect(
    (
      (await (await page.request.get("/api/auth/session")).json()) as {
        authenticated?: boolean;
      }
    ).authenticated
  ).toBe(true);
});

test("sign out everywhere, from the account page: another device's session ends too", async ({
  page,
  baseURL,
}) => {
  // The other device: its own cookie jar.
  const phone = await playwrightRequest.newContext({ baseURL });
  try {
    // A person of this journey's own (their sessions are ended here: no other journey signs in
    // as them), on two devices — this browser and the phone, each its own sign-in.
    await signIn(page.context().request, DEVICES);
    await signIn(phone, DEVICES);
    await page.goto("/account");
    const devices = page.getByRole("region", { name: "Signed-in devices" });
    await devices.getByRole("button", { name: "Sign out everywhere" }).click();
    const done = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/auth/sign-out-everywhere") &&
        r.request().method() === "POST"
    );
    await devices.getByRole("button", { name: "Yes, sign out everywhere" }).click();
    const res = await done;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { sessionsEnded?: number }).sessionsEnded).toBe(2);
    await expect(page).toHaveURL(/\/auth/);
    // The phone, which did nothing, is signed out.
    const status = (await (await phone.get("/api/auth/session")).json()) as {
      authenticated?: boolean;
    };
    expect(status.authenticated).toBe(false);
    // Someone else's session is untouched: the suite's own user is still signed in.
    const other = await sessionFetch(E2E_USER, "GET", "/api/auth/session");
    expect(((await other.json()) as { authenticated?: boolean }).authenticated).toBe(
      true
    );
  } finally {
    await phone.dispose();
  }
});

test("a staff session idle past its 30 minutes is ended at its next request, and the page goes to sign-in", async ({
  page,
}) => {
  test.skip(!OWNER_URL, "needs the harness's database (E2E_DATABASE_OWNER_URL)");
  const db = new Client({ connectionString: OWNER_URL });
  await db.connect();
  try {
    // A staff account (the admin journeys seed the same row): staff sessions have the short limits.
    await db.query(
      `insert into users (id, cognito_sub, email, display_name, role_id, tenant_id, email_verified)
       select $1::uuid, $1, $2, 'admin-a', r.id, $3::uuid, true from roles r where r.name = 'super_admin'
       on conflict (id) do update set role_id = excluded.role_id, deleted_at = null`,
      [STAFF.id, STAFF.email, TENANT]
    );
    await signInPage(page, STAFF);
    const read = page.waitForResponse((r) => r.url().endsWith("/api/admin/session"));
    await page.goto("/admin");
    expect((await read).status()).toBe(200);
    await page.getByRole("navigation", { name: "Admin sections" }).waitFor();
    const status = (await (await page.request.get("/api/auth/session")).json()) as {
      audience?: string;
    };
    expect(status.audience).toBe("staff");
    const cookie = await sessionCookie(page.context());
    const idHash = createHash("sha256")
      .update(`pf_session.v1\0${cookie!.value}`)
      .digest("hex");

    // Thirty-one minutes without a request: past the staff idle limit
    // (auth.session.staff_idle_seconds, 1800) — and far inside a user's seven days.
    const aged = await db.query(
      "update auth_sessions set last_seen_at = now() - interval '31 minutes', created_at = now() - interval '2 hours' where id_hash = $1 and revoked_at is null",
      [idHash]
    );
    expect(aged.rowCount).toBe(1);

    // Its next read is refused, and the console becomes the access page — no console shell left
    // standing — with the way to sign in.
    await page.reload();
    await expect(
      page.getByText(
        "This page is for administrators. Sign in with an account that has administrative access."
      )
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("navigation", { name: "Admin sections" })).toHaveCount(0);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/auth/);
    await expect(
      page.getByRole("button", { name: "Sign In", exact: true })
    ).toBeVisible();
    // Ended in its record, with why — not merely ignored.
    const { rows } = await db.query<{ revoked_reason: string | null }>(
      "select revoked_reason from auth_sessions where id_hash = $1",
      [idHash]
    );
    expect(rows[0]?.revoked_reason).toBe("idle_timeout");
  } finally {
    await db.end();
    // The suite's session of this administrator is the one that expired.
    await forgetSession(STAFF);
  }
});

test("a browser signed in before server-side sessions is moved over without signing in again, and its stored token is gone", async ({
  page,
  baseURL,
}) => {
  const host = new URL(baseURL!).hostname;
  // What a signed-in browser held before ADR-057: the token and the user in localStorage, the
  // refresh token in the httpOnly cookie for the auth routes, and the readable indicator.
  await page.context().addCookies([
    {
      name: "pf_refresh",
      value: legacyRefreshCookieValue(E2E_USER.id, "mock-refresh-token"),
      domain: host,
      path: "/api/auth",
      httpOnly: true,
      secure: false,
      sameSite: "Strict",
    },
    {
      name: "pf_has_session",
      value: "true",
      domain: host,
      path: "/",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  await page.addInitScript(() => {
    if (sessionStorage.getItem("legacy-planted")) return;
    sessionStorage.setItem("legacy-planted", "1");
    localStorage.setItem("pf_access_token", "a-token-from-before");
    localStorage.setItem("pf_refresh_token", "another-from-before");
    localStorage.setItem(
      "pf_user",
      JSON.stringify({ userId: "someone-else-entirely", email: "forged@example.com" })
    );
  });

  // The page's own move: its status (the page navigates as soon as it is moved, and a browser
  // drops a response's body once the page that asked has gone — the answer's body is read from
  // another browser of the same kind, below).
  const moved = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/auth/session/migrate") && r.request().method() === "POST"
  );
  await page.goto("/");
  expect((await moved).status()).toBe(200);

  // Signed in, on the home page, with no sign-in form in between.
  await expect(page.getByRole("button", { name: "Sign Out" })).toBeVisible({
    timeout: 30_000,
  });
  await expectNoCredentialInThePage(page);
  // Who is signed in is the cookie's user — never what storage claimed.
  const status = (await (await page.request.get("/api/auth/session")).json()) as {
    user?: { userId?: string };
  };
  expect(status.user?.userId).toBe(E2E_USER.id);
  const names = (await page.context().cookies()).map((c) => c.name);
  expect(names).not.toContain("pf_refresh");
  expect(names).not.toContain("pf_has_session");

  // The move's answer itself, for another browser signed in before ADR-057 (a client with its
  // own cookie jar holding the same kind of cookie): who it is, and no token.
  const other = await playwrightRequest.newContext({ baseURL });
  try {
    const answer = await other.post("/api/auth/session/migrate", {
      headers: {
        origin: baseURL!,
        cookie: `pf_refresh=${legacyRefreshCookieValue(E2E_USER.id, "mock-refresh-token")}`,
      },
    });
    expect(answer.status()).toBe(200);
    const body = (await answer.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ migrated: true, userId: E2E_USER.id });
    expect(tokenKeys(body)).toEqual([]);
    const set = answer
      .headersArray()
      .filter((h) => h.name.toLowerCase() === "set-cookie");
    expect(
      set.some((h) => /^(?:__Host-)?pf_session=[\w-]{43};.*HttpOnly/i.test(h.value))
    ).toBe(true);
    // Hostile: the same move asked from another origin moves no one.
    const forged = await other.post("/api/auth/session/migrate", {
      headers: {
        origin: "https://elsewhere.example",
        cookie: `pf_refresh=${legacyRefreshCookieValue(E2E_USER.id, "mock-refresh-token")}`,
      },
    });
    expect(forged.status()).toBe(403);
    // Hostile: a cookie naming another user under the same refresh token (a wrong signature).
    const tampered = legacyRefreshCookieValue(E2E_USER.id, "mock-refresh-token").replace(
      E2E_USER.id,
      "e2e00000-0000-4000-8000-00000000000a"
    );
    const refused = await other.post("/api/auth/session/migrate", {
      headers: { origin: baseURL!, cookie: `pf_refresh=${tampered}` },
    });
    expect(((await refused.json()) as { migrated?: boolean }).migrated).not.toBe(true);
  } finally {
    await other.dispose();
  }
});
