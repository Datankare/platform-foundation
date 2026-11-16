/**
 * components/admin/ui/admin-call.ts — the one way an admin screen calls the API (TASK-216,
 * SCREEN-FINDINGS P6 and P13)
 *
 * Each screen wrote its own call: several showed `body.message ?? body.code` — a bare code where
 * a sentence belongs — and a request that never got an answer rejected unhandled, leaving
 * "Loading…" or a disabled button for ever (the command bar's confirm, the panel reads, dual
 * control). One helper, one answer:
 *
 *   { ok: true,  status, body }      a 2xx — 202 included: a held change is not a refusal, and
 *                                     its caller reads `body.held`;
 *   { ok: false, refusal, body }     anything else: the Refusal the shared handler decides
 *                                     (platform/errors/refusal.ts — the catalogue's sentence for
 *                                     the code, never the code), or networkRefusal() when no
 *                                     answer came. It never throws.
 *
 * The request goes through apiFetch (ADR-057: the cookie session, and `x-csrf-token` on a
 * state-changing call). An account that no longer exists ends the session here, once, for every
 * screen.
 *
 * @module components/admin/ui
 */

import { apiFetch } from "@/platform/auth/api-fetch";
import {
  announceSessionEnd,
  handleRefusal,
  networkRefusal,
  type Refusal,
} from "@/platform/errors/refusal";

export type CallBody = Record<string, unknown>;

export type CallResult =
  | { readonly ok: true; readonly status: number; readonly body: CallBody }
  | {
      readonly ok: false;
      /** Absent when no answer came. */
      readonly status?: number;
      readonly refusal: Refusal;
      /** What the refusal's body carried besides its code (a decision's `approvalKept`, …). */
      readonly body: CallBody;
    };

/**
 * A call's method and body. A plain read is a GET; a call with a body names its method — never a
 * method implied by the body — so a reader of the source (and the awaited-requests guard,
 * __tests__/e2e-awaited-requests.test.ts, TASK-218) sees what each call sends.
 */
export type CallOptions =
  | { readonly method?: "GET"; readonly json?: undefined }
  | {
      readonly method: "POST" | "PATCH" | "PUT" | "DELETE";
      /** Sent as the JSON body, with its content type. */
      readonly json?: unknown;
    };

async function bodyOf(res: Response): Promise<CallBody> {
  try {
    const parsed = (await res.json()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as CallBody)
      : {};
  } catch {
    // No body, or not JSON (a proxy's page): the status alone decides.
    return {};
  }
}

/** The Refusal a refused answer's body carries. */
export function refusalFrom(status: number, body: CallBody): Refusal {
  const refusal = handleRefusal(body.code, {
    message: typeof body.message === "string" ? body.message : body.error,
    params: body.params,
    status,
  });
  if (refusal.kind === "signed-out-erased") announceSessionEnd(refusal.code);
  return refusal;
}

export async function adminCall(
  url: string,
  options: CallOptions = {}
): Promise<CallResult> {
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: options.method ?? "GET",
      ...(options.json !== undefined
        ? {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options.json),
          }
        : {}),
    });
  } catch {
    return { ok: false, refusal: networkRefusal(), body: {} };
  }
  const body = await bodyOf(res);
  if (res.ok) return { ok: true, status: res.status, body };
  return { ok: false, status: res.status, refusal: refusalFrom(res.status, body), body };
}
