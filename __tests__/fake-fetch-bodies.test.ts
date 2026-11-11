/**
 * __tests__/fake-fetch-bodies.test.ts — no screen test answers a route with a body written by hand
 * (TASK-200, rule 3)
 *
 * @guard a screen test that mocks fetch with a hand-written body instead of the route's own answer
 *
 * TASK-194's fixes were tested against mock bodies the real routes never returned. A screen or
 * component test answers fetch with a fixture the real route handler produced
 * (__tests__/fixtures/route-responses.ts, made and checked by __tests__/route-fixtures.test.ts), or
 * drives the real route. Each hand-written body (helpers/fake-fetch-scan.ts says what counts) is
 * refused. fake-fetch-baseline.json (repository root, per repository — an app keeps its own)
 * counted the bodies written before the rule, per file with its reason; TASK-207 (N-17) replaced
 * every one with a route fixture, so it is empty, and it stays empty: any hand-written body fails
 * here, in any file, and the file may hold no exception (the test below) — nor be raised by hand,
 * which scripts/process-check.mjs refuses (CI Layer 0f, against the merge base).
 */
import { readFileSync, writeFileSync } from "fs";
import { join, relative, sep } from "path";
import {
  FETCH_WRAPPERS,
  handWrittenBodies,
  isComponentFetchTest,
} from "./helpers/fake-fetch-scan";
import { testFiles } from "./helpers/repo-files";

const ROOT = join(__dirname, "..");
const BASELINE_FILE = join(ROOT, "fake-fetch-baseline.json");
const rel = (p: string) => relative(ROOT, p).split(sep).join("/");

interface Entry {
  count: number;
  reason: string;
}
interface Baseline {
  $comment?: string;
  count: number;
  files: Record<string, Entry>;
}

/** Hand-written bodies per component test file (files with none left out). */
function current(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of testFiles(ROOT)) {
    const text = readFileSync(f, "utf8");
    if (!isComponentFetchTest(text)) continue;
    const n = handWrittenBodies(text, f).length;
    if (n > 0) out[rel(f)] = n;
  }
  return out;
}

/** What the counts do against the baseline: files over it, files under it, entries without reason. */
export function compare(
  counts: Readonly<Record<string, number>>,
  baseline: Baseline
): { over: string[]; under: string[]; unexplained: string[]; total: string[] } {
  const files = new Set([...Object.keys(counts), ...Object.keys(baseline.files)]);
  const over: string[] = [];
  const under: string[] = [];
  for (const f of [...files].sort()) {
    const now = counts[f] ?? 0;
    const was = baseline.files[f]?.count ?? 0;
    if (now > was) over.push(`${f}: ${now} hand-written bodies, ${was} allowed`);
    if (now < was) under.push(`${f}: ${now} now, the baseline says ${was} — lower it`);
  }
  const unexplained = Object.entries(baseline.files)
    .filter(([, e]) => (e.reason ?? "").trim().split(/\s+/).length < 4)
    .map(([f]) => `${f}: no reason`);
  const sum = Object.values(baseline.files).reduce((n, e) => n + e.count, 0);
  const total =
    sum === baseline.count ? [] : [`count ${baseline.count}, entries sum to ${sum}`];
  return { over, under, unexplained, total };
}

describe("screen tests answer fetch with the routes' own replies (TASK-200, rule 3)", () => {
  const counts = current();
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as Baseline;

  it("N-17 is done: the baseline excepts nothing — every hand-written body fails", () => {
    expect({ count: baseline.count, files: baseline.files }).toEqual({
      count: 0,
      files: {},
    });
    expect(counts).toEqual({});
  });

  it("no file has more hand-written bodies than its baseline; the baseline only shrinks", () => {
    const result = compare(counts, baseline);
    if (process.env.UPDATE_FAKE_FETCH_BASELINE === "1" && result.over.length === 0) {
      const files = Object.fromEntries(
        Object.entries(baseline.files)
          .filter(([f]) => (counts[f] ?? 0) > 0)
          .map(([f, e]) => [f, { ...e, count: counts[f] }])
      );
      const count = Object.values(files).reduce((n, e) => n + e.count, 0);
      writeFileSync(
        BASELINE_FILE,
        `${JSON.stringify({ ...baseline, count, files }, null, 2)}\n`
      );
      return;
    }
    expect(result).toEqual({ over: [], under: [], unexplained: [], total: [] });
  });

  it("[self-test] counts each kind of hand-written body, and not a fixture", () => {
    const planted = [
      'import { render } from "@testing-library/react";',
      'import { routeAnswer } from "@/__tests__/fixtures/route-responses";',
      "const fetchMock = jest.fn();",
      "global.fetch = fetchMock as unknown as typeof fetch;",
      "function reply(status: number, body: unknown) {",
      "  return { ok: status < 400, status, json: async () => body } as unknown as Response;",
      "}",
      "function answers(...list: [number, unknown][]) {",
      "  let i = 0;",
      "  fetchMock.mockImplementation(async () => { const [s, b] = list[i++]; return reply(s, b); });",
      "}",
      "const LIST = { items: [] };",
      "fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ a: 1 }) });",
      "fetchMock.mockResolvedValueOnce(Response.json({ b: 2 }));",
      "fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([3])));",
      "answers([200, { c: 4 }], [200, LIST], routeAnswer('GET /api/operator/jobs — an operator'));",
      "fetchMock.mockResolvedValueOnce(reply(403, { code: 'auth.permission_denied' }));",
    ].join("\n");
    expect(handWrittenBodies(planted)).toEqual([12, 13, 14, 15, 16, 17]);
    // Not a component test that replaces fetch: nothing to count.
    expect(handWrittenBodies("const x = { json: () => ({ a: 1 }) };")).toEqual([]);
  });

  it("[self-test] counts a body reached through a name or a same-file function (TASK-207)", () => {
    const planted = [
      'import { render } from "@testing-library/react";',
      "global.fetch = jest.fn() as unknown as typeof fetch;",
      "let guest: { ok: boolean; body: unknown } = { ok: true, body: {} };",
      "guest = { ok: false, body: { code: 'internal.error' } };",
      "let features = {};",
      "features = { sso_google: { available: true } };",
      "function makeBody() { return { items: [] }; }",
      "const fetchMock = jest.fn(async (url: string) =>",
      "  url === '/a' ? { ok: guest.ok, json: async () => guest.body }",
      "  : url === '/b' ? { ok: true, json: async () => features }",
      "  : { ok: true, json: async () => makeBody() });",
    ].join("\n");
    expect(handWrittenBodies(planted)).toEqual([3, 4, 5, 6, 7]);
    // A fixture taken by name, and a table of names, are no bodies.
    const fixture = [
      'import { render } from "@testing-library/react";',
      'import { routeAnswer } from "@/__tests__/fixtures/route-responses";',
      "global.fetch = jest.fn() as unknown as typeof fetch;",
      "const names = new Map([['/a', 'GET /api/x — one']]);",
      "const [status, body] = routeAnswer('GET /api/x — one');",
      "const reply = { ok: status < 400, json: async () => body };",
      "const named = () => ({ ok: true, json: async () => routeAnswer(names.get('/a')!)[1] });",
    ].join("\n");
    expect(handWrittenBodies(fixture)).toEqual([]);
  });

  it("[self-test] counts the bodies of a test that defines fetch, or mocks a client fetch wrapper", () => {
    const rendered = 'import { render } from "@testing-library/react";';
    const body = "m.mockResolvedValueOnce({ ok: true, json: async () => ({ a: 1 }) });";
    for (const replaces of [
      'Object.defineProperty(global, "fetch", { value: m, writable: true });',
      'Object.defineProperty(globalThis, "fetch", { value: m });',
      'jest.mock("@/platform/auth/api-fetch", () => ({ apiFetch: m }));',
      'jest.mock("../platform/auth/api-fetch");',
      'jest.mock("@/platform/errors/refusal", () => ({ ...actual, fetchWithProvisioningRetry: m }));',
      'jest.spyOn(apiFetchModule, "apiFetch").mockImplementation(m);',
    ]) {
      const planted = [rendered, replaces, body].join("\n");
      expect([replaces, handWrittenBodies(planted)]).toEqual([replaces, [3]]);
    }
    // The global replaced through a cast or a bracket.
    for (const replaces of [
      "(global as any).fetch = m;",
      "(globalThis as unknown as { fetch: unknown }).fetch = m;",
      'global["fetch"] = m;',
      "(window as any)['fetch'] = m;",
    ]) {
      const planted = [rendered, replaces, body].join("\n");
      expect([replaces, handWrittenBodies(planted)]).toEqual([replaces, [3]]);
    }
    // An app's own wrapper (scripts/fetch-wrappers.app.json), when it is listed.
    const own = [
      rendered,
      'jest.mock("@/lib/identity-conflict", () => ({ playformApiFetch: m }));',
      body,
    ].join("\n");
    const appWrappers = [{ module: "lib/identity-conflict", name: "playformApiFetch" }];
    expect(
      handWrittenBodies(own, "own.test.tsx", [...FETCH_WRAPPERS, ...appWrappers])
    ).toEqual([3]);
    expect(handWrittenBodies(own, "own.test.tsx", FETCH_WRAPPERS)).toEqual([]);
    // A comparison is no replacement.
    expect(
      handWrittenBodies(
        [rendered, "if (global.fetch === m) {}", body].join("\n"),
        "c.test.tsx",
        FETCH_WRAPPERS
      )
    ).toEqual([]);
    // A test that replaces neither: nothing to count.
    expect(handWrittenBodies([rendered, body].join("\n"))).toEqual([]);
    expect(
      handWrittenBodies(
        [rendered, 'jest.mock("@/platform/errors/refusal-copy");', body].join("\n")
      )
    ).toEqual([]);
  });

  it("[self-test] the comparison refuses a file over its count, and a count not lowered", () => {
    const base: Baseline = {
      count: 3,
      files: {
        "a.test.tsx": { count: 2, reason: "pre-dates the rule, to be replaced" },
        "b.test.tsx": { count: 1, reason: "x" },
      },
    };
    expect(compare({ "a.test.tsx": 3, "c.test.tsx": 1 }, base)).toEqual({
      over: [
        "a.test.tsx: 3 hand-written bodies, 2 allowed",
        "c.test.tsx: 1 hand-written bodies, 0 allowed",
      ],
      under: ["b.test.tsx: 0 now, the baseline says 1 — lower it"],
      unexplained: ["b.test.tsx: no reason"],
      total: [],
    });
    // Planted: a count that is not the sum of the entries.
    expect(
      compare({ "a.test.tsx": 2, "b.test.tsx": 1 }, { ...base, count: 4 }).total
    ).toEqual(["count 4, entries sum to 3"]);
  });
});
