/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AuthPage from "@/components/auth/AuthPage";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";

// Mock the auth context
const mockSetSession = jest.fn();
jest.mock("@/platform/auth/context", () => ({
  useAuth: () => ({
    setSession: mockSetSession,
    user: null,
    accessToken: null,
    isLoading: false,
    isAuthenticated: false,
    isGuest: false,
    signOut: jest.fn(),
    getAccessToken: () => null,
  }),
}));

beforeAll(() => {
  registerAuthProvider(createMockAuthProvider());
});

/** GET /api/features — what the sign-in screen asks for its SSO providers (TASK-101). */
let features: Record<string, { available: boolean }> = {};
let guestResponse: { ok: boolean; body: unknown } = { ok: true, body: {} };
const fetchMock = jest.fn(async (url: string) =>
  url === "/api/auth/guest"
    ? { ok: guestResponse.ok, json: async () => guestResponse.body }
    : { ok: true, json: async () => ({ features }) }
);

beforeEach(() => {
  jest.clearAllMocks();
  features = {};
  global.fetch = fetchMock as unknown as typeof fetch;
  window.history.replaceState(null, "", "/auth");
});

afterEach(() => {
  registerAuthProvider(createMockAuthProvider());
});

describe("AuthPage", () => {
  it("starts on login view", () => {
    render(<AuthPage />);
    expect(screen.getByRole("heading", { name: "Sign In" })).toBeDefined();
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
  });

  it("switches to register view when Create one is clicked", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText("Create one"));
    expect(screen.getByRole("heading", { name: "Create Account" })).toBeDefined();
    expect(screen.getByLabelText("Confirm Password")).toBeDefined();
  });

  it("switches back to login from register", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText("Create one"));
    expect(screen.getByRole("heading", { name: "Create Account" })).toBeDefined();

    fireEvent.click(screen.getByText("Sign in"));
    expect(screen.getByRole("heading", { name: "Sign In" })).toBeDefined();
  });

  it("switches to forgot password view", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(screen.getByText("Reset Password")).toBeDefined();
  });

  it("switches back to login from forgot password", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(screen.getByText("Reset Password")).toBeDefined();

    fireEvent.click(screen.getByText("Back to Sign In"));
    expect(screen.getByRole("heading", { name: "Sign In" })).toBeDefined();
  });

  it("shows error on failed login", async () => {
    render(<AuthPage />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeDefined();
    });
  });

  it("renders PLAYFORM branding", () => {
    render(<AuthPage />);
    expect(screen.getByText("PLAY")).toBeDefined();
    expect(screen.getByText("FORM")).toBeDefined();
  });

  it("renders guest option", () => {
    render(<AuthPage />);
    expect(screen.getByText("Continue as Guest")).toBeDefined();
  });

  it("starts a guest session with a server-minted token (ADR-050 D4)", async () => {
    guestResponse = {
      ok: true,
      body: { success: true, guestId: "guest_abc", token: "guest.p.m", expiresAt: 1 },
    };
    render(<AuthPage />);
    fireEvent.click(screen.getByText("Continue as Guest"));
    await waitFor(() =>
      expect(mockSetSession).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "guest.p.m",
          userId: "guest_abc",
          isGuest: true,
        })
      )
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/guest",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows the server's message when a guest session cannot start", async () => {
    guestResponse = {
      ok: false,
      body: { code: "internal.error", message: "Something went wrong (ref req_1)." },
    };
    render(<AuthPage />);
    fireEvent.click(screen.getByText("Continue as Guest"));
    expect(await screen.findByText("Something went wrong (ref req_1).")).toBeDefined();
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it("offers only the SSO providers /api/features reports available", async () => {
    features = {
      sso_google: { available: true },
      sso_apple: { available: false },
      sso_microsoft: { available: false },
    };
    render(<AuthPage />);
    expect(await screen.findByText("Continue with Google")).toBeDefined();
    expect(screen.queryByText("Continue with Apple")).toBeNull();
    expect(screen.queryByText("Continue with Microsoft")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/features");
  });

  it("offers no SSO when none is configured or the feature list fails", async () => {
    render(<AuthPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText("Continue with Google")).toBeNull();

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    render(<AuthPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText("Continue with Google")).toBeNull();
  });

  it("shows the catalog message for an SSO error returned in the address", async () => {
    window.history.replaceState(null, "", "/auth?error=auth.sso_failed");
    render(<AuthPage />);
    expect(
      await screen.findByText(
        "Single sign-on did not complete. Try another sign-in method."
      )
    ).toBeDefined();
  });

  it("ignores an unknown error code in the address", async () => {
    window.history.replaceState(null, "", "/auth?error=%3Cscript%3E");
    render(<AuthPage />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the new-password view when sign-in requires a new password", async () => {
    render(<AuthPage />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "new-password-required" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(await screen.findByText("Set a New Password")).toBeDefined();
  });

  it("surfaces an error when setting the new password fails", async () => {
    registerAuthProvider(
      createMockAuthProvider({
        respondToNewPasswordChallenge: jest.fn().mockResolvedValue({
          success: false,
          error: "Server rejected password",
        }),
      })
    );
    render(<AuthPage />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "new-password-required" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByText("Set a New Password");

    fireEvent.change(screen.getByPlaceholderText("New password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toBe("Server rejected password");
    });
  });

  it("completes sign-in after a successful new password", async () => {
    render(<AuthPage />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "admin@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "new-password-required" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByText("Set a New Password");

    fireEvent.change(screen.getByPlaceholderText("New password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });
});
