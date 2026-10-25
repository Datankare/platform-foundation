/**
 * platform/kernel/audit-correlation.ts — Which operation an audit record belongs to (review 12 L1)
 *
 * An approved run's own work may itself be audited (audited(), platform/auth/audit.ts) — the config
 * write a held change makes, inside the run's transaction when it is atomic. Its records carry the
 * hold and operation they belong to, so "attempted" — and the "rolled_back" written when the run's
 * transaction rolls back — can be read against the hold's own records. The action pipeline sets
 * the correlation around an approved run; audited() reads it. Lives in the kernel: the pipeline
 * may not import platform/auth.
 *
 * @module platform/kernel
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The ids an audit record names when written within an approved run. */
export interface AuditCorrelation {
  /** The approved proposal the run is under. */
  readonly holdId?: string;
  /** The run's operation id. */
  readonly operationId?: string;
}

const KEY = Symbol.for("datankare.platform.kernel.auditCorrelation.v1");
type Holder = { [KEY]?: AsyncLocalStorage<AuditCorrelation> };
function storage(): AsyncLocalStorage<AuditCorrelation> {
  const g = globalThis as Holder;
  g[KEY] ??= new AsyncLocalStorage<AuditCorrelation>();
  return g[KEY];
}

/** Run `fn` with `correlation` named on every audit record written within it. */
export function withAuditCorrelation<T>(correlation: AuditCorrelation, fn: () => T): T {
  return storage().run({ ...storage().getStore(), ...correlation }, fn);
}

/** The correlation of the current run, if any. */
export function currentAuditCorrelation(): AuditCorrelation | undefined {
  return storage().getStore();
}
