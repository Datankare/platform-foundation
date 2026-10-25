/**
 * @jest-environment jsdom
 */
/**
 * components/admin/MfaEnrollment — a staff member without a second factor can set one up from
 * the console that refused them (audit A-9), instead of being locked out.
 */
import React from "react";
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import MfaEnrollment from "@/components/admin/MfaEnrollment";

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  localStorage.clear();
});

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const refused = (body: unknown) => ({ ok: false, status: 400, json: async () => body });

describe("MfaEnrollment", () => {
  it("enrols: the secret, then the first code, then asks to sign in again", async () => {
    const onSignOut = jest.fn();
    fetchMock
      .mockResolvedValueOnce(
        ok({ success: true, secretCode: "ABCDEF", qrCodeUri: "otpauth://x" })
      )
      .mockResolvedValueOnce(ok({ success: true, mfaEnabled: true }));
    render(<MfaEnrollment onSignOut={onSignOut} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() => expect(screen.getByText("ABCDEF")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/6-digit code/), {
      target: { value: "12a3456" },
    });
    expect(screen.getByLabelText(/6-digit code/)).toHaveValue("123456");
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() => expect(screen.getByText(/is on/)).toBeInTheDocument());
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/mfa/verify");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ code: "123456" });
    fireEvent.click(screen.getByText("Sign in again"));
    expect(onSignOut).toHaveBeenCalled();
  });

  it("shows the server's message when a code is not accepted, and stays on the code", async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ success: true, secretCode: "ABCDEF" }))
      .mockResolvedValueOnce(refused({ message: "That code is not correct." }));
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() => screen.getByLabelText(/6-digit code/));
    fireEvent.change(screen.getByLabelText(/6-digit code/), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByText("Confirm"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("not correct")
    );
    expect(screen.getByText("Confirm")).toBeInTheDocument();
  });
});
