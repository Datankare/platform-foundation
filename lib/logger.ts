/**
 * lib/logger.ts — Structured platform logger
 *
 * Design principles:
 * - Four levels aligned with NotificationLevel: error | warn | info | debug
 * - Default level: error (production-safe, minimal noise)
 * - Runtime-configurable via LOG_LEVEL environment variable
 * - Every log entry is structured JSON with mandatory fields
 * - Trace context (traceId, spanId) auto-injected when observability is initialized
 * - Never logs: API keys, user input content, audio data, PII
 *
 * OWASP A09: Security Logging and Monitoring
 *
 * Log entry schema (for log drain configuration):
 *   {
 *     "timestamp": "2026-04-06T12:00:00.000Z",  // ISO 8601
 *     "level": "info",                            // error | warn | info | debug
 *     "environment": "production",                // NODE_ENV
 *     "message": "POST /api/process → 200",       // Human-readable summary
 *     "requestId": "k3m8x2p1",                    // Short correlation ID (legacy)
 *     "traceId": "a1b2c3d4...",                    // 32-char hex, links all spans in a request
 *     "spanId": "e5f6g7h8...",                     // 16-char hex, identifies this operation
 *     "route": "/api/process",                     // API route
 *     "method": "POST",                            // HTTP method
 *     "status": 200,                               // HTTP status code
 *     "durationMs": 142,                           // Request duration
 *     "error": "TypeError: ...",                   // Error message (only on error level)
 *     ...                                          // Additional context fields
 *   }
 */

export type LogLevel = "error" | "warn" | "info" | "debug" | "silent";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  silent: 99, // suppresses all output — used in tests
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  requestId?: string;
  traceId?: string;
  spanId?: string;
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  environment: string;
  message: string;
  error?: string;
  [key: string]: unknown;
}

function getConfiguredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw && raw in LOG_LEVEL_PRIORITY) return raw as LogLevel;
  return "error"; // production-safe default
}

function shouldLog(level: LogLevel): boolean {
  const configured = getConfiguredLevel();
  if (configured === "silent") return false; // suppress all output
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[configured];
}

function emit(level: LogLevel, message: string, fields?: Partial<LogEntry>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    environment: process.env.NODE_ENV ?? "development",
    message,
    ...fields,
  };

  const output = JSON.stringify(entry);

  switch (level) {
    case "error":
      console.error(output);
      break;
    case "warn":
      console.warn(output);
      break;
    default:
      console.log(output);
  }
}

export const logger = {
  error: (message: string, fields?: Partial<LogEntry>) => emit("error", message, fields),
  warn: (message: string, fields?: Partial<LogEntry>) => emit("warn", message, fields),
  info: (message: string, fields?: Partial<LogEntry>) => emit("info", message, fields),
  debug: (message: string, fields?: Partial<LogEntry>) => emit("debug", message, fields),

  /**
   * Create a scoped logger with trace context auto-injected into every entry.
   * Use within a request handler to correlate all log entries in a trace.
   *
   * Usage:
   *   const trace = tracer.createTrace();
   *   const log = logger.withTrace(trace.traceId, trace.spanId);
   *   log.info("Processing request");  // traceId + spanId auto-attached
   */
  withTrace: (traceId: string, spanId?: string) => ({
    error: (message: string, fields?: Partial<LogEntry>) =>
      emit("error", message, { traceId, spanId, ...fields }),
    warn: (message: string, fields?: Partial<LogEntry>) =>
      emit("warn", message, { traceId, spanId, ...fields }),
    info: (message: string, fields?: Partial<LogEntry>) =>
      emit("info", message, { traceId, spanId, ...fields }),
    debug: (message: string, fields?: Partial<LogEntry>) =>
      emit("debug", message, { traceId, spanId, ...fields }),
  }),

  /** Convenience: log an incoming API request */
  request: (
    route: string,
    method: string,
    requestId: string,
    fields?: Partial<LogEntry>
  ) =>
    emit("info", `${method} ${route}`, {
      route,
      method,
      requestId,
      ...fields,
    }),

  /** Convenience: log an API response with duration */
  response: (
    route: string,
    method: string,
    status: number,
    requestId: string,
    durationMs: number,
    fields?: Partial<LogEntry>
  ) =>
    emit(
      status >= 500 ? "error" : status >= 400 ? "warn" : "info",
      `${method} ${route} → ${status}`,
      {
        route,
        method,
        status,
        requestId,
        durationMs,
        ...fields,
      }
    ),
};

/** Generate a short request ID for correlating log entries */
export function generateRequestId(): string {
  return Math.random().toString(36).slice(2, 10);
}
