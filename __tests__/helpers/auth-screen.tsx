/**
 * __tests__/helpers/auth-screen.tsx — what the sign-in screens' tests share (TASK-222)
 *
 * The screens' text is the catalogue's: a test finds a control by the words the person reads,
 * taken from messages/en.json (`say`), so a wording change is made once, in the catalogue, and
 * the tests still prove the control is there and named. The answers a screen's fetch gets are
 * the real routes' (__tests__/fixtures/route-responses.json), never a body written here.
 */
import { fireEvent, screen } from "@testing-library/react";
import { renderMessage, type MessageValues } from "@/platform/errors/messages";
import { routeAnswer, type RouteFixtureName } from "@/__tests__/fixtures/route-responses";

/** A sign-in screen's text: `say("login.sign_in")` is screens.auth.login.sign_in. */
export const say = (key: string, values?: MessageValues): string =>
  renderMessage(`screens.auth.${key}`, values);

/** A route's own answer, as fetch resolves it. */
export function answer(name: RouteFixtureName) {
  const [status, body] = routeAnswer(name);
  return { ok: status < 400, status, json: async () => body };
}

/** The password-policy answer the screens get, by default the built-in policy. */
export const policyAnswer: { name: RouteFixtureName } = {
  name: "GET /api/auth/password-policy — the built-in policy (none stored)",
};

/** A password every built-in rule accepts. */
export const STRONG = "Correct-Horse-Battery-9";

/** Declare a date of birth at the age gate (one date field, YYYY-MM-DD) and continue. */
export function declareBirthDate(iso: string): void {
  fireEvent.change(screen.getByLabelText(say("age_gate.date_of_birth")), {
    target: { value: iso },
  });
  fireEvent.click(screen.getByRole("button", { name: say("age_gate.continue") }));
}

/** Type a new password and its confirmation into the step's two fields. */
export function typeNewPassword(
  passwordLabel: string,
  confirmLabel: string,
  password: string,
  confirm: string = password
): void {
  fireEvent.change(screen.getByLabelText(passwordLabel), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(confirmLabel), { target: { value: confirm } });
}
