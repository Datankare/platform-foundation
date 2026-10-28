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

/**
 * A search term to use as a LIKE pattern value (`ilike '%' || $1 || '%'`, bound): control
 * characters removed, trimmed, at most `maxLength` characters of the term itself, then each LIKE
 * metacharacter — `%`, `_` and the escape character `\` (Postgres's default) — escaped with a
 * backslash, so it matches itself and nothing else. It used to strip them instead (TASK-185,
 * pre-existing): `john_doe` searched for `johndoe` and found neither account. `*` was stripped
 * too, a leftover of the PostgREST filter syntax (audit B-16); it is ordinary text in LIKE.
 * '' means no search.
 */
export function likeTerm(raw: string | null, maxLength = 100): string {
  return [...(raw ?? "").replace(/\p{Cc}/gu, "").trim()]
    .slice(0, maxLength)
    .join("")
    .replace(/[\\%_]/g, (c) => "\\" + c);
}
