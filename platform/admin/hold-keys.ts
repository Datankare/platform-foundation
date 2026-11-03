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

/**
 * The field each config write tool names its key in (TASK-194, audit C-1): update_config and
 * reset_config act on `key`, request_approval on `configKey`. The one source for the route that
 * checks the key's tier permission, the handlers that act on it and the holds that decide it — so
 * the key checked is always the key changed. Before, the execute route checked `key` when it was
 * set and `configKey` otherwise, and request_approval acted on `configKey`: a request naming a
 * standard key as `key` and a safety key as `configKey` passed a standard-tier admin.
 */
export const CONFIG_TOOL_TARGET_FIELD: Readonly<Record<string, "key" | "configKey">> = {
  update_config: "key",
  reset_config: "key",
  request_approval: "configKey",
};

/** The key config tool `toolId` acts on, read from the field it acts on; undefined if none. */
export function configToolTargetKey(
  toolId: string,
  input: Record<string, unknown>
): string | undefined {
  const field = CONFIG_TOOL_TARGET_FIELD[toolId];
  const k = field ? input[field] : undefined;
  return typeof k === "string" ? k : undefined;
}

/** The config key a proposal's payload names, if any (for messages and records). */
export function proposalConfigKey(payload: Record<string, unknown>): string | undefined {
  const k = payload["key"] ?? payload["configKey"];
  return typeof k === "string" ? k : undefined;
}
