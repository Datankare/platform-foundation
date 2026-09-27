/**
 * ADR-051 D3: { code, message, params } bodies, locale negotiation, rendering fallbacks.
 */
import { apiError, apiErrorBody } from "@/platform/errors/respond";
import {
  availableLocales,
  catalogKeys,
  lookup,
  negotiateLocale,
  renderMessage,
} from "@/platform/errors/messages";
import { isErrorCode, messageKey } from "@/platform/errors/registry";
import * as barrel from "@/platform/errors";

jest.mock("@/lib/logger", () => ({ generateRequestId: () => "req-123" }));

describe("apiError", () => {
  it("returns the registry status and a coded body", async () => {
    const res = apiError("request.missing_fields", {
      params: { fields: ["email", "password"] },
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      code: "request.missing_fields",
      message: "Required: email and password.",
      params: { fields: ["email", "password"] },
    });
  });

  it("formats numbers per locale", () => {
    expect(apiErrorBody("request.text_too_long", { params: { max: 5000 } }).message).toBe(
      "Text must be 5,000 characters or fewer."
    );
  });

  it("internal.error always carries a requestId and no detail", async () => {
    const res = apiError("internal.error");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.params).toEqual({ requestId: "req-123" });
    expect(body.message).toContain("req-123");
    expect(
      apiErrorBody("internal.error", { params: { requestId: "given" } }).params.requestId
    ).toBe("given");
  });

  it("retryAfterSeconds sets Retry-After", () => {
    const res = apiError("rate.limited", { params: { retryAfterSeconds: 2.2 } });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3");
    expect(apiError("rate.limited").headers.get("Retry-After")).toBeNull();
  });

  it("passes extra headers through", () => {
    expect(
      apiError("auth.required", { headers: { "X-A": "1" } }).headers.get("X-A")
    ).toBe("1");
  });

  it("uses the request's Accept-Language, falling back to English", () => {
    const request = { headers: new Headers({ "accept-language": "fr-CA,fr;q=0.8" }) };
    expect(apiErrorBody("auth.required", { request }).message).toBe(
      "Sign in to continue."
    );
    expect(apiErrorBody("auth.required", { locale: "xx" }).message).toBe(
      "Sign in to continue."
    );
  });
});

describe("negotiateLocale", () => {
  it.each([
    [undefined, "en"],
    ["", "en"],
    ["*", "en"],
    ["fr, de;q=0.5", "en"],
    ["en-GB,en;q=0.9", "en"],
    ["de;q=0, en;q=0.1", "en"],
    ["EN", "en"],
    ["xx;q=abc", "en"],
  ])("%p → %p", (header, want) => {
    expect(negotiateLocale(header as string | undefined)).toBe(want);
  });

  it("only English ships until a locale is decided (ADR-051 D6)", () => {
    expect(availableLocales()).toEqual(["en"]);
  });
});

describe("renderMessage / lookup", () => {
  it("returns the key when a message does not exist", () => {
    expect(renderMessage("errors.nope.nothing")).toBe("errors.nope.nothing");
  });

  it("returns the source text when formatting fails", () => {
    // Missing value for a plain argument makes intl-messageformat throw.
    expect(renderMessage(messageKey("request.invalid_value"), {})).toBe(
      "{field} must be one of: {allowed}."
    );
  });

  it("lookup handles non-objects and non-strings", () => {
    expect(lookup({ a: "x" }, "a.b")).toBeUndefined();
    expect(lookup({ a: { b: 1 } }, "a.b")).toBeUndefined();
    expect(lookup({ a: null }, "a.b")).toBeUndefined();
    expect(catalogKeys({ a: { b: "x", c: 5 }, d: "y" })).toEqual(["a.b", "d"]);
  });

  it("isErrorCode", () => {
    expect(isErrorCode("auth.required")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(7)).toBe(false);
  });

  it("the barrel exports the public API", () => {
    expect(typeof barrel.apiError).toBe("function");
    expect(typeof barrel.renderApiErrorsDoc).toBe("function");
  });
});
