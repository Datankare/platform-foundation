/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NewPasswordForm from "@/components/auth/NewPasswordForm";
import { BUILT_IN_RULES } from "@/components/auth/ui/usePasswordPolicy";
import { STRONG, say, typeNewPassword } from "@/__tests__/helpers/auth-screen";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onCancel: jest.fn(),
  policy: BUILT_IN_RULES,
};

beforeEach(() => {
  jest.clearAllMocks();
});

const field = (key: string) =>
  screen.getByLabelText(say(`new_password.${key}`)) as HTMLInputElement;
const button = () =>
  screen.getByRole("button", { name: say("new_password.set_password_continue") });
const type = (password: string, confirm = password) =>
  typeNewPassword(
    say("new_password.new_password"),
    say("new_password.confirm_new_password"),
    password,
    confirm
  );

describe("NewPasswordForm", () => {
  it("SF-app-045: both fields have a label a sighted person reads, not a placeholder that vanishes", () => {
    render(<NewPasswordForm {...mockProps} />);
    for (const key of ["new_password", "confirm_new_password"]) {
      const label = document.querySelector(`label[for="${field(key).id}"]`)!;
      expect(label.textContent).toBe(say(`new_password.${key}`));
      expect(label.className).not.toMatch(/\bsr-only\b/);
      expect(field(key).getAttribute("placeholder")).toBeNull();
    }
  });

  it("E-112: keeps submit disabled until the server's policy is met and the password confirmed", () => {
    render(<NewPasswordForm {...mockProps} />);
    expect(button().getAttribute("disabled")).not.toBeNull();
    // Eight characters were enough here before; the policy asks for more.
    type("StrongP1");
    expect(button().getAttribute("disabled")).not.toBeNull();
    type(STRONG, "Different-Horse-9");
    expect(button().getAttribute("disabled")).not.toBeNull();
    type(STRONG);
    expect(button().getAttribute("disabled")).toBeNull();
  });

  it("states the policy's rules as the password field's help, each met or not met in words", () => {
    render(<NewPasswordForm {...mockProps} />);
    type("abc");
    const help = document.getElementById(
      field("new_password").getAttribute("aria-describedby")!
    )!;
    expect(help.textContent).toContain(
      say("password_rules.at_least_characters", { count: BUILT_IN_RULES.minLength })
    );
    expect(help.textContent).toContain(say("password_rules.not_met"));
    expect(help.textContent).toContain(say("password_rules.met"));
  });

  it("says when the passwords do not match, as the confirmation's error", () => {
    render(<NewPasswordForm {...mockProps} />);
    type(STRONG, "Different-Horse-9");
    expect(screen.getByRole("alert").textContent).toBe(
      say("password_rules.do_not_match")
    );
    expect(field("confirm_new_password").getAttribute("aria-invalid")).toBe("true");
  });

  it("calls onSubmit with the new password on submit", async () => {
    render(<NewPasswordForm {...mockProps} />);
    type(STRONG);
    fireEvent.click(button());
    await waitFor(() => expect(mockProps.onSubmit).toHaveBeenCalledWith(STRONG));
  });

  it("displays an error when the error prop is set", () => {
    render(<NewPasswordForm {...mockProps} error="Password change failed" />);
    expect(screen.getByRole("alert").textContent).toBe("Password change failed");
  });

  it("disables the field and shows progress text while loading", () => {
    render(<NewPasswordForm {...mockProps} isLoading />);
    expect(screen.getByText(say("new_password.setting_password"))).toBeDefined();
    expect(field("new_password").disabled).toBe(true);
  });

  it("calls onCancel when the cancel link is clicked", () => {
    render(<NewPasswordForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("new_password.cancel_sign_in")));
    expect(mockProps.onCancel).toHaveBeenCalled();
  });

  it("uses new-password autocomplete on both inputs", () => {
    render(<NewPasswordForm {...mockProps} />);
    expect(field("new_password").getAttribute("autocomplete")).toBe("new-password");
    expect(field("confirm_new_password").getAttribute("autocomplete")).toBe(
      "new-password"
    );
  });
});
