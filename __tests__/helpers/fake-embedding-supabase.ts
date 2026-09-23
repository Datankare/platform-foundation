/**
 * __tests__/helpers/fake-embedding-supabase.ts
 *
 * A tiny STATEFUL fake of the supabase-js query builder — enough of `.from().select()
 * .upsert().delete().eq()` (with { count, head }) for SupabaseEmbeddingStore. Unlike the
 * canned-response mock, it actually stores rows and honours `.eq` filters, so the
 * store-agnostic no-leak kit genuinely exercises scope isolation without a database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

interface BuilderState {
  op: "select" | "upsert" | "delete";
  filters: [string, string][];
  head: boolean;
  count: boolean;
  upsertRow: any;
  onConflict: string;
}

function matches(row: any, filters: [string, string][]): boolean {
  return filters.every(([k, v]) => String(row[k]) === String(v));
}

function execute(rows: any[], s: BuilderState) {
  if (s.op === "upsert") {
    const r = s.upsertRow;
    const keys = s.onConflict.split(",").filter(Boolean);
    const i = rows.findIndex((x) => keys.every((k) => x[k] === r[k]));
    if (i >= 0) rows[i] = { ...r };
    else rows.push({ ...r });
    return { data: null, error: null, count: null };
  }
  if (s.op === "delete") {
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (matches(rows[i], s.filters)) rows.splice(i, 1);
    }
    return { data: null, error: null, count: before - rows.length };
  }
  const found = rows.filter((r) => matches(r, s.filters));
  if (s.head) return { data: null, error: null, count: found.length };
  return { data: found.map((r) => ({ ...r })), error: null, count: found.length };
}

function makeBuilder(rows: any[]) {
  const s: BuilderState = {
    op: "select",
    filters: [],
    head: false,
    count: false,
    upsertRow: null,
    onConflict: "",
  };
  const builder: any = {
    select(_cols?: string, opts?: any) {
      if (opts?.head) s.head = true;
      if (opts?.count) s.count = true;
      return builder;
    },
    upsert(row: any, opts?: any) {
      s.op = "upsert";
      s.upsertRow = row;
      s.onConflict = opts?.onConflict ?? "";
      return builder;
    },
    delete(opts?: any) {
      s.op = "delete";
      if (opts?.count) s.count = true;
      return builder;
    },
    eq(col: string, val: string) {
      s.filters.push([col, val]);
      return builder;
    },
    then(resolve: any, reject: any) {
      return Promise.resolve(execute(rows, s)).then(resolve, reject);
    },
  };
  return builder;
}

/** A fresh, empty fake client. Each call is an independent backing store. */
export function makeFakeSupabase() {
  const rows: any[] = [];
  return {
    _rows: rows,
    from(_table: string) {
      return makeBuilder(rows);
    },
  };
}
