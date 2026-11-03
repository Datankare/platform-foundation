/**
 * @jest-environment node
 */
/**
 * platform/errors/__tests__/request-body.test.ts — requireTextFields (PF v5.1.0, register PR-16)
 */

import { readJsonBody, requireTextFields, type InputSchemaNode } from "../request-body";
import { unmarkedOpenNodes } from "@/platform/admin/input-keys";

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

describe("readJsonBody (TASK-200, rule 5: schema first)", () => {
  const SCHEMA = {
    type: "object",
    properties: {
      email: { type: "string" },
      rules: {
        type: "array",
        items: { type: "object", properties: { max: { type: "number" } } },
      },
    },
  };
  const post = (body: string) =>
    new Request("http://localhost/x", { method: "POST", body, headers: new Headers() });

  it("takes a body whose every key the schema names", async () => {
    const r = await readJsonBody(post('{"email":"a@b.c","rules":[{"max":1}]}'), SCHEMA);
    expect(r).toEqual({ ok: true, body: { email: "a@b.c", rules: [{ max: 1 }] } });
  });

  it.each([
    ['{"email":"a@b.c","role":"super_admin"}', "request.unknown_input", "role"],
    ['{"rules":[{"max":1,"note":"x"}]}', "request.unknown_input", "rules[0].note"],
    ['{"email":{"nested":1}}', "request.unknown_input_none", "email.nested"],
  ])("refuses %s before a field is read: %s at %s", async (raw, code, field) => {
    const r = await readJsonBody(post(raw), SCHEMA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.response.status).toBe(400);
      const body = await r.response.json();
      expect([body.code, body.params.field]).toEqual([code, field]);
    }
  });

  const refusedAt = async (raw: string, schema: InputSchemaNode) => {
    const r = await readJsonBody(post(raw), schema);
    return r.ok
      ? null
      : ((await r.response.json()) as { params: { field: string } }).params.field;
  };

  it("[self-test] an open node that does not say why takes no key, at the top or at any depth", async () => {
    // `{}` as the whole body's schema took every key (review: satisfiable without a schema).
    expect(await refusedAt('{"anything":1}', {})).toBe("anything");
    expect(await refusedAt("{}", {})).toBeNull();
    const nested: InputSchemaNode = {
      type: "object",
      properties: {
        filter: {},
        list: { type: "array", items: {} },
        short: { openBecause: "the caller's own" },
      },
    };
    expect(await refusedAt('{"filter":{"role":"super_admin"}}', nested)).toBe(
      "filter.role"
    );
    expect(await refusedAt('{"list":[{"x":1}]}', nested)).toBe("list[0].x");
    expect(await refusedAt('{"short":{"x":1}}', nested)).toBe("short.x");
    // Scalars under a closed node are values, as before.
    expect(await refusedAt('{"filter":"x","list":[1,"a"]}', nested)).toBeNull();
  });

  it("an open node that says why (openBecause, four words or more) takes the caller's own shape", async () => {
    const schema: InputSchemaNode = {
      type: "object",
      properties: {
        value: { openBecause: "a config entry's value has the entry's own shape" },
      },
    };
    expect(await refusedAt('{"value":{"any":{"depth":[{"x":1}]}}}', schema)).toBeNull();
    expect(await refusedAt('{"other":1}', schema)).toBe("other");
    expect(unmarkedOpenNodes(schema)).toEqual([]);
    expect(
      unmarkedOpenNodes({
        type: "object",
        properties: { a: {}, b: { type: "array", items: {} } },
      })
    ).toEqual(["a", "b[]"]);
    expect(unmarkedOpenNodes({})).toEqual([""]);
  });

  it("[self-test] the body itself is never open, marked or not", async () => {
    const marked: InputSchemaNode = { openBecause: "the caller's own shape, any keys" };
    expect(await refusedAt('{"role":"super_admin"}', marked)).toBe("role");
    expect(unmarkedOpenNodes(marked)).toEqual([""]);
  });

  it("answers malformed JSON and a non-object as readJsonObject does", async () => {
    for (const [raw, code] of [
      ["{nope", "request.invalid_json"],
      ["[1]", "request.invalid_body"],
    ]) {
      const r = await readJsonBody(post(raw), SCHEMA);
      expect(r.ok ? null : (await r.response.json()).code).toBe(code);
    }
  });
});
