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

  // ADR-056 D4: each step is recorded, so readiness (/api/health/ready) can say whether this
  // instance finished starting — and which step did not.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const boot = require("@/platform/observability/boot");

  try {
    // ADR-055 D5: in a container (NEXT_MANUAL_SIG_HANDLE=true, set by the image) SIGTERM and
    // SIGINT are the app's: readiness flips to not ready, the instance drains, then telemetry is
    // flushed and the cache and database pools are closed before it exits. Installed first, so
    // an instance stopped while it is still booting stops the same way. Elsewhere Next.js keeps
    // the signals and this installs nothing.
    boot.recordBootStep("shutdown");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { installShutdownHandlers } = require("@/platform/observability/shutdown");
    installShutdownHandlers();

    // ADR-054 D4: the app's modules are registered before the providers initialize, so their
    // provider slots, agents, prompts, rules and vocabulary are in place when the core composes
    // them. platform/modules/app-modules.ts is the app's own list (a consumer seam).
    boot.recordBootStep("modules");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { registerModules } = require("@/platform/modules");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { APP_MODULES } = require("@/platform/modules/app-modules");
    registerModules(APP_MODULES);

    boot.recordBootStep("providers");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initProviders } = require("@/platform/providers");
    initProviders();

    // ADR-056 D2: every job kind — the core's duties, the modules', the app's — is composed and
    // validated now, so a malformed or colliding declaration fails boot, not a tick; and in a
    // deployment a kind whose attempt cannot fit in a tick (it would never be claimed) is refused
    // by name.
    boot.recordBootStep("jobs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { listJobDefinitions } = require("@/platform/jobs/registry");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { checkJobsFitTick } = require("@/platform/jobs/tick");
    checkJobsFitTick(listJobDefinitions());

    // ADR-056 D4: readiness needs the database (when this deployment has one), the selected
    // cache and the Cognito pool's shape; realtime, the job schedules, the modules' probes
    // (TASK-041: the song-ID probe; TASK-197: the Google key and voices), the AI provider with the
    // deployed key and models, and an external rate-limit store (TASK-197) only degrade. The
    // probes are built now so each wraps the LIVE provider initProviders() installed — not a
    // freshly constructed duplicate. A probe that makes a billable call is cached (audit X-13).
    boot.recordBootStep("health probes");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildReadinessProbes } = require("@/platform/providers/readiness-probes");
    const { required, degradedOnly } = buildReadinessProbes() as {
      required: HealthProbe[];
      degradedOnly: HealthProbe[];
    };

    boot.recordBootStep("observability");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { initObservability } = require("@/platform/observability");

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PLATFORM_VERSION } = require("@/platform/version");
    initObservability({
      sentryDsn: process.env.SENTRY_DSN,
      environment: process.env.NODE_ENV ?? "development",
      // The platform release (platform/version.ts) — npm_package_version is unset under a
      // standalone server, so it cannot identify a container build (ADR-055 D2).
      version: PLATFORM_VERSION,
      traceSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,
      healthProbes: required,
      degradedOnlyProbes: degradedOnly,
    });
    boot.recordBootCompleted();

    console.log("[instrumentation] Observability initialized", {
      errorReporter: process.env.ERROR_REPORTER ?? "noop",
      hasSentryDsn: !!process.env.SENTRY_DSN,
    });
  } catch (err) {
    boot.recordBootFailed();
    console.error("[instrumentation] Failed to initialize:", err);
    // Fail closed (audit X-21): in production a server whose providers did not initialize
    // must not start and serve on whatever defaults it has — Next.js aborts startup when
    // register() throws. Outside production the error is logged and development continues,
    // and readiness reports the failed step (ADR-056 D4).
    if (process.env.NODE_ENV === "production") throw err;
  }
}
