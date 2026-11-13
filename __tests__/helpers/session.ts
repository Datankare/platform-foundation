/**
 * __tests__/helpers/session.ts — the one way a test presents a signed-in caller (ADR-057, TASK-214)
 *
 * A user route authenticates by the server-side session its cookie names — never by an
 * `Authorization: Bearer` header (__tests__/user-route-credentials.test.ts). A test that drives a
 * real handler through the real guard starts a real session here, in the store the handler will
 * read (memory, or Postgres when the suite has a database), and sends what a browser would:
 *
 *   const s = await startTestSession({ token: "mock-access-token" });
 *   new NextRequest("http://localhost/api/thing", { method: "POST", headers: s.headers });
 *
 *   s.headers      the session cookie, this origin, and the session's forgery token — what
 *                  apiFetch sends with a state-changing request;
 *   s.cookie       the cookie alone (a GET needs no more; a hostile test leaves the rest out);
 *   s.id, s.idHash the session id and its hash, to tamper with or look up.
 *
 * `token` is the provider token the session holds — what the mock provider (or a test's own
 * verifyToken) recognises. `subject` is the session's user; it defaults to the mock user.
 */

import {
  hashSessionId,
  sessionCookieName,
  type LiveSession,
} from "@/platform/auth/session";
import { getAuthProvider } from "@/platform/auth/config";
import { verifyGuestToken } from "@/platform/auth/guest-token";
import {
  MemorySessionStore,
  PostgresSessionStore,
  getSessionStore,
  setSessionStore,
  type SessionStore,
} from "@/platform/auth/session-store";
import { sealTokens } from "@/platform/auth/session-vault";
import {
  DEFAULT_TENANT_ID,
  runWithTenant,
  runWithoutTenant,
} from "@/platform/tenancy/context";
import { randomBytes } from "node:crypto";

/** The mock provider's own user (platform/auth/mock-provider.ts). */
export const MOCK_SUBJECT = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
/** The origin test requests are made to. */
export const TEST_ORIGIN = "http://localhost";

export interface TestSession {
  readonly id: string;
  readonly idHash: string;
  readonly csrfToken: string;
  /** `name=value`, for a Cookie header. */
  readonly cookie: string;
  /** Cookie, Origin and the forgery token: a same-origin state-changing request's headers. */
  readonly headers: Record<string, string>;
}

export interface TestSessionOptions {
  readonly kind?: "user" | "guest";
  readonly subject?: string;
  /** The access token (a user) or guest token (a guest) the session holds. */
  readonly token?: string;
  readonly refreshToken?: string;
  /** When the held token expires, seconds since the epoch (default: in an hour). */
  readonly tokenExpiresAt?: number;
  readonly method?: string;
  readonly tenantId?: string;
  /** ms since the epoch; default now. */
  readonly createdAt?: number;
  readonly lastSeenAt?: number;
  readonly origin?: string;
}

/**
 * The store the handler under test will read. A suite with no database connection that makes
 * the platform believe it has one (`hasDatabase` mocked, to exercise the audit path) would be
 * given the Postgres store: it gets the memory store instead, set as the current one.
 */
function testStore(): SessionStore {
  const store = getSessionStore();
  if (store instanceof PostgresSessionStore && !process.env.DATABASE_URL) {
    const memory = new MemorySessionStore();
    setSessionStore(memory);
    return memory;
  }
  return store;
}

/**
 * Start a session in the current store. With `tenantId`, in that tenant only. Without, where a
 * single-tenant test will look for it: the default tenant (a handler wrapped in tenantRoute
 * establishes it) and — for the memory store — outside any tenant too (a guard called directly,
 * with no request scope, reads there; platform/tenancy/partition.ts).
 */
export async function startTestSession(
  options: TestSessionOptions = {}
): Promise<TestSession> {
  const kind = options.kind ?? "user";
  const id = randomBytes(32).toString("base64url");
  const idHash = hashSessionId(id);
  const csrfToken = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = options.tokenExpiresAt ?? Math.floor(now / 1000) + 3600;
  const token = options.token ?? "mock-access-token";
  const sealedTokens = sealTokens(
    kind === "guest"
      ? { kind: "guest", token, expiresAt }
      : {
          kind: "user",
          accessToken: token,
          ...(options.refreshToken ? { refreshToken: options.refreshToken } : {}),
          expiresAt,
        },
    idHash
  );
  const record = {
    idHash,
    kind,
    subject: options.subject ?? MOCK_SUBJECT,
    method: options.method ?? (kind === "guest" ? "guest" : "password"),
    csrfToken,
    sealedTokens,
    createdAt: options.createdAt ?? now,
    lastSeenAt: options.lastSeenAt ?? options.createdAt ?? now,
  };
  const store = testStore();
  await runWithTenant(
    { tenantId: options.tenantId ?? DEFAULT_TENANT_ID, mode: "single" },
    () => store.open(record)
  );
  if (options.tenantId === undefined && store instanceof MemorySessionStore) {
    await runWithoutTenant(() => store.open(record));
  }
  const cookie = `${sessionCookieName()}=${id}`;
  return {
    id,
    idHash,
    csrfToken,
    cookie,
    headers: {
      cookie,
      origin: options.origin ?? TEST_ORIGIN,
      "x-csrf-token": csrfToken,
    },
  };
}

/**
 * The headers of a browser whose session holds `token` — for a suite written around "the caller
 * presents this token": the session's subject is whoever the token names (`subject`, or the
 * registered provider's answer; a guest token's own guest id), so the real guard verifies it as
 * it would any session's. A token that names no one still gets a session: the guard refuses it.
 */
export async function sessionHeadersFor(
  token: string,
  options: Omit<TestSessionOptions, "token" | "kind"> = {}
): Promise<Record<string, string>> {
  if (token.startsWith("guest.")) {
    const verified = await verifyGuestToken(token);
    const session = await startTestSession({
      ...options,
      kind: "guest",
      token,
      subject:
        options.subject ?? (verified.valid ? verified.guestId : "guest_unverified"),
      tokenExpiresAt:
        options.tokenExpiresAt ?? (verified.valid ? verified.expiresAt : undefined),
    });
    return session.headers;
  }
  let subject = options.subject;
  if (subject === undefined) {
    try {
      subject = (await getAuthProvider().verifyToken(token))?.sub;
    } catch {
      subject = undefined;
    }
  }
  const session = await startTestSession({
    ...options,
    token,
    subject: subject ?? "unverified-subject",
  });
  return session.headers;
}

/**
 * A live session of `subject` as the guard hands it to a route (LiveSession) — for a suite that
 * replaces token verification (helpers/test-identities.ts) but whose route still acts on the
 * session itself: enrolling a factor with its token, moving it to a new id.
 */
export async function liveTestSession(
  subject: string,
  options: Omit<TestSessionOptions, "subject" | "kind"> = {}
): Promise<LiveSession> {
  const started = await startTestSession({ ...options, subject });
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID;
  const record = await runWithTenant({ tenantId, mode: "single" }, () =>
    getSessionStore().find(started.idHash)
  );
  if (!record) throw new Error("the test session was not recorded");
  const lifetimes = { idleSeconds: 7 * 86400, absoluteSeconds: 30 * 86400 };
  return {
    idHash: started.idHash,
    kind: "user",
    subject,
    method: record.method,
    csrfToken: started.csrfToken,
    audience: "user",
    lifetimes,
    idleAt: record.lastSeenAt + lifetimes.idleSeconds * 1000,
    absoluteAt: record.createdAt + lifetimes.absoluteSeconds * 1000,
    identityToken: options.token ?? "mock-access-token",
    record,
  };
}

/** The session cookie a response set, as `name=value` — or null when it set none or cleared it. */
export function sessionCookieOf(response: {
  headers: { getSetCookie?: () => string[] };
}): string | null {
  const name = sessionCookieName();
  for (const line of response.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair;
  }
  return null;
}

/** The attributes of the session cookie a response set (lower-cased names), or null. */
export function sessionCookieAttributes(response: {
  headers: { getSetCookie?: () => string[] };
}): Record<string, string> | null {
  const name = sessionCookieName();
  for (const line of response.headers.getSetCookie?.() ?? []) {
    if (!line.startsWith(`${name}=`)) continue;
    const out: Record<string, string> = {};
    for (const part of line.split(";").slice(1)) {
      const [k, ...v] = part.trim().split("=");
      out[k.toLowerCase()] = v.join("=") || "true";
    }
    return out;
  }
  return null;
}
