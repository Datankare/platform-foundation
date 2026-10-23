/**
 * @jest-environment node
 */
/**
 * platform/errors/__tests__/request-body.test.ts — requireTextFields (PF v5.1.0, register PR-16)
 */

import { requireTextFields } from "../request-body";

const request = { headers: new Headers() };

async function codeOf(res: Response | null) {
  return res ? ((await res.json()) as { code: string; params?: unknown }) : null;
}

describe("requireTextFields", () => {
  it("passes when every named field is non-empty text", () => {
    expect(
      requireTextFields({ a: "x", b: "y", extra: 5 }, ["a", "b"], request)
    ).toBeNull();
  });

  it.each([7, true, ["x"], { x: 1 }])(
    "refuses a non-text value (%p) as request.invalid_body",
    async (v) => {
      const res = requireTextFields({ a: "x", b: v }, ["a", "b"], request);
      expect(res?.status).toBe(400);
      expect((await codeOf(res))?.code).toBe("request.invalid_body");
    }
  );

  it("checks types before presence: a wrong type wins over a missing field", async () => {
    const res = requireTextFields({ b: 1 }, ["a", "b"], request);
    expect((await codeOf(res))?.code).toBe("request.invalid_body");
  });

  it.each([{}, { a: "" }, { a: null }, { a: "x", b: undefined }])(
    "answers absent, null or empty (%p) as request.missing_fields naming the fields",
    async (body) => {
      const res = requireTextFields(body as Record<string, unknown>, ["a", "b"], request);
      expect(res?.status).toBe(400);
      expect(await codeOf(res)).toMatchObject({
        code: "request.missing_fields",
        params: { fields: ["a", "b"] },
      });
    }
  );
});
