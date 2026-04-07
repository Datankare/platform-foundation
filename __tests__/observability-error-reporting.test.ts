/**
 * __tests__/observability-error-reporting.test.ts — Error reporting tests
 *
 * Tests: NoopErrorReporter, SentryErrorReporter (fallback when SDK absent),
 * createErrorReporter factory.
 */

import {
  NoopErrorReporter,
  SentryErrorReporter,
  createErrorReporter,
} from "@/platform/observability/error-reporting";

describe("NoopErrorReporter", () => {
  let reporter: NoopErrorReporter;

  beforeEach(() => {
    reporter = new NoopErrorReporter();
  });

  it("init does not throw", () => {
    expect(() => reporter.init()).not.toThrow();
  });

  it("captureError does not throw", () => {
    expect(() => reporter.captureError(new Error("test"))).not.toThrow();
  });

  it("captureError accepts context", () => {
    expect(() =>
      reporter.captureError(new Error("test"), {
        traceContext: {
          traceId: "abc",
          spanId: "def",
          startedAt: new Date().toISOString(),
        },
        userId: "user-1",
        tags: { route: "/api/test" },
        extra: { foo: "bar" },
      })
    ).not.toThrow();
  });

  it("captureMessage does not throw", () => {
    expect(() => reporter.captureMessage("test message", "warning")).not.toThrow();
  });

  it("setUser does not throw", () => {
    expect(() => reporter.setUser("user-1")).not.toThrow();
    expect(() => reporter.setUser(null)).not.toThrow();
  });

  it("flush resolves immediately", async () => {
    await expect(reporter.flush()).resolves.toBeUndefined();
  });
});

describe("SentryErrorReporter (without SDK installed)", () => {
  let reporter: SentryErrorReporter;

  beforeEach(() => {
    reporter = new SentryErrorReporter({
      dsn: "https://fake@sentry.io/123",
      environment: "test",
      version: "1.0.0",
    });
  });

  it("init falls back gracefully when @sentry/nextjs is not installed", () => {
    // @sentry/nextjs is not installed in test environment
    // init() should log a warning and fall back to no-op behavior
    expect(() => reporter.init()).not.toThrow();
  });

  it("captureError is no-op after failed init", () => {
    reporter.init();
    expect(() => reporter.captureError(new Error("test"))).not.toThrow();
  });

  it("captureMessage is no-op after failed init", () => {
    reporter.init();
    expect(() => reporter.captureMessage("test", "error")).not.toThrow();
  });

  it("setUser is no-op after failed init", () => {
    reporter.init();
    expect(() => reporter.setUser("user-1")).not.toThrow();
  });

  it("flush resolves after failed init", async () => {
    reporter.init();
    await expect(reporter.flush()).resolves.toBeUndefined();
  });

  it("init is idempotent", () => {
    reporter.init();
    reporter.init(); // second call should not throw
    expect(() => reporter.captureError(new Error("test"))).not.toThrow();
  });
});

describe("createErrorReporter", () => {
  it("returns NoopErrorReporter when no DSN provided", () => {
    const reporter = createErrorReporter({
      environment: "test",
      version: "1.0.0",
    });
    expect(reporter).toBeInstanceOf(NoopErrorReporter);
  });

  it("returns NoopErrorReporter when DSN is empty string", () => {
    const reporter = createErrorReporter({
      sentryDsn: "",
      environment: "test",
      version: "1.0.0",
    });
    expect(reporter).toBeInstanceOf(NoopErrorReporter);
  });

  it("returns SentryErrorReporter when DSN is provided", () => {
    const reporter = createErrorReporter({
      sentryDsn: "https://fake@sentry.io/123",
      environment: "test",
      version: "1.0.0",
    });
    expect(reporter).toBeInstanceOf(SentryErrorReporter);
  });
});
