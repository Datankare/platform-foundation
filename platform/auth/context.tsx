/**
 * platform/auth/context.tsx — React auth context
 *
 * Provides the current authenticated user (or guest) to all client components.
 * Handles token storage, refresh, and expiry detection.
 *
 * Only the short-lived access token is kept where script can read it. The refresh token never
 * reaches the browser's storage (audit X-17): the server keeps it in an httpOnly cookie, and an
 * expired access token is renewed through POST /api/auth/refresh (refreshSession). Sign-out
 * revokes the session on the server (POST /api/auth/sign-out) before forgetting it here.
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
 * ADR-012: Client-side auth state management.
 */

"use client";

import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";

/** Client-side user representation */
export interface AuthUser {
  userId: string;
  email: string;
  emailVerified: boolean;
  isGuest: boolean;
}

/** Auth context value */
export interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  isGuest: boolean;
  /** Sign in — stores the access token and updates user state */
  setSession: (session: SessionInput) => void;
  /** Sign out — revokes the session on the server, then clears it here */
  signOut: () => Promise<void>;
  /** Get the current access token (for API calls) */
  getAccessToken: () => string | null;
}

/** What a sign-in hands the context: never a refresh token (it stays in an httpOnly cookie). */
export interface SessionInput {
  accessToken: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  isGuest?: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_STORAGE_KEY = "pf_access_token";
/** Where earlier versions kept the refresh token; removed wherever it is still found. */
const LEGACY_REFRESH_STORAGE_KEY = "pf_refresh_token";
const USER_STORAGE_KEY = "pf_user";

/** Get a value from localStorage safely (SSR-compatible) */
function getStoredValue(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    /* justified */
    // localStorage unavailable — return safe default
    return null;
  }
}

/** Set a value in localStorage safely */
function setStoredValue(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* justified */
    // localStorage unavailable — return safe default
    // localStorage may be full or disabled — fail silently
  }
}

/** Remove a value from localStorage safely */
function removeStoredValue(key: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key);
  } catch {
    /* justified */
    // localStorage unavailable — return safe default
    // fail silently
  }
}

/**
 * Set the session indicator for the page proxy when the server has not: the server sets it for
 * as long as the session can be renewed (the refresh cookie's life), which this must not cut
 * short.
 */
function setSessionCookie(maxAge: number): void {
  if (typeof document === "undefined") return;
  if (/(?:^|;\s*)pf_has_session=true(?:;|$)/.test(document.cookie)) return;
  document.cookie = "pf_has_session=true; path=/; max-age=" + maxAge + "; SameSite=Lax";
}

/** Clear session indicator cookie */
function clearSessionCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = "pf_has_session=; path=/; max-age=0; SameSite=Lax";
}

/** Guest tokens of the form guest_<id>_<timestamp> are valid for 24h. */
const GUEST_TOKEN_VALIDITY_MS = 86_400_000;

/**
 * Best-effort token expiry in epoch ms, or null when undeterminable.
 * Handles: guest_<id>_<ts> (underscore scheme), JWTs, and guest.<jwt>.
 * Null means "cannot tell" — hydration proceeds and the server remains the
 * authority; a determinable past expiry means the stored session is stale.
 */
function getTokenExpiryMs(token: string): number | null {
  if (token.startsWith("guest_")) {
    const ts = parseInt(token.slice(token.lastIndexOf("_") + 1), 10);
    return isNaN(ts) ? 0 : ts + GUEST_TOKEN_VALIDITY_MS;
  }
  const segments = token.split(".");
  const payloadSegment =
    segments.length === 3
      ? segments[1]
      : segments.length === 4 && segments[0] === "guest"
        ? segments[2]
        : null;
  if (!payloadSegment) return null;
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized)) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp * 1000 : null;
  } catch {
    /* justified */
    // Not a decodable JWT — cannot determine expiry client-side
    return null;
  }
}

/**
 * What the browser holds: a session to restore, nothing, or one to discard. Stale (a
 * determinable past expiry) or corrupt sessions are discarded rather than restored: restoring
 * them leaves the client claiming a session while the pf_has_session cookie (max-age 3600) has
 * expired, so middleware and the client disagree forever and auth pages render blank.
 */
type StoredSession =
  | { kind: "session"; user: AuthUser; accessToken: string }
  | { kind: "none" }
  | { kind: "discard" }
  /** A user's access token has expired: renewed from the refresh cookie, else discarded. */
  | { kind: "expired"; user: AuthUser };

/** Reads, never writes: the purge and the cookie re-issue happen in an effect. */
function readStoredSession(): StoredSession {
  const storedToken = getStoredValue(TOKEN_STORAGE_KEY);
  const storedUser = getStoredValue(USER_STORAGE_KEY);
  if (!storedToken || !storedUser) return { kind: "none" };
  let user: AuthUser;
  try {
    user = JSON.parse(storedUser) as AuthUser;
  } catch {
    /* justified */
    // Corrupted storage — discard it
    return { kind: "discard" };
  }
  const expiryMs = getTokenExpiryMs(storedToken);
  if (expiryMs !== null && expiryMs <= Date.now()) {
    // A guest has no refresh token; a user may (the server holds it).
    return user && !user.isGuest ? { kind: "expired", user } : { kind: "discard" };
  }
  return { kind: "session", user, accessToken: storedToken };
}

/**
 * The access token of the stored session, for API calls made outside a component (apiFetch):
 * null when there is none, or when it has expired or is corrupt — never a stale token.
 */
export function readAccessToken(): string | null {
  const stored = readStoredSession();
  return stored.kind === "session" ? stored.accessToken : null;
}

/**
 * The session as an external store (React's useSyncExternalStore): read from storage once, on
 * the client, then changed only by setSession, signOut and refreshSession. The server snapshot
 * is "not read yet", so the server render and the hydrating render agree (loading) and no state
 * is set inside an effect. One store per page, shared by every provider and by apiFetch.
 */
function createSessionStore() {
  let snapshot: StoredSession | undefined;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot(): StoredSession {
      snapshot ??= readStoredSession();
      return snapshot;
    },
    set(next: StoredSession) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const notReadOnServer = (): undefined => undefined;

type SessionStore = ReturnType<typeof createSessionStore>;
/** The mounted provider's store, so a renewal made outside React (apiFetch) updates it. */
let activeStore: SessionStore | undefined;

function clearStoredSession(): void {
  removeStoredValue(TOKEN_STORAGE_KEY);
  removeStoredValue(LEGACY_REFRESH_STORAGE_KEY);
  removeStoredValue(USER_STORAGE_KEY);
  clearSessionCookie();
}

function storeSession(session: SessionInput): void {
  const authUser: AuthUser = {
    userId: session.userId,
    email: session.email,
    emailVerified: session.emailVerified,
    isGuest: session.isGuest ?? false,
  };
  setStoredValue(TOKEN_STORAGE_KEY, session.accessToken);
  setStoredValue(USER_STORAGE_KEY, JSON.stringify(authUser));
  // A refresh token an earlier version left in storage is removed (audit X-17).
  removeStoredValue(LEGACY_REFRESH_STORAGE_KEY);
  setSessionCookie(3600);
  activeStore?.set({ kind: "session", user: authUser, accessToken: session.accessToken });
}

let refreshing: Promise<string | null> | undefined;

/**
 * Renew the signed-in user's access token from the server's refresh cookie: the new token, or
 * null (no user session, or the refresh was refused — then the session is ended here). Calls
 * made at once share one request.
 */
export function refreshSession(): Promise<string | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const current = readStoredSession();
  const user =
    current.kind === "session" || current.kind === "expired" ? current.user : null;
  if (!user || user.isGuest) return Promise.resolve(null);
  refreshing ??= (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "same-origin",
      });
      const data = (await res.json().catch(() => ({}))) as {
        accessToken?: unknown;
        userId?: unknown;
      };
      if (res.ok && typeof data.accessToken === "string" && data.userId === user.userId) {
        storeSession({ ...user, accessToken: data.accessToken });
        return data.accessToken;
      }
    } catch {
      /* justified */
      // Network failure: the session ends here, as a refused refresh does.
    }
    clearStoredSession();
    activeStore?.set({ kind: "none" });
    return null;
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createSessionStore);
  useEffect(() => {
    activeStore = store;
    return () => {
      if (activeStore === store) activeStore = undefined;
    };
  }, [store]);
  const stored = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    notReadOnServer
  );
  // An expired session is still loading: it is renewed, or ended, by the effect below.
  const isLoading = stored === undefined || stored.kind === "expired";
  const user = stored?.kind === "session" ? stored.user : null;
  const accessToken = stored?.kind === "session" ? stored.accessToken : null;

  // Bring storage and the middleware cookie in line with what was restored: a discarded session
  // is purged; a restored one re-issues the cookie so both sides agree again.
  useEffect(() => {
    if (stored?.kind === "discard") {
      clearStoredSession();
      store.set({ kind: "none" });
    } else if (stored?.kind === "session") {
      setSessionCookie(3600);
      removeStoredValue(LEGACY_REFRESH_STORAGE_KEY);
    } else if (stored?.kind === "expired") void refreshSession();
  }, [stored, store]);

  const setSession = useCallback((session: SessionInput) => storeSession(session), []);

  // The server revokes the refresh token (its cookie) and the access token's sign-in; the
  // session is forgotten here whatever it answers, so a failed revocation never leaves the
  // browser claiming one.
  const signOut = useCallback(async () => {
    const token = stored?.kind === "session" ? stored.accessToken : null;
    try {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        credentials: "same-origin",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch {
      /* justified */
      // Offline: the session still ends here; the server's tokens expire on their own.
    }
    clearStoredSession();
    store.set({ kind: "none" });
  }, [store, stored]);

  const getAccessToken = useCallback(() => {
    return accessToken;
  }, [accessToken]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      accessToken,
      isLoading,
      isAuthenticated: user !== null,
      isGuest: user?.isGuest ?? false,
      setSession,
      signOut,
      getAccessToken,
    }),
    [user, accessToken, isLoading, setSession, signOut, getAccessToken]
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
