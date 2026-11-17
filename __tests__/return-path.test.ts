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

  // Fixed cases, so the result never depends on a fast-check seed (batch 56e-2). Each is a value
  // the browser's URL parser (WHATWG, as Node's URL) resolves to another site, or to a path that
  // starts "//" (another site to the next redirect): dot segments plain or percent-encoded
  // (%2e), backslashes (read as slashes), a tab, newline or carriage return the parser drops,
  // leading whitespace it strips, and scheme-relative forms.
  it.each([
    "/.//evil.example",
    "/..//evil.example",
    "/a/..//evil.example",
    "/%2e//evil.example",
    "/%2E//evil.example",
    "/%2e%2e//evil.example",
    "/%2E%2E//evil.example",
    "/.%2e//evil.example",
    "/%2e.//evil.example",
    "/a/%2e%2e//evil.example",
    "/%09/..//evil.example",
    "/.//",
    "/./\\evil.example",
    "/.\\/evil.example",
    "/a\\..\\..\\/evil.example",
    "\\\\evil.example",
    "\\/evil.example",
    " //evil.example",
    " /account",
    "\t//evil.example",
    "\n//evil.example",
    "/\r/evil.example",
    "/\u0000/evil.example",
    "/\u007f/evil.example",
    "\u00a0//evil.example",
    "https:evil.example",
    "https:/evil.example",
    "//evil.example@app.example.com/",
    "/\\\\evil.example",
  ])(
    "[hostile:open-redirect] refuses %j, which leaves the site or normalises to //host (batch 56e-2)",
    (raw) => {
      expect(safeReturnPath(raw, ORIGIN)).toBeNull();
    }
  );

  // Encoded slashes and backslashes stay encoded in a path: the browser asks this site for that
  // path, it never reads them as a way to another host. Kept, as the parser writes them.
  it.each([
    ["/%2f%2fevil.example", "/%2f%2fevil.example"],
    ["/%2F/evil.example", "/%2F/evil.example"],
    ["/%5c%5cevil.example", "/%5c%5cevil.example"],
    ["/%252f%252fevil.example", "/%252f%252fevil.example"],
    ["/a/%2e%2e/account", "/account"],
    ["/\u3000/x", "/%E3%80%80/x"],
    ["/\uff0f/evil.example", "/%EF%BC%8F/evil.example"],
    ["/\u00a0//evil.example", "/%C2%A0//evil.example"],
    ["/account ", "/account"],
  ])("[hostile:open-redirect] keeps %j on this site as %j", (raw, kept) => {
    expect(safeReturnPath(raw, ORIGIN)).toBe(kept);
    expect(new URL(kept, ORIGIN).origin).toBe(ORIGIN);
  });

  it("refuses what is not text", () => {
    expect(safeReturnPath(null, ORIGIN)).toBeNull();
    expect(safeReturnPath(undefined, ORIGIN)).toBeNull();
  });

  /** What a kept value must be: a path on this site that stays one when read again. */
  const soundlyKept = (kept: string) => {
    expect(kept.startsWith("/")).toBe(true);
    expect(kept.startsWith("//")).toBe(false);
    expect(kept.startsWith("/\\")).toBe(false);
    // eslint-disable-next-line no-control-regex -- the control characters are what is refused
    expect(/[\u0000-\u001f\u007f]/.test(kept)).toBe(false);
    // A backslash may stay in a query or fragment; never in the path.
    expect(kept.split(/[?#]/)[0]!.includes("\\")).toBe(false);
    const url = new URL(kept, ORIGIN);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname.startsWith("//")).toBe(false);
    // Read again — by the next redirect, or the browser — it is the same page.
    expect(safeReturnPath(kept, ORIGIN)).toBe(kept);
  };

  it("whatever is given, the answer is null or a path on this site's origin", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 60 }), (a, b) => {
        for (const raw of [a, `/${a}`, `//${a}`, `/${a}/${b}`, "/\\" + a]) {
          const kept = safeReturnPath(raw, ORIGIN);
          if (kept !== null) soundlyKept(kept);
        }
      })
    );
  });

  // The pieces an open redirect is made of, so the generator meets them often, not by chance.
  const PIECES = [
    "/",
    "//",
    "\\",
    ".",
    "..",
    "%2e",
    "%2E",
    "%2e%2e",
    ".%2e",
    "%2f",
    "%2F",
    "%5c",
    "%5C",
    "%09",
    "%0a",
    "%252f",
    "\t",
    "\n",
    "\r",
    " ",
    "\u0000",
    "\u007f",
    "\u00a0",
    "\u3000",
    "\uff0f",
    "evil.example",
    "app.example.com",
    "@",
    ":",
    "?",
    "#",
    "a",
    "https:",
    "javascript:",
    "auth",
    "api",
  ];

  it("[hostile:open-redirect] built from slashes, backslashes, dots, encodings, controls and whitespace, the answer is null or a path on this site", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("", "/", " ", "\t", "\\"),
        fc.array(fc.constantFrom(...PIECES), { maxLength: 10 }),
        (lead, parts) => {
          const raw = lead + parts.join("");
          const kept = safeReturnPath(raw, ORIGIN);
          if (kept !== null) soundlyKept(kept);
          // Anything the browser would resolve off this site is refused.
          let leaves = false;
          try {
            const url = new URL(raw, ORIGIN);
            leaves = url.origin !== ORIGIN || url.pathname.startsWith("//");
          } catch {
            leaves = true;
          }
          if (leaves) expect(kept).toBeNull();
        }
      )
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
