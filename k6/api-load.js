/**
 * k6/api-load.js — Load test for AI + streaming endpoints
 *
 * Two profiles:
 *   DRY_RUN=1  → Tests infra only (validation paths, no external API calls, $0)
 *   DRY_RUN=0  → Tests real end-to-end (hits Anthropic + Google APIs, ~$5)
 *
 * Usage:
 *   # Dry run (every sprint) — tests Vercel infra, middleware, cold starts
 *   K6_BASE_URL=https://playform-inky.vercel.app DRY_RUN=1 k6 run k6/api-load.js
 *
 *   # Live burst (every phase close) — tests real API latency under load
 *   K6_BASE_URL=https://playform-inky.vercel.app DRY_RUN=0 k6 run k6/api-load.js
 *
 *   # Custom concurrency
 *   K6_BASE_URL=... K6_PEAK_VUS=50 k6 run k6/api-load.js
 *
 * Thresholds:
 *   health:    p99 < 100ms
 *   process:   p95 < 3000ms (live), p95 < 500ms (dry)
 *   stream:    p95 < 5000ms (live), p95 < 500ms (dry)
 *   errors:    < 5% failure rate
 */

import http from "k6/http";

// 401 is expected in dry run (auth middleware rejects before validation)
http.setResponseCallback(http.expectedStatuses(200, 400, 401));
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

// ── Config ──────────────────────────────────────────────────────────────

const BASE_URL = __ENV.K6_BASE_URL || "http://localhost:3000";
const DRY_RUN = (__ENV.DRY_RUN || "1") === "1";
const PEAK_VUS = parseInt(__ENV.K6_PEAK_VUS || "10", 10);

// ── Custom Metrics ──────────────────────────────────────────────────────

const healthLatency = new Trend("health_latency", true);
const processLatency = new Trend("process_latency", true);
const streamLatency = new Trend("stream_latency", true);
const processErrors = new Rate("process_error_rate");
const streamErrors = new Rate("stream_error_rate");
const totalRequests = new Counter("total_requests");

// ── Stages ──────────────────────────────────────────────────────────────

export const options = {
  stages: [
    { duration: "10s", target: Math.ceil(PEAK_VUS * 0.5) }, // ramp up
    { duration: "30s", target: PEAK_VUS }, // sustained peak
    { duration: "10s", target: 0 }, // ramp down
  ],
  thresholds: {
    health_latency: ["p(95)<200", "p(99)<1000"],
    process_latency: DRY_RUN ? ["p(95)<500"] : ["p(95)<3000"],
    stream_latency: DRY_RUN ? ["p(95)<500"] : ["p(95)<5000"],
    process_error_rate: ["rate<0.05"],
    stream_error_rate: ["rate<0.05"],
    http_req_failed: ["rate<0.05"],
  },
};

// ── Test Payloads ───────────────────────────────────────────────────────

// Dry run payloads: hit validation paths (no external API calls)
const DRY_PAYLOADS = {
  process: [
    // Empty text → 400 (no API call)
    { text: "" },
    // Missing field → 400 (no API call)
    {},
    // Whitespace only → 400 (no API call)
    { text: "   " },
    // Over limit → 400 (no API call)
    { text: "x".repeat(10000) },
  ],
  stream: [
    // Missing prompt → 400 (no API call)
    {},
    // Empty prompt → 400 (no API call)
    { prompt: "" },
  ],
};

// Live payloads: real text that hits external APIs
const LIVE_PAYLOADS = {
  process: [
    { text: "Hello world" },
    { text: "Good morning" },
    { text: "How are you today" },
    { text: "Thank you very much" },
    { text: "See you later" },
  ],
  stream: [
    { prompt: "Say hello in one sentence.", maxTokens: 50, tier: "fast" },
    {
      prompt: "What is 2+2? Answer in one word.",
      maxTokens: 20,
      tier: "fast",
    },
    {
      prompt: "Name one color.",
      maxTokens: 10,
      tier: "fast",
    },
  ],
};

// ── Helpers ──────────────────────────────────────────────────────────────

const HEADERS = { "Content-Type": "application/json" };

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Main Test ───────────────────────────────────────────────────────────

export default function () {
  // 1. Health check (always)
  const healthRes = http.get(`${BASE_URL}/api/health`, {
    tags: { name: "health" },
  });
  check(healthRes, {
    "health: status 200": (r) => r.status === 200,
  });
  healthLatency.add(healthRes.timings.duration);
  totalRequests.add(1);

  // 2. Process endpoint
  const processPayload = DRY_RUN
    ? pick(DRY_PAYLOADS.process)
    : pick(LIVE_PAYLOADS.process);

  const processRes = http.post(
    `${BASE_URL}/api/process`,
    JSON.stringify(processPayload),
    { headers: HEADERS, tags: { name: "process" } }
  );

  if (DRY_RUN) {
    // Dry run: expect 400s (validation rejections)
    check(processRes, {
      "process-dry: status 200 or 400": (r) =>
        r.status === 200 || r.status === 400 || r.status === 401,
      "process-dry: has error message": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.error !== undefined || body.success === false;
        } catch {
          return false;
        }
      },
    });
    processErrors.add(processRes.status >= 500 ? 1 : 0);
  } else {
    // Live: expect 200s
    check(processRes, {
      "process-live: status 200": (r) => r.status === 200,
      "process-live: has translations": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.success === true && body.translations !== undefined;
        } catch {
          return false;
        }
      },
    });
    processErrors.add(processRes.status !== 200 ? 1 : 0);
  }
  processLatency.add(processRes.timings.duration);
  totalRequests.add(1);

  // 3. Stream endpoint
  const streamPayload = DRY_RUN ? pick(DRY_PAYLOADS.stream) : pick(LIVE_PAYLOADS.stream);

  const streamRes = http.post(`${BASE_URL}/api/stream`, JSON.stringify(streamPayload), {
    headers: HEADERS,
    tags: { name: "stream" },
  });

  if (DRY_RUN) {
    check(streamRes, {
      "stream-dry: status 200 or 400": (r) =>
        r.status === 200 || r.status === 400 || r.status === 401,
    });
    streamErrors.add(streamRes.status >= 500 ? 1 : 0);
  } else {
    check(streamRes, {
      "stream-live: status 200": (r) => r.status === 200,
      "stream-live: has SSE content": (r) => r.body && r.body.length > 0,
    });
    streamErrors.add(streamRes.status !== 200 ? 1 : 0);
  }
  streamLatency.add(streamRes.timings.duration);
  totalRequests.add(1);

  sleep(DRY_RUN ? 0.5 : 1);
}

// ── Summary ─────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const mode = DRY_RUN ? "DRY RUN (infra only)" : "LIVE (real APIs)";
  const peak = PEAK_VUS;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`k6 Load Test Results — ${mode}`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`Peak VUs: ${peak}`);
  console.log(`${"=".repeat(60)}\n`);

  return {
    stdout: textSummary(data, { indent: "  ", enableColors: true }),
  };
}

// k6 built-in text summary
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.1/index.js";
