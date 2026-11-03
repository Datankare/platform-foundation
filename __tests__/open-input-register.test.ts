/**
 * __tests__/open-input-register.test.ts — every open input-schema node is in the register, with
 * its reason (TASK-200, review round 2)
 *
 * @guard an input schema node opened (openBecause) without being listed in open-input-register.json
 *
 * An open node takes keys of the caller's own shape unchecked (platform/admin/input-keys.ts). A
 * route body's node is open only when it says why (`openBecause: "<four words or more>"`; the body
 * itself never is), and four words open anything — so each one is listed here, where review sees
 * it: open-input-register.json (repository root, per repository) maps `<file>#<path>` to the
 * reason the code gives. This finds every `openBecause:` in the production sources and refuses one
 * the register lacks, one it lists that is gone, and a reason that differs. The register never
 * grows against the base branch (scripts/process-check.mjs, CI Layer 0f): a new open node is a
 * finding, fixed by closing the node or by the owner's deliberate change to the register — never a
 * quiet addition.
 */
import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";
import { productionSources, read } from "./helpers/route-policy";

const ROOT = join(__dirname, "..");
const REGISTER = join(ROOT, "open-input-register.json");

interface Register {
  $comment?: string;
  count: number;
  entries: Record<string, string>;
}

/** Schema keys: an object with one of them (or a JSON Schema `type`) is part of an input schema. */
const SCHEMA_KEYS = new Set(["properties", "items", "openBecause"]);
/** A JSON Schema `type`: an object with one of these as its `type` is a schema node. */
const SCHEMA_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

/** A property's key as written: an identifier, a string or number, `["literal"]`; null if not. */
function keyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  if (ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression))
    return name.expression.text;
  return null;
}

/**
 * Each open node in a source, as `<file>#<path>` → its reason. The path is the object keys from the
 * schema's root down to the node (`properties` dropped, `items` as `[]`): a node at
 * `{ properties: { value: { openBecause } } }` is `value`. Found however it is written — `openBecause:
 * "…"`, `"openBecause": "…"`, `["openBecause"]: "…"`, the shorthand `{ openBecause }`. Fail closed
 * on what the scan cannot read in an object that is part of a schema (one with a schema key, or a
 * value under `properties`): a reason that is not a plain string (`<not a literal>`), a computed key
 * (`<unresolved key>`, path `…#<key>`) and a spread (`<spread>`, path `…#...`), which could carry an
 * `openBecause`. Those cannot be registered (registerDrift).
 */
export function openNodes(file: string, text: string): Map<string, string> {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const pathOf = (from: ts.Node): string => {
    const path: string[] = [];
    for (let at: ts.Node = from; at && !ts.isSourceFile(at); at = at.parent) {
      if (!ts.isPropertyAssignment(at)) continue;
      const key = keyName(at.name) ?? "<?>";
      if (key === "properties") continue;
      path.unshift(key === "items" ? "[]" : key);
    }
    return path.join(".").replace(/\.\[\]/g, "[]");
  };
  const schemaLike = (o: ts.ObjectLiteralExpression): boolean => {
    if (
      o.properties.some((p) => {
        const k = p.name ? keyName(p.name) : null;
        if (k === "type")
          return (
            ts.isPropertyAssignment(p) &&
            ts.isStringLiteralLike(p.initializer) &&
            SCHEMA_TYPES.has(p.initializer.text)
          );
        return k !== null && SCHEMA_KEYS.has(k);
      })
    )
      return true;
    // A value under `properties`: { properties: { x: <o> } }.
    const holder = o.parent;
    if (!ts.isPropertyAssignment(holder) || !ts.isObjectLiteralExpression(holder.parent))
      return false;
    const owner = holder.parent.parent;
    return ts.isPropertyAssignment(owner) && keyName(owner.name) === "properties";
  };
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      const schema = schemaLike(n);
      const at = pathOf(n);
      const key = (k: string) => `${file}#${at === "" ? k : `${at}.${k}`}`;
      for (const p of n.properties) {
        const k = p.name ? keyName(p.name) : null;
        if (k === "openBecause") {
          const reason =
            ts.isPropertyAssignment(p) && ts.isStringLiteralLike(p.initializer)
              ? p.initializer.text
              : "<not a literal>";
          out.set(`${file}#${at}`, reason);
        } else if (schema && ts.isSpreadAssignment(p)) {
          out.set(key("..."), "<spread>");
        } else if (schema && p.name && k === null) {
          out.set(key("<key>"), "<unresolved key>");
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Where the found open nodes and the register disagree. */
export function registerDrift(found: Map<string, string>, register: Register): string[] {
  const out: string[] = [];
  for (const [key, reason] of found) {
    if (reason.startsWith("<"))
      out.push(
        `${key}: ${reason} — the scan cannot read it, so it cannot be registered; write it plainly`
      );
    else if (!(key in register.entries))
      out.push(`${key}: open (${reason}) but not in open-input-register.json`);
    else if (register.entries[key] !== reason)
      out.push(`${key}: the register's reason is not the code's`);
  }
  for (const key of Object.keys(register.entries))
    if (!found.has(key)) out.push(`${key}: in the register but no longer open`);
  const count = Object.keys(register.entries).length;
  if (register.count !== count)
    out.push(`count ${register.count}, the register lists ${count}`);
  return out;
}

describe("open input nodes are registered (TASK-200)", () => {
  it("every openBecause in the sources is in the register, with its reason", () => {
    const found = new Map<string, string>();
    for (const f of productionSources())
      for (const [k, v] of openNodes(f, read(f))) found.set(k, v);
    const register = JSON.parse(readFileSync(REGISTER, "utf8")) as Register;
    expect(registerDrift(found, register)).toEqual([]);
  });

  it("[self-test] reports an open node the register lacks, a stale entry and a changed reason", () => {
    const planted = [
      "const BODY = {",
      '  type: "object",',
      "  properties: {",
      '    value: { openBecause: "a config entry\'s own shape here" },',
      '    rules: { type: "array", items: { openBecause: "each rule is the caller\'s own" } },',
      "  },",
      "};",
    ].join("\n");
    const found = openNodes("app/api/planted/route.ts", planted);
    expect([...found.keys()]).toEqual([
      "app/api/planted/route.ts#value",
      "app/api/planted/route.ts#rules[]",
    ]);
    expect(
      registerDrift(found, {
        count: 2,
        entries: {
          "app/api/planted/route.ts#rules[]": "a different reason entirely given",
          "app/api/gone/route.ts#x": "it was open once upon a time",
        },
      })
    ).toEqual([
      "app/api/planted/route.ts#value: open (a config entry's own shape here) but not in open-input-register.json",
      "app/api/planted/route.ts#rules[]: the register's reason is not the code's",
      "app/api/gone/route.ts#x: in the register but no longer open",
    ]);
    // Planted: a count that is not the number of entries.
    expect(
      registerDrift(new Map([["a#b", "the caller's own shape here"]]), {
        count: 2,
        entries: { "a#b": "the caller's own shape here" },
      })
    ).toEqual(["count 2, the register lists 1"]);
  });

  it("[self-test] finds an open node however its key is written, and refuses what it cannot read", () => {
    const planted = [
      "const reason = 'the caller decides this one';",
      "const KEY = 'openBecause';",
      "const BODY = {",
      '  type: "object",',
      "  properties: {",
      '    a: { "openBecause": "a string-literal key here" },',
      '    b: { ["openBecause"]: "a computed literal key" },',
      "    c: { openBecause },",
      "    d: { openBecause: reason },",
      "    e: { [KEY]: 'a computed key the scan cannot resolve' },",
      "    f: { ...OPEN },",
      "  },",
      "};",
      "const notASchema = { ...rest, [dynamic]: 1 };",
    ].join("\n");
    const found = openNodes("app/api/planted/route.ts", planted);
    expect(Object.fromEntries(found)).toEqual({
      "app/api/planted/route.ts#a": "a string-literal key here",
      "app/api/planted/route.ts#b": "a computed literal key",
      "app/api/planted/route.ts#c": "<not a literal>",
      "app/api/planted/route.ts#d": "<not a literal>",
      "app/api/planted/route.ts#e.<key>": "<unresolved key>",
      "app/api/planted/route.ts#f....": "<spread>",
    });
    const drift = registerDrift(found, {
      count: 2,
      entries: {
        "app/api/planted/route.ts#a": "a string-literal key here",
        "app/api/planted/route.ts#b": "a computed literal key",
      },
    });
    expect(drift).toHaveLength(4);
    expect(drift.every((d) => /cannot be registered/.test(d))).toBe(true);
  });
});
