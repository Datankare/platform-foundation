/**
 * platform/errors/respond.ts — The only way an API route returns an error (ADR-051 D3)
 *
 *   return apiError("request.missing_fields", { params: { fields: ["email"] }, request });
 *
 * Body: { code, message, params } — `code` is stable (act on it), `message` is rendered in the
 * request's locale (Accept-Language, English fallback), `params` are the values used, so any
 * client can re-render the message itself. Status comes from the registry.
 *
 * Compatibility (until Sprint 7B, TASK-110): the body also carries `success: false` and
 * `error: <message>` — deprecated aliases for screens that still read them. Clients act on `code`. `internal.error`
 * always carries a `requestId` (generated when not given) and never internal detail; a
 * `retryAfterSeconds` param also sets the Retry-After header.
 *
 * @module platform/errors
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
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

/** A reference for a 500 — self-contained, so the error path depends on nothing that can fail. */
function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  params: ErrorParams;
  /** @deprecated compatibility alias until Sprint 7B (TASK-110) — always false. */
  success: false;
  /** @deprecated compatibility alias until Sprint 7B (TASK-110) — equals `message`. */
  error: string;
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
    params.requestId = newRequestId();
  }
  const locale =
    options.locale ?? negotiateLocale(options.request?.headers.get("accept-language"));
  const message = renderMessage(messageKey(code), params, locale);
  return { code, message, params, success: false, error: message };
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

/**
 * A 500 whose detail goes to the log only: logs the error with a fresh request id and returns
 * `internal.error` carrying that id, so a user's report can be matched to the log line. Never
 * put an internal error's text in a response (OWASP A04/A09 — information exposure).
 */
export function internalError(
  err: unknown,
  options: {
    request?: { headers: Headers; nextUrl?: { pathname: string } };
    context?: string;
  } = {}
): NextResponse {
  const requestId = newRequestId();
  try {
    logger.error(options.context ?? "Internal error", {
      requestId,
      route: options.request?.nextUrl?.pathname,
      error:
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "non-Error thrown",
    });
  } catch {
    // Logging must not turn a 500 into an unhandled throw.
  }
  return apiError("internal.error", { params: { requestId }, request: options.request });
}
