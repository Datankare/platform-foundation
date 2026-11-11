/**
 * @jest-environment node
 */
/**
 * __tests__/jobs-required.test.ts — a required schedule runs whatever its enabled setting says
 * (TASK-194 round 18)
 *
 * @not-guard: reads migration 062 to pin one note's wording; an instance check, not a scan
 *
 * config.expire-approvals settles approvals whose outcome is being checked and lists undecided
 * runs for a person; nothing else does. It is required: its `enabled` setting is ignored (a value
 * set off by hand, or by a tenant, before migration 062 still runs it), and every other job's is
 * read as before. Round 19: a required schedule declares no tenant opt-out (it would turn the job
 * off for that tenant) — defineJob refuses one.
 */

const settings = new Map<string, boolean>();
jest.mock("@/platform/auth/platform-config", () => ({
  ...jest.requireActual("@/platform/auth/platform-config"),
  getConfigBoolean: async (key: string, fallback: boolean) =>
    settings.has(key) ? settings.get(key) : fallback,
}));

import { requiredJob } from "@/platform/errors/recorded-text";
import { renderShown } from "@/platform/errors/shown-text";
import { scheduleEnabled } from "@/platform/jobs/runner";
import {
  defineJob,
  getJobDefinition,
  JobDefinitionError,
  scheduleKeys,
} from "@/platform/jobs/registry";
import { readFileSync } from "fs";
import { join } from "path";
import { refusesRequiredSchedule } from "@/platform/jobs/required-schedule";

beforeEach(() => settings.clear());

describe("scheduleEnabled (round 18)", () => {
  it("config.expire-approvals is required, and its enabled setting off is ignored", async () => {
    expect(getJobDefinition("config.expire-approvals")?.schedule?.required).toBe(true);
    settings.set(scheduleKeys("config.expire-approvals").enabled, false);
    await expect(scheduleEnabled("config.expire-approvals")).resolves.toBe(true);
  });

  it("another job's setting is read as before", async () => {
    settings.set(scheduleKeys("moderation.escalation-reaper").enabled, false);
    await expect(scheduleEnabled("moderation.escalation-reaper")).resolves.toBe(false);
  });
});

describe("defineJob (round 19)", () => {
  // A tenant's opt-out would turn a required job off for that tenant — what `required` forbids.
  it("refuses a required schedule with a tenant opt-out", () => {
    expect(() =>
      defineJob("test.required-opt-out", async () => ({}), {
        description: "required, yet opted out",
        schedule: {
          scope: "each-tenant",
          defaultIntervalMinutes: 60,
          minIntervalMinutes: 15,
          maxIntervalMinutes: 1440,
          tenantOptOutKey: "test.opt_out",
          required: true,
        },
      })
    ).toThrow(JobDefinitionError);
  });

  it("takes a required schedule without one, and an opt-out on one not required", () => {
    const base = {
      scope: "each-tenant" as const,
      defaultIntervalMinutes: 60,
      minIntervalMinutes: 15,
      maxIntervalMinutes: 1440,
    };
    expect(
      defineJob("test.required", async () => ({}), {
        description: "required",
        schedule: { ...base, required: true },
      }).schedule?.required
    ).toBe(true);
    expect(
      defineJob("test.opt-out", async () => ({}), {
        description: "opted out",
        schedule: { ...base, tenantOptOutKey: "test.opt_out" },
      }).schedule?.tenantOptOutKey
    ).toBe("test.opt_out");
  });
});

describe("refusesRequiredSchedule (round 19)", () => {
  const KEY = scheduleKeys("config.expire-approvals").enabled;
  it("refuses config.expire-approvals' enabled key off, or set for a tenant", async () => {
    await expect(refusesRequiredSchedule(KEY, false, "platform")).resolves.toBe(true);
    await expect(refusesRequiredSchedule(KEY, true, "tenant")).resolves.toBe(true);
    await expect(refusesRequiredSchedule(KEY, true, "platform")).resolves.toBe(false);
  });

  it("leaves another job's enabled key, and its interval, to the writer", async () => {
    const other = scheduleKeys("moderation.escalation-reaper");
    await expect(refusesRequiredSchedule(other.enabled, false, "tenant")).resolves.toBe(
      false
    );
    await expect(
      refusesRequiredSchedule(
        scheduleKeys("config.expire-approvals").interval,
        30,
        "platform"
      )
    ).resolves.toBe(false);
  });
});

describe("a required job's withdrawal note (round 20; TASK-209)", () => {
  // One wording for every row withdrawn because its job is required — now the catalog's key and
  // values (screens.records.required_job), which words exactly what migration 062 wrote, so
  // migration 067 moves 062's rows to it by their exact text.
  it("words what migration 062 writes, with the migration named", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/062_expire_approvals_required.sql"),
      "utf8"
    );
    const why = requiredJob(scheduleKeys("config.expire-approvals").enabled);
    const words = renderShown({
      key: "screens.records.config_required_job_062",
      params: { why },
    });
    expect(sql).toContain(`'${words}'`);
    expect(renderShown(why)).toMatch(/now required/);
    expect(renderShown(why)).not.toMatch(/withdrawn/);
  });
});
