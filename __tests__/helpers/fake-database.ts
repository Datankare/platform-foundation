/**
 * __tests__/helpers/fake-database.ts — An in-memory database behind the Supabase client API
 *
 * Unlike a canned per-table response, this keeps real rows and evaluates the filters a query
 * sends, so a test sees what the code actually reads and writes: a lookup by the wrong column
 * finds nothing, an update with a missing filter changes every row, and a test can assert the
 * state afterwards (Adversarial Validation, practice 5 — CONTRIBUTING.md).
 *
 * Supported: from(table) · select(columns?, { count, head }) · insert · update · upsert
 * (onConflict) · delete · eq · neq · in · is · gt · gte · lt · lte · order · limit ·
 * single · maybeSingle · await. Filter strings (`.or()`, `.filter()`) are refused on purpose:
 * code must not assemble filters from input (TASK-145).
 *
 * Privileged and isolation paths are also tested against real Postgres in CI; this fake is for
 * fast unit tests of handler logic.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Row = Record<string, any>;

interface Filter {
  readonly column: string;
  readonly test: (value: any) => boolean;
}

export interface FakeDatabaseOptions {
  /** Fill `created_at` (ISO now) on inserted rows that have none, as a column default would. */
  readonly timestamps?: boolean;
  /** Unique column sets per table, e.g. { roles: [["name"]], role_permissions: [["role_id", "permission_id"]] } */
  readonly unique?: Record<string, readonly (readonly string[])[]>;
}

let idCounter = 0;
function newId(): string {
  idCounter += 1;
  return `00000000-0000-4000-8000-${idCounter.toString(16).padStart(12, "0")}`;
}

export class FakeDatabase {
  readonly tables: Record<string, Row[]>;
  private readonly unique: Record<string, readonly (readonly string[])[]>;
  /** @internal */
  readonly timestamps: boolean;
  /** Every write, in order: [operation, table, rows affected]. */
  readonly writes: [string, string, number][] = [];
  /** Tables whose writes fail (injected failure — Adversarial Validation practice 6). */
  readonly failing = new Set<string>();

  /** Tables whose reads fail. */
  readonly failingReads = new Set<string>();

  /** Make every write to `table` fail with a database error, as an outage would. */
  failWrites(table: string): this {
    this.failing.add(table);
    return this;
  }

  /** Make every read of `table` fail with a database error: a read error must never pass as "no rows". */
  failReads(table: string): this {
    this.failingReads.add(table);
    return this;
  }

  constructor(seed: Record<string, Row[]> = {}, options: FakeDatabaseOptions = {}) {
    this.tables = {};
    for (const [table, rows] of Object.entries(seed)) {
      this.tables[table] = rows.map((r) => ({ ...r }));
    }
    this.unique = options.unique ?? {};
    this.timestamps = options.timestamps ?? false;
  }

  rows(table: string): Row[] {
    if (!this.tables[table]) this.tables[table] = [];
    return this.tables[table];
  }

  /** A client with the subset of the supabase-js API the server code uses. */
  client(): any {
    return { from: (table: string) => new Query(this, table) };
  }

  /** @internal */
  violatesUnique(table: string, candidate: Row, ignore?: Row): boolean {
    for (const cols of this.unique[table] ?? []) {
      const clash = this.rows(table).some(
        (r) =>
          r !== ignore && cols.every((c) => r[c] !== undefined && r[c] === candidate[c])
      );
      if (clash) return true;
    }
    return false;
  }
}

type Operation =
  | { kind: "select" }
  | { kind: "insert"; rows: Row[] }
  | { kind: "update"; patch: Row }
  | { kind: "upsert"; rows: Row[]; onConflict: string[] }
  | { kind: "delete" };

class Query implements PromiseLike<any> {
  private operation: Operation = { kind: "select" };
  private readonly filters: Filter[] = [];
  private columns: string | undefined;
  private countMode = false;
  private head = false;
  private returning = false;
  private ordering: { column: string; ascending: boolean } | undefined;
  private max: number | undefined;
  private skip = 0;
  private expect: "many" | "single" | "maybeSingle" = "many";

  constructor(
    private readonly db: FakeDatabase,
    private readonly table: string
  ) {}

  select(columns?: string, options?: { count?: string; head?: boolean }): this {
    if (this.operation.kind === "select") {
      this.columns = columns;
      this.countMode = options?.count !== undefined;
      this.head = options?.head === true;
    } else {
      this.returning = true;
      this.columns = columns;
    }
    return this;
  }

  insert(rows: Row | Row[]): this {
    this.operation = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] };
    return this;
  }

  update(patch: Row): this {
    this.operation = { kind: "update", patch };
    return this;
  }

  upsert(rows: Row | Row[], options?: { onConflict?: string }): this {
    this.operation = {
      kind: "upsert",
      rows: Array.isArray(rows) ? rows : [rows],
      onConflict: (options?.onConflict ?? "id").split(",").map((c) => c.trim()),
    };
    return this;
  }

  delete(): this {
    this.operation = { kind: "delete" };
    return this;
  }

  private where(column: string, test: (v: any) => boolean): this {
    this.filters.push({ column, test });
    return this;
  }

  eq(column: string, value: unknown): this {
    return this.where(column, (v) => v === value);
  }
  neq(column: string, value: unknown): this {
    return this.where(column, (v) => v !== value);
  }
  in(column: string, values: readonly unknown[]): this {
    return this.where(column, (v) => values.includes(v));
  }
  is(column: string, value: null | boolean): this {
    return this.where(column, (v) =>
      value === null ? v === null || v === undefined : v === value
    );
  }
  gt(column: string, value: any): this {
    return this.where(column, (v) => v > value);
  }
  gte(column: string, value: any): this {
    return this.where(column, (v) => v >= value);
  }
  lt(column: string, value: any): this {
    return this.where(column, (v) => v < value);
  }
  lte(column: string, value: any): this {
    return this.where(column, (v) => v <= value);
  }

  /** LIKE, case-insensitive: `%` any run, `_` one character (as Postgres). */
  ilike(column: string, pattern: string): this {
    const rx = new RegExp(
      "^" +
        pattern
          .split("")
          .map((c) =>
            c === "%" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          )
          .join("") +
        "$",
      "is"
    );
    return this.where(column, (v) => typeof v === "string" && rx.test(v));
  }

  or(): never {
    throw new Error(
      "FakeDatabase refuses .or(): build filters with bound methods, not strings"
    );
  }
  filter(): never {
    throw new Error("FakeDatabase refuses .filter(): build filters with bound methods");
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.ordering = { column, ascending: options?.ascending !== false };
    return this;
  }

  limit(n: number): this {
    this.max = n;
    return this;
  }

  /** Rows from..to inclusive, as PostgREST. A bound that is not a whole number is an error. */
  range(from: number, to: number): this {
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error(`FakeDatabase: range(${from}, ${to}) is not a valid range`);
    }
    this.skip = from;
    this.max = Math.max(0, to - from + 1);
    return this;
  }

  single(): Promise<any> {
    this.expect = "single";
    return this.run();
  }

  maybeSingle(): Promise<any> {
    this.expect = "maybeSingle";
    return this.run();
  }

  then<A = any, B = never>(
    onFulfilled?: ((value: any) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: any) => B | PromiseLike<B>) | null
  ): Promise<A | B> {
    return this.run().then(onFulfilled, onRejected);
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => f.test(row[f.column]));
  }

  private project(row: Row): Row {
    if (!this.columns || this.columns.trim() === "*") return { ...row };
    const out: Row = {};
    for (const col of this.columns.split(",").map((c) => c.trim())) {
      if (col && !col.includes("(")) out[col] = row[col] ?? null;
    }
    return out;
  }

  private async run(): Promise<any> {
    const rows = this.db.rows(this.table);
    let affected: Row[];

    if (this.operation.kind !== "select" && this.db.failing.has(this.table)) {
      return {
        data: null,
        error: { message: `${this.table} is unavailable`, code: "08006" },
      };
    }

    switch (this.operation.kind) {
      case "select": {
        if (this.db.failingReads.has(this.table)) {
          return {
            data: null,
            error: { message: `${this.table} is unavailable`, code: "08006" },
          };
        }
        affected = rows.filter((r) => this.matches(r));
        if (this.ordering) {
          const { column, ascending } = this.ordering;
          affected = [...affected].sort((a, b) =>
            a[column] === b[column]
              ? 0
              : (a[column] > b[column] ? 1 : -1) * (ascending ? 1 : -1)
          );
        }
        if (this.skip) affected = affected.slice(this.skip);
        if (this.max !== undefined) affected = affected.slice(0, this.max);
        if (this.head) return { data: null, error: null, count: affected.length };
        break;
      }
      case "insert": {
        const stamp = this.db.timestamps ? { created_at: new Date().toISOString() } : {};
        const created = this.operation.rows.map((r) => ({ id: newId(), ...stamp, ...r }));
        for (const row of created) {
          if (this.db.violatesUnique(this.table, row)) {
            return {
              data: null,
              error: {
                message: "duplicate key value violates unique constraint",
                code: "23505",
              },
            };
          }
          rows.push(row);
        }
        this.db.writes.push(["insert", this.table, created.length]);
        affected = created;
        break;
      }
      case "update": {
        affected = rows.filter((r) => this.matches(r));
        for (const row of affected) Object.assign(row, this.operation.patch);
        this.db.writes.push(["update", this.table, affected.length]);
        break;
      }
      case "upsert": {
        const { onConflict } = this.operation;
        affected = [];
        for (const candidate of this.operation.rows) {
          const existing = rows.find((r) =>
            onConflict.every((c) => r[c] === candidate[c])
          );
          if (existing) {
            Object.assign(existing, candidate);
            affected.push(existing);
          } else {
            const row = { id: newId(), ...candidate };
            rows.push(row);
            affected.push(row);
          }
        }
        this.db.writes.push(["upsert", this.table, affected.length]);
        break;
      }
      case "delete": {
        affected = rows.filter((r) => this.matches(r));
        this.db.tables[this.table] = rows.filter((r) => !affected.includes(r));
        this.db.writes.push(["delete", this.table, affected.length]);
        break;
      }
    }

    if (this.operation.kind !== "select" && !this.returning) {
      return { data: null, error: null, count: affected.length };
    }
    const data = affected.map((r) => this.project(r));
    if (this.expect === "many") {
      return { data, error: null, count: this.countMode ? data.length : null };
    }
    if (data.length === 1) return { data: data[0], error: null };
    if (data.length === 0 && this.expect === "maybeSingle")
      return { data: null, error: null };
    return {
      data: null,
      error: { message: `expected one row, got ${data.length}`, code: "PGRST116" },
    };
  }
}
