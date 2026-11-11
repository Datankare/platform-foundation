/**
 * __tests__/route-exports.test.ts — a route file exports only what Next.js reads from it
 * (TASK-204, N-96)
 *
 * @guard a route or page file that exports a name Next.js does not know
 *
 * app/api/health/route.ts re-exported a helper (`deployedCommit`); Next.js's generated route types
 * refuse any other export, so `next build --webpack` failed with TS2344 while the Turbopack
 * build and the tests passed. A helper lives in a module (platform/, lib/), never in a route file.
 * The exports are read with the TypeScript parser, every form: declarations, `export { … }`,
 * `export … from`, and `export *`.
 */
import { readFileSync } from "fs";
import { join, relative, sep } from "path";
import ts from "typescript";
import { walkFiles } from "./helpers/repo-files";

/** What Next.js reads from a route handler file (the App Router's route segment config). */
const ROUTE_EXPORTS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  "runtime",
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "preferredRegion",
  "maxDuration",
  "generateStaticParams",
]);

/** The names a source file exports ("*" for `export * from`). */
export function exportedNames(source: string): string[] {
  const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const exported = (n: ts.Node) =>
    ts.canHaveModifiers(n) &&
    (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const st of file.statements) {
    if (ts.isExportDeclaration(st)) {
      if (!st.exportClause) names.push("*");
      else if (ts.isNamedExports(st.exportClause))
        for (const el of st.exportClause.elements) names.push(el.name.text);
      else names.push(st.exportClause.name.text);
    } else if (ts.isExportAssignment(st)) {
      names.push("default");
    } else if (exported(st)) {
      if (ts.isVariableStatement(st))
        for (const d of st.declarationList.declarations)
          names.push(ts.isIdentifier(d.name) ? d.name.text : d.name.getText());
      else if (
        (ts.isFunctionDeclaration(st) ||
          ts.isClassDeclaration(st) ||
          ts.isInterfaceDeclaration(st) ||
          ts.isTypeAliasDeclaration(st) ||
          ts.isEnumDeclaration(st)) &&
        st.name
      )
        names.push(st.name.text);
    }
  }
  return names;
}

describe("route files export only what Next.js reads (TASK-204, N-96)", () => {
  const routes = walkFiles(join(process.cwd(), "app"), (n) =>
    /^route\.tsx?$/.test(n)
  ).map((p) => relative(process.cwd(), p).split(sep).join("/"));

  it("[self-test] reads every form of export", () => {
    expect(
      exportedNames(
        [
          "export const GET = 1;",
          "export async function POST() {}",
          "export { helper };",
          "export { a as b } from './x';",
          "export * from './y';",
          "export type T = 1;",
          "export const runtime = 'nodejs';",
        ].join("\n")
      )
    ).toEqual(["GET", "POST", "helper", "b", "*", "T", "runtime"]);
  });

  it("[self-test] the health route's former re-export is refused", () => {
    const bad = exportedNames(
      "import { deployedCommit } from 'x';\nexport { deployedCommit };\nexport const GET = 1;"
    ).filter((n) => !ROUTE_EXPORTS.has(n));
    expect(bad).toEqual(["deployedCommit"]);
  });

  it("every route file", () => {
    expect(routes.length).toBeGreaterThan(30);
    const bad = routes.flatMap((f) =>
      exportedNames(readFileSync(join(process.cwd(), f), "utf8"))
        .filter((n) => !ROUTE_EXPORTS.has(n))
        .map((n) => `${f}: exports ${n} — move it to a module (platform/, lib/)`)
    );
    expect(bad).toEqual([]);
  });
});
