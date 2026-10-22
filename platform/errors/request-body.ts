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
