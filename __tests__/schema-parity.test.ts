/**
 * __tests__/schema-parity.test.ts
 *
 * TASK-067. Runs the parity check in CI so a store writing a column no migration creates
 * fails the suite rather than failing on first call in production.
 *
 * This is the gap that let migration 023 ship a column that did not exist: the conformance
 * kits fake PostgREST and accept whatever the store sends, so they prove a store
 * self-consistent and say nothing about the schema (Gotcha 66).
 */

import { execFileSync } from "child_process";
import { join } from "path";

describe("schema parity (TASK-067)", () => {
  it("every column every store writes is created by a migration", () => {
    // The script exits non-zero and prints what it found. Surfacing its output here means a
    // failure names the store and the column rather than just failing.
    let output = "";
    let failed = false;
    try {
      output = execFileSync(
        process.execPath,
        [join(process.cwd(), "scripts/schema-parity.mjs")],
        { cwd: process.cwd(), encoding: "utf-8" }
      );
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string };
      output = (e.stdout ?? "") + (e.stderr ?? "");
      failed = true;
    }
    if (failed) {
      console.error(output);
    }
    expect(failed ? output : "").toBe("");
  });
});
