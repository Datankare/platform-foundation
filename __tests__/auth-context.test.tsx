/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, act } from "@testing-library/react";
import { AuthContextProvider, useAuth } from "@/platform/auth/context";

// Test component that exposes auth context values
function AuthDisplay() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="loading">{auth.isLoading.toString()}</span>
      <span data-testid="authenticated">{auth.isAuthenticated.toString()}</span>
      <span data-testid="guest">{auth.isGuest.toString()}</span>
      <span data-testid="email">{auth.user?.email || "none"}</span>
      <button onClick={auth.signOut}>Sign Out</button>
      <button
        onClick={() =>
          auth.setSession({
            accessToken: "test-token",
            refreshToken: "test-refresh",
            userId: "user-1",
            email: "test@example.com",
            emailVerified: true,
          })
        }
      >
        Set Session
      </button>
      <button
        onClick={() =>
          auth.setSession({
            accessToken: "guest-token",
            refreshToken: "",
            userId: "guest-1",
            email: "",
            emailVerified: false,
            isGuest: true,
          })
        }
      >
        Set Guest
      </button>
    </div>
  );
}

// Mock localStorage
const mockStorage: Record<string, string> = {};
beforeEach(() => {
  Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
  jest
    .spyOn(Storage.prototype, "getItem")
    .mockImplementation((key) => mockStorage[key] || null);
  jest.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => {
    mockStorage[key] = value;
  });
  jest.spyOn(Storage.prototype, "removeItem").mockImplementation((key) => {
    delete mockStorage[key];
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("AuthContextProvider", () => {
  it("starts with loading true then resolves to false", async () => {
    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    // After mount, loading should resolve to false
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("starts unauthenticated with no stored session", () => {
    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    expect(screen.getByTestId("authenticated").textContent).toBe("false");
    expect(screen.getByTestId("guest").textContent).toBe("false");
    expect(screen.getByTestId("email").textContent).toBe("none");
  });

  it("setSession updates user state", () => {
    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    act(() => {
      screen.getByText("Set Session").click();
    });

    expect(screen.getByTestId("authenticated").textContent).toBe("true");
    expect(screen.getByTestId("guest").textContent).toBe("false");
    expect(screen.getByTestId("email").textContent).toBe("test@example.com");
  });

  it("setSession stores tokens in localStorage", () => {
    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    act(() => {
      screen.getByText("Set Session").click();
    });

    expect(mockStorage["pf_access_token"]).toBe("test-token");
    expect(mockStorage["pf_refresh_token"]).toBe("test-refresh");
    expect(mockStorage["pf_user"]).toContain("test@example.com");
  });

  it("guest session sets isGuest to true", () => {
    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    act(() => {
      screen.getByText("Set Guest").click();
    });

    expect(screen.getByTestId("authenticated").textContent).toBe("true");
    expect(screen.getByTestId("guest").textContent).toBe("true");
  });

  it("signOut clears user state and localStorage", () => {
    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    // Set session first
    act(() => {
      screen.getByText("Set Session").click();
    });
    expect(screen.getByTestId("authenticated").textContent).toBe("true");

    // Sign out
    act(() => {
      screen.getByText("Sign Out").click();
    });
    expect(screen.getByTestId("authenticated").textContent).toBe("false");
    expect(mockStorage["pf_access_token"]).toBeUndefined();
    expect(mockStorage["pf_user"]).toBeUndefined();
  });

  it("restores session from localStorage on mount", () => {
    mockStorage["pf_access_token"] = "stored-token";
    mockStorage["pf_user"] = JSON.stringify({
      userId: "user-1",
      email: "stored@example.com",
      emailVerified: true,
      isGuest: false,
    });

    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    expect(screen.getByTestId("authenticated").textContent).toBe("true");
    expect(screen.getByTestId("email").textContent).toBe("stored@example.com");
  });

  it("handles corrupted localStorage gracefully", () => {
    mockStorage["pf_access_token"] = "stored-token";
    mockStorage["pf_user"] = "not-valid-json{{{";

    render(
      <AuthContextProvider>
        <AuthDisplay />
      </AuthContextProvider>
    );

    // Should fall back to unauthenticated
    expect(screen.getByTestId("authenticated").textContent).toBe("false");
  });
});

describe("useAuth", () => {
  it("throws when used outside AuthContextProvider", () => {
    // Suppress console.error for expected error
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => render(<AuthDisplay />)).toThrow(
      "useAuth must be used within an AuthContextProvider"
    );

    spy.mockRestore();
  });
});
