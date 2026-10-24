/**
 * scripts/module-manifest.cjs — Reads platform/modules/manifest.json (ADR-054 D6)
 *
 * The one reader of the module manifest, so every consumer of it draws the same boundary:
 *
 *   eslint.config.mjs           the import/no-restricted-paths zones (lintBoundaryConfigs)
 *   __tests__/module-*.test.ts  the manifest bijection and the zero-violation boundary check
 *   scripts/migration-replay.sh the order migrations are applied in (--migrations)
 *
 * Paths are repository-relative; a directory stands for every file beneath it. A module's zone
 * is its code, prompts, evals, routes and components; its tests and kits sit outside the zone but
 * belong to it (they may import it and the modules it depends on).
 *
 * CLI (used by the replay script):
 *   node scripts/module-manifest.cjs --replay-order [module,module,...]
 *     prints supabase/migrations' files in the order a fresh replay applies them — the core's,
 *     then the selected modules' (all modules when none are given) — one file name per line.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = "platform/modules/manifest.json";
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);

/** The manifest, parsed. */
function loadManifest(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8"));
}

/** Normalise a repository-relative path: forward slashes, no leading "./", no trailing "/". */
function normalise(rel) {
  return rel.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Whether `rel` is `entry` or lies beneath it. */
function within(rel, entry) {
  const r = normalise(rel);
  const e = normalise(entry);
  return r === e || r.startsWith(`${e}/`);
}

/** Every file at or beneath a listed path (a missing path yields none). */
function expandPath(entry, root = ROOT) {
  const abs = path.join(root, entry);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [normalise(entry)];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    out.push(...expandPath(path.join(entry, e.name), root));
  }
  return out.sort();
}

/** The module ids, in manifest order. */
function moduleIds(manifest = loadManifest()) {
  return Object.keys(manifest.modules);
}

/** A module's zone: the paths the core may not import. */
function zonePaths(manifest, id) {
  const m = manifest.modules[id];
  return [...m.code, ...m.prompts, ...m.evals, ...m.routes, ...m.components];
}

/** The paths outside the zone that belong to a module: its tests, kits and kit manifest. */
function ownedPaths(manifest, id) {
  const m = manifest.modules[id];
  return [...m.tests, ...m.kits, ...(m.kitManifest ? [m.kitManifest] : [])];
}

/** The module whose zone contains `rel`, or null for a core file. */
function zoneOf(manifest, rel) {
  for (const id of moduleIds(manifest)) {
    if (zonePaths(manifest, id).some((p) => within(rel, p))) return id;
  }
  return null;
}

/** The module a file belongs to — by zone, or as one of its tests or kits — or null. */
function ownerOf(manifest, rel) {
  const zone = zoneOf(manifest, rel);
  if (zone) return zone;
  for (const id of moduleIds(manifest)) {
    if (ownedPaths(manifest, id).some((p) => within(rel, p))) return id;
  }
  return null;
}

/** Whether `rel` is a composition root (the only core files that may import a module). */
function isCompositionRoot(manifest, rel) {
  return manifest.compositionRoots.some((p) => within(rel, p));
}

/** Whether module `from` may import module `to`: itself, or a declared dependency. */
function mayImport(manifest, from, to) {
  return from === to || manifest.modules[from].dependsOn.includes(to);
}

/** Selected modules (all when none given) ordered so each follows its dependencies. */
function dependencyOrder(manifest, selected = moduleIds(manifest)) {
  const unknown = selected.filter((id) => !manifest.modules[id]);
  if (unknown.length > 0) throw new Error(`unknown module(s): ${unknown.join(", ")}`);
  const ordered = [];
  const visit = (id, trail) => {
    if (ordered.includes(id)) return;
    if (trail.includes(id))
      throw new Error(`dependency cycle: ${[...trail, id].join(" → ")}`);
    for (const dep of manifest.modules[id].dependsOn) {
      if (!selected.includes(dep)) {
        throw new Error(`module "${id}" depends on "${dep}", which is not selected`);
      }
      visit(dep, [...trail, id]);
    }
    ordered.push(id);
  };
  for (const id of selected) visit(id, []);
  return ordered;
}

/** Migration file names listed by `ids`, in that order (each module's in file-name order). */
function moduleMigrations(manifest, ids) {
  return ids.flatMap((id) =>
    [...manifest.modules[id].migrations].map((p) => path.basename(p)).sort()
  );
}

/**
 * The order a fresh replay applies migrations in (ADR-054 D5): the core's — every file no module
 * lists — in file-name order, then each selected module's, modules in dependency order and each
 * module's files in file-name order. A module that is not selected contributes nothing. `files`
 * is the migration directory's listing (file names).
 */
function replayOrder(manifest, files, selected = moduleIds(manifest)) {
  const listed = new Set(moduleMigrations(manifest, moduleIds(manifest)));
  const present = new Set(files);
  const core = [...files].filter((f) => !listed.has(f)).sort();
  const modules = moduleMigrations(manifest, dependencyOrder(manifest, selected));
  const missing = modules.filter((f) => !present.has(f));
  if (missing.length > 0) {
    throw new Error(`module migrations listed but not present: ${missing.join(", ")}`);
  }
  return [...core, ...modules];
}

const LINT_EXTENSIONS = ["js", "jsx", "mjs", "cjs", "ts", "tsx"];
const LINT_FILES = [`**/*.{${LINT_EXTENSIONS.join(",")}}`];

/**
 * The ESLint `files` globs for a listed path: a lintable file itself, a directory's lintable
 * files. (A config object's `files` also selects what is linted, so a listed README must not
 * appear in it.)
 */
function filesGlobs(entry, root = ROOT) {
  const abs = path.join(root, entry);
  const isFile = fs.existsSync(abs) && fs.statSync(abs).isFile();
  if (!isFile) return [`${normalise(entry)}/${LINT_FILES[0]}`];
  const ext = path.extname(entry).slice(1);
  return LINT_EXTENSIONS.includes(ext) ? [normalise(entry)] : [];
}

/** The rule entry for files that may not import the given modules. */
function restrictedPathsRule(manifest, forbidden, why, root) {
  if (forbidden.length === 0) return "off";
  return [
    "error",
    {
      basePath: root,
      // A module's tests and kits are as much the module's as its code: importing either from
      // outside the module (or a dependant) is the same breach.
      zones: forbidden.map((id) => ({
        target: ".",
        from: [...zonePaths(manifest, id), ...ownedPaths(manifest, id)],
        message: `${why} Module "${id}" is outside it (ADR-054 D3; platform/modules/manifest.json).`,
      })),
    },
  ];
}

/**
 * The ESLint config objects that draw the boundary. They partition the files — later objects
 * win for the files they match — so each file gets exactly the zones that apply to it:
 *   1. every file: the core may import no module;
 *   2. each module's zone, tests and kits: that module may import itself and its declared
 *      dependencies, no other module;
 *   3. the composition roots: they import the app's modules, which is their purpose.
 */
function lintBoundaryConfigs(manifest = loadManifest(), root = ROOT) {
  const ids = moduleIds(manifest);
  const configs = [
    {
      files: LINT_FILES,
      rules: {
        "import/no-restricted-paths": restrictedPathsRule(
          manifest,
          ids,
          "The core never imports a product module.",
          root
        ),
      },
    },
  ];
  for (const id of ids) {
    const files = [...zonePaths(manifest, id), ...ownedPaths(manifest, id)].flatMap((p) =>
      filesGlobs(p, root)
    );
    if (files.length === 0) continue;
    configs.push({
      files,
      rules: {
        "import/no-restricted-paths": restrictedPathsRule(
          manifest,
          ids.filter((other) => !mayImport(manifest, id, other)),
          `Module "${id}" may import the core, itself and its declared dependencies (${manifest.modules[id].dependsOn.join(", ") || "none"}).`,
          root
        ),
      },
    });
  }
  configs.push({
    files: manifest.compositionRoots.map(normalise),
    rules: { "import/no-restricted-paths": "off" },
  });
  return configs;
}

module.exports = {
  ROOT,
  MANIFEST,
  loadManifest,
  normalise,
  within,
  expandPath,
  moduleIds,
  zonePaths,
  ownedPaths,
  zoneOf,
  ownerOf,
  isCompositionRoot,
  mayImport,
  dependencyOrder,
  moduleMigrations,
  replayOrder,
  lintBoundaryConfigs,
};

if (require.main === module) {
  const [flag, list] = process.argv.slice(2);
  if (flag !== "--replay-order") {
    console.error(
      "usage: node scripts/module-manifest.cjs --replay-order [module,module,...]"
    );
    process.exit(2);
  }
  const manifest = loadManifest();
  const selected = list ? list.split(",").filter(Boolean) : moduleIds(manifest);
  const dir = path.join(ROOT, "supabase/migrations");
  const files = fs.readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f));
  try {
    process.stdout.write(replayOrder(manifest, files, selected).join("\n") + "\n");
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exit(1);
  }
}
