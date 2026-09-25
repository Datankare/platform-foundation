/**
 * budget-config.test.ts — governed agent budget caps (ADR-048 M1).
 */
import * as platformConfig from "@/platform/auth/platform-config";
import {
  resolveDailyCostCap,
  resolveStepCap,
  BUDGET_COST_CAP_KEY,
  BUDGET_STEP_CAP_KEY,
} from "../budget-config";

const spy = jest.spyOn(platformConfig, "getConfig");
afterEach(() => spy.mockReset());
afterAll(() => spy.mockRestore());

describe("governed budget caps (ADR-048)", () => {
  it("a lower governed ceiling tightens the per-agent default", async () => {
    spy.mockResolvedValue(3 as never);
    expect(await resolveDailyCostCap(10)).toBe(3);
    expect(await resolveStepCap(15)).toBe(3);
  });

  it("a higher governed ceiling cannot loosen the default (min-wins)", async () => {
    spy.mockResolvedValue(50 as never);
    expect(await resolveDailyCostCap(10)).toBe(10);
    expect(await resolveStepCap(15)).toBe(15);
  });

  it("an unset governed value falls back to the per-agent default (no regression)", async () => {
    spy.mockImplementation(async (_k: string, d?: unknown) => d as never);
    expect(await resolveDailyCostCap(5)).toBe(5);
    expect(await resolveStepCap(15)).toBe(15);
  });

  it("a config-store failure fails safe to the per-agent default", async () => {
    spy.mockRejectedValue(new Error("db down"));
    expect(await resolveDailyCostCap(5)).toBe(5);
    expect(await resolveStepCap(15)).toBe(15);
  });

  it("reads the governed keys with the per-agent default as fallback", async () => {
    spy.mockResolvedValue(1 as never);
    await resolveDailyCostCap(10);
    await resolveStepCap(12);
    expect(spy).toHaveBeenCalledWith(BUDGET_COST_CAP_KEY, 10);
    expect(spy).toHaveBeenCalledWith(BUDGET_STEP_CAP_KEY, 12);
  });
});
