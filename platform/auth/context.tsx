/**
 * platform/auth/context.tsx — React auth context
 *
 * Provides the current authenticated user (or guest) to all client components.
 * Handles token storage, refresh, and expiry detection.
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
  /** Sign in — stores tokens and updates user state */
  setSession: (session: {
    accessToken: string;
    refreshToken: string;
    userId: string;
    email: string;
    emailVerified: boolean;
    isGuest?: boolean;
  }) => void;
  /** Sign out — clears tokens and user state */
  signOut: () => void;
  /** Get the current access token (for API calls) */
  getAccessToken: () => string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const TOKEN_STORAGE_KEY = "pf_access_token";
const REFRESH_STORAGE_KEY = "pf_refresh_token";
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

/** Set session indicator cookie for middleware route protection */
function setSessionCookie(maxAge: number): void {
  if (typeof document === "undefined") return;
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
  | { kind: "discard" };

/** Reads, never writes: the purge and the cookie re-issue happen in an effect. */
function readStoredSession(): StoredSession {
  const storedToken = getStoredValue(TOKEN_STORAGE_KEY);
  const storedUser = getStoredValue(USER_STORAGE_KEY);
  if (!storedToken || !storedUser) return { kind: "none" };
  const expiryMs = getTokenExpiryMs(storedToken);
  if (expiryMs !== null && expiryMs <= Date.now()) return { kind: "discard" };
  try {
    return {
      kind: "session",
      user: JSON.parse(storedUser) as AuthUser,
      accessToken: storedToken,
    };
  } catch {
    /* justified */
    // Corrupted storage — discard it
    return { kind: "discard" };
  }
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
 * the client, then changed only by setSession and signOut. The server snapshot is "not read
 * yet", so the server render and the hydrating render agree (loading) and no state is set
 * inside an effect.
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

function clearStoredSession(): void {
  removeStoredValue(TOKEN_STORAGE_KEY);
  removeStoredValue(REFRESH_STORAGE_KEY);
  removeStoredValue(USER_STORAGE_KEY);
  clearSessionCookie();
}

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const [store] = useState(createSessionStore);
  const stored = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    notReadOnServer
  );
  const isLoading = stored === undefined;
  const user = stored?.kind === "session" ? stored.user : null;
  const accessToken = stored?.kind === "session" ? stored.accessToken : null;

  // Bring storage and the middleware cookie in line with what was restored: a discarded session
  // is purged; a restored one re-issues the cookie so both sides agree again.
  useEffect(() => {
    if (stored?.kind === "discard") clearStoredSession();
    else if (stored?.kind === "session") setSessionCookie(3600);
  }, [stored]);

  const setSession = useCallback(
    (session: {
      accessToken: string;
      refreshToken: string;
      userId: string;
      email: string;
      emailVerified: boolean;
      isGuest?: boolean;
    }) => {
      const authUser: AuthUser = {
        userId: session.userId,
        email: session.email,
        emailVerified: session.emailVerified,
        isGuest: session.isGuest ?? false,
      };

      setStoredValue(TOKEN_STORAGE_KEY, session.accessToken);
      setStoredValue(REFRESH_STORAGE_KEY, session.refreshToken);
      setStoredValue(USER_STORAGE_KEY, JSON.stringify(authUser));
      setSessionCookie(3600);
      store.set({ kind: "session", user: authUser, accessToken: session.accessToken });
    },
    [store]
  );

  const signOut = useCallback(() => {
    clearStoredSession();
    store.set({ kind: "none" });
  }, [store]);

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
