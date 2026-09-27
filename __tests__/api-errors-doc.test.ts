/**
 * ADR-051 D5 (c): docs/API_ERRORS.md is generated from the registry and catalog and never drifts.
 * The generator pads tables as Prettier does, so the file also passes format:check.
 * Regenerate: UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { renderApiErrorsDoc } from "@/platform/errors/doc";

const DOC = join(__dirname, "..", "docs", "API_ERRORS.md");

describe("docs/API_ERRORS.md", () => {
  it("matches the registry and the English catalog", () => {
    const want = renderApiErrorsDoc() + "\n";
    if (process.env.UPDATE_API_ERRORS_DOC === "1") writeFileSync(DOC, want);
    expect(readFileSync(DOC, "utf8")).toBe(want);
  });
});
