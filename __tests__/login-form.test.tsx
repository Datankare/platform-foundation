/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LoginForm from "@/components/auth/LoginForm";
import { say } from "@/__tests__/helpers/auth-screen";

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

const email = () => screen.getByLabelText(say("login.email")) as HTMLInputElement;
const password = () => screen.getByLabelText(say("login.password")) as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: say("login.sign_in") });

describe("LoginForm", () => {
  it("renders email and password inputs, each with a visible label", () => {
    render(<LoginForm {...mockProps} />);
    expect(email()).toBeDefined();
    expect(password()).toBeDefined();
    expect(screen.getByText(say("login.email")).tagName).toBe("LABEL");
  });

  it("renders the configured SSO buttons and the divider", () => {
    render(<LoginForm {...mockProps} enabledSsoProviders={["google"]} />);
    expect(screen.getByText(say("sso.continue_with_google"))).toBeDefined();
    expect(screen.queryByText(say("sso.continue_with_apple"))).toBeNull();
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("renders no SSO buttons, and only the guest divider, when none are configured", () => {
    render(<LoginForm {...mockProps} />);
    expect(screen.queryByText(say("sso.continue_with_google"))).toBeNull();
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("renders guest option by default", () => {
    render(<LoginForm {...mockProps} />);
    expect(screen.getByText(say("login.continue_as_guest"))).toBeDefined();
  });

  it("hides guest option when showGuestOption is false", () => {
    render(<LoginForm {...mockProps} showGuestOption={false} />);
    expect(screen.queryByText(say("login.continue_as_guest"))).toBeNull();
  });

  it("submit button is disabled when fields are empty", () => {
    render(<LoginForm {...mockProps} />);
    expect(submit().getAttribute("disabled")).not.toBeNull();
  });

  it("calls onSubmit with email and password on form submit", async () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.change(email(), { target: { value: " test@example.com " } });
    fireEvent.change(password(), { target: { value: "password123" } });
    expect(submit().getAttribute("disabled")).toBeNull();
    fireEvent.click(submit());
    await waitFor(() =>
      expect(mockProps.onSubmit).toHaveBeenCalledWith("test@example.com", "password123")
    );
  });

  it("a refusal is announced and describes the form, and marks no field (it never says which was wrong)", () => {
    render(<LoginForm {...mockProps} error="Email or password is incorrect." />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Email or password is incorrect.");
    expect(alert.closest("form")?.getAttribute("aria-describedby")).toBe(alert.id);
    expect(email().getAttribute("aria-invalid")).toBeNull();
    expect(password().getAttribute("aria-invalid")).toBeNull();
  });

  it("SF-app-040: starts with the address it is given and says what happened", () => {
    render(
      <LoginForm {...mockProps} initialEmail="new@example.com" notice="Verified." />
    );
    expect(email().value).toBe("new@example.com");
    expect(screen.getByRole("status").textContent).toBe("Verified.");
  });

  it("a notice gives way to a refusal", () => {
    render(<LoginForm {...mockProps} notice="Verified." error="No." />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("No.");
  });

  it("calls onForgotPassword when forgot password link clicked", () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("login.forgot_password")));
    expect(mockProps.onForgotPassword).toHaveBeenCalled();
  });

  it("calls onCreateAccount when create account link clicked", () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    expect(mockProps.onCreateAccount).toHaveBeenCalled();
  });

  it("calls onGuestClick when guest button clicked", async () => {
    render(<LoginForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("login.continue_as_guest")));
    await waitFor(() => expect(mockProps.onGuestClick).toHaveBeenCalled());
  });

  it("no button inside or beside the form submits it by accident", () => {
    render(<LoginForm {...mockProps} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.filter((b) => b.getAttribute("type") === "submit")).toEqual([
      submit(),
    ]);
  });

  it("has correct autocomplete attributes for password managers", () => {
    render(<LoginForm {...mockProps} />);
    expect(email().getAttribute("autocomplete")).toBe("username");
    expect(password().getAttribute("autocomplete")).toBe("current-password");
  });
});
