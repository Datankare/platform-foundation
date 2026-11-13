/**
 * __tests__/fixtures/route-responses.ts — route answers for screen tests, made by the real
 * route handlers (TASK-200, rule 3)
 *
 * route-responses.json is written by __tests__/route-fixtures.test.ts, which calls each route
 * handler and fails when its answer drifts from the file. A screen test answers fetch from here,
 * never with a body written by hand (__tests__/fake-fetch-bodies.test.ts counts those).
 */
import { isDeepStrictEqual } from "node:util";
import FIXTURES from "./route-responses.json";

export interface RouteFixture {
  readonly status: number;
  readonly body: unknown;
}

export type RouteFixtureName = keyof typeof FIXTURES;

const REQUEST_ID = /^req_[0-9a-f]{16}$/;

/**
 * The instant every fixture is produced at: the producers run on a clock frozen here, so a time
 * a route takes from the clock is this one, and every other time is the producer's own row
 * (TASK-207: a screen test reads the dates a route really returns).
 */
export const FIXTURE_NOW = "2026-01-01T00:00:00.000Z";

/** What a fixture holds where a session's forgery token was. Not a credential. */
export const CSRF_TOKEN = "csrf-token-of-the-session";

/**
 * A body with its volatile values fixed: every generated request id (alone or quoted), and a
 * session's forgery token.
 */
export function normaliseBody(value: unknown): unknown {
  if (typeof value === "string") {
    if (REQUEST_ID.test(value)) return "req_0000000000000000";
    // A message that quotes its reference (internal.error): the reference fixed too.
    return value.replace(/\breq_[0-9a-f]{16}\b/g, "req_0000000000000000");
  }
  if (Array.isArray(value)) return value.map(normaliseBody);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        // A session's forgery token is random per session (ADR-057): fixed, as a request id is.
        k === "csrfToken" && typeof v === "string" ? CSRF_TOKEN : normaliseBody(v),
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

/**
 * How the fixture file differs from what the handlers answered: each fixture whose recorded
 * answer is not the handler's, each the file lacks, each the file has that no handler produces.
 * Compared as JSON: what the file can hold (an undefined field is no field).
 */
export function fixtureDrift(
  file: Readonly<Record<string, unknown>>,
  produced: Readonly<Record<string, RouteFixture>>
): string[] {
  const out: string[] = [];
  for (const [name, answer] of Object.entries(produced)) {
    if (!(name in file)) out.push(`${name}: not in route-responses.json`);
    else if (!isDeepStrictEqual(file[name], JSON.parse(JSON.stringify(answer))))
      out.push(`${name}: the file's answer is not what the handler answers`);
  }
  for (const name of Object.keys(file))
    if (!(name in produced)) out.push(`${name}: no handler produces it`);
  return out;
}
