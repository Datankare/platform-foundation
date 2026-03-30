/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ForgotPasswordForm from "@/components/auth/ForgotPasswordForm";

const mockProps = {
  onSendCode: jest.fn().mockResolvedValue(undefined),
  onConfirmReset: jest.fn().mockResolvedValue(undefined),
  onBackToLogin: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("ForgotPasswordForm", () => {
  it("starts on email step", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    expect(screen.getByText("Reset Password")).toBeDefined();
    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByText("Send Reset Code")).toBeDefined();
  });

  it("send button disabled when email is empty", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    const button = screen.getByText("Send Reset Code");
    expect(button.getAttribute("disabled")).not.toBeNull();
  });

  it("calls onSendCode and advances to code step", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send Reset Code"));

    await waitFor(() => {
      expect(mockProps.onSendCode).toHaveBeenCalledWith("test@example.com");
    });

    // Should now show code step
    await waitFor(() => {
      expect(screen.getByLabelText("Verification Code")).toBeDefined();
      expect(screen.getByLabelText("New Password")).toBeDefined();
      expect(screen.getByLabelText("Confirm New Password")).toBeDefined();
    });
  });

  it("shows passwords do not match on code step", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    // Advance to code step
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText("Send Reset Code"));

    await waitFor(() => {
      expect(screen.getByLabelText("New Password")).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "NewStrongPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "Different" },
    });
    expect(screen.getByText("Passwords do not match")).toBeDefined();
  });

  it("displays error when error prop is set", () => {
    render(<ForgotPasswordForm {...mockProps} error="User not found" />);
    expect(screen.getByRole("alert").textContent).toBe("User not found");
  });

  it("calls onBackToLogin when back link clicked", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    fireEvent.click(screen.getByText("Back to Sign In"));
    expect(mockProps.onBackToLogin).toHaveBeenCalled();
  });

  it("has correct autocomplete on email field", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    expect(screen.getByLabelText("Email").getAttribute("autocomplete")).toBe("username");
  });
});
