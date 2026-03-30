/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import MfaChallengeForm from "@/components/auth/MfaChallengeForm";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onCancel: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("MfaChallengeForm", () => {
  it("renders code input and verify button", () => {
    render(<MfaChallengeForm {...mockProps} />);
    expect(screen.getByText("Two-Factor Authentication")).toBeDefined();
    expect(screen.getByText("Verify")).toBeDefined();
  });

  it("only accepts numeric input", () => {
    render(<MfaChallengeForm {...mockProps} />);
    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "abc123" } });
    expect((input as HTMLInputElement).value).toBe("123");
  });

  it("limits input to 6 digits", () => {
    render(<MfaChallengeForm {...mockProps} />);
    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "12345678" } });
    expect((input as HTMLInputElement).value).toBe("123456");
  });

  it("verify button disabled until 6 digits entered", () => {
    render(<MfaChallengeForm {...mockProps} />);
    const button = screen.getByText("Verify");
    expect(button.getAttribute("disabled")).not.toBeNull();

    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "12345" } });
    expect(button.getAttribute("disabled")).not.toBeNull();

    fireEvent.change(input, { target: { value: "123456" } });
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("calls onSubmit with code on form submit", async () => {
    render(<MfaChallengeForm {...mockProps} />);
    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByText("Verify"));

    await waitFor(() => {
      expect(mockProps.onSubmit).toHaveBeenCalledWith("123456");
    });
  });

  it("displays error when error prop is set", () => {
    render(<MfaChallengeForm {...mockProps} error="Invalid code" />);
    expect(screen.getByRole("alert").textContent).toBe("Invalid code");
  });

  it("calls onCancel when cancel link clicked", () => {
    render(<MfaChallengeForm {...mockProps} />);
    fireEvent.click(screen.getByText("Cancel sign-in"));
    expect(mockProps.onCancel).toHaveBeenCalled();
  });

  it("has correct autocomplete and inputMode attributes", () => {
    render(<MfaChallengeForm {...mockProps} />);
    const input = screen.getByPlaceholderText("000000");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
  });
});
