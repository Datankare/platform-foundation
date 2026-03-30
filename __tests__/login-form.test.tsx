/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginForm from "@/components/auth/LoginForm";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onSsoClick: jest.fn().mockResolvedValue(undefined),
  onGuestClick: jest.fn().mockResolvedValue(undefined),
  onForgotPassword: jest.fn(),
  onCreateAccount: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("LoginForm", () => {
  it("renders email and password inputs", () => {
    render(<LoginForm {...mockProps} />);
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
  });

  it("renders SSO buttons", () => {
    render(<LoginForm {...mockProps} />);
    expect(screen.getByText("Continue with Google")).toBeDefined();
    expect(screen.getByText("Continue with Apple")).toBeDefined();
    expect(screen.getByText("Continue with Microsoft")).toBeDefined();
  });

  it("renders guest option by default", () => {
    render(<LoginForm {...mockProps} />);
    expect(screen.getByText("Continue as Guest")).toBeDefined();
  });

  it("hides guest option when showGuestOption is false", () => {
    render(<LoginForm {...mockProps} showGuestOption={false} />);
    expect(screen.queryByText("Continue as Guest")).toBeNull();
  });

  it("submit button is disabled when fields are empty", () => {
    render(<LoginForm {...mockProps} />);
    const button = screen.getByRole("button", { name: "Sign In" });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("submit button enables after entering email and password", () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    const button = screen.getByRole("button", { name: "Sign In" });
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with email and password on form submit", async () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "password123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(mockProps.onSubmit).toHaveBeenCalledWith("test@example.com", "password123");
    });
  });

  it("displays error message when error prop is set", () => {
    render(<LoginForm {...mockProps} error="Invalid credentials" />);
    expect(screen.getByRole("alert").textContent).toBe("Invalid credentials");
  });

  it("calls onForgotPassword when forgot password link clicked", () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.click(screen.getByText("Forgot password?"));
    expect(mockProps.onForgotPassword).toHaveBeenCalled();
  });

  it("calls onCreateAccount when create account link clicked", () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.click(screen.getByText("Create one"));
    expect(mockProps.onCreateAccount).toHaveBeenCalled();
  });

  it("calls onGuestClick when guest button clicked", async () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.click(screen.getByText("Continue as Guest"));
    await waitFor(() => {
      expect(mockProps.onGuestClick).toHaveBeenCalled();
    });
  });

  it("has correct autocomplete attributes for password managers", () => {
    render(<LoginForm {...mockProps} />);
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe(
      "current-password"
    );
  });
});
