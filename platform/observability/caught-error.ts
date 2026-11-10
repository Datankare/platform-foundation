/**
 * platform/observability/caught-error.ts — A caught error's text goes to the log, never out (R-77)
 *
 * An error's own message can name a table, a constraint, a host, a path or a provider's reply. A
 * result field, a stored record, a thrown error's message or a health answer that carries it
 * reaches a person who should not read it (an admin screen, an API answer, an export) and changes
 * whenever a dependency rewords it. So a caught error's text is logged where it is caught, and
 * what leaves the catch is a fixed text or a code: `__tests__/error-text-not-returned.test.ts`
 * holds every file under platform/, app/api and lib/ to it (TASK-205: R-77, R-78).
 *
 * The practice is MITRE's CWE-209, "Generation of Error Message Containing Sensitive Information"
 * (MITRE Corporation), and the OWASP Error Handling Cheat Sheet (OWASP Foundation): a generic
 * message to the caller, the detail to the log.
 *
 *   } catch (err) {
 *     logCaught(logger, "Device registration failed", err, { userId });
 *     return { success: false, error: WRITE_FAILED };
 *   }
 *
 * @module platform/observability
 */

import type { logger as appLogger } from "@/lib/logger";

/**
 * The caller's own logger: each module passes the `logger` it imports, so a test's
 * jest.mock("@/lib/logger") applies to the line written (this module is loaded early, by the
 * agents' bootstrap, before a suite's mock is registered).
 */
export type CaughtLogger = Pick<typeof appLogger, "error" | "warn">;

/** What a failed write says to its caller: the store's own text is in the log. */
export const WRITE_FAILED = "the write did not complete";

/** What a failed read says to its caller: the store's own text is in the log. */
export const READ_FAILED = "the read did not complete";

/** What a failed call to another service says: its own text is in the log. */
export const CALL_FAILED = "the call did not complete";

/** What a failed health or readiness probe says: its own text is in the log. */
export const PROBE_FAILED = "the check did not complete";

/**
 * Log a caught error with its own text (`error`) and the caller's context. The one place the
 * text of an error caught under platform/ is written; nothing returns it.
 */
export function logCaught(
  logger: CaughtLogger,
  message: string,
  err: unknown,
  context: Readonly<Record<string, unknown>> = {},
  level: "error" | "warn" = "error"
): void {
  if (level === "warn")
    logger.warn(message, {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
  else
    logger.error(message, {
      ...context,
      error: err instanceof Error ? err.message : String(err),
    });
}

/**
 * Run a write: undefined when it succeeded; otherwise the error is logged under `message` with
 * `context`, and WRITE_FAILED is returned for the caller's result.
 */
export async function failedWrite(
  logger: CaughtLogger,
  write: () => Promise<unknown>,
  message: string,
  context: Readonly<Record<string, unknown>> = {}
): Promise<typeof WRITE_FAILED | undefined> {
  try {
    await write();
    return undefined;
  } catch (err) {
    logCaught(logger, message, err, context);
    return WRITE_FAILED;
  }
}
