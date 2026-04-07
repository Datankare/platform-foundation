/**
 * platform/observability/error-reporting.ts — Error tracking
 *
 * ADR-014: Real-time error aggregation — every error surfaced.
 *
 * Two implementations:
 *   NoopErrorReporter — used when no SENTRY_DSN is configured. Silent, zero overhead.
 *   SentryErrorReporter — captures errors to Sentry with full context.
 *
 * The Sentry SDK (@sentry/nextjs) is loaded dynamically so the dependency
 * is optional. If the package is not installed, SentryErrorReporter falls
 * back to NoopErrorReporter with a startup warning.
 *
 * Consumers can implement ErrorReporter for Datadog, Bugsnag, New Relic, etc.
 */

import type { ErrorReporter, ErrorContext } from "./types";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// No-op implementation — zero overhead when no DSN configured
// ---------------------------------------------------------------------------

export class NoopErrorReporter implements ErrorReporter {
  init(): void {
    // No-op
  }

  captureError(_error: Error, _context?: ErrorContext): void {
    // No-op — errors still logged via structured logger
  }

  captureMessage(
    _message: string,
    _level: "info" | "warning" | "error",
    _context?: ErrorContext
  ): void {
    // No-op
  }

  setUser(_userId: string | null): void {
    // No-op
  }

  async flush(_timeoutMs?: number): Promise<void> {
    // No-op
  }
}

// ---------------------------------------------------------------------------
// Sentry implementation
// ---------------------------------------------------------------------------

interface SentryConfig {
  dsn: string;
  environment: string;
  version: string;
  traceSampleRate?: number;
}

/**
 * Minimal Sentry interface — only the methods we use.
 * This avoids a hard dependency on @sentry/nextjs types.
 * When the actual package is installed, these align with its API.
 */
interface SentryLike {
  init(options: {
    dsn: string;
    environment: string;
    release: string;
    tracesSampleRate: number;
    sendDefaultPii: boolean;
  }): void;
  captureException(error: Error): void;
  captureMessage(message: string, level: string): void;
  setUser(user: { id: string } | null): void;
  withScope(callback: (scope: SentryScope) => void): void;
  flush(timeoutMs: number): Promise<boolean>;
}

interface SentryScope {
  setContext(name: string, context: Record<string, unknown>): void;
  setUser(user: { id: string } | null): void;
  setTag(key: string, value: string): void;
  setExtra(key: string, value: unknown): void;
}

/**
 * SentryErrorReporter — captures errors and messages to Sentry.
 *
 * Requires @sentry/nextjs as a peer dependency. If the package is not
 * installed, init() logs a warning and all methods become no-ops.
 *
 * Consumer swap example (in ObservabilityConfig):
 *   errorReporter: new DatadogErrorReporter({ apiKey: "..." })
 */
export class SentryErrorReporter implements ErrorReporter {
  private sentry: SentryLike | null = null;
  private readonly config: SentryConfig;
  private initialized = false;

  constructor(config: SentryConfig) {
    this.config = config;
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    try {
      // Dynamic import — @sentry/nextjs is an optional peer dependency.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const sentryModule = require("@sentry/nextjs") as SentryLike;
      this.sentry = sentryModule;

      sentryModule.init({
        dsn: this.config.dsn,
        environment: this.config.environment,
        release: this.config.version,
        tracesSampleRate: this.config.traceSampleRate ?? 0.1,
        // Don't send PII
        sendDefaultPii: false,
      });

      logger.info("Sentry error reporter initialized", {
        environment: this.config.environment,
        version: this.config.version,
      });
    } catch {
      logger.warn(
        "Sentry SDK not available — install @sentry/nextjs to enable error tracking. " +
          "Falling back to no-op error reporter."
      );
      this.sentry = null;
    }
  }

  captureError(error: Error, context?: ErrorContext): void {
    if (!this.sentry) return;

    this.sentry.withScope((scope) => {
      if (context?.traceContext) {
        scope.setContext("trace", {
          traceId: context.traceContext.traceId,
          spanId: context.traceContext.spanId,
          parentSpanId: context.traceContext.parentSpanId,
        });
      }
      if (context?.userId) {
        scope.setUser({ id: context.userId });
      }
      if (context?.tags) {
        for (const [key, value] of Object.entries(context.tags)) {
          scope.setTag(key, value);
        }
      }
      if (context?.extra) {
        for (const [key, value] of Object.entries(context.extra)) {
          scope.setExtra(key, value);
        }
      }
      this.sentry!.captureException(error);
    });
  }

  captureMessage(
    message: string,
    level: "info" | "warning" | "error",
    context?: ErrorContext
  ): void {
    if (!this.sentry) return;

    this.sentry.withScope((scope) => {
      if (context?.tags) {
        for (const [key, value] of Object.entries(context.tags)) {
          scope.setTag(key, value);
        }
      }
      if (context?.extra) {
        for (const [key, value] of Object.entries(context.extra)) {
          scope.setExtra(key, value);
        }
      }
      this.sentry!.captureMessage(message, level);
    });
  }

  setUser(userId: string | null): void {
    if (!this.sentry) return;
    this.sentry.setUser(userId ? { id: userId } : null);
  }

  async flush(timeoutMs = 2000): Promise<void> {
    if (!this.sentry) return;
    await this.sentry.flush(timeoutMs);
  }
}

// ---------------------------------------------------------------------------
// Factory — creates the appropriate reporter based on config
// ---------------------------------------------------------------------------

/**
 * Create an ErrorReporter based on available configuration.
 * Returns NoopErrorReporter when no DSN is provided.
 */
export function createErrorReporter(options: {
  sentryDsn?: string;
  environment: string;
  version: string;
  traceSampleRate?: number;
}): ErrorReporter {
  if (!options.sentryDsn) {
    logger.info("No SENTRY_DSN configured — error reporter is no-op");
    return new NoopErrorReporter();
  }

  return new SentryErrorReporter({
    dsn: options.sentryDsn,
    environment: options.environment,
    version: options.version,
    traceSampleRate: options.traceSampleRate,
  });
}
