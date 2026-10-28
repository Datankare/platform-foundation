/**
 * __tests__/admin-list-search.test.ts — admin list search and paging take no filter syntax (audit B-16, E-15)
 *
 * The users and audit lists spliced `q` into a PostgREST .or() string, so filter syntax in a
 * search widened or rewrote the query, and paging passed NaN from hostile `limit`/`offset` to
 * the database. They now bind `q` as a parameter and bound every page. The properties of the
 * paging and search-term helpers are here; the routes themselves are run with filter syntax,
 * wildcards and hostile paging against Postgres in __tests__/db/admin-tenant-data.db.test.ts.
 */

import fc from "fast-check";
import { fuzzParams } from "@/__tests__/helpers/fuzz";
import { likeTerm, pageParams } from "@/lib/pagination";

fc.configureGlobal(fuzzParams());

describe("paging", () => {
  it("property: any query string gives integers in bounds", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (limit, offset) => {
        const p = pageParams(new URLSearchParams({ limit, offset }), {
          maxLimit: 100,
          maxOffset: 10_000,
        });
        return (
          Number.isInteger(p.limit) &&
          p.limit >= 1 &&
          p.limit <= 100 &&
          Number.isInteger(p.offset) &&
          p.offset >= 0 &&
          p.offset <= 10_000
        );
      })
    );
  });

  it("property: a like term carries no control character and at most 100 characters of the term", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (raw) => {
        const t = likeTerm(raw);
        return !/\p{Cc}/u.test(t) && [...unescape(t)].length <= 100;
      })
    );
  });

  // TASK-185 (pre-existing): the wildcards were stripped, so `john_doe` could not be found.
  it("property: as the pattern `%term%`, a term matches exactly the texts that contain it", () => {
    fc.assert(
      fc.property(
        fc.string({
          maxLength: 20,
          unit: fc.constantFrom("a", "b", "%", "_", "\\", " ", "x"),
        }),
        fc.string({
          maxLength: 30,
          unit: fc.constantFrom("a", "b", "%", "_", "\\", " ", "x"),
        }),
        (raw, text) => {
          const term = likeTerm(raw);
          if (!term) return true;
          const literal = raw.trim();
          return like(`%${term}%`, text) === text.includes(literal);
        }
      )
    );
  });

  it.each([
    ["john_doe", "john\\_doe"],
    ["50%", "50\\%"],
    ["a\\b", "a\\\\b"],
    ["  spaced  ", "spaced"],
    ["x\u0000y\u001f", "xy"],
    ["*", "*"],
  ])("likeTerm(%p) is %p", (raw, expected) => {
    expect(likeTerm(raw)).toBe(expected);
  });

  it("matches john_doe, not johnXdoe; 50% not 500", () => {
    expect(like(`%${likeTerm("john_doe")}%`, "john_doe")).toBe(true);
    expect(like(`%${likeTerm("john_doe")}%`, "johnXdoe")).toBe(false);
    expect(like(`%${likeTerm("50%")}%`, "save 50% now")).toBe(true);
    expect(like(`%${likeTerm("50%")}%`, "500")).toBe(false);
  });
});

/** Postgres LIKE with the default escape character (backslash), as a test oracle. */
function like(pattern: string, text: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\" && i + 1 < pattern.length) {
      re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "%") re += "[\\s\\S]*";
    else if (c === "_") re += "[\\s\\S]";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "u").test(text);
}

/** A term with its escapes removed: the text it matches. */
function unescape(term: string): string {
  return term.replace(/\\([\\%_])/g, "$1");
}
