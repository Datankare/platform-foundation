/**
 * ADR-051 D5 (c): docs/API_ERRORS.md is generated from the registry and catalog and never drifts.
 * The generator pads tables as Prettier does, so the file also passes format:check.
 * Regenerate: UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { escapeTableCell, renderApiErrorsDoc } from "@/platform/errors/doc";

const DOC = join(__dirname, "..", "docs", "API_ERRORS.md");

describe("docs/API_ERRORS.md", () => {
  it("matches the registry and the English catalog", () => {
    const want = renderApiErrorsDoc() + "\n";
    if (process.env.UPDATE_API_ERRORS_DOC === "1") writeFileSync(DOC, want);
    expect(readFileSync(DOC, "utf8")).toBe(want);
  });
});

describe("escapeTableCell (CodeQL js/incomplete-sanitization)", () => {
  it("escapes pipes", () => {
    expect(escapeTableCell("a|b")).toBe("a\\|b");
  });

  it("escapes backslashes first, so an existing backslash cannot unescape a pipe", () => {
    // "\|" in the input must stay literal: backslash escaped, then pipe escaped.
    expect(escapeTableCell("a\\|b")).toBe("a\\\\\\|b");
    expect(escapeTableCell("C:\\path")).toBe("C:\\\\path");
  });

  it("leaves ordinary text alone", () => {
    expect(escapeTableCell("Sign in to continue.")).toBe("Sign in to continue.");
  });
});
