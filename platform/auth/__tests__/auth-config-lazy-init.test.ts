/**
 * platform/auth/__tests__/auth-config-lazy-init.test.ts
 *
 * Tests for the lazy initialization fallback in getAuthProvider().
 * Covers the try/catch block added for Gotcha 43 (Next.js module isolation).
 *
 * When no provider is registered, getAuthProvider() attempts a dynamic
 * require("@/platform/providers").initProviders() as a recovery path.
 * These tests verify: (1) successful lazy init, (2) catch path when
 * require fails, (3) skip when provider is already registered.
 */

jest.mock("@/lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  generateRequestId: jest.fn(() => "test-request-id"),
}));

describe("getAuthProvider lazy init", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("recovers via lazy init when no provider is registered", async () => {
    const { getAuthProvider, hasAuthProvider, registerAuthProvider } =
      await import("@/platform/auth/config");

    expect(hasAuthProvider()).toBe(false);

    jest.mock("@/platform/providers", () => ({
      initProviders: () => {
        const { createMockAuthProvider } = jest.requireActual(
          "@/platform/auth/mock-provider"
        );
        registerAuthProvider(createMockAuthProvider({}));
      },
    }));

    const provider = getAuthProvider();
    expect(provider).toBeDefined();
    expect(hasAuthProvider()).toBe(true);
  });

  it("throws after catch when require fails and no provider registered", async () => {
    const { getAuthProvider, hasAuthProvider } = await import("@/platform/auth/config");

    expect(hasAuthProvider()).toBe(false);

    jest.mock("@/platform/providers", () => {
      throw new Error("Module not available");
    });

    expect(() => getAuthProvider()).toThrow("No auth provider registered");
  });

  it("skips lazy init when provider is already registered", async () => {
    const { getAuthProvider, registerAuthProvider } =
      await import("@/platform/auth/config");
    const { createMockAuthProvider } = await import("@/platform/auth/mock-provider");

    registerAuthProvider(createMockAuthProvider({}));

    const provider = getAuthProvider();
    expect(provider).toBeDefined();
  });
});
