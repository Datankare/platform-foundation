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

  it("property: a like term carries no wildcard or control character", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (raw) => {
        const t = likeTerm(raw);
        return t.length <= 100 && !/[%_*\\\p{Cc}]/u.test(t);
      })
    );
  });
});
