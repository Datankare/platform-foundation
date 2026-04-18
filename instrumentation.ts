/**
 * instrumentation.ts — Next.js server startup hook
 *
 * Called once when the server starts. Initializes observability
 * (error reporting, tracing, metrics) and provider registry.
 *
 * Uses require() instead of import — Turbopack does not resolve
 * path aliases in instrumentation.ts with top-level imports.
 *
 * @see https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 *
 * ## Error reporter customization
 *
 * Default: Sentry (when SENTRY_DSN + ERROR_REPORTER=sentry are set).
 * To use a different provider (Datadog, Bugsnag, New Relic, etc.):
 *
 *   1. Implement the ErrorReporter interface from platform/observability/types
 *   2. Pass it via the errorReporter config option:
 *
 *      initObservability({
 *        ...baseConfig,
 *        errorReporter: new DatadogErrorReporter({ apiKey: "..." }),
 *      });
 *
 *   3. The custom reporter replaces Sentry entirely — no env vars needed.
 *
 * @module instrumentation
 */

export function register() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initProviders } = require("@/platform/providers");
    initProviders();

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initObservability } = require("@/platform/observability");
    initObservability({
      sentryDsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? "development",
      version: process.env.npm_package_version ?? "0.0.0",
      traceSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
    });

    console.log("[instrumentation] Observability initialized", {
      errorReporter: process.env.ERROR_REPORTER ?? "noop",
      hasSentryDsn: !!process.env.SENTRY_DSN,
    });
  } catch (err) {
    console.error("[instrumentation] Failed to initialize:", err);
  }
}
