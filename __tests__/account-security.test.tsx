/** @jest-environment jsdom */
/**
 * __tests__/account-security.test.tsx — changing the password and two-step verification from the
 * account page (TASK-225, E-126)
 *
 * components/account/SignInSecurity.tsx, answered with each route's own answers
 * (__tests__/fixtures/route-responses.json): how the account signs in is read, and a read that
 * fails is never shown as "off"; Change password asks first, then sends the code to the account's
 * own address through the reset route, then the code and the new password — every device signed
 * out after; two-step verification is turned on (the secret drawn, the first code confirmed, the
 * session's new forgery token taken) and off (asked first, with the password and a current code —
 * the server's step-up); a provider's account manages neither here; a refusal is said in its own
 * words and changes nothing.
 *
 * hostile:role a provider's (single sign-on) account is offered no password or factor change
 * hostile:self n/a: every call is the session's own account; the page sends no account id
 * hostile:store-down the read refused or unanswered: said, with "Try again" — never "off"
 * hostile:id-spelling n/a: no id is read or sent
 */
import React from "react";
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import { renderMessage } from "@/platform/errors/messages";

const mockNoteCsrf = jest.fn();
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({ user: { email: "me@example.test" } }),
  noteCsrfToken: (token: string) => mockNoteCsrf(token),
}));

import SignInSecurity, { readSecurity } from "@/components/account/SignInSecurity";

const t = (key: string, values?: Record<string, string>) =>
  renderMessage(`screens.account.security.${key}`, values);

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const answers = new Map<string, RouteFixtureName | "network">();

/** fetch answered by route, each with its own fixture; every call kept. */
function routes(map: Record<string, RouteFixtureName | "network">) {
  answers.clear();
  for (const [k, v] of Object.entries(map)) answers.set(k, v);
  global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({
      url: String(url),
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const name = answers.get(`${method} ${url}`);
    if (!name) throw new Error(`no answer for ${method} ${url}`);
    if (name === "network") throw new TypeError("network down");
    const [status, body] = routeAnswer(name);
    return { ok: status < 300, status, json: async () => body } as Response;
  }) as unknown as typeof fetch;
}

const ON = "GET /api/account/security — signed in, two-step verification on";
const OFF = "GET /api/account/security — signed in, two-step verification off";
const SSO =
  "GET /api/account/security — a single sign-on session, the provider not saying";

beforeEach(() => {
  calls.length = 0;
  mockNoteCsrf.mockReset();
});

async function shown() {
  render(<SignInSecurity />);
  await waitFor(() =>
    expect(screen.queryByRole("status")).not.toHaveTextContent(t("loading"))
  );
}

describe("how the account signs in (E-126)", () => {
  it("two-step verification on: said, with Turn off; Change password offered", async () => {
    routes({ "GET /api/account/security": ON });
    await shown();
    expect(await screen.findByTestId("mfa-state")).toHaveTextContent(t("mfa_is_on"));
    expect(screen.getByRole("button", { name: t("mfa_turn_off") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("mfa_turn_on") })).toBeNull();
    expect(
      screen.getByRole("button", { name: t("password_change") })
    ).toBeInTheDocument();
  });

  it("a read that fails is said, never shown as off; Try again reads again", async () => {
    routes({ "GET /api/account/security": "network" });
    render(<SignInSecurity />);
    expect(await screen.findByText(t("unreadable"))).toBeInTheDocument();
    expect(screen.queryByTestId("mfa-state")).toBeNull();
    expect(screen.queryByText(t("mfa_is_off"))).toBeNull();
    routes({ "GET /api/account/security": OFF });
    await act(async () => {
      // One "Try again", not two (the notice offers none of its own here).
      expect(screen.getAllByRole("button", { name: /try again/i })).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: t("retry") }));
    });
    expect(await screen.findByTestId("mfa-state")).toHaveTextContent(t("mfa_is_off"));
  });

  it("readSecurity: an answer that does not say is unknown, never off", async () => {
    routes({ "GET /api/account/security": SSO });
    expect(await readSecurity()).toEqual({
      kind: "ready",
      state: { mfaEnabled: null, signInMethod: "sso" },
    });
  });
});

describe("change the password (E-126)", () => {
  it("asks first, sends the code to the account's own address, then the code and the new password", async () => {
    routes({
      "GET /api/account/security": ON,
      "POST /api/auth/forgot-password":
        "POST /api/auth/forgot-password — sent, or not: the same answer either way",
      "POST /api/auth/confirm-forgot-password":
        "POST /api/auth/confirm-forgot-password — reset",
      "GET /api/auth/password-policy":
        "GET /api/auth/password-policy — the built-in policy (none stored)",
    });
    await shown();
    fireEvent.click(await screen.findByRole("button", { name: t("password_change") }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(
      t("password_confirm_consequence", { email: "me@example.test" })
    );
    expect(dialog).toHaveFocus();
    expect(calls.some((c) => c.url === "/api/auth/forgot-password")).toBe(false);
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: t("password_send_code") })
      );
    });
    expect(calls.find((c) => c.url === "/api/auth/forgot-password")?.body).toEqual({
      email: "me@example.test",
    });
    const form = await screen.findByRole("form", { name: t("password_form") });
    fireEvent.change(within(form).getByLabelText(t("code_label")), {
      target: { value: "123456" },
    });
    fireEvent.change(within(form).getByLabelText(t("new_password")), {
      target: { value: "Correct-Horse-Battery-9!" },
    });
    fireEvent.change(within(form).getByLabelText(t("confirm_password")), {
      target: { value: "Correct-Horse-Battery-9!" },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t("password_change") }));
    });
    expect(
      calls.find((c) => c.url === "/api/auth/confirm-forgot-password")?.body
    ).toEqual({
      email: "me@example.test",
      code: "123456",
      newPassword: "Correct-Horse-Battery-9!",
    });
    expect(await screen.findByText(t("password_changed"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t("sign_in_again") })).toHaveAttribute(
      "href",
      "/auth?redirect=%2Faccount"
    );
  });

  it("a wrong code is said in its own words; nothing else changes", async () => {
    routes({
      "GET /api/account/security": ON,
      "POST /api/auth/forgot-password":
        "POST /api/auth/forgot-password — sent, or not: the same answer either way",
      "POST /api/auth/confirm-forgot-password":
        "POST /api/auth/confirm-forgot-password — refused (the code is wrong)",
      "GET /api/auth/password-policy":
        "GET /api/auth/password-policy — the built-in policy (none stored)",
    });
    await shown();
    fireEvent.click(await screen.findByRole("button", { name: t("password_change") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t("password_send_code") }));
    });
    const form = await screen.findByRole("form", { name: t("password_form") });
    fireEvent.change(within(form).getByLabelText(t("code_label")), {
      target: { value: "000000" },
    });
    fireEvent.change(within(form).getByLabelText(t("new_password")), {
      target: { value: "Correct-Horse-Battery-9!" },
    });
    fireEvent.change(within(form).getByLabelText(t("confirm_password")), {
      target: { value: "Correct-Horse-Battery-9!" },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t("password_change") }));
    });
    expect(await screen.findByText("That code is not correct.")).toBeInTheDocument();
    expect(screen.queryByText(t("password_changed"))).toBeNull();
  });

  it("a provider's account: its password is managed there — nothing offered", async () => {
    routes({ "GET /api/account/security": SSO });
    await shown();
    expect(await screen.findByText(t("password_sso"))).toBeInTheDocument();
    expect(screen.getByText(t("mfa_sso"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("password_change") })).toBeNull();
    expect(screen.queryByRole("button", { name: t("mfa_turn_on") })).toBeNull();
  });
});

describe("two-step verification on and off (E-126)", () => {
  it("off → on: the secret drawn, the first code confirmed, the session's new token taken", async () => {
    routes({
      "GET /api/account/security": OFF,
      "POST /api/auth/mfa/setup": "POST /api/auth/mfa/setup — the secret and its URI",
      "POST /api/auth/mfa/verify": "POST /api/auth/mfa/verify — enabled",
    });
    await shown();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: t("mfa_turn_on") }));
    });
    const form = await screen.findByRole("form", { name: t("mfa_code_form") });
    expect(within(form).getByRole("img", { name: /QR code/ })).toBeInTheDocument();
    expect(calls.find((c) => c.url === "/api/auth/mfa/setup")?.body).toBeUndefined();
    routes({
      "GET /api/account/security": ON,
      "POST /api/auth/mfa/verify": "POST /api/auth/mfa/verify — enabled",
    });
    fireEvent.change(within(form).getByLabelText(t("code_label")), {
      target: { value: "123456" },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t("mfa_confirm") }));
    });
    expect(calls.find((c) => c.url === "/api/auth/mfa/verify")?.body).toEqual({
      code: "123456",
    });
    expect(mockNoteCsrf).toHaveBeenCalledWith("csrf-token-of-the-session");
    expect(await screen.findByText(t("mfa_on_done"))).toBeInTheDocument();
    expect(await screen.findByTestId("mfa-state")).toHaveTextContent(t("mfa_is_on"));
  });

  it("the server asks for proof first: the password is asked, then the set-up is sent with it", async () => {
    routes({
      "GET /api/account/security": OFF,
      "POST /api/auth/mfa/setup":
        "POST /api/auth/mfa/setup — refused (proof needed first)",
    });
    await shown();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: t("mfa_turn_on") }));
    });
    const form = await screen.findByRole("form", { name: t("proof_form") });
    routes({
      "GET /api/account/security": OFF,
      "POST /api/auth/mfa/setup": "POST /api/auth/mfa/setup — the secret and its URI",
    });
    fireEvent.change(within(form).getByLabelText(t("step_up_password")), {
      target: { value: "pw" },
    });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t("continue") }));
    });
    expect(calls.filter((c) => c.url === "/api/auth/mfa/setup").at(-1)?.body).toEqual({
      password: "pw",
    });
    expect(
      await screen.findByRole("form", { name: t("mfa_code_form") })
    ).toBeInTheDocument();
  });

  it("on → off: asked first, with the password and a current code; then the new token", async () => {
    routes({
      "GET /api/account/security": ON,
      "POST /api/auth/mfa/disable": "POST /api/auth/mfa/disable — turned off",
    });
    await shown();
    fireEvent.click(await screen.findByRole("button", { name: t("mfa_turn_off") }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(t("mfa_off_consequence"));
    // Nothing sent without the proof.
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("mfa_turn_off") }));
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(t("step_up_missing"));
    expect(calls.some((c) => c.url === "/api/auth/mfa/disable")).toBe(false);
    fireEvent.change(within(dialog).getByLabelText(t("step_up_password")), {
      target: { value: "pw" },
    });
    fireEvent.change(within(dialog).getByLabelText(t("step_up_code")), {
      target: { value: "123456" },
    });
    routes({
      "GET /api/account/security": OFF,
      "POST /api/auth/mfa/disable": "POST /api/auth/mfa/disable — turned off",
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("mfa_turn_off") }));
    });
    expect(calls.find((c) => c.url === "/api/auth/mfa/disable")?.body).toEqual({
      password: "pw",
      currentCode: "123456",
    });
    expect(mockNoteCsrf).toHaveBeenCalledWith("csrf-token-of-the-session");
    expect(await screen.findByText(t("mfa_off_done"))).toBeInTheDocument();
  });

  it("a wrong password: said in its own words; still on", async () => {
    routes({
      "GET /api/account/security": ON,
      "POST /api/auth/mfa/disable":
        "POST /api/auth/mfa/disable — refused (the password is wrong)",
    });
    await shown();
    fireEvent.click(await screen.findByRole("button", { name: t("mfa_turn_off") }));
    const dialog = screen.getByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText(t("step_up_password")), {
      target: { value: "wrong" },
    });
    fireEvent.change(within(dialog).getByLabelText(t("step_up_code")), {
      target: { value: "123456" },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: t("mfa_turn_off") }));
    });
    expect(
      await screen.findByText("Email or password is incorrect.")
    ).toBeInTheDocument();
    expect(mockNoteCsrf).not.toHaveBeenCalled();
    expect(screen.getByTestId("mfa-state")).toHaveTextContent(t("mfa_is_on"));
  });
});
