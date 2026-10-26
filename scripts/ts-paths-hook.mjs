/**
 * scripts/ts-paths-hook.mjs — lets an operator script run the platform's own TypeScript in Node
 * (TASK-174), with no build step and no dependency
 *
 * Node runs TypeScript with --experimental-transform-types (Node ≥ 22.7); this resolve hook adds
 * what the code base's imports need beyond it: the `@/` alias (the repository root, as in
 * tsconfig.json) and extensionless relative imports (`./x` → `./x.ts`, or `./x/index.ts`).
 * Everything else resolves as Node resolves it. Registered by scripts/relink-identity.mjs.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let root = "";

/** Told the repository root by the script that registers the hook. */
export function initialize(data) {
  root = data.root;
}

function file(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  let base = null;
  if (specifier.startsWith("@/")) base = join(root, specifier.slice(2));
  else if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  )
    base = join(dirname(fileURLToPath(context.parentURL)), specifier);
  if (base) {
    const found = file(base);
    if (found) {
      return {
        url: pathToFileURL(found).href,
        shortCircuit: true,
        ...(found.endsWith(".ts") ? { format: "module-typescript" } : {}),
      };
    }
  }
  return nextResolve(specifier, context);
}
