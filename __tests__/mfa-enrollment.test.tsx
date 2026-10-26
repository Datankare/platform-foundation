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
import qrcode from "qrcode-generator";
import MfaEnrollment from "@/components/admin/MfaEnrollment";

jest.mock("qrcode-generator", () => {
  const actual = jest.requireActual("qrcode-generator");
  const factory = jest.fn(actual);
  return Object.assign(factory, actual);
});
const qrFactory = qrcode as unknown as jest.Mock;
const realQrcode = jest.requireActual<typeof qrcode>("qrcode-generator");

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  qrFactory.mockClear();
  qrFactory.mockImplementation(realQrcode);
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
    await waitFor(() => screen.getByLabelText(/6-digit code/));
    fireEvent.click(screen.getByText("Can't scan? Show key"));
    expect(screen.getByText("ABCDEF")).toBeInTheDocument();
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

  const URI =
    "otpauth://totp/PlatformFoundation?secret=JBSWY3DPEHPK3PXP&issuer=PlatformFoundation";

  it("draws the setup URI as a QR code and keeps the key hidden until asked for", async () => {
    fetchMock.mockResolvedValueOnce(
      ok({ success: true, secretCode: "JBSWY3DPEHPK3PXP", qrCodeUri: URI })
    );
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => {})
    );
    const { container } = render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    const img = await screen.findByRole("img", { name: /QR code/ });

    // The modules drawn are the encoder's own for exactly the URI setup returned.
    const ref = realQrcode(0, "M");
    ref.addData(URI);
    ref.make();
    const n = ref.getModuleCount();
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (ref.isDark(r, c)) dark++;
    expect(img.getAttribute("viewBox")).toBe(`0 0 ${n + 8} ${n + 8}`);
    const d = img.querySelector("path")?.getAttribute("d") ?? "";
    expect(d.match(/M/g)).toHaveLength(dark);
    expect(d.startsWith("M")).toBe(true);
    expect(qrFactory).toHaveBeenCalledTimes(1);

    // Neither the secret nor the URI is on screen (or in markup) until "Show key".
    expect(container.innerHTML).not.toContain("JBSWY3DPEHPK3PXP");
    const toggle = screen.getByText("Can't scan? Show key");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(screen.getByText(URI)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Hide key"));
    expect(container.innerHTML).not.toContain("JBSWY3DPEHPK3PXP");

    // Only the setup call went out; nothing carrying the secret was logged.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/mfa/setup");
    for (const spy of logs) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain("JBSWY3DPEHPK3PXP");
      spy.mockRestore();
    }
  });

  it("falls back to the key when the code cannot be drawn", async () => {
    qrFactory.mockImplementation(() => {
      throw new Error("code length overflow");
    });
    fetchMock.mockResolvedValueOnce(
      ok({ success: true, secretCode: "ABCDEF", qrCodeUri: URI })
    );
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("could not be drawn")
    );
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByText("Can't scan? Show key"));
    expect(screen.getByText("ABCDEF")).toBeInTheDocument();
  });

  it("draws no code when setup returns no URI, and the key is still behind the toggle", async () => {
    fetchMock.mockResolvedValueOnce(ok({ success: true, secretCode: "ABCDEF" }));
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() => screen.getByText("Can't scan? Show key"));
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("ABCDEF")).toBeNull();
  });

  it("shows the server's message when setup is refused, and a generic one when it cannot be reached", async () => {
    fetchMock.mockResolvedValueOnce(
      refused({ message: "Software tokens are not enabled." })
    );
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Software tokens are not enabled."
      )
    );
    expect(screen.queryByRole("img")).toBeNull();

    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Setup failed.")
    );
    expect(screen.getByText("Set up two-step verification")).not.toBeDisabled();
  });

  // TASK-181: a pool with authenticator MFA off answers feature.not_configured (501).
  it("says authenticator setup is off for the pool when the feature is not configured", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 501,
      json: async () => ({ code: "feature.not_configured", message: "Not available." }),
    });
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByText("Set up two-step verification"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        /turned off for this sign-in service/
      )
    );
  });
});
