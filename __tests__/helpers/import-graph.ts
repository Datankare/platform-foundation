/**
 * __tests__/helpers/import-graph.ts — Every import between repository files (ADR-054 D3)
 *
 * Parses each TypeScript/JavaScript file with the TypeScript compiler and records what it
 * imports from the repository: `import` and `export … from` declarations, dynamic `import()`,
 * `require()`, and jest's `jest.mock` / `jest.requireActual` / `jest.requireMock` (a test that
 * mocks a module's file depends on it as much as one that imports it). Specifiers are resolved
 * the way the app resolves them: `@/` from the repository root, relative from the file, with the
 * .ts/.tsx/index fallbacks. Package imports are not recorded.
 *
 * The lint rule (import/no-restricted-paths) stops a new boundary breach at edit time; this graph
 * is the independent check the module-boundary test runs over the whole tree.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, normalize, relative, sep } from "path";
import ts from "typescript";

export const ROOT = process.cwd();

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);
const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const JEST_LOADERS = new Set(["mock", "requireActual", "requireMock"]);

export interface ImportEdge {
  /** The importing file, repository-relative. */
  readonly from: string;
  /** The specifier as written. */
  readonly specifier: string;
  /** The resolved file (or the unresolved path), repository-relative. */
  readonly to: string;
}

const toRel = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

/** Every source file under the repository (minus build output and dependencies). */
export function sourceFiles(dir: string = ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(abs));
    else if (SOURCE.test(entry.name)) out.push(toRel(abs));
  }
  return out.sort();
}

/** The repository file a specifier names, or null for a package. */
export function resolveSpecifier(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = specifier.slice(2);
  else if (specifier.startsWith(".")) base = normalize(join(dirname(from), specifier));
  else return null;
  base = base.split(sep).join("/");
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.mjs`,
  ]) {
    const abs = join(ROOT, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return base;
}

/** The literal first argument of a call, if it has one. */
function literalArgument(node: ts.CallExpression): string | null {
  const [first] = node.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : null;
}

/** Whether a call loads a module: import(), require(), jest.mock / requireActual / requireMock. */
function isLoaderCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  return ts.isPropertyAccessExpression(callee) && JEST_LOADERS.has(callee.name.text);
}

/** Every module specifier a source text loads, in source order. */
export function specifiersIn(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && isLoaderCall(node)) {
      const spec = literalArgument(node);
      if (spec !== null) found.push(spec);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** Every repository-internal import in the tree. */
export function importGraph(files: readonly string[] = sourceFiles()): ImportEdge[] {
  const edges: ImportEdge[] = [];
  for (const from of files) {
    const source = readFileSync(join(ROOT, from), "utf8");
    for (const specifier of specifiersIn(from, source)) {
      const to = resolveSpecifier(from, specifier);
      if (to !== null) edges.push({ from, specifier, to });
    }
  }
  return edges;
}

/** Whether a file is a test file (it runs under jest or Playwright, never in the app). */
export function isTestFile(rel: string): boolean {
  return /(?:^|\/)(?:__tests__|__mocks__|e2e)\/|\.test\.|\.spec\./.test(rel);
}
