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

import type { HealthProbe } from "@/platform/observability/types";

export function register() {
  // Next.js runs this hook in both the Node and Edge runtimes. Provider + observability
  // init touch Node-only modules (crypto, Supabase, ffmpeg) via the provider registry;
  // pulling them into the Edge pass logs warnings (and would fail at runtime). Skip Edge
  // only — Node, and any context where NEXT_RUNTIME is unset, initialize as before.
  if (process.env.NEXT_RUNTIME === "edge") {
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initProviders } = require("@/platform/providers");
    initProviders();

    // TASK-041: register the song-ID health probe. The adapter existed but was never
    // registered, so the probe was dead code (Gotcha #27). It wraps the LIVE provider
    // stored by initProviders() above — not a freshly constructed duplicate — so the
    // probe reports on the instance actually serving traffic.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSongIdProvider, SongIdHealthProbeAdapter } = require("@/platform/voice");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initObservability, CachedHealthProbe } = require("@/platform/observability");
    // The song-ID probe makes a billable identify call; at most one per 15 minutes per
    // instance, however often /api/health is requested (audit X-13).
    const healthProbes: HealthProbe[] = [
      new CachedHealthProbe(
        new SongIdHealthProbeAdapter(getSongIdProvider()),
        15 * 60_000
      ),
    ];

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PLATFORM_VERSION } = require("@/platform/version");
    initObservability({
      sentryDsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? "development",
      // The platform release (platform/version.ts) — npm_package_version is unset under a
      // standalone server, so it cannot identify a container build (ADR-055 D2).
      version: PLATFORM_VERSION,
      traceSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      healthProbes,
    });

    console.log("[instrumentation] Observability initialized", {
      errorReporter: process.env.ERROR_REPORTER ?? "noop",
      hasSentryDsn: !!process.env.SENTRY_DSN,
    });
  } catch (err) {
    console.error("[instrumentation] Failed to initialize:", err);
    // Fail closed (audit X-21): in production a server whose providers did not initialize
    // must not start and serve on whatever defaults it has — Next.js aborts startup when
    // register() throws. Outside production the error is logged and development continues.
    if (process.env.NODE_ENV === "production") throw err;
  }
}
