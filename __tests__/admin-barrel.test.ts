/**
 * __tests__/admin-barrel.test.ts — coverage remediation B5: the platform/admin public API barrel.
 * Importing the barrel exercises its re-export statements (the last admin file at 0%).
 */
import * as adminApi from "@/platform/admin";

describe("platform/admin barrel", () => {
  it("re-exports the config handlers, approval service, and impact helpers", () => {
    expect(typeof adminApi.dispatchConfigTool).toBe("function");
    expect(typeof adminApi.listApprovals).toBe("function");
    expect(typeof adminApi.generateImpactReport).toBe("function");
    expect(adminApi.CONFIG_TOOL_IDS).toBeDefined();
    expect(adminApi.CONFIG_TOOLS).toBeDefined();
  });
});
