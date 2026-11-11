#!/usr/bin/env node
/**
 * scripts/catalog-definitions-check.mjs — every setting and permission the database holds is
 * named by the catalog, in every locale it defines (TASK-209, N-113; ADR-051 D4)
 *
 * The migrations write a setting's description and a permission's name and description in
 * English (platform_config.description; permissions.display_name, description): the definitional
 * record. A screen, and an answer a screen shows, words them from the catalog by key and code
 * (platform/errors/definitions.ts): `screens.settings.<key>` and
 * `screens.permissions.<code>.name|description` (messages/<locale>.json), or an app's own under
 * `screens.app.…` (messages/app/<locale>.json, merged as platform/errors/messages.ts merges it).
 *
 *   node scripts/catalog-definitions-check.mjs [--root <dir>] < lines
 *
 * reads the database's keys and codes on stdin, one per line — `setting <key>` or
 * `permission <code>` — and prints every gap ("<locale>: setting <key>", "<locale>: permission
 * <code>.<part>", "<locale>: no such setting <key>", "<locale>: no such permission <code>",
 * "<locale>: permission <code> has <part>"); exit 1 when there is one. scripts/migration-replay.sh
 * runs it on the replayed database, before any test writes to it: the database then holds what
 * the migrations — the platform's, every module's and the app's — define, and nothing a test
 * made (TASK-209: a guard reading the shared test database saw another suite's setting).
 * __tests__/catalog-definitions-guard.test.ts plants each kind of gap.
 *
 * Node's built-ins only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A node of `catalog` by dotted path, or undefined. */
function node(catalog, path) {
  let n = catalog;
  for (const part of path.split(".")) {
    if (n === null || typeof n !== "object") return undefined;
    n = n[part];
  }
  return n;
}

/** Every leaf's dotted path under `n` (a message's key, less the prefix). */
function leaves(n, prefix = "") {
  if (typeof n === "string") return [prefix];
  if (!n || typeof n !== "object") return [];
  return Object.entries(n).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

const text = (catalog, key) => {
  const v = node(catalog, key);
  return typeof v === "string" && v.trim() !== "";
};

/** What the catalogs lack or have too much of, given the database's keys and codes. */
export function definitionGaps(catalogs, settings, permissions) {
  const out = [];
  const keys = new Set(settings);
  const codes = new Set(permissions);
  for (const [locale, catalog] of Object.entries(catalogs)) {
    for (const key of settings)
      if (
        !text(catalog, `screens.settings.${key}`) &&
        !text(catalog, `screens.app.settings.${key}`)
      )
        out.push(`${locale}: setting ${key}`);
    for (const code of permissions)
      for (const part of ["name", "description"])
        if (
          !text(catalog, `screens.permissions.${code}.${part}`) &&
          !text(catalog, `screens.app.permissions.${code}.${part}`)
        )
          out.push(`${locale}: permission ${code}.${part}`);
    for (const root of ["screens.settings", "screens.app.settings"])
      for (const key of leaves(node(catalog, root)))
        if (!keys.has(key)) out.push(`${locale}: no such setting ${key}`);
    for (const root of ["screens.permissions", "screens.app.permissions"]) {
      const entries = node(catalog, root);
      if (!entries || typeof entries !== "object") continue;
      for (const [code, parts] of Object.entries(entries)) {
        if (!codes.has(code)) out.push(`${locale}: no such permission ${code}`);
        for (const part of leaves(parts))
          if (part !== "name" && part !== "description")
            out.push(`${locale}: permission ${code} has ${part}`);
      }
    }
  }
  return out.sort();
}

/** The app catalog merged into the platform's (platform/errors/messages.ts mergeCatalogs). */
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b))
    out[k] =
      out[k] && typeof out[k] === "object" && v && typeof v === "object"
        ? merge(out[k], v)
        : v;
  return out;
}

/** Every locale the catalog defines (messages/<locale>.json), each with the app's merged in. */
export function loadCatalogs(root) {
  const dir = join(root, "messages");
  const catalogs = {};
  for (const f of readdirSync(dir).filter((n) =>
    /^[a-z]{2}(?:-[A-Z]{2})?\.json$/.test(n)
  )) {
    const locale = f.replace(/\.json$/, "");
    const platform = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const appFile = join(dir, "app", f);
    catalogs[locale] = existsSync(appFile)
      ? merge(platform, JSON.parse(readFileSync(appFile, "utf8")))
      : platform;
  }
  return catalogs;
}

/** The database's keys and codes from `setting <key>` / `permission <code>` lines. */
export function parseLines(input) {
  const settings = [];
  const permissions = [];
  for (const line of input.split("\n")) {
    const m = /^(setting|permission) (\S+)$/.exec(line.trim());
    if (!m) continue;
    (m[1] === "setting" ? settings : permissions).push(m[2]);
  }
  return { settings, permissions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? process.argv[i + 1] : process.cwd();
  const { settings, permissions } = parseLines(readFileSync(0, "utf8"));
  const catalogs = loadCatalogs(root);
  if (settings.length === 0 || permissions.length === 0 || !catalogs.en) {
    console.error(
      "✗ catalog definitions: no settings, no permissions or no English catalog read"
    );
    process.exit(1);
  }
  const gaps = definitionGaps(catalogs, settings, permissions);
  if (gaps.length > 0) {
    console.error(
      "✗ a setting or permission the catalog does not name (or an entry naming none):"
    );
    for (const g of gaps) console.error(`  ${g}`);
    process.exit(1);
  }
  console.log(
    `✓ catalog definitions: ${settings.length} settings and ${permissions.length} permissions named in ${Object.keys(catalogs).join(", ")}`
  );
}
