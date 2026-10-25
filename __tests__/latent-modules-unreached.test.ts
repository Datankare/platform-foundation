/**
 * __tests__/latent-modules-unreached.test.ts — no route reaches the latent modules (audit X-25)
 *
 * The October 2026 audit found issues in modules no route reaches yet — social, realtime and
 * retrieval — and left them to Wave 3, to be fixed before any route reaches them. This holds
 * that line: it follows every runtime import (not `import type`) from every API route, and fails
 * when one reaches platform/social or platform/realtime, or reaches platform/rag other than
 * through the provider registry's boot wiring (the embedding provider and the empty reference
 * knowledge base). Nothing outside platform/rag may call retrieval or ingestion.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative } from "path";

const ROOT = process.cwd();

function resolveSpec(from: string, spec: string): string | null {
  let p: string;
  if (spec.startsWith("@/")) p = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) p = join(dirname(from), spec);
  else return null;
  for (const c of [p, `${p}.ts`, `${p}.tsx`, join(p, "index.ts"), join(p, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Runtime imports of a file: static (not type-only), side-effect, require and import(). */
function runtimeImports(file: string): string[] {
  const out: string[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trimStart();
    if (!head.startsWith("import ") && !head.startsWith("export ")) continue;
    // The statement runs to the line naming its module (or ends without one).
    let statement = head;
    for (let j = i; j < lines.length && !/["'];?\s*$/.test(lines[j]) && j < i + 40; j++) {
      statement += " " + (lines[j + 1] ?? "");
    }
    if (/^(?:import|export) type\b/.test(statement)) continue;
    const spec =
      /from ["']([^"']+)["']/.exec(statement) ?? /^import ["']([^"']+)["']/.exec(head);
    if (spec) out.push(spec[1]);
  }
  const src = lines.join("\n");
  for (const m of src.matchAll(/require\(["']([^"']+)["']\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/import\(["']([^"']+)["']\)/g)) out.push(m[1]);
  return out;
}

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...routes(p));
    else if (name === "route.ts") out.push(p);
  }
  return out;
}

/** Every latent-module file a route reaches, with the file that imported it. */
function reached(): { target: string; via: string; route: string }[] {
  const hits: { target: string; via: string; route: string }[] = [];
  for (const route of routes(join(ROOT, "app/api"))) {
    const seen = new Set([route]);
    const queue = [route];
    while (queue.length) {
      const file = queue.shift()!;
      for (const spec of runtimeImports(file)) {
        const target = resolveSpec(file, spec);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        const rel = relative(ROOT, target);
        if (/^platform\/(?:social|realtime|rag)\//.test(rel)) {
          hits.push({
            target: rel,
            via: relative(ROOT, file),
            route: relative(ROOT, route),
          });
          continue;
        }
        queue.push(target);
      }
    }
  }
  return hits;
}

describe("latent modules (X-25) are not reached by any route", () => {
  const hits = reached();

  it("self-test: the walker follows imports from the routes", () => {
    // The registry's boot wiring reaches platform/rag — the walker must see that much.
    expect(hits.some((h) => h.target.startsWith("platform/rag/"))).toBe(true);
  });

  it("no route reaches platform/social or platform/realtime", () => {
    expect(
      hits
        .filter((h) => /^platform\/(?:social|realtime)\//.test(h.target))
        .map((h) => `${h.route}: ${h.target} (imported by ${h.via})`)
    ).toEqual([]);
  });

  it("platform/rag is reached only through the provider registry's boot wiring", () => {
    expect(
      hits
        .filter(
          (h) =>
            h.target.startsWith("platform/rag/") &&
            h.via !== "platform/providers/registry.ts"
        )
        .map((h) => `${h.route}: ${h.target} (imported by ${h.via})`)
    ).toEqual([]);
  });

  it("nothing outside platform/rag retrieves or ingests", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (name === "node_modules" || name === "__tests__" || name.startsWith("."))
          continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name)) {
          const rel = relative(ROOT, p);
          if (rel.startsWith("platform/rag/")) continue;
          if (
            /\b(?:retrieve|ingestDocument|buildContextBlock)\s*\(/.test(
              readFileSync(p, "utf8")
            )
          ) {
            offenders.push(rel);
          }
        }
      }
    };
    for (const d of ["app", "platform", "lib", "components"]) walk(join(ROOT, d));
    expect(offenders).toEqual([]);
  });
});
