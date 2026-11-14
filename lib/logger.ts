import { generateId } from "@/platform/agents/utils";
import { REDACTED_LOG_FIELDS } from "@/lib/log-fields";
/**
 * lib/logger.ts — Structured platform logger
 *
 * Design principles:
 * - Four levels aligned with NotificationLevel: error | warn | info | debug
 * - Default level: warn — fallbacks, refusals and degraded paths are warnings, and an error-only
 *   default hid every one of them (audit G-11)
 * - Runtime-configurable via LOG_LEVEL environment variable
 * - Every log entry is structured JSON with mandatory fields
 * - Trace context (traceId, spanId) auto-injected when observability is initialized
 * - Never logs: API keys, user input content, audio data, PII — credential and personal-data
 *   fields are redacted in emit() whatever the caller passes (redact, REDACTED_KEYS, and every
 *   field lib/log-fields.ts classifies "redacted"), and an e-mail or IP address inside any text —
 *   the message included — is replaced (redactText; TASK-215, audit A-10). Every field name a log
 *   call passes is classified there (__tests__/log-fields.test.ts).
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
  return "warn"; // audit G-11: "error" hid every fallback and degraded-path warning
}

function shouldLog(level: LogLevel): boolean {
  const configured = getConfiguredLevel();
  if (configured === "silent") return false; // suppress all output
  return LOG_LEVEL_PRIORITY[level] <= LOG_LEVEL_PRIORITY[configured];
}

/**
 * Fields never written to a log, at any depth, whatever a caller passes: personal data and
 * credentials (ring 6). Enforced here so one forgotten call site cannot leak them.
 */
const REDACTED_KEYS =
  /^(?:email|password|newpassword|oldpassword|token|accesstoken|refreshtoken|idtoken|authorization|cookie|phone|phonenumber|secret|apikey|api_key|clientsecret|client_secret|codeverifier|code_verifier|currentcode|current_code)$/i;

/** An e-mail address anywhere in a text. */
const EMAIL_IN_TEXT = /[\w.%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
/** An IPv4 address anywhere in a text (an IPv4-mapped IPv6 address's last part too). */
const IPV4_IN_TEXT =
  /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
/** An IPv6 address: eight groups, or a compressed one (`::`) — never a time like 02:05:14. */
const IPV6_IN_TEXT =
  /(?<!\w)(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?)(?![\w:])/gi;

/**
 * `text` with every e-mail and IP address in it replaced (TASK-215, audit A-10): a value, not a
 * field name, can carry them — an error's text, a rate-limit bucket, a message a caller wrote.
 */
export function redactText(text: string): string {
  return text
    .replace(EMAIL_IN_TEXT, "[redacted email]")
    .replace(IPV4_IN_TEXT, "[redacted ip]")
    .replace(IPV6_IN_TEXT, (m) => (m.length > 2 ? "[redacted ip]" : m));
}

/** A field whose value is never written: a credential, or personal data by its name. */
const redactedKey = (k: string): boolean =>
  REDACTED_KEYS.test(k) || REDACTED_LOG_FIELDS.has(k);

/**
 * A copy of `value` with every redacted field replaced and every string's addresses replaced
 * (redactText), to a bounded depth.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactedKey(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level: LogLevel, message: string, fields?: Partial<LogEntry>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    environment: process.env.NODE_ENV ?? "development",
    message: redactText(message),
    ...(fields ? (redact(fields) as Partial<LogEntry>) : {}),
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
  return generateId();
}
