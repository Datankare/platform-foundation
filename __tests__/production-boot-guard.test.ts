/**
 * TASK-089 — PF production-boot check.
 *
 * PF's CI never starts the production build under an E2E harness, so the ADR-048 D3 store-guard
 * cascade (v2.5.0 M2) was invisible to PF's own gate and only surfaced downstream in Playform's
 * Layer 3, forcing the v2.5.1 patch. This drives the real boot entry point — instrumentation
 * `register()` — through a simulated production boot and asserts both halves of the contract:
 *
 *   - fail-closed: in production on in-memory stores with no opt-out, register() swallows the
 *     guard throw (it must not crash the process) BUT boot does NOT complete — observability and
 *     probes never initialize, which is exactly what left health at 503 and Guardian unregistered.
 *   - opt-out: with E2E_IN_MEMORY_STORES=true, boot completes end-to-end (observability initializes).
 *
 * This is the option-(b) floor from TASK-089: a guaranteed catch with no server. A full CI E2E
 * layer (option (a)) can follow. The test is portable: it runs unchanged against a consumer's own
 * (sync-excluded) instrumentation.ts, because it simulates the Node server runtime Next.js sets.
 */
import { register } from "@/instrumentation";
import { resetObservability, tryGetObservability } from "@/platform/observability";
import { resetProviders } from "@/platform/providers";

function setNodeEnv(v: string): void {
  Object.defineProperty(process.env, "NODE_ENV", {
    value: v,
    configurable: true,
    writable: true,
  });
}

describe("production boot guard (TASK-089)", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    resetObservability();
    resetProviders();
    process.env = { ...origEnv };
    // A real Next.js server boots register() with NEXT_RUNTIME=nodejs; jest does not set it.
    // Consumers' instrumentation.ts commonly returns early outside the Node runtime (the
    // provider chain reaches node:crypto), so the simulated boot must set it or register()
    // is a no-op and the check tests nothing.
    process.env.NEXT_RUNTIME = "nodejs";
  });

  afterEach(() => {
    resetObservability();
    resetProviders();
    process.env = { ...origEnv };
  });

  it("fail-closed: production + in-memory stores + no opt-out — register() swallows the throw but boot does not complete", () => {
    setNodeEnv("production");
    delete process.env.E2E_IN_MEMORY_STORES;
    delete process.env.TRAJECTORY_STORE;
    delete process.env.BUDGET_STORE;
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    expect(() => register()).not.toThrow();
    expect(tryGetObservability()).toBeFalsy();
    expect(errSpy).toHaveBeenCalledWith(
      "[instrumentation] Failed to initialize:",
      expect.anything()
    );

    errSpy.mockRestore();
  });

  it("opt-out: production + E2E_IN_MEMORY_STORES=true — boot completes (observability initializes)", () => {
    setNodeEnv("production");
    process.env.E2E_IN_MEMORY_STORES = "true";
    delete process.env.TRAJECTORY_STORE;
    delete process.env.BUDGET_STORE;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    expect(() => register()).not.toThrow();
    expect(tryGetObservability()).toBeTruthy();

    logSpy.mockRestore();
  });

  it("non-production: in-memory stores boot normally (no guard, boot completes)", () => {
    setNodeEnv("test");
    delete process.env.E2E_IN_MEMORY_STORES;
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

    expect(() => register()).not.toThrow();
    expect(tryGetObservability()).toBeTruthy();

    logSpy.mockRestore();
  });
});
