/**
 * __tests__/contract/health-probe-contract.ts
 * HealthProbe conformance kit (TCK) — ADR-027. Not a *.test.ts.
 */

import type { HealthProbe } from "@/platform/observability/types";

const VALID_STATUS = ["healthy", "degraded", "unhealthy"];
const ISO = /^\d{4}-\d{2}-\d{2}T/;

export interface HealthProbeContractFixtures {
  makeProbe: () => HealthProbe | Promise<HealthProbe>;
}

export function runHealthProbeContract(fx: HealthProbeContractFixtures): void {
  let probe: HealthProbe;

  beforeEach(async () => {
    probe = await fx.makeProbe();
  });

  describe("name", () => {
    it("exposes a non-empty name", () => {
      expect(typeof probe.name).toBe("string");
      expect(probe.name.length).toBeGreaterThan(0);
    });
  });

  describe("check", () => {
    it("returns a well-formed health check result", async () => {
      const result = await probe.check();
      expect(result.name).toBe(probe.name);
      expect(VALID_STATUS).toContain(result.status);
      expect(result.checkedAt).toMatch(ISO);
      if (result.latencyMs !== undefined) {
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      }
    });
  });
}
