/**
 * platform/errors/request-body.ts — Read a JSON object body, or answer with the coded 400
 *
 * `await request.json()` throws on a malformed body and happily returns `null`, an array or a
 * number for a well-formed one. Routes that destructured the result crashed into an uncoded 500
 * (audit I-4/I-5; found again by the monkey run, scripts/monkey). A route reads its body here:
 * malformed JSON → `request.invalid_json`, anything but a plain object → `request.invalid_body`.
 *
 * Schema first (TASK-200, rule 5): a route reads its body with `readJsonBody(request, SCHEMA)` —
 * the body checked against the route's declared schema before any field is read: a key the schema
 * does not name, at any depth, is refused (`request.unknown_input`, with the keys allowed there).
 * An open node — `{}`, no type, properties, items or enum — below the top takes any keys only when
 * it says why (`openBecause: "<four words or more>"`, listed in open-input-register.json); unmarked,
 * it is read closed, and the body itself is never open (platform/admin/input-keys.ts,
 * closeUnmarkedOpen): `readJsonBody(request, {})` takes no key, marked or not.
 * `readJsonObject` alone is the old form; __tests__/api-route-body-schema.test.ts refuses it in a
 * new route (the routes before the rule are counted in body-schema-baseline.json, only shrinking).
 *
 * @module platform/errors
 */

import type { NextResponse } from "next/server";
import { apiError } from "./respond";
import {
  closeUnmarkedOpen,
  inputKeyRefusal,
  type InputSchemaNode,
} from "@/platform/admin/input-keys";

export type { InputSchemaNode } from "@/platform/admin/input-keys";

interface JsonRequest {
  json(): Promise<unknown>;
  readonly headers: Headers;
}

export type JsonObjectResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly response: NextResponse };

export async function readJsonObject(request: JsonRequest): Promise<JsonObjectResult> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return { ok: false, response: apiError("request.invalid_json", { request }) };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: apiError("request.invalid_body", { request }) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Read a JSON object body and check its keys against the route's schema before anything reads a
 * field (TASK-200, rule 5). The schema is the route's declared input — `{ type: "object",
 * properties: { … } }`, the JSON Schema subset of platform/admin/input-keys.ts — and a key it does
 * not name, at any depth, is refused: `request.unknown_input` (with the keys allowed there) or
 * `request.unknown_input_none` where none is. An open node that does not say why
 * (`openBecause`), or the body's own top node, is read closed. Values remain the route's to check.
 */
export async function readJsonBody(
  request: JsonRequest,
  schema: InputSchemaNode
): Promise<JsonObjectResult> {
  const read = await readJsonObject(request);
  if (!read.ok) return read;
  const refused = inputKeyRefusal(closeUnmarkedOpen(schema), read.body);
  if (refused) {
    return {
      ok: false,
      response: apiError(refused.code, { params: { ...refused.params }, request }),
    };
  }
  return read;
}

/**
 * Require text fields of a JSON body: each a non-empty string. Absent or empty → the coded
 * `request.missing_fields` naming all of `names`; present but not a string (a number, a list) →
 * `request.invalid_body`. Returns null when all are text. A route that passed the cast
 * `body as { email?: string }` on trust once sent a number to the identity provider — or, in
 * sign-up, to the password rules — and answered an uncoded 500 (PF v5.1.0 monkey run).
 */
export function requireTextFields(
  body: Record<string, unknown>,
  names: readonly string[],
  request: { readonly headers: Headers }
): NextResponse | null {
  if (
    names.some(
      (n) => body[n] !== undefined && body[n] !== null && typeof body[n] !== "string"
    )
  ) {
    return apiError("request.invalid_body", { request });
  }
  if (names.some((n) => typeof body[n] !== "string" || body[n] === "")) {
    return apiError("request.missing_fields", {
      params: { fields: [...names] },
      request,
    });
  }
  return null;
}
