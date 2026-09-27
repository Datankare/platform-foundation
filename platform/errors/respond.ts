/**
 * platform/errors/respond.ts — The only way an API route returns an error (ADR-051 D3)
 *
 *   return apiError("request.missing_fields", { params: { fields: ["email"] }, request });
 *
 * Body: { code, message, params } — `code` is stable (act on it), `message` is rendered in the
 * request's locale (Accept-Language, English fallback), `params` are the values used, so any
 * client can re-render the message itself. Status comes from the registry. `internal.error`
 * always carries a `requestId` (generated when not given) and never internal detail; a
 * `retryAfterSeconds` param also sets the Retry-After header.
 *
 * @module platform/errors
 */

import { NextResponse } from "next/server";
import { generateRequestId } from "@/lib/logger";
import {
  ERROR_CODES,
  messageKey,
  type ErrorCode,
  type ErrorCodeSpec,
} from "@/platform/errors/registry";
import {
  negotiateLocale,
  renderMessage,
  type MessageValues,
} from "@/platform/errors/messages";

export type ErrorParams = MessageValues;

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  params: ErrorParams;
}

export interface ApiErrorOptions {
  params?: ErrorParams;
  /** The incoming request — used only to pick the message locale. */
  request?: { headers: Headers };
  /** Explicit locale (e.g. the user's preference); wins over Accept-Language. */
  locale?: string;
  headers?: Record<string, string>;
}

/** The error body for a code — for callers that build their own response. */
export function apiErrorBody(
  code: ErrorCode,
  options: ApiErrorOptions = {}
): ApiErrorBody {
  const spec: ErrorCodeSpec = ERROR_CODES[code];
  const params: Record<string, string | number | readonly string[]> = {
    ...(options.params ?? {}),
  };
  if (spec.params.some((p) => p.name === "requestId") && params.requestId === undefined) {
    params.requestId = generateRequestId();
  }
  const locale =
    options.locale ?? negotiateLocale(options.request?.headers.get("accept-language"));
  return { code, message: renderMessage(messageKey(code), params, locale), params };
}

export function apiError(code: ErrorCode, options: ApiErrorOptions = {}): NextResponse {
  const body = apiErrorBody(code, options);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const retry = body.params.retryAfterSeconds;
  if (typeof retry === "number" && Number.isFinite(retry)) {
    headers["Retry-After"] = String(Math.max(0, Math.ceil(retry)));
  }
  return NextResponse.json(body, { status: ERROR_CODES[code].status, headers });
}
