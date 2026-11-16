/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import RegisterForm from "@/components/auth/RegisterForm";
import { BUILT_IN_RULES } from "@/components/auth/ui/usePasswordPolicy";
import { STRONG, say, typeNewPassword } from "@/__tests__/helpers/auth-screen";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onBackToLogin: jest.fn(),
  policy: BUILT_IN_RULES,
};

beforeEach(() => {
  jest.clearAllMocks();
});

const submit = () => screen.getByRole("button", { name: say("register.create_account") });
const type = (password: string, confirm = password) =>
  typeNewPassword(
    say("register.password"),
    say("register.confirm_password"),
    password,
    confirm
  );

describe("RegisterForm", () => {
  it("renders email, password, and confirm password inputs", () => {
    render(<RegisterForm {...mockProps} />);
    expect(screen.getByLabelText(say("register.email"))).toBeDefined();
    expect(screen.getByLabelText(say("register.password"))).toBeDefined();
    expect(screen.getByLabelText(say("register.confirm_password"))).toBeDefined();
  });

  it("submit button disabled when fields are empty", () => {
    render(<RegisterForm {...mockProps} />);
    expect(submit().getAttribute("disabled")).not.toBeNull();
  });

  it("states the policy's rules before anything is typed, as the password field's help", () => {
    render(<RegisterForm {...mockProps} />);
    const field = screen.getByLabelText(say("register.password"));
    const help = document.getElementById(field.getAttribute("aria-describedby")!)!;
    for (const key of ["uppercase", "lowercase", "number", "special", "not_common"])
      expect(help.textContent).toContain(say(`password_rules.${key}`));
    expect(help.textContent).toContain(
      say("password_rules.at_least_characters", { count: BUILT_IN_RULES.minLength })
    );
  });

  it("says when the passwords do not match: announced, the field marked", () => {
    render(<RegisterForm {...mockProps} />);
    type(STRONG, "Different");
    const confirm = screen.getByLabelText(say("register.confirm_password"));
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(say("password_rules.do_not_match"));
    expect(confirm.getAttribute("aria-invalid")).toBe("true");
    expect(confirm.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("does not call a confirmation that is still a beginning of the password a mismatch", () => {
    render(<RegisterForm {...mockProps} />);
    type(STRONG, STRONG.slice(0, 5));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("enables submit only when every rule is met and the passwords match", () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText(say("register.email")), {
      target: { value: "test@example.com" },
    });
    type("password1234");
    expect(submit().getAttribute("disabled")).not.toBeNull();
    type(STRONG);
    expect(submit().getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with email and password", async () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.change(screen.getByLabelText(say("register.email")), {
      target: { value: "test@example.com" },
    });
    type(STRONG);
    fireEvent.click(submit());
    await waitFor(() =>
      expect(mockProps.onSubmit).toHaveBeenCalledWith("test@example.com", STRONG)
    );
  });

  it("displays error when error prop is set", () => {
    render(<RegisterForm {...mockProps} error="That did not work." />);
    expect(screen.getByRole("alert").textContent).toBe("That did not work.");
  });

  it("calls onBackToLogin when sign in link clicked", () => {
    render(<RegisterForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("register.sign_in")));
    expect(mockProps.onBackToLogin).toHaveBeenCalled();
  });

  it("has correct autocomplete attributes", () => {
    render(<RegisterForm {...mockProps} />);
    expect(
      screen.getByLabelText(say("register.email")).getAttribute("autocomplete")
    ).toBe("username");
    expect(
      screen.getByLabelText(say("register.password")).getAttribute("autocomplete")
    ).toBe("new-password");
  });
});
