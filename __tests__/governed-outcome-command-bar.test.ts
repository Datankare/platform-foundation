/**
 * @jest-environment node
 */
/**
 * __tests__/governed-outcome-command-bar.test.ts — a governed config write's failure, as the
 * command bar answers it (TASK-194 round 14, items 1 and 2)
 *
 * fromGovernedConfig answered every failed write `admin.action_failed`: a change already waiting
 * for approval, the audit log unavailable and a lost commit read alike. It answers the write's
 * own code now, `admin.action_failed` only when it has none (its text logged); a refused value
 * answers `admin.config_invalid_value` with its structured reason.
 */

import { fromGovernedConfig } from "@/app/api/admin/ai/handlers/shared";
import { logger } from "@/lib/logger";
import type { GovernedConfigOutcome } from "@/platform/admin/governed-config";

const result = { toolId: "update_config", success: true, data: {}, durationMs: 0 };

it.each([
  ["approvals.already_pending", { key: "agent.trusted_agents" }],
  ["service.unavailable", { service: "audit" }],
  ["admin.write_indeterminate", {}],
] as const)("answers a write that failed with %s by that code", (code, params) => {
  const outcome = { kind: "failed", result, code, params } as GovernedConfigOutcome;
  expect(fromGovernedConfig(outcome, "agent.trusted_agents", "s")).toEqual({
    success: false,
    error: code,
    code,
    params,
    // A lost commit may stand: audited indeterminate, never failed (round 15, I-3).
    ...(code === "admin.write_indeterminate" ? { indeterminate: true } : {}),
  });
});

it("answers a failure with no code admin.action_failed, its text logged", () => {
  const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
  const outcome = {
    kind: "failed",
    result: { ...result, success: false, error: "db said no" },
  } as GovernedConfigOutcome;
  expect(fromGovernedConfig(outcome, "k", "s")).toMatchObject({
    code: "admin.action_failed",
  });
  expect(error).toHaveBeenCalledWith(
    "Governed config write failed",
    expect.objectContaining({ error: "db said no" })
  );
  error.mockRestore();
});

it("answers a refused value with its structured reason", () => {
  const outcome = {
    kind: "invalid",
    errors: ["Value 0 is below minimum 60"],
    params: { key: "k", reason: "below_min", min: 60 },
  } as GovernedConfigOutcome;
  expect(fromGovernedConfig(outcome, "k", "s")).toMatchObject({
    code: "admin.config_invalid_value",
    params: { key: "k", reason: "below_min", min: 60 },
  });
});
