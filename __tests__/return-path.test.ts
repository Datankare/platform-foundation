/**
 * @jest-environment node
 */
/**
 * __tests__/return-path.test.ts — sign-in returns only to a page of this site (TASK-222, E-113)
 *
 * hostile:open-redirect: every way a value has been seen to leave a site through a "return to"
 * parameter (OWASP, "Unvalidated Redirects and Forwards Cheat Sheet"), each refused.
 */
import fc from "fast-check";
import { fuzzParams } from "./helpers/fuzz";

fc.configureGlobal(fuzzParams());
import {
  returnPathFromLocation,
  safeReturnPath,
  signInPath,
  ssoStartPath,
} from "@/platform/auth/return-path";

const ORIGIN = "https://app.example.com";

describe("safeReturnPath", () => {
  it.each([
    ["/account", "/account"],
    ["/admin?section=users", "/admin?section=users"],
    ["/agent/authorize?request=abc#top", "/agent/authorize?request=abc#top"],
    ["/a/../account", "/account"],
    ["/caf%C3%A9", "/caf%C3%A9"],
    // An encoded tab is part of a path here, never a way off it.
    ["/%09/evil.example/", "/%09/evil.example/"],
  ])("keeps a page of this site: %s", (raw, kept) => {
    expect(safeReturnPath(raw, ORIGIN)).toBe(kept);
  });

  it.each([
    "//evil.example/",
    "///evil.example/",
    "/\\evil.example/",
    "/\\/evil.example/",
    "https://evil.example/",
    "http://app.example.com/account",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,x",
    "evil.example",
    "account",
    "/\t/evil.example/",
    "/\n/evil.example/",
    "/auth",
    "/auth?view=two-step",
    "/auth/callback?code=x",
    "/api/auth/session",
    "",
    "/" + "a".repeat(2048),
  ])("refuses %j", (raw) => {
    expect(safeReturnPath(raw, ORIGIN)).toBeNull();
  });

  it("refuses what is not text", () => {
    expect(safeReturnPath(null, ORIGIN)).toBeNull();
    expect(safeReturnPath(undefined, ORIGIN)).toBeNull();
  });

  it("whatever is given, the answer is null or a path on this site's origin", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (a, b) => {
        for (const raw of [a, `/${a}`, `//${a}`, `/${a}/${b}`, "/\\" + a]) {
          const kept = safeReturnPath(raw, ORIGIN);
          if (kept === null) continue;
          expect(kept.startsWith("/")).toBe(true);
          expect(kept.startsWith("//")).toBe(false);
          expect(new URL(kept, ORIGIN).origin).toBe(ORIGIN);
        }
      })
    );
  });
});

describe("the sign-in page's address", () => {
  it("names the page to return to", () => {
    expect(signInPath("/admin?section=users")).toBe(
      "/auth?redirect=%2Fadmin%3Fsection%3Dusers"
    );
    expect(signInPath(null)).toBe("/auth");
    expect(
      returnPathFromLocation({
        search: "?redirect=%2Fadmin%3Fsection%3Dusers",
        origin: ORIGIN,
      })
    ).toBe("/admin?section=users");
    expect(
      returnPathFromLocation({ search: "?redirect=%2F%2Fevil.example", origin: ORIGIN })
    ).toBeNull();
  });
});

describe("the start of single sign-on", () => {
  it("names the page to return to, encoded", () => {
    expect(ssoStartPath("google", "/admin?section=users")).toBe(
      "/api/auth/sso/google?redirect=%2Fadmin%3Fsection%3Dusers"
    );
    expect(ssoStartPath("apple", null)).toBe("/api/auth/sso/apple");
  });
});
