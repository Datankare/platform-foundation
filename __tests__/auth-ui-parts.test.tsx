/**
 * @jest-environment jsdom
 */
/**
 * __tests__/auth-ui-parts.test.tsx — the sign-in screens' shared parts (TASK-222):
 * AuthField (label, help and error wired), PasswordRules (the server's policy, each item said met
 * or not met in words), NewPasswordFields, AuthHeading (focus when a step opens) and
 * usePasswordPolicy (the server's policy, or the built-in one).
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  AuthField,
  AuthInput,
  CodeInput,
  FormError,
  FormNotice,
} from "@/components/auth/ui/AuthField";
import { AuthHeading, StepMoved } from "@/components/auth/ui/AuthHeading";
import {
  PasswordRules,
  meetsPolicy,
  ruleItems,
} from "@/components/auth/ui/PasswordRules";
import {
  confirmationDiffers,
  newPasswordReady,
} from "@/components/auth/ui/NewPasswordFields";
import {
  BUILT_IN_RULES,
  readPolicyAnswer,
  usePasswordPolicy,
} from "@/components/auth/ui/usePasswordPolicy";
import { DEFAULT_POLICY } from "@/platform/auth/password-rules";
import { answer, say } from "@/__tests__/helpers/auth-screen";
import { routeAnswer } from "@/__tests__/fixtures/route-responses";

describe("AuthField", () => {
  it("gives its control a visible label, and ties help and error to it", () => {
    render(
      <AuthField id="f" label="Name" help="What we call you" error="Too short">
        {(c) => <AuthInput {...c} value="" onChange={() => {}} />}
      </AuthField>
    );
    const input = screen.getByLabelText("Name");
    expect(input.id).toBe("f");
    const ids = input.getAttribute("aria-describedby")!.split(" ");
    expect(ids.map((id) => document.getElementById(id)?.textContent)).toEqual([
      "What we call you",
      "Too short",
    ]);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe("Too short");
  });

  it("with no error, marks nothing and announces nothing", () => {
    render(<AuthField label="Name">{(c) => <AuthInput {...c} />}</AuthField>);
    const input = screen.getByLabelText("Name");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a code field keeps digits only, six at most, and fills from the device's one-time code", () => {
    const got: string[] = [];
    render(
      <AuthField label="Code">
        {(c) => <CodeInput {...c} value="" onDigits={(d) => got.push(d)} />}
      </AuthField>
    );
    const input = screen.getByLabelText("Code");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    fireEvent.change(input, { target: { value: "12a34-5678" } });
    expect(got).toEqual(["123456"]);
  });

  it("a code field's digits are spaced apart, but not its placeholder's words", () => {
    render(
      <AuthField label="Code">
        {(c) => (
          <CodeInput {...c} value="" placeholder="6-digit code" onDigits={() => {}} />
        )}
      </AuthField>
    );
    const classes = screen.getByLabelText("Code").className.split(/\s+/);
    expect(classes).toEqual(
      expect.arrayContaining(["tracking-[0.5em]", "placeholder:tracking-normal"])
    );
  });

  it("a form's refusal is an alert; a notice is a status; nothing renders for none", () => {
    const { rerender } = render(
      <>
        <FormError id="e" message="No." />
        <FormNotice message="Done." />
      </>
    );
    expect(screen.getByRole("alert").id).toBe("e");
    expect(screen.getByRole("status").textContent).toBe("Done.");
    rerender(
      <>
        <FormError message={null} />
        <FormNotice message="" />
      </>
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("PasswordRules (E-112, SF-app-043)", () => {
  it("lists the policy's rules, and only those it asks for", () => {
    expect(ruleItems(BUILT_IN_RULES).map((i) => i.key)).toEqual([
      "length",
      "uppercase",
      "lowercase",
      "number",
      "special",
      "not_common",
    ]);
    expect(
      ruleItems({
        ...BUILT_IN_RULES,
        requireUppercase: false,
        requireSpecial: false,
      }).map((i) => i.key)
    ).toEqual(["length", "lowercase", "number", "not_common"]);
  });

  it("says each item met or not met in words a screen reader reads, not by colour alone", () => {
    render(<PasswordRules password="abcdefghijklmnop" policy={BUILT_IN_RULES} />);
    const items = screen.getAllByRole("listitem");
    // What a screen reader reads: everything but the glyph, which is hidden from it.
    const said = items.map((li) =>
      [...li.querySelectorAll("span:not([aria-hidden])")]
        .filter((el) => !el.parentElement?.closest("span:not([aria-hidden])"))
        .map((el) => el.textContent)
        .join("")
    );
    expect(said[0]).toBe(
      `${say("password_rules.at_least_characters", { count: 12 })} — ${say("password_rules.met")}`
    );
    expect(said[1]).toBe(
      `${say("password_rules.uppercase")} — ${say("password_rules.not_met")}`
    );
    // The glyph only repeats the words: it is hidden from a screen reader.
    for (const li of items)
      expect(li.querySelector("[aria-hidden='true']")?.textContent).toMatch(/^[✓•]$/);
  });

  it("before anything is typed, no item is met", () => {
    render(<PasswordRules password="" policy={BUILT_IN_RULES} />);
    for (const li of screen.getAllByRole("listitem"))
      expect(li.getAttribute("data-met")).toBe("false");
  });

  it("a common, repeated or sequential password does not meet 'not common', as the server refuses it", () => {
    const relaxed = {
      minLength: 8,
      requireUppercase: false,
      requireLowercase: false,
      requireNumber: false,
      requireSpecial: false,
    };
    for (const pw of ["password", "aaaaaaaa", "xx123456"])
      expect(meetsPolicy(pw, relaxed)).toBe(false);
    expect(meetsPolicy("plain words here", relaxed)).toBe(true);
  });
});

describe("NewPasswordFields' judgements", () => {
  it("a confirmation differs once it is no longer a beginning of the password", () => {
    expect(confirmationDiffers("Secret-1", "")).toBe(false);
    expect(confirmationDiffers("Secret-1", "Sec")).toBe(false);
    expect(confirmationDiffers("Secret-1", "Sex")).toBe(true);
    expect(confirmationDiffers("Secret-1", "Secret-1")).toBe(false);
    expect(confirmationDiffers("Secret-1", "Secret-12")).toBe(true);
  });

  it("is ready when the policy is met and the two are the same", () => {
    expect(newPasswordReady("Correct-Horse-9", "Correct-Horse-9", BUILT_IN_RULES)).toBe(
      true
    );
    expect(newPasswordReady("Correct-Horse-9", "Correct-Horse-8", BUILT_IN_RULES)).toBe(
      false
    );
    expect(newPasswordReady("short", "short", BUILT_IN_RULES)).toBe(false);
  });
});

describe("AuthHeading (SF-app-041)", () => {
  it("takes focus when the page has moved to its step, and only then", () => {
    const { unmount } = render(<AuthHeading>Step</AuthHeading>);
    expect(document.activeElement).toBe(document.body);
    unmount();
    render(
      <StepMoved.Provider value={true}>
        <AuthHeading>Step</AuthHeading>
      </StepMoved.Provider>
    );
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Step" }));
    expect(screen.getByRole("heading", { name: "Step" }).getAttribute("tabindex")).toBe(
      "-1"
    );
  });
});

describe("usePasswordPolicy (E-112)", () => {
  function Probe() {
    const p = usePasswordPolicy();
    return <p data-testid="p">{JSON.stringify(p)}</p>;
  }

  it("is the built-in policy the routes fall back to", () => {
    expect(BUILT_IN_RULES).toEqual({
      minLength: DEFAULT_POLICY.minLength,
      requireUppercase: DEFAULT_POLICY.requireUppercase,
      requireLowercase: DEFAULT_POLICY.requireLowercase,
      requireNumber: DEFAULT_POLICY.requireNumber,
      requireSpecial: DEFAULT_POLICY.requireSpecial,
    });
  });

  it("becomes the server's policy when the route answers", async () => {
    global.fetch = jest.fn(async () =>
      answer("GET /api/auth/password-policy — an administrator's policy")
    ) as unknown as typeof fetch;
    render(<Probe />);
    const expected = (
      routeAnswer("GET /api/auth/password-policy — an administrator's policy")[1] as {
        policy: unknown;
      }
    ).policy;
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId("p").textContent!)).toEqual(expected)
    );
  });

  it("stays the built-in policy when the route is unreachable or refuses", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    render(<Probe />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(JSON.parse(screen.getByTestId("p").textContent!)).toEqual(BUILT_IN_RULES);
  });

  it("believes no answer an administrator could not have set", () => {
    const good = { policy: { ...BUILT_IN_RULES } };
    expect(readPolicyAnswer(good)).toEqual(BUILT_IN_RULES);
    for (const bad of [
      null,
      {},
      { policy: { ...BUILT_IN_RULES, minLength: 4 } },
      { policy: { ...BUILT_IN_RULES, minLength: 500 } },
      { policy: { ...BUILT_IN_RULES, minLength: 12.5 } },
      { policy: { ...BUILT_IN_RULES, requireNumber: "yes" } },
    ])
      expect(readPolicyAnswer(bad)).toBeNull();
  });
});
