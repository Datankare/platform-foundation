/**
 * __tests__/postgrest-url-encoding.test.ts — no value reaches a PostgREST filter unencoded (audit E-16, F-17)
 *
 * Stores that call the REST API directly built URLs like `?id=eq.${id}`. An id containing `&`
 * adds a filter; `#` truncates the URL and drops every filter after it — in the social store,
 * "remove one member" became "remove all members". Every value interpolated into a filter, in a
 * URL or in a string filter (`.or()`, `.filter()`), is passed through encodeURIComponent (values
 * set through URLSearchParams are encoded by it). No string filter is built from a variable at
 * all: an either-or query is two bound-filter queries merged (auditRowsForUser).
 *
 * Whole template literals are scanned (a template may span lines). A template whose values are
 * encoded before it (an `in.(...)` list) says so with a `// url-encoded: <why>` comment on the
 * line directly above it; the number of such exemptions is capped.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { productionSources, ROOT } from "./helpers/route-policy";

/** Every PostgREST filter operator. */
const OPERATORS =
  "eq|neq|lt|lte|gt|gte|like|ilike|match|imatch|is|isdistinct|in|cs|cd|ov|sl|sr|nxl|nxr|adj|fts|plfts|phfts|wfts|not";

/** A filter operator followed by an interpolation that is not encoded. */
const UNENCODED = new RegExp(
  `(?:^|[=(,&?.])(?:${OPERATORS})\\.\\(?["%*{]*\\$\\{(?!encodeURIComponent\\()`
);

/** A string filter built with interpolation. */
const STRING_FILTER = /\.(?:or|filter)\(\s*`[^`]*\$\{/g;

const TEMPLATE = /`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g;

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scan(file: string, src: string): { hits: Hit[]; exempted: number } {
  const hits: Hit[] = [];
  let exempted = 0;
  const lines = src.split("\n");
  const lineAt = (offset: number) => src.slice(0, offset).split("\n").length;
  for (const m of src.matchAll(TEMPLATE)) {
    const text = m[0];
    if (!UNENCODED.test(text)) continue;
    const line = lineAt(m.index ?? 0);
    if (/\/\/ url-encoded: \S/.test(lines[line - 2] ?? "")) {
      exempted++;
      continue;
    }
    hits.push({ file, line, text: text.slice(0, 120) });
  }
  // No string filter is built with interpolation at all.
  for (const m of src.matchAll(STRING_FILTER)) {
    hits.push({ file, line: lineAt(m.index ?? 0), text: m[0].slice(0, 120) });
  }
  return { hits, exempted };
}

const RESULTS = productionSources().map((file) =>
  scan(file, readFileSync(join(ROOT, file), "utf-8"))
);

describe("PostgREST URL encoding", () => {
  it("interpolates no unencoded value into a filter", () => {
    expect(RESULTS.flatMap((r) => r.hits)).toEqual([]);
  });

  it("keeps exemptions rare (each is a reviewed `url-encoded:` comment)", () => {
    expect(RESULTS.reduce((n, r) => n + r.exempted, 0)).toBeLessThanOrEqual(2);
  });

  it.each([
    ["an unencoded id", "`${url}/rest/v1/groups?id=eq.${groupId}`"],
    ["an in-list", "`?id=in.(${ids})`"],
    ["an ilike pattern", "`?name=ilike.%${q}%`"],
    ["a containment filter", "`?tags=cs.{${tag}}`"],
    ["a template across lines", "`${url}/rest/v1/x?a=eq.1\n&b=eq.${b}`"],
  ])("the checker catches %s", (_label, src) => {
    expect(scan("f.ts", src).hits).toHaveLength(1);
  });

  it("the checker accepts an encoded value, and refuses any interpolated string filter", () => {
    expect(scan("f.ts", "`?id=eq.${encodeURIComponent(groupId)}`").hits).toEqual([]);
    expect(scan("f.ts", "q.or(`actor_id.eq.${userId}`);").hits.length).toBeGreaterThan(0);
    expect(scan("f.ts", "q.filter(`x`, `${op}`, v);").hits.length).toBe(0);
  });
});
