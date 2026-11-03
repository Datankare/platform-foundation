/**
 * keepAliveForProbes — keeps a request's function alive until the paid health checks it started
 * have settled (TASK-197 review round 2).
 *
 * A paid probe answers "pending" within the readiness bound and keeps running (CachedHealthProbe,
 * PAID_PROBE_CACHE). On a serverless platform the function is frozen once the response is sent,
 * so that check would stall and "time out" on the next thaw. `after()` (Next.js) runs the wait
 * within the request's lifecycle (waitUntil), bounded by the function's maxDuration; the probe
 * itself abandons a check older than twice its budget and never caches its answer.
 */
import { after } from "next/server";
import { settlePendingProbes } from "./health";

export function keepAliveForProbes(): void {
  try {
    after(() => settlePendingProbes());
  } catch {
    // Outside a request scope (a test, a script): there is no function to keep alive.
  }
}
