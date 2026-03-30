/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AuthPage from "@/components/auth/AuthPage";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";

// Mock the auth context
jest.mock("@/platform/auth/context", () => ({
  useAuth: () => ({
    setSession: jest.fn(),
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

beforeEach(() => {
  jest.clearAllMocks();
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

  it("renders all three SSO buttons", () => {
    render(<AuthPage />);
    expect(screen.getByText("Continue with Google")).toBeDefined();
    expect(screen.getByText("Continue with Apple")).toBeDefined();
    expect(screen.getByText("Continue with Microsoft")).toBeDefined();
  });
});
