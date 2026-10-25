/**
 * platform/admin/hold-keys.ts — Which runtime holds are config changes, and of which key
 *
 * Shared by the hold authority (hold-authority.ts), which decides them, and the withdrawal of
 * superseded holds (hold-withdrawal.ts, review 12 H2), which must find every pending hold on a key.
 *
 * @module platform/admin
 */

/** The config tools whose holds the platform runs on approval. */
export const CONFIG_HOLD_TOOLS: ReadonlySet<string> = new Set([
  "update_config",
  "reset_config",
]);

/** The config key a proposal's payload names, if any. */
export function proposalConfigKey(payload: Record<string, unknown>): string | undefined {
  const k = payload["key"] ?? payload["configKey"];
  return typeof k === "string" ? k : undefined;
}
