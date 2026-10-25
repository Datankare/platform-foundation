/**
 * __tests__/helpers/audited-external-scan.ts — which audited() acts reach outside the database
 * (review 14 L-6)
 *
 * audited() refuses an act marked `{ external: true }` inside an open transaction: a rollback
 * cannot undo a call to an identity provider, an e-mail, a webhook, and the `rolled_back` record
 * would be false. Whether a call site carries the flag was checked by a hand count per file
 * (review 13), which a flag moved from one call to another in the same file passed. This reads the
 * code instead, with the TypeScript compiler API:
 *
 *   - every call of audited() — or of a wrapper of it — is found, with its act and its options;
 *   - the act's body is walked, and every function of the same file it calls, transitively; it
 *     reaches an external boundary when it calls
 *       · a function imported from an EXTERNAL_MODULES module (Cognito, the AWS signer, the
 *         e-mail and fetch helpers, the AI and speech providers),
 *       · the global `fetch`,
 *       · or a function — of the same file or imported — whose JSDoc carries `@external`
 *         (a helper that runs registered hooks, which may reach anywhere);
 *   - the call site's flag must say exactly that: `external: true` when the act reaches outside,
 *     no flag when it does not. A wrapper (a function that passes its own act parameter to
 *     audited()) must forward its options parameter, and its own call sites are checked the same.
 *
 * An act the scan cannot see (not inline, not a function of the file, not a wrapper's parameter)
 * is reported, so it is classified by hand rather than passed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import * as ts from "typescript";

/**
 * Modules whose functions reach outside the database (path prefixes, repository-relative, no
 * extension). A function imported from one of them is an external call.
 */
export const EXTERNAL_MODULES: Readonly<Record<string, string>> = {
  "lib/fetchWithTimeout": "outbound HTTP",
  "platform/auth/cognito-provider": "the Cognito identity provider",
  "platform/auth/aws-sigv4": "signed calls to AWS",
  "platform/ai/provider": "the AI model provider",
  "platform/translation/google-translate": "the translation provider",
  "platform/voice": "the speech, conversion and song-identification providers",
  "platform/email": "e-mail",
};

/** A call of audited() or of a wrapper of it. */
export interface AuditedCallSite {
  readonly file: string;
  readonly line: number;
  /** The function called: "audited" or a wrapper's name. */
  readonly callee: string;
  /** How the act was found: written inline, a function of the file, a wrapper's parameter, or not. */
  readonly act: "inline" | "local" | "parameter" | "unresolved";
  /** The options say external: true; "forwarded" — a wrapper passing its own options on. */
  readonly flagged: boolean | "forwarded";
  /** Why the act reaches outside the database (empty: it does not). */
  readonly reaches: readonly string[];
}

export interface ScanResult {
  readonly sites: readonly AuditedCallSite[];
  /** Wrappers found: name → file. */
  readonly wrappers: Readonly<Record<string, string>>;
  /** Wrappers that do not forward their options to audited() (each a finding). */
  readonly unforwarded: readonly string[];
}

/** A source file to scan: its repository-relative path and text. */
export interface SourceText {
  readonly path: string;
  readonly text: string;
}

type FnNode = ts.FunctionLikeDeclaration;

interface FileInfo {
  readonly path: string;
  readonly sf: ts.SourceFile;
  /** Local name → where it was imported from (a repository-relative path, or the specifier). */
  readonly imports: Map<string, { readonly from: string; readonly name: string }>;
  /** Function declarations and `const f = (…) => …` of the file, by name. */
  readonly functions: Map<string, FnNode[]>;
  /** Other variables of the file with an initializer, by name. */
  readonly variables: Map<string, ts.Expression[]>;
}

interface WrapperSpec {
  readonly file: string;
  readonly act: number;
  readonly options: number;
}

const hasExternalTag = (node: ts.Node): boolean =>
  ts.getJSDocTags(node).some((t) => t.tagName.text === "external") ||
  (ts.isVariableDeclaration(node) &&
    ts.isVariableDeclarationList(node.parent) &&
    ts.getJSDocTags(node.parent.parent).some((t) => t.tagName.text === "external"));

function isFunctionInit(
  e: ts.Expression | undefined
): e is ts.ArrowFunction | ts.FunctionExpression {
  return !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
}

interface FileIndex {
  readonly info: (path: string) => FileInfo | null;
  readonly exportedExternal: (file: string, name: string) => boolean;
}

/** The files' parsed index: imports, functions and variables of each, and `@external` lookups. */
function fileIndex(
  files: readonly SourceText[],
  root: string,
  read: (path: string) => string | undefined
): FileIndex {
  const cache = new Map<string, FileInfo | null>();
  const given = new Map(files.map((f) => [f.path, f.text]));

  const resolveModule = (from: string, spec: string): string => {
    let base: string;
    if (spec.startsWith("@/")) base = spec.slice(2);
    else if (spec.startsWith("."))
      base = relative(root, resolve(root, dirname(from), spec));
    else return spec;
    base = base.split("\\").join("/");
    for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
      if (given.has(cand) || read(cand) !== undefined) return cand;
    }
    return base;
  };

  const info = (path: string): FileInfo | null => {
    if (cache.has(path)) return cache.get(path)!;
    const text = given.get(path) ?? read(path);
    if (text === undefined) {
      cache.set(path, null);
      return null;
    }
    const sf = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const imports = new Map<string, { from: string; name: string }>();
    const functions = new Map<string, FnNode[]>();
    const variables = new Map<string, ts.Expression[]>();
    const add = <T>(m: Map<string, T[]>, k: string, v: T) =>
      m.set(k, [...(m.get(k) ?? []), v]);
    const visit = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
        const from = resolveModule(path, n.moduleSpecifier.text);
        const clause = n.importClause;
        if (clause?.name) imports.set(clause.name.text, { from, name: "default" });
        const b = clause?.namedBindings;
        if (b && ts.isNamedImports(b)) {
          for (const el of b.elements) {
            imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
          }
        } else if (b && ts.isNamespaceImport(b)) {
          imports.set(b.name.text, { from, name: "*" });
        }
      }
      if (ts.isFunctionDeclaration(n) && n.name) add(functions, n.name.text, n);
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        if (isFunctionInit(n.initializer)) add(functions, n.name.text, n.initializer);
        else add(variables, n.name.text, n.initializer);
      }
      // A dynamic import: `const { f } = await import("@/x")`.
      if (
        ts.isVariableDeclaration(n) &&
        ts.isObjectBindingPattern(n.name) &&
        n.initializer &&
        /\bimport\(\s*["']/.test(n.initializer.getText(sf))
      ) {
        const m = /import\(\s*["']([^"']+)["']/.exec(n.initializer.getText(sf));
        if (m) {
          const from = resolveModule(path, m[1]);
          for (const el of n.name.elements) {
            if (ts.isIdentifier(el.name)) {
              const name =
                el.propertyName && ts.isIdentifier(el.propertyName)
                  ? el.propertyName.text
                  : el.name.text;
              imports.set(el.name.text, { from, name });
            }
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const fi = { path, sf, imports, functions, variables };
    cache.set(path, fi);
    return fi;
  };

  /** Whether `name`, exported by `file`, is declared `@external` (following re-exports). */
  const exportedExternal = (file: string, name: string, depth = 0): boolean => {
    if (depth > 6) return false;
    const fi = info(file);
    if (!fi) return false;
    for (const fn of fi.functions.get(name) ?? []) {
      const decl = ts.isFunctionDeclaration(fn) ? fn : fn.parent;
      if (hasExternalTag(decl)) return true;
    }
    for (const st of fi.sf.statements) {
      if (
        ts.isExportDeclaration(st) &&
        st.moduleSpecifier &&
        ts.isStringLiteral(st.moduleSpecifier)
      ) {
        const target = resolveModule(file, st.moduleSpecifier.text);
        const clause = st.exportClause;
        if (!clause) {
          if (exportedExternal(target, name, depth + 1)) return true;
        } else if (ts.isNamedExports(clause)) {
          for (const el of clause.elements) {
            if (el.name.text === name) {
              return exportedExternal(
                target,
                (el.propertyName ?? el.name).text,
                depth + 1
              );
            }
          }
        }
      }
    }
    return false;
  };

  return { info, exportedExternal: (file, name) => exportedExternal(file, name) };
}

interface Reach {
  readonly nameReaches: (
    fi: FileInfo,
    name: string,
    seen: Set<ts.Node>,
    asCallee: boolean
  ) => string | undefined;
  readonly nodeReaches: (fi: FileInfo, node: ts.Node, seen: Set<ts.Node>) => string[];
  readonly bodyReaches: (fi: FileInfo, fn: FnNode, seen: Set<ts.Node>) => string[];
}

/** What an act's code reaches: external modules, fetch, `@external` functions — transitively. */
function reachability(index: FileIndex): Reach {
  const { exportedExternal } = index;

  const externalModule = (from: string): string | undefined => {
    const hit = Object.keys(EXTERNAL_MODULES).find(
      (m) => from === m || from.startsWith(`${m}.`) || from.startsWith(`${m}/`)
    );
    return hit ? `${hit} (${EXTERNAL_MODULES[hit]})` : undefined;
  };

  /** Why `name` (as used in `fi`) reaches outside, or undefined; walks local functions. */
  const nameReaches = (
    fi: FileInfo,
    name: string,
    seen: Set<ts.Node>,
    asCallee: boolean
  ): string | undefined => {
    const imported = fi.imports.get(name);
    if (imported) {
      const mod = externalModule(imported.from);
      if (mod) return `${name} from ${mod}`;
      if (imported.name !== "*" && exportedExternal(imported.from, imported.name)) {
        return `${name} (@external, ${imported.from})`;
      }
      return undefined;
    }
    const fns = fi.functions.get(name);
    if (fns) {
      for (const fn of fns) {
        const decl = ts.isFunctionDeclaration(fn) ? fn : fn.parent;
        if (hasExternalTag(decl)) return `${name} (@external)`;
        const r = bodyReaches(fi, fn, seen);
        if (r.length) return `${name} → ${r[0]}`;
      }
      return undefined;
    }
    for (const init of fi.variables.get(name) ?? []) {
      if (seen.has(init)) continue;
      seen.add(init);
      const r = nodeReaches(fi, init, seen);
      if (r.length) return `${name} = ${r[0]}`;
    }
    if (asCallee && name === "fetch") return "fetch (outbound HTTP)";
    return undefined;
  };

  /** The root identifier of `a.b.c(…)` / `a().b`. */
  const rootName = (e: ts.Expression): string | undefined => {
    let cur: ts.Expression = e;
    for (;;) {
      if (ts.isIdentifier(cur)) return cur.text;
      if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
        cur = cur.expression;
      } else if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur)) {
        cur = cur.expression;
      } else return undefined;
    }
  };

  const nodeReaches = (fi: FileInfo, node: ts.Node, seen: Set<ts.Node>): string[] => {
    const out: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression;
        const name = rootName(callee);
        if (name) {
          const r = nameReaches(fi, name, seen, ts.isIdentifier(callee));
          if (r) out.push(r);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
  };

  const bodyReaches = (fi: FileInfo, fn: FnNode, seen: Set<ts.Node>): string[] => {
    if (seen.has(fn)) return [];
    seen.add(fn);
    return fn.body ? nodeReaches(fi, fn.body, seen) : [];
  };

  return { nameReaches, nodeReaches, bodyReaches };
}

/** Scan `files` (repository-relative) under `root`; `read` loads an imported file not in the set. */
export function scanAudited(
  files: readonly SourceText[],
  root: string,
  read: (path: string) => string | undefined = (p) => {
    const full = join(root, p);
    return existsSync(full) ? readFileSync(full, "utf8") : undefined;
  }
): ScanResult {
  const index = fileIndex(files, root, read);
  const { info } = index;
  const { nameReaches, nodeReaches, bodyReaches } = reachability(index);

  /** The function a node sits in, and its name, if it has one. */
  const enclosing = (n: ts.Node): { fn: FnNode; name?: string } | undefined => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (
        ts.isFunctionDeclaration(p) ||
        ts.isArrowFunction(p) ||
        ts.isFunctionExpression(p) ||
        ts.isMethodDeclaration(p)
      ) {
        const name =
          ts.isFunctionDeclaration(p) && p.name
            ? p.name.text
            : ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)
              ? p.parent.name.text
              : undefined;
        return { fn: p as FnNode, name };
      }
    }
    return undefined;
  };

  const paramIndex = (fn: FnNode, id: ts.Expression): number =>
    ts.isIdentifier(id)
      ? fn.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === id.text)
      : -1;

  /** The index of a parameter of `encl` that `act`'s body calls, or -1. */
  const calledParameter = (
    act: ts.ArrowFunction | ts.FunctionExpression,
    encl: FnNode
  ): number => {
    let found = -1;
    const visit = (n: ts.Node): void => {
      if (found >= 0) return;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const i = paramIndex(encl, n.expression);
        if (i >= 0) found = i;
      }
      ts.forEachChild(n, visit);
    };
    if (act.body) visit(act.body);
    return found;
  };

  const flagOf = (
    opt: ts.Expression | undefined,
    encl?: FnNode
  ): boolean | "forwarded" => {
    if (!opt) return false;
    if (ts.isObjectLiteralExpression(opt)) {
      for (const p of opt.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          p.name.getText() === "external" &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword
        ) {
          return true;
        }
        if (ts.isSpreadAssignment(p) && encl && paramIndex(encl, p.expression) >= 0) {
          return "forwarded";
        }
      }
      return false;
    }
    if (encl && paramIndex(encl, opt) >= 0) return "forwarded";
    return false;
  };

  // Wrappers, found to a fixed point: audited first, then whatever passes its act parameter on.
  const wrappers = new Map<string, WrapperSpec>([
    ["audited", { file: "platform/auth/audit.ts", act: 1, options: 2 }],
  ]);
  const unforwarded = new Set<string>();
  const sites: AuditedCallSite[] = [];

  const calleeSpec = (
    fi: FileInfo,
    callee: ts.Expression
  ): [string, WrapperSpec] | undefined => {
    if (!ts.isIdentifier(callee)) return undefined;
    const spec = wrappers.get(callee.text);
    if (!spec) return undefined;
    const imported = fi.imports.get(callee.text);
    if (imported)
      return imported.from === spec.file || imported.name === callee.text
        ? [callee.text, spec]
        : undefined;
    return fi.path === spec.file ? [callee.text, spec] : undefined;
  };

  for (let pass = 0; pass < 5; pass++) {
    const before = wrappers.size;
    sites.length = 0;
    for (const f of files) {
      const fi = info(f.path);
      if (!fi) continue;
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const hit = calleeSpec(fi, n.expression);
          if (hit) {
            const [callee, spec] = hit;
            const actArg = n.arguments[spec.act];
            const encl = enclosing(n);
            const flagged = flagOf(n.arguments[spec.options], encl?.fn);
            let act: AuditedCallSite["act"] = "unresolved";
            let reaches: string[] = [];
            const seen = new Set<ts.Node>();
            // An inline act that calls a parameter of the function it is in: that function is a
            // wrapper of audited() — its callers' acts are what runs (platform/tenancy/admin.ts).
            const calledParam =
              actArg && isFunctionInit(actArg) && encl
                ? calledParameter(actArg, encl.fn)
                : -1;
            if (actArg && isFunctionInit(actArg) && calledParam < 0) {
              act = "inline";
              reaches = bodyReaches(fi, actArg, seen);
            } else if (actArg && encl && calledParam >= 0) {
              act = "parameter";
              if (encl.name && !wrappers.has(encl.name)) {
                const opt = n.arguments[spec.options];
                const optIdx = opt ? paramIndex(encl.fn, opt) : -1;
                wrappers.set(encl.name, {
                  file: fi.path,
                  act: calledParam,
                  options: optIdx,
                });
              }
              if (encl.name && flagged !== "forwarded")
                unforwarded.add(`${fi.path}:${encl.name}`);
            } else if (actArg && encl && paramIndex(encl.fn, actArg) >= 0) {
              act = "parameter";
              if (encl.name && !wrappers.has(encl.name)) {
                const optIdx =
                  n.arguments[spec.options] &&
                  paramIndex(encl.fn, n.arguments[spec.options]);
                wrappers.set(encl.name, {
                  file: fi.path,
                  act: paramIndex(encl.fn, actArg),
                  options: typeof optIdx === "number" ? optIdx : -1,
                });
              }
              if (encl.name && flagged !== "forwarded")
                unforwarded.add(`${fi.path}:${encl.name}`);
            } else if (
              actArg &&
              ts.isIdentifier(actArg) &&
              (fi.functions.has(actArg.text) || fi.variables.has(actArg.text))
            ) {
              act = "local";
              const r = nameReaches(fi, actArg.text, seen, false);
              reaches = r ? [r] : [];
            } else if (
              actArg &&
              (ts.isCallExpression(actArg) || ts.isIdentifier(actArg))
            ) {
              // An act built by a call (`() => f()` is inline; `makeAct()` is not): read its call.
              const r = nodeReaches(fi, actArg, seen);
              if (r.length) {
                act = "local";
                reaches = r;
              }
            }
            sites.push({
              file: fi.path,
              line: fi.sf.getLineAndCharacterOfPosition(n.getStart(fi.sf)).line + 1,
              callee,
              act,
              flagged,
              reaches,
            });
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(fi.sf);
    }
    if (wrappers.size === before) break;
  }
  return {
    sites,
    wrappers: Object.fromEntries([...wrappers].map(([k, v]) => [k, v.file])),
    unforwarded: [...unforwarded].sort(),
  };
}

/** The findings of a scan: each call site whose flag does not match what its act reaches. */
export function auditedFindings(result: ScanResult): string[] {
  const out: string[] = [];
  for (const s of result.sites) {
    const at = `${s.file}:${s.line} ${s.callee}()`;
    if (s.act === "unresolved") {
      out.push(
        `${at}: the act cannot be read — write it inline or as a function of the file`
      );
      continue;
    }
    if (s.act === "parameter") continue; // a wrapper: its own call sites are checked
    const external = s.reaches.length > 0;
    if (s.flagged === "forwarded") continue;
    if (external && s.flagged !== true) {
      out.push(
        `${at}: the act reaches outside the database (${s.reaches[0]}) — pass { external: true }`
      );
    }
    if (!external && s.flagged === true) {
      out.push(
        `${at}: marked external, but the act reaches nothing outside the database`
      );
    }
  }
  for (const w of result.unforwarded) {
    out.push(`${w}: a wrapper of audited() must forward its options (external) to it`);
  }
  return out;
}
