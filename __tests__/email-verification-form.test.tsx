/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import EmailVerificationForm from "@/components/auth/EmailVerificationForm";
import { say } from "@/__tests__/helpers/auth-screen";

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

const input = () =>
  screen.getByLabelText(say("email_verification.code_label")) as HTMLInputElement;
const verify = () =>
  screen.getByRole("button", { name: say("email_verification.verify_email") });

describe("EmailVerificationForm", () => {
  it("displays the email address", () => {
    render(<EmailVerificationForm {...mockProps} />);
    expect(screen.getByText("test@example.com")).toBeDefined();
  });

  it("renders its heading and verify button", () => {
    render(<EmailVerificationForm {...mockProps} />);
    expect(
      screen.getByRole("heading", { name: say("email_verification.verify_your_email") })
    ).toBeDefined();
    expect(verify()).toBeDefined();
  });

  it("S8 accessibility: the code field is labelled (it had only a placeholder)", () => {
    render(<EmailVerificationForm {...mockProps} />);
    expect(input().id).toBe("verify-code");
  });

  it("only accepts numeric input", () => {
    render(<EmailVerificationForm {...mockProps} />);
    fireEvent.change(input(), { target: { value: "abc123" } });
    expect(input().value).toBe("123");
  });

  it("verify button disabled until 6 digits entered", () => {
    render(<EmailVerificationForm {...mockProps} />);
    expect(verify().getAttribute("disabled")).not.toBeNull();
    fireEvent.change(input(), { target: { value: "123456" } });
    expect(verify().getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with code", async () => {
    render(<EmailVerificationForm {...mockProps} />);
    fireEvent.change(input(), { target: { value: "123456" } });
    fireEvent.click(verify());
    await waitFor(() => expect(mockProps.onSubmit).toHaveBeenCalledWith("123456"));
  });

  it("shows resend cooldown after clicking resend", async () => {
    render(<EmailVerificationForm {...mockProps} />);
    await act(async () => {
      fireEvent.click(
        screen.getByText(say("email_verification.resend_verification_code"))
      );
    });
    expect(mockProps.onResend).toHaveBeenCalled();
    expect(
      screen.getByText(say("email_verification.resend_in", { seconds: 60 }))
    ).toBeDefined();
    for (let i = 0; i < 10; i++)
      act(() => {
        jest.advanceTimersByTime(1000);
      });
    expect(
      screen.getByText(say("email_verification.resend_in", { seconds: 50 }))
    ).toBeDefined();
  });

  it("displays error when error prop is set", () => {
    render(<EmailVerificationForm {...mockProps} error="That code is not correct." />);
    expect(screen.getByRole("alert").textContent).toBe("That code is not correct.");
  });

  it("calls onBackToLogin when back link clicked", () => {
    render(<EmailVerificationForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("email_verification.back_to_sign_in")));
    expect(mockProps.onBackToLogin).toHaveBeenCalled();
  });
});
