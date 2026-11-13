/**
 * e2e/helpers/session.ts — the one way a journey signs in (ADR-057, TASK-214)
 *
 * A user is authenticated by a server-side session behind an HttpOnly cookie — never by a token
 * in the page or an `Authorization: Bearer` header (ADR-057 D8). So a journey signs in the way a
 * browser does: `POST /api/auth/sign-in` (the test double's identities sign in by their address,
 * platform/auth/mock-provider.ts), then `GET /api/auth/session` for the session's forgery token,
 * which every state-changing request sends back as `x-csrf-token`.
 *
 *   sessionOf(who)               an API client of its own for `who` — its own cookie jar, so two
 *                                people can act in one test — signed in ONCE per run and kept
 *                                across spec files, and across workers (a failed test restarts
 *                                its worker: the new one joins the run's sessions, kept in the
 *                                run's own temporary directory, instead of signing in again);
 *   signInPage(page, who)        the browser context joins that session (its cookie is copied
 *                                in), so the page and `sessionFetch(who, …)` are one person on
 *                                one session;
 *   sessionFetch(who, …)         a request as `who`: the cookie, this origin and the token;
 *   signIn(api, who)             a NEW session on `api` — only for a journey that needs one of
 *                                its own to end (sign-out, another device);
 *   startGuest(api)              a guest session on `api`;
 *   forgetSession(who)           after a journey ended `who`'s session on purpose.
 *
 * Why one sign-in per person: sign-in is limited per address (DEFAULT_RULES.AUTH_LOGIN, 10 in 15
 * minutes) and every journey comes from one address. A journey that signed in afresh for each
 * test would be refused part-way through the suite — and the limit is never bypassed or raised
 * for the harness. A refusal is not waited out (its window is minutes): it fails, saying so.
 *
 * Nothing here reads or stores a token: the helper holds what a page holds — the forgery token —
 * and the cookie jar holds what a browser holds. The run's directory (E2E_SESSIONS_DIR, made by
 * global setup under the system's temporary directory) keeps the same two things per person, for
 * the length of the run: the test double's session cookie and its forgery token.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

export interface Identity {
  readonly email: string;
}

/** The test double's own user (platform/auth/mock-provider.ts): any address it does not know. */
export const E2E_USER: Identity & { readonly id: string } = {
  id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  email: "e2e@test.com",
};

/** Any password the test double accepts (its named ones — "wrong-password", … — drive other steps). */
const PASSWORD = "e2e-journey-password";

export interface SignedIn {
  readonly api: APIRequestContext;
  /** The session's forgery token: sent as `x-csrf-token` on every state-changing request. */
  readonly csrfToken: string;
  /** The headers of a state-changing request from this origin. */
  readonly headers: Readonly<Record<string, string>>;
}

function baseURL(): string {
  const url = test.info().project.use.baseURL;
  if (!url) throw new Error("e2e session helper: no baseURL in playwright.config.ts");
  return url;
}

/**
 * Start a NEW session for `who` on `api` (its cookie jar receives the session cookie) and read
 * the session's forgery token. Counts against the sign-in limit: journeys use sessionOf and
 * signInPage unless they need a session of their own.
 */
export async function signIn(
  api: APIRequestContext,
  who: Identity = E2E_USER,
  origin: string = baseURL()
): Promise<SignedIn> {
  const res = await api.post("/api/auth/sign-in", {
    headers: { origin },
    data: { email: who.email, password: PASSWORD },
  });
  expect(
    res.status(),
    res.status() === 429
      ? `sign-in as ${who.email} was rate limited (10 sign-ins in 15 minutes per address): a journey signs in once per person — use sessionOf / signInPage`
      : `sign-in as ${who.email}`
  ).toBe(200);
  // The answer names the user and carries no token (ADR-057 D1).
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).filter((k) => /token/i.test(k))).toEqual([]);
  const status = await api.get("/api/auth/session");
  expect(status.status(), "session status").toBe(200);
  const session = (await status.json()) as {
    authenticated?: boolean;
    csrfToken?: string;
  };
  expect(session.authenticated, `a session for ${who.email}`).toBe(true);
  const csrfToken = String(session.csrfToken ?? "");
  expect(csrfToken).toMatch(/^[\w-]{43}$/);
  return { api, csrfToken, headers: { origin, "x-csrf-token": csrfToken } };
}

/**
 * The page's browser context joins `who`'s session (sessionOf): the session cookie is copied
 * into it, so its pages — and `page.request` — are signed in as `who`, on the same session the
 * journey's own requests use.
 */
export async function signInPage(
  page: Page,
  who: Identity = E2E_USER
): Promise<SignedIn> {
  const session = await sessionOf(who);
  const { cookies } = await session.api.storageState();
  await page
    .context()
    .addCookies(cookies.filter((c) => /^(?:__Host-)?pf_session$/.test(c.name)));
  return session;
}

/**
 * Start a guest session on `api` (POST /api/auth/guest: its cookie jar receives the session
 * cookie; the answer names the guest and carries no token) and read its forgery token.
 */
export async function startGuest(
  api: APIRequestContext,
  origin: string = baseURL()
): Promise<SignedIn & { readonly guestId: string }> {
  const res = await api.post("/api/auth/guest", { headers: { origin } });
  expect(res.status(), "guest session").toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).filter((k) => /token/i.test(k))).toEqual([]);
  const session = (await (await api.get("/api/auth/session")).json()) as {
    csrfToken?: string;
    user?: { isGuest?: boolean };
  };
  expect(session.user?.isGuest, "a guest's session").toBe(true);
  const csrfToken = String(session.csrfToken ?? "");
  return {
    api,
    csrfToken,
    headers: { origin, "x-csrf-token": csrfToken },
    guestId: String(body.guestId ?? ""),
  };
}

const sessions = new Map<string, Promise<SignedIn>>();

/** The run's kept sessions (global setup names the directory), or null: this worker's memory only. */
const keptDir = (): string | null => process.env.E2E_SESSIONS_DIR || null;

function keptFile(origin: string, email: string): string | null {
  const dir = keptDir();
  if (!dir) return null;
  const name = createHash("sha256")
    .update(`${origin}|${email}`)
    .digest("hex")
    .slice(0, 32);
  return join(dir, `${name}.json`);
}

/**
 * Keep `who`'s session for the rest of the run: its cookie jar and forgery token, written whole
 * (a rename) so a worker never reads half a file. Also called by global setup, whose sign-in is
 * then the suite's own session of that person.
 */
export async function keepSession(
  origin: string,
  email: string,
  session: SignedIn
): Promise<void> {
  const file = keptFile(origin, email);
  if (!file) return;
  mkdirSync(keptDir()!, { recursive: true });
  const { cookies } = await session.api.storageState();
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify({ cookies, csrfToken: session.csrfToken }), {
    mode: 0o600,
  });
  renameSync(partial, file);
}

/** The session kept for `who`, joined by a client of its own — or null when none is live. */
async function joinKept(origin: string, who: Identity): Promise<SignedIn | null> {
  const file = keptFile(origin, who.email);
  if (!file || !existsSync(file)) return null;
  let kept: { cookies: unknown[]; csrfToken: string };
  try {
    kept = JSON.parse(readFileSync(file, "utf8")) as typeof kept;
  } catch {
    return null;
  }
  const api = await playwrightRequest.newContext({
    baseURL: origin,
    storageState: { cookies: kept.cookies as never, origins: [] },
  });
  // Still live, and still this session's token (a journey may have ended it on the server). An
  // answer that is no answer (a limit, a server error) fails here, saying so — it is never read
  // as "ended", which would sign the person in again and spend the sign-in limit.
  const read = await api.get("/api/auth/session");
  expect(read.status(), `the kept session of ${who.email}: session status`).toBe(200);
  const status = (await read.json()) as { authenticated?: boolean; csrfToken?: string };
  if (status.authenticated !== true || status.csrfToken !== kept.csrfToken) {
    await api.dispose();
    rmSync(file, { force: true });
    return null;
  }
  return {
    api,
    csrfToken: kept.csrfToken,
    headers: { origin, "x-csrf-token": kept.csrfToken },
  };
}

/**
 * `who`'s own API client, signed in once per run: this worker's, else the one the run kept (an
 * earlier worker's, or global setup's), else a new sign-in — which is then kept. A sign-in that
 * failed is not kept: the next call tries again.
 */
export function sessionOf(who: Identity = E2E_USER): Promise<SignedIn> {
  const origin = baseURL();
  const key = `${origin}|${who.email}`;
  let session = sessions.get(key);
  if (!session) {
    session = (async () => {
      const joined = await joinKept(origin, who);
      if (joined) return joined;
      const api = await playwrightRequest.newContext({ baseURL: origin });
      const signedIn = await signIn(api, who, origin);
      await keepSession(origin, who.email, signedIn);
      return signedIn;
    })();
    sessions.set(key, session);
    session.catch(() => sessions.delete(key));
  }
  return session;
}

/** Forget `who`'s session (it was ended on purpose): the next sessionOf signs in again. */
export async function forgetSession(who: Identity = E2E_USER): Promise<void> {
  const origin = baseURL();
  const key = `${origin}|${who.email}`;
  const session = sessions.get(key);
  sessions.delete(key);
  const file = keptFile(origin, who.email);
  if (file) rmSync(file, { force: true });
  if (session) await (await session).api.dispose().catch(() => undefined);
}

/** A request as `who`: the session cookie, this origin and — it is harmless on a GET — the token. */
export async function sessionFetch(
  who: Identity,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  data?: unknown,
  headers: Record<string, string> = {}
): Promise<APIResponse> {
  const session = await sessionOf(who);
  return session.api.fetch(path, {
    method,
    headers: {
      ...session.headers,
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(data === undefined ? {} : { data }),
  });
}
