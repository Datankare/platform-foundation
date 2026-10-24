/**
 * platform/jobs/authority.ts — who may enqueue beyond the current tenant (ADR-056 D2)
 *
 * enqueueJob puts work on the queue for the tenant the caller runs in — and nothing else — unless
 * the caller presents a JobAuthority: the capability to enqueue for another tenant, or a platform
 * job. It is an object, not a flag: one is valid only if this module minted it (a WeakSet of the
 * ones it issued), so code that builds `{ holder: "runner" }` itself is refused. Two holders:
 *
 *   the runner     claims its authority once, when its module loads (claimRunnerAuthority — a
 *                  second claim throws, so no other code can obtain it), and hands it to a
 *                  platform job's handler only (JobContext.authority): platform work such as a
 *                  fan-out may enqueue for the tenants it serves;
 *   an operator    operatorJobAuthority(admin) for a verified operator (platform_operate).
 *
 * The issued set is this module copy's own, deliberately not a globalThis singleton: an authority
 * is used in the bundle that minted it (the runner's handlers, the operator's route), and one
 * minted in another copy — or by another copy's runner claim — is not valid here.
 *
 * A tenant's job is given none: its handler, like a request, enqueues for its own tenant only.
 *
 * @module platform/jobs
 */

import { holds, type VerifiedAdmin } from "@/platform/auth/role-governance";
import type { JobAuthority } from "./types";

/** The permission an operator needs (the operator console's). */
export const OPERATOR_PERMISSION = "platform_operate";

const issued = new WeakSet<object>();
let runnerClaimed = false;

function mint(holder: string): JobAuthority {
  const authority: JobAuthority = Object.freeze({ holder });
  issued.add(authority);
  return authority;
}

/** Whether `value` is an authority this module issued. */
export function isJobAuthority(value: unknown): value is JobAuthority {
  return typeof value === "object" && value !== null && issued.has(value);
}

/**
 * The runner's authority — claimed once, by platform/jobs/runner.ts as it loads. Any later claim
 * throws: nothing else can hold it.
 */
export function claimRunnerAuthority(): JobAuthority {
  if (runnerClaimed) {
    throw new Error(
      "The job runner's authority is already held (platform/jobs/runner.ts)"
    );
  }
  runnerClaimed = true;
  return mint("runner");
}

/** A verified operator's authority; null when the admin does not hold platform_operate. */
export function operatorJobAuthority(admin: VerifiedAdmin): JobAuthority | null {
  if (!holds(admin, OPERATOR_PERMISSION)) return null;
  return mint(`operator:${admin.userId}`);
}
