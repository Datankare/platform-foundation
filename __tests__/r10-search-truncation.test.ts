/**
 * __tests__/r10-search-truncation.test.ts — The command bar's search result is cut deliberately,
 * never failed (review 10 M5)
 *
 * Twenty audit_log rows can hold up to 1 MiB of details each: the result could not be recorded,
 * and the action failed after the search had run. It is now limited to SEARCH_RESULT_MAX_BYTES —
 * whole rows while they fit, then a note of how many were not shown — well inside one step.
 */

jest.mock("@/platform/data", () => require("./helpers/fake-data").fakeDataModule());

import { fakeData } from "./helpers/fake-data";
import { CALLERS } from "@/__tests__/helpers/test-identities";
import {
  handleSearch,
  SEARCH_RESULT_MAX_BYTES,
  searchResultText,
} from "@/app/api/admin/ai/handlers/search";
import {
  STORED_JSON_MAX_BYTES,
  storedJsonViolation,
} from "@/platform/errors/json-limits";

describe("r10 M5: search over 1 MiB", () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({
    id: i,
    details: { blob: "d".repeat(200_000) },
  }));

  it("shows whole rows while they fit, and says how many were cut", () => {
    const text = searchResultText(rows);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
      SEARCH_RESULT_MAX_BYTES + 200
    );
    expect(text).toMatch(
      /… 19 rows not shown \(1, 2, 3, .*, 19\): the result is limited to 256 KiB \(showing 1 of 20\)\./
    );
    expect(JSON.parse(text.slice(0, text.lastIndexOf("]") + 1))).toEqual([rows[0]]);
  });

  it("a result that fits is the plain list, unchanged", () => {
    const small = [{ a: 1 }, { b: "x" }];
    expect(searchResultText(small)).toBe(JSON.stringify(small, null, 2));
  });

  it("a single row larger than the limit is not shown, and said so", () => {
    const text = searchResultText([{ blob: "e".repeat(SEARCH_RESULT_MAX_BYTES) }]);
    expect(text).toMatch(/^\[\]\n… 1 row not shown:/);
  });

  it("the action's result is storable as a step, whatever the rows hold", async () => {
    fakeData().reset();
    fakeData().answer = (sql) =>
      /from audit_log/.test(sql) ? rows.map((r) => ({ r })) : undefined;
    const result = await handleSearch(
      { table: "audit_log" },
      CALLERS.super_admin as never
    );
    expect(result.success).toBe(true);
    expect(storedJsonViolation(result)).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      STORED_JSON_MAX_BYTES
    );
  });
});
