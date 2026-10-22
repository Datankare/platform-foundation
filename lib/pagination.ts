/**
 * lib/pagination.ts — Bounded page parameters from a query string
 *
 * `parseInt("x")` is NaN and `Math.min(NaN, 100)` is NaN: list routes passed hostile `limit` and
 * `offset` values straight to the database, which answered with an error the route turned into a
 * 500 (found while adding the monkey run). Every list route reads its page here: integers,
 * clamped to [1, maxLimit] and [0, maxOffset], defaults for anything else.
 */

export interface PageOptions {
  readonly defaultLimit?: number;
  readonly maxLimit?: number;
  readonly maxOffset?: number;
}

export interface Page {
  readonly limit: number;
  readonly offset: number;
}

function int(raw: string | null): number | null {
  if (raw === null || !/^\d{1,9}$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

export function pageParams(params: URLSearchParams, options: PageOptions = {}): Page {
  const maxLimit = options.maxLimit ?? 100;
  const defaultLimit = Math.min(options.defaultLimit ?? 50, maxLimit);
  const maxOffset = options.maxOffset ?? 10_000;
  const limit = int(params.get("limit"));
  const offset = int(params.get("offset"));
  return {
    limit: limit === null || limit < 1 ? defaultLimit : Math.min(limit, maxLimit),
    offset: offset === null ? 0 : Math.min(offset, maxOffset),
  };
}

/** A search term safe to use as a LIKE pattern value: wildcards and control characters removed. */
export function likeTerm(raw: string | null, maxLength = 100): string {
  return (raw ?? "")
    .replace(/[\p{Cc}%_*\\]/gu, "")
    .trim()
    .slice(0, maxLength);
}
