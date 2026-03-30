/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import EmailVerificationForm from "@/components/auth/EmailVerificationForm";

const mockProps = {
  email: "test@example.com",
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onResend: jest.fn().mockResolvedValue(undefined),
  onBackToLogin: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("EmailVerificationForm", () => {
  it("displays the email address", () => {
    render(<EmailVerificationForm {...mockProps} />);
    expect(screen.getByText("test@example.com")).toBeDefined();
  });

  it("renders code input and verify button", () => {
    render(<EmailVerificationForm {...mockProps} />);
    expect(screen.getByText("Verify Your Email")).toBeDefined();
    expect(screen.getByText("Verify Email")).toBeDefined();
  });

  it("only accepts numeric input", () => {
    render(<EmailVerificationForm {...mockProps} />);
    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "abc123" } });
    expect((input as HTMLInputElement).value).toBe("123");
  });

  it("verify button disabled until 6 digits entered", () => {
    render(<EmailVerificationForm {...mockProps} />);
    const button = screen.getByText("Verify Email");
    expect(button.getAttribute("disabled")).not.toBeNull();

    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "123456" } });
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with code", async () => {
    render(<EmailVerificationForm {...mockProps} />);
    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify Email"));

    await waitFor(() => {
      expect(mockProps.onSubmit).toHaveBeenCalledWith("123456");
    });
  });

  it("shows resend cooldown after clicking resend", async () => {
    render(<EmailVerificationForm {...mockProps} />);
    const resendButton = screen.getByText("Resend verification code");

    await act(async () => {
      fireEvent.click(resendButton);
    });

    expect(mockProps.onResend).toHaveBeenCalled();
    expect(screen.getByText("Resend code in 60s")).toBeDefined();

    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(screen.getByText(/Resend code in \d+s/)).toBeDefined();
  });

  it("displays error when error prop is set", () => {
    render(<EmailVerificationForm {...mockProps} error="Invalid code" />);
    expect(screen.getByRole("alert").textContent).toBe("Invalid code");
  });

  it("calls onBackToLogin when back link clicked", () => {
    render(<EmailVerificationForm {...mockProps} />);
    fireEvent.click(screen.getByText("Back to Sign In"));
    expect(mockProps.onBackToLogin).toHaveBeenCalled();
  });
});
