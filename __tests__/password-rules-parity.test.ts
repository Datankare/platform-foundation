/**
 * @jest-environment node
 */
/**
 * __tests__/password-rules-parity.test.ts — the sign-in screens and the server judge a new
 * password alike (TASK-222, E-112)
 *
 * The screens stated three rules of their own (12 characters and four kinds; 12 characters;
 * 8 characters) and none was the policy the routes refuse a password by. Now a screen reads the
 * policy from GET /api/auth/password-policy and judges with the routes' own function. This
 * proves the two agree end to end, for any policy an administrator may set and any password:
 * what the route answers, read as the screen reads it, accepts a password exactly when the
 * refusal every password-setting route applies (passwordPolicyRefusal) lets it through.
 *
 * hostile:policy-drift: the screen's policy is the route's answer, never its own copy — a policy
 * changed between two reads is the one both sides judge by.
 */
// hostile:role n/a: the route is public — no role is asked for, and every caller gets the same rules
// hostile:self n/a: the route names no person, so there is no own or other account to tell apart
// hostile:id-spelling n/a: the route takes no id, parameter or body — only the request's tenant
// hostile:store-down n/a: an unreadable store is auth-password-policy-route.test.ts's own case
import fc from "fast-check";
import { fuzzParams } from "./helpers/fuzz";

fc.configureGlobal(fuzzParams());
import { NextRequest } from "next/server";

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "test-req-id",
}));

/** The tenant's stored policy, as the store would answer it. */
let mockStored: Record<string, unknown> = {};
jest.mock("@/platform/auth/password-policy", () => {
  const actual = jest.requireActual("@/platform/auth/password-policy");
  return {
    ...actual,
    getGlobalPasswordPolicy: jest.fn(async () => ({
      ...actual.DEFAULT_POLICY,
      ...mockStored,
    })),
  };
});

import { GET } from "@/app/api/auth/password-policy/route";
import { passwordPolicyRefusal } from "@/platform/auth/auth-response";
import { readPolicyAnswer } from "@/components/auth/ui/usePasswordPolicy";
import { meetsPolicy } from "@/components/auth/ui/PasswordRules";
import { PASSWORD_POLICY_LIMITS } from "@/platform/auth/password-rules";

// Each request from an address of its own: the property makes many, and the route's rate limit
// is not what is judged here.
let n = 0;
const req = () => {
  n += 1;
  return new NextRequest("http://localhost/api/auth/password-policy", {
    method: "GET",
    headers: { "x-forwarded-for": `198.51.${(n >> 8) & 255}.${n & 255}` },
  });
};

const policyArb = fc.record({
  minLength: fc.integer({
    min: PASSWORD_POLICY_LIMITS.minLength.min,
    max: 24,
  }),
  requireUppercase: fc.boolean(),
  requireLowercase: fc.boolean(),
  requireNumber: fc.boolean(),
  requireSpecial: fc.boolean(),
});
const passwordArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 30 }),
  fc.constantFrom(
    "password",
    "Password1!",
    "aaaaaaaaaaaaaaaa",
    "abcd1234ABCD!",
    "Correct-Horse-Battery-9"
  )
);

describe("the screens and the server judge a new password alike (E-112)", () => {
  it("the route answers the tenant's policy, and only what a person choosing a password needs", async () => {
    mockStored = {
      minLength: 10,
      requireSpecial: false,
      rotationDays: 30,
      passwordHistoryCount: 3,
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      policy: {
        minLength: 10,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSpecial: false,
      },
    });
  });

  it("for any policy and any password: the screen accepts it exactly when the routes would", async () => {
    await fc.assert(
      fc.asyncProperty(
        policyArb,
        fc.array(passwordArb, { minLength: 1, maxLength: 6 }),
        async (policy, passwords) => {
          mockStored = policy;
          const seen = readPolicyAnswer(await (await GET(req())).json());
          expect(seen).toEqual(policy);
          for (const pw of passwords) {
            const refused = await passwordPolicyRefusal(pw, req());
            expect([pw, meetsPolicy(pw, seen!)]).toEqual([pw, refused === null]);
          }
        }
      )
    );
  });
});
