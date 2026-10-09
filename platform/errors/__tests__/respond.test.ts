/**
 * ADR-051 D3: { code, message, params } bodies, locale negotiation, rendering fallbacks.
 */
import {
  apiError,
  apiErrorBody,
  errorFromResult,
  internalError,
} from "@/platform/errors/respond";
import { logger } from "@/lib/logger";
import {
  availableLocales,
  catalogKeys,
  lookup,
  negotiateLocale,
  renderMessage,
} from "@/platform/errors/messages";
import { isErrorCode, messageKey } from "@/platform/errors/registry";
import * as barrel from "@/platform/errors";

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const REQ_ID = /^req_[0-9a-f]{16}$/;

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
      success: false,
      error: "Required: email and password.",
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
    expect(body.params.requestId).toMatch(REQ_ID);
    expect(body.message).toContain(body.params.requestId);
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

describe("internalError", () => {
  it("logs the detail with a request id and returns only the id", async () => {
    const request = {
      headers: new Headers(),
      nextUrl: { pathname: "/api/admin/roles" },
    };
    const res = internalError(new Error("relation users does not exist"), {
      request,
      context: "Roles query failed",
    });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.code).toBe("internal.error");
    expect(JSON.stringify(body)).not.toContain("relation users");
    expect(logger.error).toHaveBeenCalledWith("Roles query failed", {
      requestId: body.params.requestId,
      route: "/api/admin/roles",
      error: "relation users does not exist",
    });
  });

  it("never throws, even when logging does", () => {
    (logger.error as jest.Mock).mockImplementationOnce(() => {
      throw new Error("log sink down");
    });
    expect(internalError(new Error("x")).status).toBe(500);
  });

  it("handles strings, non-errors and no options", () => {
    internalError("boom");
    expect(logger.error).toHaveBeenLastCalledWith(
      "Internal error",
      expect.objectContaining({ error: "boom" })
    );
    internalError({ weird: true });
    expect(logger.error).toHaveBeenLastCalledWith(
      "Internal error",
      expect.objectContaining({ error: "non-Error thrown" })
    );
  });
});

describe("errorFromResult", () => {
  it("uses the result's code and params", async () => {
    const res = errorFromResult({
      error: "Appeal window has expired (48 hours)",
      errorCode: "moderation.appeal_window_expired",
      errorParams: { hours: 48 },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("moderation.appeal_window_expired");
    expect(body.message).toBe(
      "The appeal window has closed. Appeals must be made within 48 hours."
    );
  });

  it("an uncoded or internal failure is a logged 500 with no detail", async () => {
    for (const result of [
      { error: "Update failed: 500" },
      { error: "No row returned", errorCode: "internal.error" as const },
      {},
    ]) {
      const res = errorFromResult(result, { context: "Review update" });
      expect(res.status).toBe(500);
      expect(JSON.stringify(await res.json())).not.toMatch(/Update failed|No row/);
    }
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
