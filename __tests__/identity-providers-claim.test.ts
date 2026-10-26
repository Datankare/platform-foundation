/**
 * Review 16 L8: who verified a user's address, as the platform's Cognito provider reads it from
 * GetUser — the federated providers (`identities`), none for a native user, or unknown — and the
 * allow-list it is checked against (emailClaimTrusted).
 */
import { identityProvidersFrom } from "@/platform/auth/cognito-provider";
import {
  emailClaimTrusted,
  identityProvidersOf,
} from "@/platform/auth/identity-directory";

const SUB = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const attrs = (over: Record<string, string>) =>
  Object.entries({ sub: SUB, ...over }).map(([Name, Value]) => ({ Name, Value }));

describe("identityProvidersFrom (GetUser)", () => {
  it("a federated user: the providers its identities attribute names", () => {
    expect(
      identityProvidersFrom(
        "Google_1093",
        attrs({
          identities: JSON.stringify([{ providerName: "Google", userId: "1093" }]),
        })
      )
    ).toEqual({ identityProviders: ["Google"] });
  });

  it("a native user of a pool that signs in by address: its username is its sub — none", () => {
    expect(identityProvidersFrom(SUB, attrs({}))).toEqual({ identityProviders: [] });
  });

  it("no identities and a username that is not the sub: unknown (never trusted)", () => {
    expect(identityProvidersFrom("Google_1093", attrs({}))).toEqual({});
    expect(identityProvidersFrom(undefined, attrs({}))).toEqual({});
    expect(identityProvidersFrom(SUB, undefined)).toEqual({});
  });

  it("an unreadable identities attribute names no provider an allow-list holds", () => {
    expect(identityProvidersFrom("x", attrs({ identities: "{" }))).toEqual({
      identityProviders: ["(unreadable)"],
    });
    expect(identityProvidersOf(JSON.stringify([{ providerName: "" }]))).toEqual([
      "(unreadable)",
    ]);
  });
});

describe("emailClaimTrusted", () => {
  const google = new Set(["Google"]);
  it.each([
    [[], true],
    [["Google"], true],
    [["EntraID"], false],
    [["Google", "EntraID"], false],
    [["(unreadable)"], false],
    [undefined, false],
  ] as const)("%j: %s", (providers, ok) => {
    expect(emailClaimTrusted(providers, google)).toBe(ok);
  });
});
