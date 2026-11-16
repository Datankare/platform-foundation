/**
 * @jest-environment jsdom
 */
/**
 * __tests__/auth-page.test.tsx — the sign-in page's steps, as a person moves through them
 * (TASK-181, TASK-222)
 */

import React from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import AuthPage from "@/components/auth/AuthPage";
import { hrefForView, initialView, viewFromSearch } from "@/components/auth/useAuthSteps";
import { registerAuthProvider } from "@/platform/auth/config";
import { createMockAuthProvider } from "@/platform/auth/mock-provider";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";
import {
  STRONG,
  answer,
  declareBirthDate,
  policyAnswer,
  say,
  typeNewPassword,
} from "@/__tests__/helpers/auth-screen";

// Mock the auth context: after a sign-in step the page asks it to read the new session from the
// server (ADR-057 — the page receives no token to keep).
const mockSessionStarted = jest.fn(async () => true);
jest.mock("@/platform/auth/context", () => ({
  ...jest.requireActual("@/platform/auth/context"),
  useAuth: () => ({
    sessionStarted: mockSessionStarted,
    user: null,
    isLoading: false,
    isAuthenticated: false,
    isGuest: false,
    session: { status: "signed-out" },
    signOut: jest.fn(),
    signOutEverywhere: jest.fn(),
    staySignedIn: jest.fn(),
  }),
}));

beforeAll(() => {
  registerAuthProvider(createMockAuthProvider());
});

let guest: RouteFixtureName = "POST /api/auth/guest — started";
const fetchMock = jest.fn(async (url: string) =>
  url === "/api/auth/guest" ? answer(guest) : answer(policyAnswer.name)
);

beforeEach(() => {
  jest.clearAllMocks();
  guest = "POST /api/auth/guest — started";
  policyAnswer.name = "GET /api/auth/password-policy — the built-in policy (none stored)";
  global.fetch = fetchMock as unknown as typeof fetch;
  window.history.replaceState(null, "", "/auth");
});

afterEach(() => {
  registerAuthProvider(createMockAuthProvider());
});

const heading = (key: string) => screen.getByRole("heading", { name: say(key) });
const findHeading = (key: string) => screen.findByRole("heading", { name: say(key) });
const signInAs = (email: string, password = "pw") => {
  fireEvent.change(screen.getByLabelText(say("login.email")), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText(say("login.password")), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole("button", { name: say("login.sign_in") }));
};
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

/** Where the page leaves for by a full navigation (single sign-on). */
const mockLeaveFor = jest.fn();
jest.mock("@/components/auth/ui/leave-for", () => ({
  leaveFor: (url: string) => mockLeaveFor(url),
}));
function withAssign(run: (assign: jest.Mock) => void): void {
  run(mockLeaveFor);
}

describe("AuthPage", () => {
  it("starts on login view", () => {
    render(<AuthPage />);
    expect(heading("login.sign_in")).toBeDefined();
    expect(screen.getByLabelText(say("login.email"))).toBeDefined();
    expect(screen.getByLabelText(say("login.password"))).toBeDefined();
  });

  it("asks for a date of birth before the account form (audit X-16)", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    expect(
      screen.queryByRole("heading", { name: say("register.create_account") })
    ).toBeNull();
    declareBirthDate("1990-01-15");
    expect(heading("register.create_account")).toBeDefined();
    expect(screen.getByLabelText(say("register.confirm_password"))).toBeDefined();
  });

  it("sends the declared date of birth with the sign-up", async () => {
    const signUp = jest.fn().mockResolvedValue({
      success: true,
      emailVerificationRequired: true,
    });
    registerAuthProvider(createMockAuthProvider({ signUp }));
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    declareBirthDate("1990-01-15");
    fill(say("register.email"), "a@b.c");
    typeNewPassword(say("register.password"), say("register.confirm_password"), STRONG);
    press(say("register.create_account"));
    await waitFor(() =>
      expect(signUp).toHaveBeenCalledWith("a@b.c", STRONG, { dateOfBirth: "1990-01-15" })
    );
  });

  it("switches back to login from register", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    declareBirthDate("1990-01-15");
    fireEvent.click(screen.getByText(say("register.sign_in")));
    expect(heading("login.sign_in")).toBeDefined();
  });

  it("switches to forgot password and back", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.forgot_password")));
    expect(heading("forgot_password.reset_password")).toBeDefined();
    fireEvent.click(screen.getByText(say("forgot_password.back_to_sign_in")));
    expect(heading("login.sign_in")).toBeDefined();
  });

  it("shows error on failed login", async () => {
    render(<AuthPage />);
    signInAs("test@example.com", "wrong-password");
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());
  });

  it("renders the brand from two catalogue parts, as one heading", () => {
    render(<AuthPage />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      say("layout.brand_first") + say("layout.brand_second")
    );
  });

  it("starts a guest session on the server and reads it back — no token reaches the page (ADR-050 D4, ADR-057)", async () => {
    // The route's own answer carries no token for the page to keep.
    expect(JSON.stringify(routeAnswer(guest)[1])).not.toMatch(/token/i);
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.continue_as_guest")));
    await waitFor(() => expect(mockSessionStarted).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/guest",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows the server's message when a guest session cannot start", async () => {
    guest = "POST /api/auth/guest — the mint failing";
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.continue_as_guest")));
    const { message } = routeAnswer(guest)[1] as { message: string };
    expect(await screen.findByText(message)).toBeDefined();
    expect(mockSessionStarted).not.toHaveBeenCalled();
  });

  it("offers no single sign-on when none is configured", () => {
    render(<AuthPage />);
    expect(screen.queryByText(say("sso.continue_with_google"))).toBeNull();
  });

  it("shows the catalog message for an SSO error returned in the address", () => {
    window.history.replaceState(null, "", "/auth?error=auth.sso_failed");
    render(<AuthPage />);
    expect(
      screen.getByText("Single sign-on did not complete. Try another sign-in method.")
    ).toBeDefined();
  });

  it("ignores an unknown error code in the address", () => {
    window.history.replaceState(null, "", "/auth?error=%3Cscript%3E");
    render(<AuthPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the new-password view when sign-in requires a new password", async () => {
    render(<AuthPage />);
    signInAs("admin@example.com", "new-password-required");
    expect(await findHeading("new_password.set_a_new_password")).toBeDefined();
  });

  it("surfaces an error when setting the new password fails", async () => {
    registerAuthProvider(
      createMockAuthProvider({
        respondToNewPasswordChallenge: jest.fn().mockResolvedValue({
          success: false,
          error: "Server rejected password",
        }),
      })
    );
    render(<AuthPage />);
    signInAs("admin@example.com", "new-password-required");
    await findHeading("new_password.set_a_new_password");
    typeNewPassword(
      say("new_password.new_password"),
      say("new_password.confirm_new_password"),
      STRONG
    );
    press(say("new_password.set_password_continue"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("Server rejected password")
    );
  });

  it("completes sign-in after a successful new password", async () => {
    render(<AuthPage />);
    signInAs("admin@example.com", "new-password-required");
    await findHeading("new_password.set_a_new_password");
    typeNewPassword(
      say("new_password.new_password"),
      say("new_password.confirm_new_password"),
      STRONG
    );
    press(say("new_password.set_password_continue"));
    await waitFor(() => expect(mockSessionStarted).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("SF-app-041: cancelling two-step verification or a new password returns to sign-in with the address kept", async () => {
    render(<AuthPage />);
    signInAs("admin@example.com", "mfa-required");
    await findHeading("mfa_challenge.two_factor_authentication");
    press(say("mfa_challenge.cancel_sign_in"));
    await findHeading("login.sign_in");
    expect((screen.getByLabelText(say("login.email")) as HTMLInputElement).value).toBe(
      "admin@example.com"
    );
    expect((screen.getByLabelText(say("login.password")) as HTMLInputElement).value).toBe(
      ""
    );
    signInAs("admin@example.com", "new-password-required");
    await findHeading("new_password.set_a_new_password");
    press(say("new_password.cancel_sign_in"));
    await findHeading("login.sign_in");
    expect((screen.getByLabelText(say("login.email")) as HTMLInputElement).value).toBe(
      "admin@example.com"
    );
  });

  it("completes sign-in after two-step verification", async () => {
    render(<AuthPage />);
    signInAs("admin@example.com", "mfa-required");
    await findHeading("mfa_challenge.two_factor_authentication");
    expect(window.location.search).toBe("?view=two-step");
    fill(say("mfa_challenge.code_label"), "123456");
    press(say("mfa_challenge.verify"));
    await waitFor(() => expect(mockSessionStarted).toHaveBeenCalled());
  });
});

// ── TASK-181 ─────────────────────────────────────────────────────────────────────────────────
describe("AuthPage — following the server's answer (TASK-181)", () => {
  it("an unconfirmed account's sign-in shows email verification, not 'Sign-in failed'", async () => {
    registerAuthProvider(
      createMockAuthProvider({
        signIn: jest.fn().mockResolvedValue({
          success: false,
          errorCode: "auth.email_not_verified",
          emailVerificationRequired: true,
        }),
      })
    );
    render(<AuthPage />);
    signInAs("new@example.com");
    expect(await findHeading("email_verification.verify_your_email")).toBeDefined();
    expect(screen.queryByText(say("page.sign_in_failed"))).toBeNull();
  });

  const toVerification = async (resend: jest.Mock) => {
    registerAuthProvider(
      createMockAuthProvider({
        signIn: jest.fn().mockResolvedValue({
          success: false,
          emailVerificationRequired: true,
        }),
        resendEmailVerification: resend,
      })
    );
    render(<AuthPage />);
    signInAs("new@example.com");
    await findHeading("email_verification.verify_your_email");
    fireEvent.click(screen.getByText(say("email_verification.resend_verification_code")));
  };

  it("says when a new verification code was sent", async () => {
    const resend = jest.fn().mockResolvedValue({ success: true });
    await toVerification(resend);
    expect(await screen.findByText(say("code_resent"))).toBeDefined();
    expect(resend).toHaveBeenCalledWith("new@example.com");
    expect(
      screen.getByText(say("email_verification.resend_in", { seconds: 60 }))
    ).toBeDefined();
  });

  it("shows the server's message when the code cannot be resent, and no cooldown", async () => {
    await toVerification(
      jest.fn().mockResolvedValue({ success: false, error: "Too many attempts." })
    );
    expect(await screen.findByText("Too many attempts.")).toBeDefined();
    expect(
      screen.getByText(say("email_verification.resend_verification_code"))
    ).toBeDefined();
  });

  const toResetCode = async (forgot: jest.Mock, confirm?: jest.Mock) => {
    registerAuthProvider(
      createMockAuthProvider({
        forgotPassword: forgot,
        ...(confirm ? { confirmForgotPassword: confirm } : {}),
      })
    );
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.forgot_password")));
    fill(say("forgot_password.email"), "a@example.com");
    press(say("forgot_password.send_reset_code"));
  };

  it("stays on the email step with the server's message when the code is refused", async () => {
    await toResetCode(
      jest.fn().mockResolvedValue({ success: false, error: "Too many requests." })
    );
    expect(await screen.findByText("Too many requests.")).toBeDefined();
    expect(screen.queryByLabelText(say("forgot_password.reset_code"))).toBeNull();
  });

  it("stays on the code step when the reset is refused (wrong code, policy)", async () => {
    await toResetCode(
      jest.fn().mockResolvedValue({ success: true }),
      jest.fn().mockResolvedValue({
        success: false,
        error: "The code is wrong or has expired.",
      })
    );
    await screen.findByLabelText(say("forgot_password.reset_code"));
    fill(say("forgot_password.reset_code"), "123456");
    typeNewPassword(
      say("forgot_password.new_password"),
      say("forgot_password.confirm_new_password"),
      STRONG
    );
    press(say("forgot_password.reset_password"));
    expect(await screen.findByText("The code is wrong or has expired.")).toBeDefined();
    expect(screen.queryByText(say("page.password_was_reset"))).toBeNull();
    expect(screen.getByLabelText(say("forgot_password.reset_code"))).toBeDefined();
  });

  it("refuses an under-13 date of birth at the age gate (no account form)", () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    declareBirthDate(`${new Date().getFullYear() - 9}-01-15`);
    expect(screen.getByText(/not available yet/)).toBeDefined();
    expect(
      screen.queryByRole("heading", { name: say("register.create_account") })
    ).toBeNull();
  });
});

// ── TASK-222 ─────────────────────────────────────────────────────────────────────────────────
describe("AuthPage — the sign-in screens' review (TASK-222)", () => {
  it("SF-app-040: a verified address goes to sign-in, saying so, the address filled in", async () => {
    const confirm = jest.fn().mockResolvedValue({ success: true });
    registerAuthProvider(
      createMockAuthProvider({
        signUp: jest.fn().mockResolvedValue({
          success: true,
          emailVerificationRequired: true,
        }),
        confirmEmailVerification: confirm,
      })
    );
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    declareBirthDate("1990-01-15");
    fill(say("register.email"), "new@example.com");
    typeNewPassword(say("register.password"), say("register.confirm_password"), STRONG);
    press(say("register.create_account"));
    await screen.findByLabelText(say("email_verification.code_label"));
    fill(say("email_verification.code_label"), "123456");
    press(say("email_verification.verify_email"));
    await findHeading("login.sign_in");
    expect(confirm).toHaveBeenCalledWith("new@example.com", "123456");
    expect(screen.getByRole("status").textContent).toBe(say("page.email_verified"));
    expect((screen.getByLabelText(say("login.email")) as HTMLInputElement).value).toBe(
      "new@example.com"
    );
    // The password is not kept from the account form: it is typed again.
    expect((screen.getByLabelText(say("login.password")) as HTMLInputElement).value).toBe(
      ""
    );
  });

  it("SF-app-044: a reset password goes to sign-in, saying so, the address filled in", async () => {
    registerAuthProvider(
      createMockAuthProvider({
        forgotPassword: jest.fn().mockResolvedValue({ success: true }),
        confirmForgotPassword: jest.fn().mockResolvedValue({ success: true }),
      })
    );
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.forgot_password")));
    fill(say("forgot_password.email"), "a@example.com");
    press(say("forgot_password.send_reset_code"));
    await screen.findByLabelText(say("forgot_password.reset_code"));
    fill(say("forgot_password.reset_code"), "123456");
    typeNewPassword(
      say("forgot_password.new_password"),
      say("forgot_password.confirm_new_password"),
      STRONG
    );
    press(say("forgot_password.reset_password"));
    await findHeading("login.sign_in");
    expect(screen.getByRole("status").textContent).toBe(say("page.password_was_reset"));
    expect((screen.getByLabelText(say("login.email")) as HTMLInputElement).value).toBe(
      "a@example.com"
    );
  });

  it("SF-app-041: each step is in the address, and its heading takes focus when it opens", () => {
    render(<AuthPage />);
    // The first load leaves focus where the browser puts it.
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByText(say("login.forgot_password")));
    expect(window.location.search).toBe("?view=reset-password");
    expect(document.activeElement).toBe(heading("forgot_password.reset_password"));
    fireEvent.click(screen.getByText(say("forgot_password.back_to_sign_in")));
    expect(window.location.search).toBe("");
    expect(document.activeElement).toBe(heading("login.sign_in"));
  });

  it("SF-app-041: Back returns to the step before, inside the page", async () => {
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    expect(window.location.search).toBe("?view=create-account");
    act(() => {
      window.history.back();
    });
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(await findHeading("login.sign_in")).toBeDefined();
    expect(document.activeElement).toBe(heading("login.sign_in"));
  });

  it("SF-app-041: Back from two-step verification cancels it; Forward cannot reopen it without a challenge", async () => {
    render(<AuthPage />);
    signInAs("admin@example.com", "mfa-required");
    await findHeading("mfa_challenge.two_factor_authentication");
    act(() => {
      window.history.back();
    });
    expect(await findHeading("login.sign_in")).toBeDefined();
  });

  it("SF-app-041: an address opens the account or reset step; a step that needs an earlier one opens sign-in", () => {
    expect(initialView("?view=create-account")).toBe("register");
    expect(initialView("?view=reset-password")).toBe("forgot-password");
    expect(initialView("?view=two-step")).toBe("login");
    expect(initialView("?view=new-password")).toBe("login");
    expect(initialView("?view=verify-email")).toBe("login");
    expect(viewFromSearch("?view=nonsense")).toBe("login");
    window.history.replaceState(null, "", "/auth?view=two-step&redirect=%2Faccount");
    render(<AuthPage />);
    expect(heading("login.sign_in")).toBeDefined();
    // The address now names what is shown; the page asked for is kept.
    expect(window.location.search).toBe("?redirect=%2Faccount");
  });

  it("SF-app-041: an address naming the account step opens it", () => {
    window.history.replaceState(null, "", "/auth?view=create-account");
    render(<AuthPage />);
    expect(heading("age_gate.verify_your_age")).toBeDefined();
  });

  it("SF-app-041: a step's address keeps the page asked for and drops what sign-on returned with", () => {
    expect(
      hrefForView(
        "http://x/auth?redirect=%2Fadmin&error=auth.sso_failed&sso=cancelled",
        "register"
      )
    ).toBe("/auth?redirect=%2Fadmin&view=create-account");
    expect(hrefForView("http://x/auth?view=create-account", "login")).toBe("/auth");
  });

  it("SF-app-048: a cancelled single sign-on is said as a cancellation, not a failure", () => {
    window.history.replaceState(null, "", "/auth?sso=cancelled");
    render(<AuthPage />);
    expect(screen.getByRole("status").textContent).toBe(say("sso.cancelled"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("SF-app-049: dismissing what sign-on returned with takes it out of the address", async () => {
    window.history.replaceState(
      null,
      "",
      "/auth?error=auth.sso_failed&redirect=%2Fadmin"
    );
    render(<AuthPage />);
    expect(screen.getByRole("alert")).toBeDefined();
    signInAs("test@example.com");
    await waitFor(() => expect(mockSessionStarted).toHaveBeenCalled());
    expect(window.location.search).toBe("?redirect=%2Fadmin");
    expect(
      screen.queryByText("Single sign-on did not complete. Try another sign-in method.")
    ).toBeNull();
  });

  it("SF-app-047: the single sign-on buttons are the ones the server rendered the page with, and nothing is read for them", () => {
    render(<AuthPage ssoProviders={["google"]} />);
    expect(screen.getByText(say("sso.continue_with_google"))).toBeDefined();
    expect(screen.queryByText(say("sso.continue_with_apple"))).toBeNull();
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain("/api/features");
  });

  it("E-113: single sign-on starts with the page asked for, which the attempt keeps", () => {
    window.history.replaceState(null, "", "/auth?redirect=%2Fadmin%3Fsection%3Dusers");
    withAssign((assign) => {
      render(<AuthPage ssoProviders={["google"]} />);
      fireEvent.click(screen.getByText(say("sso.continue_with_google")));
      expect(assign).toHaveBeenCalledWith(
        "/api/auth/sso/google?redirect=%2Fadmin%3Fsection%3Dusers"
      );
    });
  });

  it("E-113: a page of another site is never sent on with single sign-on", () => {
    window.history.replaceState(null, "", "/auth?redirect=%2F%2Fevil.example%2F");
    withAssign((assign) => {
      render(<AuthPage ssoProviders={["google"]} />);
      fireEvent.click(screen.getByText(say("sso.continue_with_google")));
      expect(assign).toHaveBeenCalledWith("/api/auth/sso/google");
    });
  });

  it("E-112: the account form states the policy the server answered, not a rule of its own", async () => {
    policyAnswer.name = "GET /api/auth/password-policy — an administrator's policy";
    render(<AuthPage />);
    fireEvent.click(screen.getByText(say("login.create_one")));
    declareBirthDate("1990-01-15");
    expect(
      await screen.findByText(say("password_rules.at_least_characters", { count: 10 }))
    ).toBeDefined();
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/auth/password-policy");
    expect(screen.queryByText(say("password_rules.uppercase"))).toBeNull();
    expect(screen.queryByText(say("password_rules.special"))).toBeNull();
    expect(screen.getByText(say("password_rules.number"))).toBeDefined();
  });
});
