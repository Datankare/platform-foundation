/**
 * lib/screening-refusal.ts — the one answer to input the screening did not let through
 * (TASK-211, N-119)
 *
 * A block, a hold for a moderator and an outage were all answered `content.rejected`, and every
 * screen links that refusal to the account page to appeal it — but only a block is a decision
 * recorded against the account that can be appealed. Pure (no server imports): a route, and code
 * whose effects are injected (lib/translate-session.ts, Playform's), map a `SafetyResult` here.
 * __tests__/screening-refusal.test.ts refuses any other source of `content.rejected`.
 *
 * @module lib
 */

import type { ErrorCode } from "@/platform/errors/registry";
import type { SafetyResult } from "@/types";

/** How a route answers input the screening did not let through (TASK-211, N-119). */
export type ScreeningRefusal =
  | { readonly code: "content.rejected"; readonly params: Record<string, never> }
  | { readonly code: "content.held_for_review"; readonly params: Record<string, never> }
  | {
      readonly code: "service.unavailable";
      readonly params: { readonly service: "moderation" };
    };

/**
 * The refusal for input `checkSafety` did not let through — the one way a route answers it
 * (__tests__/screening-refusal.test.ts refuses a route that names `content.rejected` itself):
 *
 *   block     → `content.rejected`: a decision recorded against the account, which the screen
 *               links to on the account page, where it can be appealed;
 *   escalate  → `content.held_for_review`: queued for a moderator; nothing to appeal;
 *   unjudged  → `service.unavailable` (moderation): the screening could not run; nothing was
 *               decided or queued, so the user tries again.
 *
 * A result with no decision (a screening that predates it) is not claimed to be a block: it is
 * answered as held, which offers no appeal for a decision that may not exist.
 */
export function screeningRefusal(
  safety: Pick<SafetyResult, "decision">
): ScreeningRefusal {
  switch (safety.decision) {
    case "block":
      return { code: "content.rejected", params: {} };
    case "unjudged":
      return { code: "service.unavailable", params: { service: "moderation" } };
    default:
      return { code: "content.held_for_review", params: {} };
  }
}

/**
 * The codes a route that answers by screeningRefusal can return (__tests__/refusal-coverage.test.ts
 * reads this: every screen calling such a route must handle each).
 */
export const REFUSAL_GUARDS: Readonly<Record<string, readonly ErrorCode[]>> = {
  screeningRefusal: [
    "content.rejected",
    "content.held_for_review",
    "service.unavailable",
  ],
};
