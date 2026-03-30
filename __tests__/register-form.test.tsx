/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RegisterForm from "@/components/auth/RegisterForm";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onBackToLogin: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("RegisterForm", () => {
  it("renders email, password, and confirm password inputs", () => {
    render(<RegisterForm {...mockProps} />);
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
    expect(screen.getByLabelText("Confirm Password")).toBeDefined();
  });

  it("submit button disabled when fields are empty", () => {
    render(<RegisterForm {...mockProps} />);
    const button = screen.getByRole("button", { name: "Create Account" });
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("shows password requirements when typing", () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "a" },
    });
    expect(screen.getByText("At least 12 characters")).toBeDefined();
    expect(screen.getByText("Uppercase letter")).toBeDefined();
    expect(screen.getByText("Lowercase letter")).toBeDefined();
    expect(screen.getByText("Number")).toBeDefined();
    expect(screen.getByText("Special character")).toBeDefined();
  });

  it("shows passwords do not match message", () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "StrongPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "Different" },
    });
    expect(screen.getByText("Passwords do not match")).toBeDefined();
  });

  it("enables submit when all requirements met", () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "StrongPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "StrongPass123!" },
    });
    const button = screen.getByRole("button", { name: "Create Account" });
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with email and password", async () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "StrongPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm Password"), {
      target: { value: "StrongPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Account" }));

    await waitFor(() => {
      expect(mockProps.onSubmit).toHaveBeenCalledWith(
        "test@example.com",
        "StrongPass123!"
      );
    });
  });

  it("displays error when error prop is set", () => {
    render(<RegisterForm {...mockProps} error="Email already in use" />);
    expect(screen.getByRole("alert").textContent).toBe("Email already in use");
  });

  it("calls onBackToLogin when sign in link clicked", () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.click(screen.getByText("Sign in"));
    expect(mockProps.onBackToLogin).toHaveBeenCalled();
  });

  it("has correct autocomplete attributes", () => {
    render(<RegisterForm {...mockProps} />);
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe(
      "new-password"
    );
  });
});
