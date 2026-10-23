/**
 * platform/errors/request-body.ts — Read a JSON object body, or answer with the coded 400
 *
 * `await request.json()` throws on a malformed body and happily returns `null`, an array or a
 * number for a well-formed one. Routes that destructured the result crashed into an uncoded 500
 * (audit I-4/I-5; found again by the monkey run, scripts/monkey). A route reads its body here:
 * malformed JSON → `request.invalid_json`, anything but a plain object → `request.invalid_body`.
 *
 * @module platform/errors
 */

import type { NextResponse } from "next/server";
import { apiError } from "./respond";

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
