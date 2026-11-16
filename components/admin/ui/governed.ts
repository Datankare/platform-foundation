/**
 * components/admin/ui/governed.ts — a change a screen makes on the governed path, and what became
 * of it (TASK-220, SCREEN-FINDINGS P3 and P6; SF-admin-053)
 *
 * The governance screens change things through the same governed paths as the command bar — never
 * a route of their own — so a change is checked, recorded and, under dual control, held exactly as
 * a typed one is:
 *
 *   runAdminAction    POST /api/admin/ai/execute with one action (roles, entitlement groups, the
 *                     password policy, account blocks, the approval policy, the capability map,
 *                     trusted agents);
 *   runConfigAction   POST /api/admin/config-ai/execute (a setting, the dual-control list).
 *
 * Each answers one standing — applied, held (waiting for a second administrator: nothing has
 * changed yet), or refused with the catalogue's sentence for its code (a refused action inside a
 * 200, a refused request, no answer at all) — never a raw code, never a throw. Each screen used to
 * read these answers its own way (Trusted agents' reasonOf could show an empty reason; dual control
 * read a refusal as "held" when its body said so).
 *
 * @module components/admin/ui
 */

import { renderMessage } from "@/platform/errors/messages";
import { isErrorCode, messageKey, type ErrorCode } from "@/platform/errors/registry";
import { handleRefusal, type Refusal } from "@/platform/errors/refusal";
import { adminCall, type CallBody } from "./admin-call";
import { outcome, refusedOutcome, type OutcomeEntry } from "./Outcome";

export type GovernedAnswer =
  | { readonly standing: "applied"; readonly body: CallBody }
  | { readonly standing: "held"; readonly body: CallBody }
  | {
      readonly standing: "refused";
      readonly refusal: Refusal;
      /** The write may have happened: its commit was lost (read the value again). */
      readonly lost: boolean;
    };

/** A refused action's sentence: the catalogue's for its code, with its values; never the code. */
function refusalOf(answer: CallBody): Refusal {
  const code = typeof answer.code === "string" ? answer.code : undefined;
  const params =
    answer.params && typeof answer.params === "object"
      ? (answer.params as Record<string, unknown>)
      : {};
  const message =
    code && isErrorCode(code)
      ? renderMessage(
          messageKey(code as ErrorCode),
          params as Record<string, string | number>
        )
      : renderMessage("screens.admin_console.ui.governed.not_done");
  return handleRefusal(code, { message, params });
}

const LOST = "admin.write_indeterminate";

/** One command-bar action, confirmed on a screen: applied, held, or refused. */
export async function runAdminAction(
  tool: string,
  input: Readonly<Record<string, unknown>>
): Promise<GovernedAnswer> {
  const answer = await adminCall("/api/admin/ai/execute", {
    method: "POST",
    json: { actions: [{ tool, input }] },
  });
  if (!answer.ok)
    return {
      standing: "refused",
      refusal: answer.refusal,
      lost: answer.refusal.code === LOST,
    };
  const results = Array.isArray(answer.body.results) ? answer.body.results : [];
  const first = (results[0] ?? {}) as CallBody;
  if (first.success === true) return { standing: "applied", body: first };
  if (first.held === true) return { standing: "held", body: first };
  return { standing: "refused", refusal: refusalOf(first), lost: first.code === LOST };
}

/** Whether a config answer says the change waits for another administrator. */
function pending(body: CallBody): boolean {
  const data = (body.data ?? {}) as CallBody;
  return (
    body.held === true ||
    data.pendingApproval === true ||
    (data.requiresApproval === true && !data.approvalError)
  );
}

/** One config tool, confirmed on a screen: applied, held, or refused. */
export async function runConfigAction(
  toolId: string,
  input: Readonly<Record<string, unknown>>
): Promise<GovernedAnswer> {
  const answer = await adminCall("/api/admin/config-ai/execute", {
    method: "POST",
    json: { toolId, input },
  });
  // A refused request is refused whatever its body says (TASK-194 round 15, I-2).
  if (!answer.ok)
    return {
      standing: "refused",
      refusal: answer.refusal,
      lost: answer.refusal.code === LOST,
    };
  if (pending(answer.body)) return { standing: "held", body: answer.body };
  if (answer.body.success === false || answer.body.error)
    return {
      standing: "refused",
      refusal: refusalOf(answer.body),
      lost: answer.body.code === LOST,
    };
  return { standing: "applied", body: answer.body };
}

/** What an outcome says beyond the change: for whom, and what a held change waits for. */
export interface GovernedOutcomeMore {
  readonly who?: string;
  readonly heldNext?: string;
  /** Under a held outcome: where it waits (a link to Approvals). */
  readonly heldDetail?: OutcomeEntry["detail"];
}

/**
 * What became of a governed change, as an outcome naming it (`what`: "Turn on the group
 * “Premium”"): done; held — nothing has changed yet, and who decides; or not done and why, with
 * "read it again" when its commit was lost.
 */
export function governedOutcome(
  answer: GovernedAnswer,
  what: string,
  more: GovernedOutcomeMore = {}
): OutcomeEntry {
  const who = more.who ? { who: more.who } : {};
  if (answer.standing === "applied") return outcome("applied", what, who);
  if (answer.standing === "held")
    return outcome("held", what, {
      ...who,
      next: more.heldNext ?? renderMessage("screens.admin_console.ui.governed.held_next"),
      ...(more.heldDetail ? { detail: more.heldDetail } : {}),
    });
  return refusedOutcome(answer.refusal, {
    action: what,
    ...who,
    ...(answer.lost
      ? { next: renderMessage("screens.admin_console.ui.governed.lost_next") }
      : {}),
  });
}

/**
 * A change sent to a route of its own that answers like the governed path (PATCH
 * /api/admin/entitlements: 200 `success`, or 202 `held` under dual control): applied, held, or
 * refused — a 2xx that says neither is not called done.
 */
export async function runRouteChange(
  url: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  json: unknown
): Promise<GovernedAnswer> {
  const answer = await adminCall(url, { method, json });
  if (!answer.ok)
    return {
      standing: "refused",
      refusal: answer.refusal,
      lost: answer.refusal.code === LOST,
    };
  if (answer.body.held === true) return { standing: "held", body: answer.body };
  if (answer.body.success === true) return { standing: "applied", body: answer.body };
  return { standing: "refused", refusal: refusalOf(answer.body), lost: false };
}
