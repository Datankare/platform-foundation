/**
 * __tests__/contract/error-reporter-contract.ts
 * ErrorReporter conformance kit (TCK) — ADR-027. Not a *.test.ts.
 *
 * The contract is "safe to call, never throws, flush resolves" — error
 * reporting must never break the request path (no-op or real, same surface).
 */

import type { ErrorReporter } from "@/platform/observability/types";

export interface ErrorReporterContractFixtures {
  makeReporter: () => ErrorReporter | Promise<ErrorReporter>;
}

export function runErrorReporterContract(fx: ErrorReporterContractFixtures): void {
  let reporter: ErrorReporter;

  beforeEach(async () => {
    reporter = await fx.makeReporter();
    reporter.init();
  });

  describe("init", () => {
    it("can be called without throwing", () => {
      expect(() => reporter.init()).not.toThrow();
    });
  });

  describe("captureError", () => {
    it("accepts an error with and without context", () => {
      expect(() => reporter.captureError(new Error("boom"))).not.toThrow();
      expect(() =>
        reporter.captureError(new Error("boom"), {
          userId: "anon-1",
          tags: { route: "/x" },
        })
      ).not.toThrow();
    });
  });

  describe("captureMessage", () => {
    it("accepts messages at each level", () => {
      expect(() => reporter.captureMessage("info msg", "info")).not.toThrow();
      expect(() => reporter.captureMessage("warn msg", "warning")).not.toThrow();
      expect(() => reporter.captureMessage("err msg", "error")).not.toThrow();
    });
  });

  describe("setUser", () => {
    it("accepts an id and null", () => {
      expect(() => reporter.setUser("anon-1")).not.toThrow();
      expect(() => reporter.setUser(null)).not.toThrow();
    });
  });

  describe("flush", () => {
    it("resolves", async () => {
      await expect(reporter.flush()).resolves.toBeUndefined();
    });
  });
}
