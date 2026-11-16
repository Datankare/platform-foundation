/**
 * @jest-environment jsdom
 */
/**
 * __tests__/mfa-enrollment.test.tsx — staff two-step enrolment on the console's shared parts
 * (audit A-9, TASK-180; TASK-221, SF-admin-150 to 152)
 *
 * Fed the routes' own answers (__tests__/fixtures/route-responses.json).
 */
import { renderMessage } from "@/platform/errors/messages";
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import MfaEnrollment from "@/components/admin/MfaEnrollment";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

const fetchMock = jest.fn();
beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});
beforeEach(() => fetchMock.mockReset());

function reply(name: string) {
  const [status, body] = routeAnswer(name as RouteFixtureName);
  return {
    ok: status < 400,
    status,
    json: async () => body,
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}
function answers(...list: (string | Error)[]) {
  let i = 0;
  fetchMock.mockImplementation(async () => {
    const next = list[Math.min(i++, list.length - 1)]!;
    if (next instanceof Error) throw next;
    return reply(next);
  });
}
const t = (key: string) => renderMessage(`screens.mfa.${key}`);

async function toCode() {
  fireEvent.click(screen.getByRole("button", { name: t("start") }));
  return screen.findByLabelText(t("code_label"));
}

describe("MfaEnrollment", () => {
  it("[SF-admin-151] is the page's main landmark, and offers sign-out at every step", async () => {
    const signOut = jest.fn();
    answers("POST /api/auth/mfa/setup — the secret and its URI");
    render(<MfaEnrollment onSignOut={signOut} />);
    expect(screen.getByRole("main", { name: t("title") })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: t("sign_out") }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await toCode();
    fireEvent.click(screen.getByRole("button", { name: t("sign_out") }));
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it("draws the QR code and keeps the key hidden until asked; the key is shown to copy exactly", async () => {
    answers("POST /api/auth/mfa/setup — the secret and its URI");
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    await toCode();
    expect(screen.getByRole("img", { name: t("qr_label") })).toBeDefined();
    expect(document.querySelector("[data-secret-text]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("show_key") }));
    expect(document.querySelector("[data-secret-text]")).not.toBeNull();
  });

  it("[SF-admin-151] the code is a form: Enter sends it; a short code is said at its field", async () => {
    answers(
      "POST /api/auth/mfa/setup — the secret and its URI",
      "POST /api/auth/mfa/verify — enabled"
    );
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    const code = await toCode();
    fireEvent.change(code, { target: { value: "12" } });
    fireEvent.submit(screen.getByRole("form", { name: t("code_form") }));
    expect(code).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("form", { name: t("code_form") }));
    expect(await screen.findByText(t("done"))).toBeDefined();
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/auth/mfa/verify");
    expect(JSON.parse(String(init.body))).toEqual({ code: "123456" });
  });

  it("[SF-admin-150] a confirm that gets no answer is said — never silence", async () => {
    answers("POST /api/auth/mfa/setup — the secret and its URI", new Error("offline"));
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    const code = await toCode();
    fireEvent.change(code, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: t("confirm") }));
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
    // The button works again.
    expect(screen.getByRole("button", { name: t("confirm") })).toBeEnabled();
  });

  it("a wrong code is said as the route says it", async () => {
    answers(
      "POST /api/auth/mfa/setup — the secret and its URI",
      "POST /api/auth/mfa/verify — refused (the code is wrong)"
    );
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    const code = await toCode();
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: t("confirm") }));
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
  });

  it("[SF-admin-152] authenticator apps turned off: said in plain words, never 'software-token MFA' or 'user pool'", async () => {
    answers("POST /api/auth/mfa/setup — refused (authenticator MFA off for the pool)");
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("start") }));
    expect(await screen.findByText(t("not_configured"))).toBeDefined();
    for (const jargon of [/software-token/i, /user pool/i, /\bMFA\b/])
      expect(t("not_configured")).not.toMatch(jargon);
    // One name for the second step, here and at sign-in.
    expect(renderMessage("screens.auth.mfa_challenge.two_factor_authentication")).toBe(
      "Two-step verification"
    );
  });

  it("a setup that gets no answer is said, and the start works again", async () => {
    answers(new Error("offline"));
    render(<MfaEnrollment onSignOut={jest.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: t("start") }));
    await waitFor(() =>
      expect(document.querySelector("[data-outcome='refused']")).not.toBeNull()
    );
    expect(screen.getByRole("button", { name: t("start") })).toBeEnabled();
  });
});
