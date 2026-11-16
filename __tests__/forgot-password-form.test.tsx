/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ForgotPasswordForm, {
  RESEND_WAIT_SECONDS,
} from "@/components/auth/ForgotPasswordForm";
import { BUILT_IN_RULES } from "@/components/auth/ui/usePasswordPolicy";
import { STRONG, say, typeNewPassword } from "@/__tests__/helpers/auth-screen";

const mockProps = {
  onSendCode: jest.fn().mockResolvedValue(true),
  onConfirmReset: jest.fn().mockResolvedValue(true),
  onResetDone: jest.fn(),
  onBackToLogin: jest.fn(),
  policy: BUILT_IN_RULES,
};

beforeEach(() => {
  jest.clearAllMocks();
});

const sendTo = async (address = "test@example.com") => {
  fireEvent.change(screen.getByLabelText(say("forgot_password.email")), {
    target: { value: address },
  });
  fireEvent.click(screen.getByText(say("forgot_password.send_reset_code")));
  await screen.findByLabelText(say("forgot_password.reset_code"));
};
const typeReset = (code = "123456", password = STRONG, confirm = password) => {
  fireEvent.change(screen.getByLabelText(say("forgot_password.reset_code")), {
    target: { value: code },
  });
  typeNewPassword(
    say("forgot_password.new_password"),
    say("forgot_password.confirm_new_password"),
    password,
    confirm
  );
};
const resetButton = () =>
  screen.getByRole("button", { name: say("forgot_password.reset_password") });

describe("ForgotPasswordForm", () => {
  it("starts on email step", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    expect(
      screen.getByRole("heading", { name: say("forgot_password.reset_password") })
    ).toBeDefined();
    expect(screen.getByLabelText(say("forgot_password.email"))).toBeDefined();
  });

  it("send button disabled when email is empty", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    expect(
      screen.getByText(say("forgot_password.send_reset_code")).getAttribute("disabled")
    ).not.toBeNull();
  });

  it("calls onSendCode and advances to code step", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    await sendTo();
    expect(mockProps.onSendCode).toHaveBeenCalledWith("test@example.com");
    expect(screen.getByLabelText(say("forgot_password.new_password"))).toBeDefined();
    expect(
      screen.getByLabelText(say("forgot_password.confirm_new_password"))
    ).toBeDefined();
  });

  it("SF-app-044: the code step names the address — never saying an account has it — and calls the code a reset code", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    await sendTo("someone@example.com");
    expect(
      screen.getByText(
        say("forgot_password.sent_code_to", { email: "someone@example.com" })
      )
    ).toBeDefined();
    expect(say("forgot_password.sent_code_to", { email: "x" })).toMatch(/^If /);
    expect(screen.getByLabelText(say("forgot_password.reset_code"))).toBeDefined();
  });

  it("SF-app-041: the code step's heading takes focus, and the address step's again — even on a page opened on this step", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    const heading = () =>
      screen.getByRole("heading", {
        level: 2,
        name: say("forgot_password.reset_password"),
      });
    expect(document.activeElement).not.toBe(heading());
    await sendTo();
    expect(document.activeElement).toBe(heading());
    fireEvent.click(
      screen.getByRole("button", { name: say("forgot_password.use_another_address") })
    );
    expect(document.activeElement).toBe(heading());
  });

  it("SF-app-044: a new code after the wait, to the same address, said as 'if'", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    try {
      render(<ForgotPasswordForm {...mockProps} />);
      await sendTo("someone@example.com");
      const wait = say("forgot_password.resend_in", { seconds: RESEND_WAIT_SECONDS });
      expect(screen.getByText(wait).closest("button")?.disabled).toBe(true);
      for (let i = 0; i < RESEND_WAIT_SECONDS; i++)
        act(() => {
          jest.advanceTimersByTime(1000);
        });
      await act(async () => {
        fireEvent.click(screen.getByText(say("forgot_password.resend_code")));
      });
      expect(mockProps.onSendCode).toHaveBeenLastCalledWith("someone@example.com");
      expect(mockProps.onSendCode).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status").textContent).toBe(
        say("forgot_password.code_resent", { email: "someone@example.com" })
      );
      expect(screen.getByText(wait)).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it("SF-app-044: a refused new code starts no wait", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "queueMicrotask"] });
    try {
      const onSendCode = jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      render(<ForgotPasswordForm {...mockProps} onSendCode={onSendCode} />);
      await sendTo();
      for (let i = 0; i < RESEND_WAIT_SECONDS; i++)
        act(() => {
          jest.advanceTimersByTime(1000);
        });
      await act(async () => {
        fireEvent.click(screen.getByText(say("forgot_password.resend_code")));
      });
      expect(screen.getByText(say("forgot_password.resend_code"))).toBeDefined();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it("SF-app-044: another address goes back to the first step, the address kept to correct", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    await sendTo("typo@example.con");
    fireEvent.click(screen.getByText(say("forgot_password.use_another_address")));
    const field = screen.getByLabelText(say("forgot_password.email")) as HTMLInputElement;
    expect(field.value).toBe("typo@example.con");
    expect(screen.queryByLabelText(say("forgot_password.reset_code"))).toBeNull();
  });

  it("says when the passwords do not match, as the field's error", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    await sendTo();
    typeReset("123456", STRONG, "Different");
    expect(screen.getByRole("alert").textContent).toBe(
      say("password_rules.do_not_match")
    );
  });

  it("states the server's policy for the new password (E-112)", async () => {
    render(
      <ForgotPasswordForm
        {...mockProps}
        policy={{ ...BUILT_IN_RULES, minLength: 20, requireSpecial: false }}
      />
    );
    await sendTo();
    expect(
      screen.getByText(say("password_rules.at_least_characters", { count: 20 }))
    ).toBeDefined();
    expect(screen.queryByText(say("password_rules.special"))).toBeNull();
    // Fifteen characters: enough for the built-in 12, not for this policy's 20.
    typeReset("123456", "Fifteen-Horse-9");
    expect(resetButton().getAttribute("disabled")).not.toBeNull();
    typeReset("123456", "Twenty-Long-Horses-99");
    expect(resetButton().getAttribute("disabled")).toBeNull();
  });

  it("resets only with a six-digit code and a password the policy accepts", async () => {
    render(<ForgotPasswordForm {...mockProps} />);
    await sendTo();
    typeReset("12345", STRONG);
    expect(resetButton().getAttribute("disabled")).not.toBeNull();
    typeReset("123456", "a-long-password-1");
    expect(resetButton().getAttribute("disabled")).not.toBeNull();
    typeReset("123456", STRONG);
    expect(resetButton().getAttribute("disabled")).toBeNull();
    fireEvent.click(resetButton());
    await waitFor(() =>
      expect(mockProps.onConfirmReset).toHaveBeenCalledWith(
        "test@example.com",
        "123456",
        STRONG
      )
    );
    expect(mockProps.onResetDone).toHaveBeenCalledWith("test@example.com");
  });

  it("displays error when error prop is set", () => {
    render(<ForgotPasswordForm {...mockProps} error="Too many requests." />);
    expect(screen.getByRole("alert").textContent).toBe("Too many requests.");
  });

  it("calls onBackToLogin when back link clicked", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("forgot_password.back_to_sign_in")));
    expect(mockProps.onBackToLogin).toHaveBeenCalled();
  });

  it("has correct autocomplete on email field", () => {
    render(<ForgotPasswordForm {...mockProps} />);
    expect(
      screen.getByLabelText(say("forgot_password.email")).getAttribute("autocomplete")
    ).toBe("username");
  });

  // TASK-181: each step advances only on the server's success.
  it("stays on the email step when the code was not sent", async () => {
    const onSendCode = jest.fn().mockResolvedValue(false);
    render(<ForgotPasswordForm {...mockProps} onSendCode={onSendCode} />);
    fireEvent.change(screen.getByLabelText(say("forgot_password.email")), {
      target: { value: "test@example.com" },
    });
    fireEvent.click(screen.getByText(say("forgot_password.send_reset_code")));
    await waitFor(() => expect(onSendCode).toHaveBeenCalled());
    expect(screen.queryByLabelText(say("forgot_password.reset_code"))).toBeNull();
  });

  it("stays on the code step when the reset was refused", async () => {
    const onConfirmReset = jest.fn().mockResolvedValue(false);
    render(<ForgotPasswordForm {...mockProps} onConfirmReset={onConfirmReset} />);
    await sendTo();
    typeReset();
    fireEvent.click(resetButton());
    await waitFor(() => expect(onConfirmReset).toHaveBeenCalled());
    expect(mockProps.onResetDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText(say("forgot_password.reset_code"))).toBeDefined();
  });
});
