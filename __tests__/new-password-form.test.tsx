/**
 * @jest-environment jsdom
 */

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import NewPasswordForm from "@/components/auth/NewPasswordForm";

const mockProps = {
  onSubmit: jest.fn().mockResolvedValue(undefined),
  onCancel: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("NewPasswordForm", () => {
  it("renders both password fields and the submit button", () => {
    render(<NewPasswordForm {...mockProps} />);
    expect(screen.getByText("Set a New Password")).toBeDefined();
    expect(screen.getByPlaceholderText("New password")).toBeDefined();
    expect(screen.getByPlaceholderText("Confirm new password")).toBeDefined();
    expect(screen.getByRole("button", { name: /set password/i })).toBeDefined();
  });

  it("keeps submit disabled until the password is valid and confirmed", () => {
    render(<NewPasswordForm {...mockProps} />);
    const button = screen.getByRole("button", { name: /set password/i });
    const pw = screen.getByPlaceholderText("New password");
    const confirm = screen.getByPlaceholderText("Confirm new password");

    expect(button.getAttribute("disabled")).not.toBeNull();

    // too short
    fireEvent.change(pw, { target: { value: "abc" } });
    fireEvent.change(confirm, { target: { value: "abc" } });
    expect(button.getAttribute("disabled")).not.toBeNull();

    // long enough but mismatched
    fireEvent.change(pw, { target: { value: "StrongPass1" } });
    fireEvent.change(confirm, { target: { value: "Different1" } });
    expect(button.getAttribute("disabled")).not.toBeNull();

    // valid and matching
    fireEvent.change(confirm, { target: { value: "StrongPass1" } });
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("shows a hint when the password is too short", () => {
    render(<NewPasswordForm {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("New password"), {
      target: { value: "abc" },
    });
    expect(screen.getByText("Password must be at least 8 characters.")).toBeDefined();
  });

  it("shows a hint when the passwords do not match", () => {
    render(<NewPasswordForm {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("New password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "Different1" },
    });
    expect(screen.getByText("Passwords do not match.")).toBeDefined();
  });

  it("calls onSubmit with the new password on submit", async () => {
    render(<NewPasswordForm {...mockProps} />);
    fireEvent.change(screen.getByPlaceholderText("New password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.change(screen.getByPlaceholderText("Confirm new password"), {
      target: { value: "StrongPass1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(mockProps.onSubmit).toHaveBeenCalledWith("StrongPass1");
    });
  });

  it("displays an error when the error prop is set", () => {
    render(<NewPasswordForm {...mockProps} error="Password change failed" />);
    expect(screen.getByRole("alert").textContent).toBe("Password change failed");
  });

  it("disables the field and shows progress text while loading", () => {
    render(<NewPasswordForm {...mockProps} isLoading />);
    expect(screen.getByText("Setting password...")).toBeDefined();
    expect(
      (screen.getByPlaceholderText("New password") as HTMLInputElement).disabled
    ).toBe(true);
  });

  it("calls onCancel when the cancel link is clicked", () => {
    render(<NewPasswordForm {...mockProps} />);
    fireEvent.click(screen.getByText("Cancel sign-in"));
    expect(mockProps.onCancel).toHaveBeenCalled();
  });

  it("uses new-password autocomplete on both inputs", () => {
    render(<NewPasswordForm {...mockProps} />);
    expect(screen.getByPlaceholderText("New password").getAttribute("autocomplete")).toBe(
      "new-password"
    );
    expect(
      screen.getByPlaceholderText("Confirm new password").getAttribute("autocomplete")
    ).toBe("new-password");
  });
});
