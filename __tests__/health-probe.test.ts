/**
 * HealthProbe interface contract — reference arm (ADR-027).
 */
import { runHealthProbeContract } from "./contract/health-probe-contract";
import { createMockHealthProbe } from "./helpers/mock-health-probe";

describe("HealthProbe contract — mock probe", () => {
  runHealthProbeContract({
    makeProbe: () => createMockHealthProbe(),
  });
});
