/**
 * __tests__/response-schema.test.ts — a route answers only the fields it declared (TASK-215, A-13)
 *
 * Hostile: a handler returns a field its schema does not list — a network address in a row, a
 * token beside a result. Outside production the answer fails, naming the field; in production the
 * field is removed and logged, never sent. Errors are checked against the one error body; a body
 * that is not JSON is passed through.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: () => "req-test",
}));

import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  UndeclaredResponseFieldError,
  checkedResponse,
  undeclaredFields,
  withoutUndeclared,
  type ResponseSchema,
} from "@/platform/errors/response-schema";
import { tenantRoute } from "@/platform/tenancy/route";
import { authResultSchema } from "@/platform/auth/auth-response-schema";

const USERS: ResponseSchema = {
  type: "object",
  properties: {
    users: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, email: { type: "string" } },
      },
    },
    counts: { type: "object", values: { type: "number" } },
    value: { json: "a setting's value, whose shape is the setting's own" },
  },
};

describe("response schemas (TASK-215, A-13)", () => {
  const env = process.env.NODE_ENV;
  afterEach(() => {
    (process.env as Record<string, string | undefined>).NODE_ENV = env;
    jest.clearAllMocks();
  });

  it("names every undeclared field, at any depth; maps and declared documents take any key", () => {
    expect(
      undeclaredFields(USERS, {
        users: [{ id: "1", email: "a", ipAddress: "203.0.113.5" }],
        counts: { users: 1, audit_log: 2 },
        value: { anything: { nested: true } },
        token: "x",
      })
    ).toEqual(["users[0].ipAddress", "token"]);
    expect(
      undeclaredFields(
        { type: "object", properties: { a: { type: "string" } } },
        { a: { b: 1 } }
      )
    ).toEqual(["a.b"]);
    expect(
      undeclaredFields({ type: "object", properties: { a: {} } }, { a: { b: 1 } })
    ).toEqual(["a.b"]);
    // A document's reason must say why (four words or more): a short one is read closed.
    expect(
      undeclaredFields(
        { type: "object", properties: { a: { json: "free" } } },
        { a: { b: 1 } }
      )
    ).toEqual(["a.b"]);
  });

  it("withoutUndeclared keeps exactly the declared fields", () => {
    expect(
      withoutUndeclared(USERS, {
        users: [{ id: "1", ipAddress: "x" }],
        token: "t",
        counts: { a: 1 },
      })
    ).toEqual({ users: [{ id: "1" }], counts: { a: 1 } });
  });

  it("outside production, a route answering an undeclared field fails, naming it", async () => {
    const GET = tenantRoute(
      async () =>
        NextResponse.json({ users: [{ id: "1", email: "a", ipAddress: "203.0.113.5" }] }),
      USERS
    );
    await expect(GET()).rejects.toThrow(UndeclaredResponseFieldError);
    await expect(GET()).rejects.toThrow(/users\[0\]\.ipAddress/);
  });

  it("in production, the undeclared field is removed and logged, never sent", async () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const res = await checkedResponse(
      NextResponse.json({
        users: [{ id: "1", email: "a", ipAddress: "203.0.113.5" }],
        secret: "s",
      }),
      USERS,
      "/api/admin/users"
    );
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ users: [{ id: "1", email: "a" }] });
    expect(text).not.toContain("203.0.113.5");
    expect(logger.error).toHaveBeenCalledWith(
      "response.undeclared_fields: removed from the answer",
      expect.objectContaining({
        route: "/api/admin/users",
        fields: ["users[0].ipAddress", "secret"],
      })
    );
  });

  it("an error is held to the one error body; a declared answer and a stream pass unchanged", async () => {
    const err = NextResponse.json(
      { code: "x", message: "m", params: { a: 1 }, success: false, error: "m", leak: 1 },
      { status: 400 }
    );
    await expect(checkedResponse(err, USERS, "/r")).rejects.toThrow(/leak/);
    const ok = NextResponse.json({ users: [] });
    expect(await checkedResponse(ok, USERS, "/r")).toBe(ok);
    const stream = new Response("a\nb\n", {
      headers: { "content-type": "application/x-ndjson" },
    });
    expect(await checkedResponse(stream, USERS, "/r")).toBe(stream);
  });

  it("[hostile] an auth route answering a token has it reported: no auth answer declares one (ADR-057)", () => {
    const schema = authResultSchema();
    expect(
      undeclaredFields(schema, {
        success: true,
        userId: "u-1",
        accessToken: "eyJ.planted",
        refreshToken: "r",
        idToken: "i",
        expiresIn: 3600,
      }).sort()
    ).toEqual(["accessToken", "expiresIn", "idToken", "refreshToken"]);
    expect(
      withoutUndeclared(schema, { success: true, accessToken: "eyJ.planted" })
    ).toEqual({
      success: true,
    });
  });
});
