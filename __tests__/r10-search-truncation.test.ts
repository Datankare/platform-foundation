/**
 * __tests__/r10-search-truncation.test.ts — The command bar's search result is cut deliberately,
 * never failed (review 10 M5)
 *
 * Twenty rows could hold more than one recorded step may (1 MiB): the result could not be
 * recorded, and the action failed after the search had run. It is limited to
 * SEARCH_RESULT_MAX_BYTES — whole rows while they fit, then a note of how many were not shown —
 * well inside one step. TASK-189: the rows are now a table of allowlisted cells (audit_log's
 * `details` is no longer one of them), and the limit applies to those cells.
 */

jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { fakeData } from "./helpers/fake-data";
import { CALLERS } from "@/__tests__/helpers/test-identities";
import {
  fitSearchRows,
  handleSearch,
  SEARCH_RESULT_MAX_BYTES,
  searchSummary,
} from "@/app/api/admin/ai/handlers/search";
import {
  STORED_JSON_MAX_BYTES,
  storedJsonViolation,
} from "@/platform/errors/json-limits";

describe("r10 M5: search over 1 MiB", () => {
  const rows = Array.from({ length: 20 }, (_, i) => [i, "d".repeat(200_000)]);
  const columns = ["id", "description"];

  it("shows whole rows while they fit, and says how many were cut", () => {
    const fitted = fitSearchRows(rows, columns);
    expect(Buffer.byteLength(JSON.stringify(fitted.shown), "utf8")).toBeLessThanOrEqual(
      SEARCH_RESULT_MAX_BYTES
    );
    expect(fitted.shown).toEqual([rows[0]]);
    expect(searchSummary("roles", rows.length, fitted)).toMatch(
      /^Showing 1 of 20 matching rows of roles\. 19 rows left out \(1, 2, 3, .*, 19\): the result is limited to 256 KiB\.$/
    );
  });

  it("a result that fits is every row, and the line counts them", () => {
    const small = [
      [1, "a"],
      [2, "b"],
    ];
    const fitted = fitSearchRows(small, columns);
    expect(fitted).toEqual({ shown: small, omitted: [] });
    expect(searchSummary("roles", 2, fitted)).toBe("2 rows of roles.");
  });

  it('a single row larger than the limit is not shown, and said so — never "no rows match" (TASK-189 round 1)', () => {
    const fitted = fitSearchRows([[null, "e".repeat(SEARCH_RESULT_MAX_BYTES)]], columns);
    expect(fitted.shown).toEqual([]);
    const text = searchSummary("roles", 1, fitted);
    expect(text).toBe(
      "Showing 0 of 1 matching row of roles. 1 row left out: the result is limited to 256 KiB."
    );
    expect(text).not.toMatch(/No rows/);
  });

  it("the action's result is storable as a step, whatever the rows hold", async () => {
    fakeData().reset();
    fakeData().answer = (sql) =>
      /from roles/.test(sql)
        ? Array.from({ length: 20 }, (_, i) => ({
            id: `r${i}`,
            name: "n",
            description: "d".repeat(200_000),
          }))
        : undefined;
    const result = await handleSearch({ table: "roles" }, CALLERS.super_admin as never);
    expect(result.success).toBe(true);
    expect(result.table?.rows.length).toBe(1);
    expect(storedJsonViolation(result)).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      STORED_JSON_MAX_BYTES
    );
  });
});
