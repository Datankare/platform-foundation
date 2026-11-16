/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MfaChallengeForm from "@/components/auth/MfaChallengeForm";
import { say } from "@/__tests__/helpers/auth-screen";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onCancel: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

const input = () =>
  screen.getByLabelText(say("mfa_challenge.code_label")) as HTMLInputElement;
const verify = () => screen.getByRole("button", { name: say("mfa_challenge.verify") });

describe("MfaChallengeForm", () => {
  it("is called two-step verification, as the console's enrolment calls it", () => {
    render(<MfaChallengeForm {...mockProps} />);
    expect(
      screen.getByRole("heading", {
        name: say("mfa_challenge.two_factor_authentication"),
      })
    ).toBeDefined();
    expect(say("mfa_challenge.two_factor_authentication")).toMatch(
      /two-step verification/i
    );
  });

  it("S8 accessibility: the code field is labelled (it had only a placeholder)", () => {
    render(<MfaChallengeForm {...mockProps} />);
    expect(input().id).toBe("mfa-code");
    expect(document.querySelector('label[for="mfa-code"]')?.textContent).toBe(
      say("mfa_challenge.code_label")
    );
  });

  it("only accepts numeric input, up to 6 digits", () => {
    render(<MfaChallengeForm {...mockProps} />);
    fireEvent.change(input(), { target: { value: "abc123" } });
    expect(input().value).toBe("123");
    fireEvent.change(input(), { target: { value: "12345678" } });
    expect(input().value).toBe("123456");
  });

  it("verify button disabled until 6 digits entered", () => {
    render(<MfaChallengeForm {...mockProps} />);
    expect(verify().getAttribute("disabled")).not.toBeNull();
    fireEvent.change(input(), { target: { value: "12345" } });
    expect(verify().getAttribute("disabled")).not.toBeNull();
    fireEvent.change(input(), { target: { value: "123456" } });
    expect(verify().getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with code on form submit", async () => {
    render(<MfaChallengeForm {...mockProps} />);
    fireEvent.change(input(), { target: { value: "123456" } });
    fireEvent.click(verify());
    await waitFor(() => expect(mockProps.onSubmit).toHaveBeenCalledWith("123456"));
  });

  it("a refusal is announced and describes the form", () => {
    render(<MfaChallengeForm {...mockProps} error="That code is not correct." />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("That code is not correct.");
    expect(alert.closest("form")?.getAttribute("aria-describedby")).toBe(alert.id);
  });

  it("calls onCancel when cancel link clicked", () => {
    render(<MfaChallengeForm {...mockProps} />);
    fireEvent.click(screen.getByText(say("mfa_challenge.cancel_sign_in")));
    expect(mockProps.onCancel).toHaveBeenCalled();
  });

  it("has correct autocomplete and inputMode attributes", () => {
    render(<MfaChallengeForm {...mockProps} />);
    expect(input().getAttribute("autocomplete")).toBe("one-time-code");
    expect(input().getAttribute("inputmode")).toBe("numeric");
  });
});
