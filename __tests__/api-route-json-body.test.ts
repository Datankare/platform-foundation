/**
 * __tests__/api-route-json-body.test.ts — routes read JSON bodies through readJsonObject (audit I-4/I-5)
 *
 * `request.json()` returns null, arrays and numbers for well-formed JSON; routes that
 * destructured the result crashed into uncoded 500s, which the monkey run (scripts/monkey) found
 * on three routes the unit tests never sent a null body to. Every route now reads its body with
 * readJsonObject (platform/errors/request-body.ts), which answers request.invalid_json or
 * request.invalid_body; this keeps it that way.
 */

import { readJsonObject } from "@/platform/errors";
import { apiRoutes, read } from "./helpers/route-policy";

const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const req = (body: string) => new Request("http://localhost/x", { method: "POST", body });

describe("JSON request bodies", () => {
  it("no route parses a body with request.json() directly", () => {
    const direct = apiRoutes().filter((f) => /\brequest\.json\(\)/.test(code(read(f))));
    expect(direct).toEqual([]);
  });

  it("the checker sees a direct call", () => {
    expect(/\brequest\.json\(\)/.test(code("const b = await request.json();"))).toBe(
      true
    );
    expect(/\brequest\.json\(\)/.test(code("// request.json()"))).toBe(false);
  });

  it.each([
    ["malformed JSON", "{nope", "request.invalid_json"],
    ["an empty body", "", "request.invalid_json"],
    ["null", "null", "request.invalid_body"],
    ["an array", "[1]", "request.invalid_body"],
    ["a number", "42", "request.invalid_body"],
    ["a string", '"x"', "request.invalid_body"],
  ])("readJsonObject answers %s with a coded 400", async (_label, raw, expected) => {
    const result = await readJsonObject(req(raw));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      expect((await result.response.json()).code).toBe(expected);
    }
  });

  it("returns a plain object body", async () => {
    expect(await readJsonObject(req('{"a":1}'))).toEqual({ ok: true, body: { a: 1 } });
  });
});
