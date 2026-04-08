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

export function AuthContextProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const storedToken = getStoredValue(TOKEN_STORAGE_KEY);
    const storedUser = getStoredValue(USER_STORAGE_KEY);

    if (storedToken && storedUser) {
      try {
        const parsed = JSON.parse(storedUser) as AuthUser;
        setUser(parsed);
        setAccessToken(storedToken);
      } catch {
        /* justified */
        // localStorage unavailable — return safe default
        // Corrupted storage — clear it
        removeStoredValue(TOKEN_STORAGE_KEY);
        removeStoredValue(REFRESH_STORAGE_KEY);
        removeStoredValue(USER_STORAGE_KEY);
        clearSessionCookie();
      }
    }
    setIsLoading(false);
  }, []);

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

      setUser(authUser);
      setAccessToken(session.accessToken);
      setStoredValue(TOKEN_STORAGE_KEY, session.accessToken);
      setStoredValue(REFRESH_STORAGE_KEY, session.refreshToken);
      setStoredValue(USER_STORAGE_KEY, JSON.stringify(authUser));
      setSessionCookie(3600);
    },
    []
  );

  const signOut = useCallback(() => {
    setUser(null);
    setAccessToken(null);
    removeStoredValue(TOKEN_STORAGE_KEY);
    removeStoredValue(REFRESH_STORAGE_KEY);
    removeStoredValue(USER_STORAGE_KEY);
    clearSessionCookie();
  }, []);

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
