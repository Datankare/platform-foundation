/**
 * platform/auth/context.tsx — React auth context
 *
 * Provides the current authenticated user (or guest) to all client components.
 *
 * The page holds no credential (ADR-057): the session is an HttpOnly cookie the browser sends
 * and script cannot read, and the identity provider's tokens never leave the server. What the
 * page knows — who is signed in, and the session's forgery token to send back with
 * state-changing requests — it reads from GET /api/auth/session and keeps in memory only: nothing
 * about the session is written to localStorage, sessionStorage or a script-readable cookie
 * (__tests__/no-client-tokens.test.ts).
 *
 * A browser signed in before ADR-057 is moved over on its first load: what it kept in storage is
 * deleted unread (legacy-session-cleanup.ts) and the server exchanges its httpOnly legacy cookie
 * for a server-side session (POST /api/auth/session/migrate) — no new sign-in. A legacy guest
 * starts again as a guest.
 *
 * Usage:
 *   import { useAuth } from "@/platform/auth/context";
 *
 *   function MyComponent() {
 *     const { user, isLoading, isAuthenticated, isGuest, signOut } = useAuth();
 *     if (isLoading) return <Loading />;
 *     if (!isAuthenticated) return <LoginScreen />;
 *     return <div>Hello {user.email}</div>;
 *   }
 *
 * Wrap your app with <AuthContextProvider>:
 *   <AuthContextProvider>
 *     <App />
 *   </AuthContextProvider>
 *
 * ADR-012: Client-side auth state management. ADR-057: server-side sessions.
 */

"use client";

import React, {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";
import { removeLegacyStoredSession } from "./legacy-session-cleanup";

/** Client-side user representation */
export interface AuthUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  isGuest: boolean;
}

/** Whose session lifetimes apply (platform/auth/session-lifetimes.ts). */
export type SessionAudience = "user" | "staff" | "guest";

/** What the server says about the browser's session. Held in memory only. */
export type SessionState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | {
      readonly status: "signed-in";
      readonly user: AuthUser;
      /** Sent in `x-csrf-token` with state-changing requests; not a credential. */
      readonly csrfToken: string;
      readonly audience: SessionAudience;
      /** When the session ends without use, ms since the epoch; null: no idle limit. */
      readonly idleExpiresAt: number | null;
      readonly absoluteExpiresAt: number;
      /** How long before an idle sign-out to warn, seconds. */
      readonly idleWarningSeconds: number;
    };

/** Auth context value */
export interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isGuest: boolean;
  /** The session as the server last described it. */
  session: SessionState;
  /**
   * After a sign-in step succeeded: read the new session from the server. Resolves true when
   * the browser is signed in.
   */
  sessionStarted: () => Promise<boolean>;
  /** Sign out — ends the session on the server, then forgets it here */
  signOut: () => Promise<void>;
  /**
   * Sign out on every device — ends every session of the account on the server. Resolves true
   * when the server did it (this page is then signed out too); false when it could not be
   * asked or refused — the page stays signed in, so the person can try again: this is the
   * action someone takes when they fear another device is in their account, and it never
   * claims a sign-out that did not happen.
   */
  signOutEverywhere: () => Promise<boolean>;
  /** "Stay signed in": counts as use of the session; resolves false when it has ended. */
  staySignedIn: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const LOADING: SessionState = { status: "loading" };
const SIGNED_OUT: SessionState = { status: "signed-out" };

// ---------------------------------------------------------------------------
// The session store: one per page, in memory, shared with apiFetch
// ---------------------------------------------------------------------------

let snapshot: SessionState = LOADING;
const listeners = new Set<() => void>();

function setState(next: SessionState): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

/**
 * React subscribes to the store when the provider is committed — before any component's effect
 * runs — and the first subscription starts the page's first read of its session. So a screen
 * whose own effect calls the API at once finds that read already under way (apiFetch waits for
 * it) instead of sending a request without the session's forgery token.
 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!firstLoadStarted && typeof window !== "undefined") {
    firstLoadStarted = true;
    firstLoading = firstLoad().finally(() => {
      firstLoading = undefined;
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): SessionState => snapshot;
const getServerSnapshot = (): SessionState => LOADING;

/** The session as last read (apiFetch reads the forgery token from it). */
export function currentSession(): SessionState {
  return snapshot;
}

/** The session ended on the server (an API call answered that it has): forget it here. */
export function noteSessionEnded(): void {
  if (snapshot.status !== "signed-out") setState(SIGNED_OUT);
}

/** A factor change moved the session to a new id: its new forgery token. */
export function noteCsrfToken(csrfToken: string): void {
  if (snapshot.status === "signed-in" && csrfToken) setState({ ...snapshot, csrfToken });
}

function parseSession(data: unknown): SessionState | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  if (d.authenticated === false) return SIGNED_OUT;
  const u = d.user as Record<string, unknown> | undefined;
  if (
    d.authenticated !== true ||
    typeof u !== "object" ||
    u === null ||
    typeof u.userId !== "string" ||
    typeof d.csrfToken !== "string" ||
    typeof d.absoluteExpiresAt !== "number"
  ) {
    return null;
  }
  return {
    status: "signed-in",
    user: {
      userId: u.userId,
      email: typeof u.email === "string" ? u.email : "",
      emailVerified: u.emailVerified === true,
      isGuest: u.isGuest === true,
    },
    csrfToken: d.csrfToken,
    audience:
      d.audience === "staff" ? "staff" : d.audience === "guest" ? "guest" : "user",
    idleExpiresAt: typeof d.idleExpiresAt === "number" ? d.idleExpiresAt : null,
    absoluteExpiresAt: d.absoluteExpiresAt,
    idleWarningSeconds:
      typeof d.idleWarningSeconds === "number" ? d.idleWarningSeconds : 120,
  };
}

function askSession(method: "GET" | "POST"): Promise<Response> {
  const headers: Record<string, string> = {};
  if (method === "POST" && snapshot.status === "signed-in") {
    headers["x-csrf-token"] = snapshot.csrfToken;
  }
  return fetch("/api/auth/session", {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
}

async function readSession(method: "GET" | "POST"): Promise<SessionState | null> {
  const res = await askSession(method);
  if (!res.ok) return null;
  return parseSession(await res.json().catch(() => null));
}

/**
 * A page's first read that the server could not answer (refused for now, an outage, the network)
 * is asked again after these waits before the page concludes anything: a signed-in person is not
 * shown the sign-in form because one read failed.
 */
const FIRST_READ_RETRY_MS: readonly number[] = [250, 750];
let firstReadRetryMs = FIRST_READ_RETRY_MS;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The page's read of its session: the server's answer, or none — and whether having none is for
 * now (refused for the moment, a server error, the network: worth asking again) or an answer in
 * itself (a coded refusal of this account or request).
 */
async function readStatus(): Promise<{ state: SessionState | null; forNow: boolean }> {
  try {
    const res = await askSession("GET");
    if (res.ok) {
      return { state: parseSession(await res.json().catch(() => null)), forNow: false };
    }
    return { state: null, forNow: res.status === 429 || res.status >= 500 };
  } catch {
    /* justified */
    // Network failure: no answer for now; the caller decides.
    return { state: null, forNow: true };
  }
}

let loading: Promise<SessionState> | undefined;
let firstLoadStarted = false;
let firstLoading: Promise<void> | undefined;

/**
 * The read of the session now under way, if any (apiFetch waits for it before a state-changing
 * call; it never starts one — a page without the provider has no session to read).
 */
export function pendingSessionLoad(): Promise<unknown> | undefined {
  return firstLoading ?? loading;
}

/**
 * Read the session from the server and keep it. Calls made at once share one request. When the
 * server cannot say (an outage, a refusal for now), the state already held stands — a signed-in
 * page is not signed out by a failed read — and a page with nothing yet asks again, briefly
 * (FIRST_READ_RETRY_MS), and only then is signed out.
 */
export function loadSession(): Promise<SessionState> {
  if (typeof window === "undefined") return Promise.resolve(LOADING);
  loading ??= (async () => {
    let read = await readStatus();
    for (const ms of snapshot.status === "loading" ? firstReadRetryMs : []) {
      if (read.state !== null || !read.forNow) break;
      await wait(ms);
      read = await readStatus();
    }
    const next = read.state ?? (snapshot.status === "signed-in" ? snapshot : SIGNED_OUT);
    setState(next);
    return next;
  })().finally(() => {
    loading = undefined;
  });
  return loading;
}

/**
 * The first read of a page: what a legacy sign-in left in storage is deleted, and when the
 * server knows no session but the browser held a legacy one, the server is asked to move it.
 */
async function firstLoad(): Promise<void> {
  const hadLegacy = removeLegacyStoredSession();
  if (!hadLegacy) {
    await loadSession();
    return;
  }
  // A browser signed in before ADR-057: it is not shown as signed out until the move has been
  // tried — the page stays "loading", so the sign-in form does not flash at a signed-in user.
  let state: SessionState | null = null;
  try {
    state = await readSession("GET");
  } catch {
    /* justified */
    // Network failure: loadSession below decides.
  }
  if (state?.status !== "signed-in") {
    try {
      await fetch("/api/auth/session/migrate", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      /* justified */
      // Not moved: the browser shows sign-in.
    }
  }
  await loadSession();
}

/**
 * Forget the page's session state (tests). `firstReadRetryMs` replaces the waits before a failed
 * first read is asked again, for a test that would otherwise wait them out.
 */
export function resetSessionStateForTests(
  options: { firstReadRetryMs?: readonly number[] } = {}
): void {
  firstReadRetryMs = options.firstReadRetryMs ?? FIRST_READ_RETRY_MS;
  snapshot = LOADING;
  loading = undefined;
  firstLoading = undefined;
  firstLoadStarted = false;
  listeners.clear();
}

async function post(path: string): Promise<void> {
  try {
    await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers:
        snapshot.status === "signed-in" ? { "x-csrf-token": snapshot.csrfToken } : {},
    });
  } catch {
    /* justified */
    // Offline: the session still ends here; the server's session ends by its lifetimes.
  }
}

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const sessionStarted = useCallback(
    async () => (await loadSession()).status === "signed-in",
    []
  );

  // The server ends the session; it is forgotten here whatever the server answers, so a failed
  // sign-out never leaves the page claiming one.
  const signOut = useCallback(async () => {
    await post("/api/auth/sign-out");
    setState(SIGNED_OUT);
  }, []);

  const signOutEverywhere = useCallback(async () => {
    let done = false;
    try {
      const res = await fetch("/api/auth/sign-out-everywhere", {
        method: "POST",
        credentials: "same-origin",
        headers:
          snapshot.status === "signed-in" ? { "x-csrf-token": snapshot.csrfToken } : {},
      });
      const data = (await res.json().catch(() => null)) as { success?: unknown } | null;
      done = res.ok && data?.success === true;
      // The session had already ended: there is nothing left to end from here.
      if (res.status === 401) done = true;
    } catch {
      /* justified */
      // Offline: not done; the page stays signed in and says so.
    }
    if (done) setState(SIGNED_OUT);
    return done;
  }, []);

  const staySignedIn = useCallback(async () => {
    let next: SessionState | null = null;
    try {
      next = await readSession("POST");
    } catch {
      /* justified */
      // Network failure: the state held stands; the next poll decides.
    }
    if (next === null) return snapshot.status === "signed-in";
    setState(next);
    return next.status === "signed-in";
  }, []);

  const user = session.status === "signed-in" ? session.user : null;
  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading: session.status === "loading",
      isAuthenticated: user !== null,
      isGuest: user?.isGuest ?? false,
      session,
      sessionStarted,
      signOut,
      signOutEverywhere,
      staySignedIn,
    }),
    [user, session, sessionStarted, signOut, signOutEverywhere, staySignedIn]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth state in any client component.
 * Must be used inside <AuthContextProvider>.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthContextProvider");
  }
  return context;
}
