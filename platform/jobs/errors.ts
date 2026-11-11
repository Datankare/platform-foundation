/**
 * platform/jobs/errors.ts — what a failed job records, and what it never does
 *
 * A job's last_error is shown to operators (the Jobs console) and to a tenant's administrators
 * (their job history), so it is the platform's own wording, never what a dependency said: a
 * database message names tables, columns and constraints; a driver message can carry a host or
 * a credential; an arbitrary thrown object can hold anything. Only a JobFailure — a handler's
 * deliberate, operator-safe explanation — keeps its message. Everything else is reduced to a
 * category, and the full detail goes to the server log and the error reporter with the job's id.
 *
 * @module platform/jobs
 */

import { DataScopeError, DataUnavailableError } from "@/platform/data";

/** A handler's own failure, worded for operators. Its message is recorded as given (trimmed). */
export class JobFailure extends Error {
  readonly code = "jobs.failure";
  constructor(message: string) {
    super(message);
    this.name = "JobFailure";
  }
}

/** An attempt ran past its time. */
export class JobTimeoutError extends Error {
  readonly code = "jobs.timeout";
  constructor(readonly timeoutMs: number) {
    super(`The job did not finish within ${timeoutMs} ms`);
    this.name = "JobTimeoutError";
  }
}

/** The longest last_error the database accepts (050 jobs_last_error_length). */
export const MAX_ERROR_LENGTH = 1000;

/** A Postgres SQLSTATE: five characters, digits and upper-case letters. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Control characters (other than ordinary spaces) are removed: the text is shown in a table. */
function clean(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    out += c < 0x20 || (c >= 0x7f && c < 0xa0) ? " " : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  return out.length > MAX_ERROR_LENGTH ? `${out.slice(0, MAX_ERROR_LENGTH - 1)}…` : out;
}

/**
 * A job whose last attempt's lease lapsed (its worker stopped before it finished): dead, recorded
 * as this code by job_claim (migration 067) and the in-memory store — worded by the Jobs console
 * (screens.jobs.errors.lease_expired). TASK-209: it was English.
 */
export const LEASE_EXPIRED = "lease_expired";

/**
 * The operator-safe description of a thrown value. Never includes a message the platform did
 * not write itself.
 */
export function describeJobError(err: unknown): string {
  // A code, never English (TASK-206, N-102): the Jobs console words it from the catalog
  // (screens.jobs.errors, components/admin/JobsPanels.tsx jobErrorText). `kind:detail` where the
  // failure has one: a handler's own token, the time limit, a SQLSTATE, an error's class.
  if (err instanceof JobFailure) {
    const token = clean(err.message);
    return /^[a-z][a-z0-9_.-]{0,63}$/.test(token) ? `reported:${token}` : "reported";
  }
  if (err instanceof JobTimeoutError) return `timeout:${err.timeoutMs}`;
  if (err instanceof DataUnavailableError) return "database_unavailable";
  if (err instanceof DataScopeError) return "data_scope";
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && SQLSTATE.test(code)) return `sqlstate:${code}`;
    // The class name only: a message may carry a dependency's own text.
    const name = /^[a-z]\w{0,63}$/i.test(err.name) ? err.name : "Error";
    return `unexpected:${name}`;
  }
  if (err === null) return "threw:null";
  const kind = typeof err;
  return `threw:${kind === "object" ? "object" : kind}`;
}

/** The thrown value's own message, for the server log only (the logger redacts secrets). */
export function internalDetail(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return `non-Error thrown: ${typeof err} ${String(err).slice(0, 500)}`;
  } catch {
    return `non-Error thrown: ${typeof err}`;
  }
}
