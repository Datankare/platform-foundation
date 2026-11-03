/**
 * __tests__/fixtures/route-responses.ts — route answers for screen tests, made by the real
 * route handlers (TASK-200, rule 3)
 *
 * route-responses.json is written by __tests__/route-fixtures.test.ts, which calls each route
 * handler and fails when its answer drifts from the file. A screen test answers fetch from here,
 * never with a body written by hand (__tests__/fake-fetch-bodies.test.ts counts those).
 */
import FIXTURES from "./route-responses.json";

export interface RouteFixture {
  readonly status: number;
  readonly body: unknown;
}

export type RouteFixtureName = keyof typeof FIXTURES;

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const REQUEST_ID = /^req_[0-9a-f]{16}$/;

/** A body with its volatile values fixed: every ISO time, every generated request id. */
export function normaliseBody(value: unknown): unknown {
  if (typeof value === "string") {
    if (ISO.test(value)) return "2026-01-01T00:00:00.000Z";
    if (REQUEST_ID.test(value)) return "req_0000000000000000";
    return value;
  }
  if (Array.isArray(value)) return value.map(normaliseBody);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        normaliseBody(v),
      ])
    );
  return value;
}

/** A fixture by name: the status and body its route handler answered. */
export function routeFixture(name: RouteFixtureName): RouteFixture {
  return FIXTURES[name] as RouteFixture;
}

/** A fixture as a `[status, body]` answer, the shape the screen tests' reply helpers take. */
export function routeAnswer(name: RouteFixtureName): [number, unknown] {
  const f = routeFixture(name);
  return [f.status, JSON.parse(JSON.stringify(f.body))];
}
