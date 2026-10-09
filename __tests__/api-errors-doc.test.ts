/**
 * ADR-051 D5 (c): docs/API_ERRORS.md (platform codes) and docs/APP_API_ERRORS.md (the consuming
 * app's `app.*` codes, D1) are generated from the registry and catalog and never drift.
 * The generator pads tables as Prettier does, so the file also passes format:check.
 * Regenerate: UPDATE_API_ERRORS_DOC=1 npx jest __tests__/api-errors-doc.test.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  escapeTableCell,
  renderApiErrorsDoc,
  renderAppApiErrorsDoc,
} from "@/platform/errors/doc";

const DOCS = join(__dirname, "..", "docs");

describe.each([
  ["API_ERRORS.md", renderApiErrorsDoc],
  ["APP_API_ERRORS.md", renderAppApiErrorsDoc],
])("docs/%s", (file, render) => {
  it("matches the registry and the English catalog", () => {
    const path = join(DOCS, file);
    const want = render() + "\n";
    if (process.env.UPDATE_API_ERRORS_DOC === "1") writeFileSync(path, want);
    expect(readFileSync(path, "utf8")).toBe(want);
  });
});

describe("platform and app references are separate", () => {
  it("the platform reference lists no app code", () => {
    expect(renderApiErrorsDoc()).not.toMatch(/^\| `app\./m);
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
