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
 * The manifest every reader sees is the platform's merged with the app's (TASK-157):
 *
 *   platform/modules/manifest.json      the platform's — synced to consumers unchanged
 *   platform/modules/app-manifest.json  the app's (CONSUMER SEAM: sync-excluded; the platform
 *                                       ships it empty) — paths the app adds to a platform module,
 *                                       the app's own modules, its migration prefix ("app") and
 *                                       the bare-numbered migrations it applied before the naming
 *                                       convention (migrationsBeforeTheConvention)
 *
 * The merge refuses, naming the file and what to change: a path claimed by two modules (or by a
 * module and a composition root), an app redefining a platform module's dependencies, definition,
 * entry or kit manifest, an unknown list, an unknown dependency, and a dependency cycle.
 *
 * It also refuses an app entry that takes something of the platform's (review 7 H2): a migration
 * listed in supabase/platform-migrations.json (claimed into a module it would leave the core's
 * replay order, and REPLAY_MODULES could leave it out), and a path the platform owns — anything
 * under platform/, any file listed in platform/modules/platform-paths.json, or a directory holding
 * one (claimed into a module's zone or tests it would move core code across the import boundary).
 * An app's entries name its own files only. platform/modules/platform-paths.json is every file
 * platform-foundation ships outside platform/ except the consumer seams; it is generated
 * (--write-platform-paths) and --check in platform-foundation proves it matches the tree.
 *
 * Migration names (TASK-158): the platform's are NNN_<name>.sql and listed in
 * supabase/platform-migrations.json; an app's are NNN<letter>_<app>_<name>.sql (052a_playform_…),
 * which sort after the platform's NNN and before NNN+1. migrationNameProblems() refuses an app
 * migration with a bare number, a letter-form file in the platform, and a letter-form file
 * without the app's prefix.
 *
 * CLI (used by the replay script):
 *   node scripts/module-manifest.cjs --replay-order [module,module,...]
 *     checks the migration names, then prints supabase/migrations' files in the order a fresh
 *     replay applies them — the core's, then the selected modules' (all modules when none are
 *     given) — one file name per line.
 *   node scripts/module-manifest.cjs --check
 *     merges the manifests and checks the migration names (and, in platform-foundation, that
 *     platform-paths.json lists the tree); prints what to change, exits 1.
 *   node scripts/module-manifest.cjs --write-platform-paths
 *     platform-foundation only: regenerates platform/modules/platform-paths.json from git.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST = "platform/modules/manifest.json";
const APP_MANIFEST = "platform/modules/app-manifest.json";
const PLATFORM_MIGRATIONS = "supabase/platform-migrations.json";
const PLATFORM_PATHS = "platform/modules/platform-paths.json";
/** Everything under it is the platform's (docs/SETUP_AND_INTEGRATION.md §6). */
const PLATFORM_TREE = "platform";
/**
 * The consumer seams outside platform/ (docs/SETUP_AND_INTEGRATION.md §6): shipped as templates,
 * owned by the consumer, so not listed in platform-paths.json.
 */
const CONSUMER_SEAMS = [
  "messages/app",
  "docs/APP_API_ERRORS.md",
  "docs/APP_ENV_REFERENCE.md",
  ".gitleaksignore",
  "coverage-baseline.json",
  "screen-literal-baseline.json",
  "instrumentation.ts",
];
const MIGRATIONS_DIR = "supabase/migrations";
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "coverage"]);

/** A module's path lists, and its single paths. */
const LIST_KEYS = [
  "code",
  "prompts",
  "evals",
  "routes",
  "components",
  "tests",
  "kits",
  "migrations",
];
/** What only the module's owner declares: an app may not change these on a platform module. */
const OWNER_KEYS = ["dependsOn", "definition", "entry", "kitManifest"];
const MODULE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const APP_ID = /^[a-z][a-z0-9]*$/;
const APP_KEYS = [
  "$comment",
  "app",
  "modules",
  "migrationsBeforeTheConvention",
  "noUserData",
];
/** A table name as the app declares one: lower-case, digits and "_". */
const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

/** A migration file name: NNN_<name>.sql (the platform's) or NNN<letter>_<name>.sql (an app's). */
const MIGRATION_FILE = /^\d+[a-z]?_.*\.sql$/;
const PLATFORM_FORM = /^\d{3}_[a-z0-9_-]+\.sql$/;
const APP_FORM = /^(\d{3})([a-z])_([a-z0-9_-]+)\.sql$/;

/** The platform's manifest, parsed. */
function loadPlatformManifest(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, MANIFEST), "utf8"));
}

/** The app's manifest (the consumer seam), parsed; an absent file is an app that adds nothing. */
function loadAppManifest(root = ROOT) {
  const file = path.join(root, APP_MANIFEST);
  if (!fs.existsSync(file))
    return { app: null, modules: {}, migrationsBeforeTheConvention: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${APP_MANIFEST}: not valid JSON (${err.message})`);
  }
}

const isStringList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/** platform/modules/platform-paths.json's files (an absent file lists none). */
function loadPlatformPaths(root = ROOT) {
  const file = path.join(root, PLATFORM_PATHS);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf8")).paths;
}

/**
 * What the platform owns, as the merge checks an app's entries against it: its migration file
 * names and the files it ships outside platform/ (everything under platform/ is its own).
 */
function loadPlatformOwnership(root = ROOT) {
  return { migrations: loadPlatformMigrations(root), paths: loadPlatformPaths(root) };
}

/**
 * The files platform-foundation ships outside platform/, as platform-paths.json lists them: the
 * files git tracks or would (untracked, not ignored), less the consumer seams. Null when the tree is not a git checkout.
 */
function trackedPlatformPaths(root = ROOT) {
  const { spawnSync } = require("child_process");
  const run = spawnSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" }
  );
  if (run.status !== 0 || typeof run.stdout !== "string") return null;
  return run.stdout
    .split("\0")
    .filter(Boolean)
    .filter((f) => fs.existsSync(path.join(root, f)))
    .filter((f) => !within(f, PLATFORM_TREE))
    .filter((f) => !CONSUMER_SEAMS.some((seam) => within(f, seam)))
    .sort();
}

/**
 * Characters a glob gives a meaning to (review 8 H-D): an entry is turned into ESLint `files`
 * patterns and matched as one, so `app/api/**`, `acc*` or `__tests__/db/*.ts` would put files the
 * app never named — the platform's own — in a module's lint zone. `*`, `?`, `[`, `]`, `{`, `}`,
 * `!` anywhere; an extglob's opening `@(` or `+(`; a `#` starting a segment (a comment to some
 * matchers); `\\` (an escape). A Next.js route group's parentheses alone are plain.
 */
const GLOB_METACHARACTERS = /[*?[\]{}!\\]|[@+]\(|(?:^|\/)#/;
/** Whether `p` holds a control character, which no repository path holds. */
const hasControl = (p) =>
  [...p].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);

/**
 * One segment of an app's path (review 9 L10): letters, digits, ".", "_" and "-" only — or a
 * Next.js route group, "(name)" of the same characters — and never ending in "." (so never "."
 * or ".."). Every lookalike of a platform path is outside it: "platform./auth" (a trailing dot,
 * which Windows drops), "platform /auth" (a space), a zero-width or other format character
 * (\p{Cf}), a fullwidth or other non-ASCII slash, "%2F" (an encoded slash).
 */
const PLAIN_SEGMENT = /^(?:[\w.-]+|\([\w.-]+\))$/;

/**
 * An entry an app may write: a relative path of plain segments (PLAIN_SEGMENT) joined by "/",
 * no "." or ".." or empty segment, no glob metacharacter and no control character — a path,
 * matched as written.
 */
function isPlainRelativePath(p) {
  if (p.length === 0 || p.startsWith("/")) return false;
  if (GLOB_METACHARACTERS.test(p) || hasControl(p)) return false;
  return p
    .replace(/\/+$/, "")
    .split("/")
    .every(
      (seg) =>
        seg !== "" && PLAIN_SEGMENT.test(seg) && !seg.endsWith(".") && !seg.endsWith(".)")
    );
}

/**
 * A path as the ownership checks compare it (review 8 H-D): Unicode NFC, lower case. The
 * platform's files are refused whatever the case or the normalisation an app writes them in —
 * `Platform/auth` or `app/api/Account` is the platform's on a case-insensitive file system
 * (macOS, Windows), and a decomposed é is the composed one.
 */
function fold(p) {
  return normalise(p).normalize("NFC").toLowerCase();
}

/** within(), on folded paths. */
function withinFolded(rel, entry) {
  return within(fold(rel), fold(entry));
}

/**
 * The app's entries that take what is the platform's (review 7 H2), as messages saying what to
 * change: a platform migration in a module's migrations, a path under platform/, a platform file
 * or a directory holding one. Before: the merge took them — 049_tenancy.sql listed by an app
 * module left the core's replay order (REPLAY_MODULES could drop it), and platform/auth/user-data.ts
 * or app/api/account listed as a module's code or tests left the core's import boundary.
 */
function appOwnershipProblems(app, owned) {
  const problems = [];
  const platformMigrations = new Set(owned.migrations.map(fold));
  const platformFiles = owned.paths.map(normalise);
  for (const [id, entry] of Object.entries(app.modules ?? {})) {
    for (const key of [...LIST_KEYS, "definition", "entry", "kitManifest"]) {
      const listed = LIST_KEYS.includes(key) ? (entry[key] ?? []) : [entry[key]];
      for (const raw of listed) {
        if (typeof raw !== "string") continue;
        const at = `${APP_MANIFEST} modules.${id}.${key} "${raw}"`;
        if (!isPlainRelativePath(raw)) {
          problems.push(
            `${at}: a repository-relative path without ".", ".." or empty segments, glob characters (* ? [ ] { } ! @( +( #) or control characters — plain segments only: letters, digits, ".", "_", "-" (or a route group "(name)"), none ending in ".", no spaces, "%" or other Unicode (review 9 L10) — write each file or directory plainly`
          );
          continue;
        }
        const p = normalise(raw);
        if (key === "migrations") {
          const file = path.posix.basename(p);
          if (path.posix.dirname(p) !== MIGRATIONS_DIR || !file.endsWith(".sql")) {
            // supabase/Migrations/049_tenancy.sql is also refused (as not the directory).
            problems.push(
              `${at}: a module's migration is one file, ${MIGRATIONS_DIR}/<name>.sql — list each of yours`
            );
            continue;
          }
          if (platformMigrations.has(fold(file))) {
            problems.push(
              `${at}: ${file} is a platform migration (${PLATFORM_MIGRATIONS}) — it replays with the core, in its place; an app lists only its own migrations. Remove it`
            );
          }
          continue;
        }
        if (withinFolded(p, PLATFORM_TREE) || withinFolded(PLATFORM_TREE, p)) {
          problems.push(
            `${at}: everything under platform/ is the platform's — an app adds its own files only. Remove it (move your file outside platform/)`
          );
          continue;
        }
        const taken = platformFiles.find((f) => withinFolded(f, p));
        if (taken) {
          problems.push(
            `${at}: ${fold(taken) === fold(p) ? "a platform file" : `holds the platform's ${taken}`} (${PLATFORM_PATHS}) — an app adds its own files only; list yours one by one. Remove it`
          );
        }
      }
    }
  }
  return problems;
}

/** What is wrong with the app's manifest on its own (shape), as messages naming what to change. */
function appManifestShapeProblems(platform, app) {
  const problems = [];
  const where = APP_MANIFEST;
  if (app === null || typeof app !== "object" || Array.isArray(app)) {
    return [
      `${where}: must be a JSON object { "app", "modules", "migrationsBeforeTheConvention" }`,
    ];
  }
  for (const key of Object.keys(app)) {
    if (!APP_KEYS.includes(key))
      problems.push(`${where}: unknown key "${key}" — allowed: ${APP_KEYS.join(", ")}`);
  }
  if (
    app.app !== undefined &&
    app.app !== null &&
    !(typeof app.app === "string" && APP_ID.test(app.app))
  ) {
    problems.push(
      `${where}: "app" must be your app's migration prefix — lower-case letters and digits, e.g. "playform" — or null in platform-foundation`
    );
  }
  if (
    app.migrationsBeforeTheConvention !== undefined &&
    !isStringList(app.migrationsBeforeTheConvention)
  ) {
    problems.push(
      `${where}: "migrationsBeforeTheConvention" must be a list of file names`
    );
  }
  // The app's tables that hold no user's data, each with its reason (the user-data coverage
  // test classifies an app's tables by the app's declarations: these, and the tables its
  // deletion modules name in deletion_manifest).
  if (app.noUserData !== undefined) {
    const n = app.noUserData;
    if (n === null || typeof n !== "object" || Array.isArray(n)) {
      problems.push(
        `${where}: "noUserData" must be an object { "<table>": "<why it holds no user's data>" }`
      );
    } else {
      for (const [table, reason] of Object.entries(n)) {
        if (!TABLE_NAME.test(table))
          problems.push(
            `${where} noUserData."${table}": not a table name (lower-case letters, digits, "_")`
          );
        if (typeof reason !== "string" || reason.trim().length < 10)
          problems.push(
            `${where} noUserData.${table}: say why it holds no user's data (a sentence)`
          );
      }
    }
  }
  const modules = app.modules ?? {};
  if (typeof modules !== "object" || Array.isArray(modules)) {
    return [...problems, `${where}: "modules" must be an object keyed by module id`];
  }
  for (const [id, entry] of Object.entries(modules)) {
    const at = `${where} modules.${id}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      problems.push(`${at}: must be an object`);
      continue;
    }
    const isPlatform = Object.prototype.hasOwnProperty.call(platform.modules, id);
    for (const [key, value] of Object.entries(entry)) {
      if (key === "$comment") continue;
      if (isPlatform && OWNER_KEYS.includes(key)) {
        problems.push(
          `${at}.${key}: "${id}" is a platform module — its ${key} is the platform's to declare. Remove "${key}"; an app adds paths only (${LIST_KEYS.join(", ")})`
        );
      } else if (LIST_KEYS.includes(key) || key === "dependsOn") {
        if (!isStringList(value))
          problems.push(`${at}.${key}: must be a list of strings`);
      } else if (!isPlatform && ["definition", "entry"].includes(key)) {
        if (typeof value !== "string") problems.push(`${at}.${key}: must be a path`);
      } else if (!isPlatform && key === "kitManifest") {
        if (value !== null && typeof value !== "string")
          problems.push(`${at}.kitManifest: must be a path or null`);
      } else {
        problems.push(
          `${at}.${key}: not a manifest key — use ${isPlatform ? LIST_KEYS.join(", ") : [...OWNER_KEYS, ...LIST_KEYS].join(", ")}`
        );
      }
    }
    if (!isPlatform) {
      if (!MODULE_ID.test(id))
        problems.push(
          `${at}: a module id is lower-case words joined by hyphens (e.g. "my-feature")`
        );
      for (const key of ["definition", "entry"]) {
        if (entry[key] === undefined)
          problems.push(
            `${at}: a new module declares "${key}" (the path of its ${key === "definition" ? "definePlatformModule call" : "public entry"})`
          );
      }
    }
  }
  return problems;
}

/** Every path a module lists, with what it is listed as (single paths included). */
function modulePaths(mod) {
  const out = [];
  for (const key of LIST_KEYS) for (const p of mod[key]) out.push([key, p]);
  if (mod.kitManifest) out.push(["kitManifest", mod.kitManifest]);
  return out;
}

/**
 * The platform's manifest with the app's merged in (a new object; the inputs are not changed).
 * Throws one Error listing every problem, each naming the file and what to change.
 */
function mergeManifests(
  platform,
  app = { modules: {} },
  owned = loadPlatformOwnership()
) {
  const shape = appManifestShapeProblems(platform, app);
  if (shape.length > 0) throw new Error(shape.join("\n"));
  const ownership = appOwnershipProblems(app, owned);
  const out = JSON.parse(JSON.stringify(platform));
  out.app = app.app ?? null;
  out.migrationsBeforeTheConvention = [...(app.migrationsBeforeTheConvention ?? [])];
  out.noUserData = { ...(app.noUserData ?? {}) };
  out.platformModules = Object.keys(platform.modules);
  out.appModules = [];
  for (const [id, entry] of Object.entries(app.modules ?? {})) {
    if (out.modules[id]) {
      const mod = out.modules[id];
      for (const key of LIST_KEYS) {
        for (const p of entry[key] ?? []) if (!mod[key].includes(p)) mod[key].push(p);
      }
    } else {
      const mod = {
        definition: entry.definition,
        entry: entry.entry,
        dependsOn: [...(entry.dependsOn ?? [])],
      };
      for (const key of LIST_KEYS) mod[key] = [...(entry[key] ?? [])];
      mod.kitManifest = entry.kitManifest ?? null;
      out.modules[id] = mod;
      out.appModules.push(id);
    }
  }
  const problems = [...ownership, ...mergedProblems(out)];
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return out;
}

/** What is wrong with a merged manifest: paths claimed twice, dependencies, cycles. */
function mergedProblems(manifest) {
  const problems = [];
  const ids = Object.keys(manifest.modules);
  const source = (id) =>
    manifest.appModules && manifest.appModules.includes(id) ? APP_MANIFEST : MANIFEST;
  // A path claimed by two modules — the same path, or one beneath the other.
  const claims = ids.flatMap((id) =>
    modulePaths(manifest.modules[id]).map(([key, p]) => ({ id, key, p: normalise(p) }))
  );
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i];
      const b = claims[j];
      if (a.id === b.id) continue;
      if (withinFolded(a.p, b.p) || withinFolded(b.p, a.p)) {
        problems.push(
          `path claimed by two modules: "${a.p}" (${a.id}.${a.key}) and "${b.p}" (${b.id}.${b.key}) — a file belongs to one module; remove it from one of them (${APP_MANIFEST} holds the app's entries)`
        );
      }
    }
  }
  for (const c of claims) {
    for (const root of [...manifest.compositionRoots, ...manifest.seamTests]) {
      if (withinFolded(root, c.p) || withinFolded(c.p, root)) {
        problems.push(
          `"${c.p}" (${c.id}.${c.key}) claims "${root}", a composition root or its test — those are the app's composition, never a module's; remove it`
        );
      }
    }
  }
  for (const id of ids) {
    for (const dep of manifest.modules[id].dependsOn) {
      if (!manifest.modules[dep]) {
        problems.push(
          `module "${id}" (${source(id)}) depends on "${dep}", which no manifest declares — declare it or remove the dependency`
        );
      }
    }
  }
  if (problems.length === 0) {
    try {
      dependencyOrder(manifest);
    } catch (err) {
      problems.push(`${err.message} — a module may not depend on itself through others`);
    }
  }
  return problems;
}

/** The manifest every reader uses: the platform's merged with the app's. */
function loadManifest(root = ROOT) {
  return mergeManifests(
    loadPlatformManifest(root),
    loadAppManifest(root),
    loadPlatformOwnership(root)
  );
}

/**
 * In platform-foundation ("app" null): what is wrong with platform-paths.json against the tree.
 * In an app, or outside a git checkout, nothing is checked (the list is the platform's).
 */
function platformPathsProblems(manifest, root = ROOT) {
  if (manifest.app !== null && manifest.app !== undefined) return [];
  const tracked = trackedPlatformPaths(root);
  if (tracked === null) return [];
  const listed = loadPlatformPaths(root);
  const want = new Set(tracked);
  const have = new Set(listed);
  const missing = tracked.filter((f) => !have.has(f));
  const extra = listed.filter((f) => !want.has(f));
  if (missing.length === 0 && extra.length === 0) return [];
  const sample = (xs) => xs.slice(0, 5).join(", ") + (xs.length > 5 ? ", …" : "");
  return [
    `${PLATFORM_PATHS} does not list the tree (${missing.length} missing${missing.length ? `: ${sample(missing)}` : ""}; ${extra.length} not in git${extra.length ? `: ${sample(extra)}` : ""}) — run node scripts/module-manifest.cjs --write-platform-paths`,
  ];
}

/** Regenerates platform-paths.json from git (platform-foundation only). */
function writePlatformPaths(root = ROOT) {
  const tracked = trackedPlatformPaths(root);
  if (tracked === null) throw new Error("--write-platform-paths needs a git checkout");
  const body = {
    $comment:
      "Generated by node scripts/module-manifest.cjs --write-platform-paths — do not edit. Every file platform-foundation ships outside platform/ except the consumer seams; scripts/module-manifest.cjs refuses an app manifest entry naming one of them, a directory holding one, or anything under platform/ (review 7 H2). Synced to consumers unchanged.",
    paths: tracked,
  };
  fs.writeFileSync(path.join(root, PLATFORM_PATHS), JSON.stringify(body, null, 2) + "\n");
  return tracked.length;
}

/** The platform's own migration file names (supabase/platform-migrations.json). */
function loadPlatformMigrations(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, PLATFORM_MIGRATIONS), "utf8"))
    .migrations;
}

/** supabase/migrations' migration files, in file-name order. */
function migrationFiles(root = ROOT) {
  return fs
    .readdirSync(path.join(root, MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** The name an app's migration should take: the platform number, a free letter, the app prefix. */
function suggestedAppName(file, app, taken) {
  const m = /^(\d+)[a-z]?_(.*)$/.exec(file);
  const num = m ? m[1].padStart(3, "0").slice(-3) : "NNN";
  let rest = m ? m[2] : file;
  const prefix = app ?? "<app>";
  if (rest.startsWith(`${prefix}_`)) rest = rest.slice(prefix.length + 1);
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    const name = `${num}${letter}_${prefix}_${rest}`;
    if (!taken.has(name) && ![...taken].some((t) => t.startsWith(`${num}${letter}_`)))
      return name;
  }
  return `${num}?_${prefix}_${rest}`;
}

/**
 * What is wrong with the migration names (TASK-158), each message saying what to change.
 *   files              supabase/migrations' .sql files
 *   manifest           the merged manifest (its "app" and "migrationsBeforeTheConvention")
 *   platformMigrations the platform's file names (supabase/platform-migrations.json)
 * In platform-foundation ("app" is null) every file is the platform's: NNN_<name>.sql, listed.
 * In an app, a bare-numbered file is the platform's or one the app applied before the convention.
 */
function migrationNameProblems(files, manifest, platformMigrations) {
  const problems = [];
  const app = manifest.app ?? null;
  const before = new Set(manifest.migrationsBeforeTheConvention ?? []);
  const platform = new Set(platformMigrations);
  const present = new Set(files);
  const letters = new Map();
  // An app's NNN names the platform migration it follows: 001 to the platform's latest (L1 —
  // 000a_ sorted before every platform migration, 999a_ after any the platform will ever ship).
  const latest = Math.max(
    0,
    ...platformMigrations.map((f) => Number(/^(\d{3})_/.exec(f)?.[1] ?? 0))
  );
  for (const f of files) {
    const appForm = APP_FORM.exec(f);
    if (appForm) {
      if (app === null) {
        problems.push(
          `${f}: platform-foundation never uses the letter form (NNN<letter>_) — that form is the apps'. Name it NNN_<name>.sql with the next free number and list it in ${PLATFORM_MIGRATIONS}. (An app sets "app" in ${APP_MANIFEST}.)`
        );
        continue;
      }
      const num = Number(appForm[1]);
      if (num < 1 || num > latest) {
        problems.push(
          `${f}: an app migration's NNN is the number of the platform migration it follows — 001 to ${String(latest).padStart(3, "0")} (the platform's latest, ${PLATFORM_MIGRATIONS}). Rename it to ${String(latest).padStart(3, "0")}${appForm[2]}_${appForm[3]}.sql`
        );
        continue;
      }
      if (!appForm[3].startsWith(`${app}_`)) {
        problems.push(
          `${f}: an app migration is named NNN<letter>_${app}_<name>.sql — rename it to ${appForm[1]}${appForm[2]}_${app}_${appForm[3]}.sql`
        );
      }
      const key = `${appForm[1]}${appForm[2]}`;
      if (letters.has(key)) {
        problems.push(
          `${f}: ${key} is already ${letters.get(key)} — give each app migration its own letter`
        );
      } else letters.set(key, f);
      continue;
    }
    if (!PLATFORM_FORM.test(f)) {
      problems.push(
        `${f}: not a migration name — the platform's are NNN_<name>.sql, an app's NNN<letter>_<app>_<name>.sql (lower-case letters, digits, "_" and "-")`
      );
      continue;
    }
    if (platform.has(f) || (app !== null && before.has(f))) continue;
    if (app === null) {
      problems.push(
        `${f}: a platform migration not listed in ${PLATFORM_MIGRATIONS} — add it there`
      );
    } else {
      problems.push(
        `${f}: an app migration with a bare platform number collides with the platform's NNN (TASK-158). Rename it to ${suggestedAppName(f, app, present)} — or, only if it is already applied to your databases under this name, list it in ${APP_MANIFEST} "migrationsBeforeTheConvention" (renaming an applied migration re-runs it)`
      );
    }
  }
  if (app === null) {
    for (const f of platform) {
      if (!present.has(f))
        problems.push(
          `${PLATFORM_MIGRATIONS} lists ${f}, which is not in ${MIGRATIONS_DIR}`
        );
    }
    for (const f of before) {
      problems.push(
        `${APP_MANIFEST}: "migrationsBeforeTheConvention" is an app's list — platform-foundation has none (${f})`
      );
    }
  } else {
    for (const f of before) {
      if (platform.has(f))
        problems.push(
          `${APP_MANIFEST} "migrationsBeforeTheConvention" lists ${f}, a platform migration — remove it`
        );
      else if (!present.has(f))
        problems.push(
          `${APP_MANIFEST} "migrationsBeforeTheConvention" lists ${f}, which is not in ${MIGRATIONS_DIR} — remove it`
        );
      else if (!PLATFORM_FORM.test(f))
        problems.push(
          `${APP_MANIFEST} "migrationsBeforeTheConvention" lists ${f}, which is not bare-numbered — remove it`
        );
    }
  }
  return problems;
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
  APP_MANIFEST,
  PLATFORM_MIGRATIONS,
  PLATFORM_PATHS,
  CONSUMER_SEAMS,
  LIST_KEYS,
  MIGRATION_FILE,
  loadPlatformManifest,
  loadAppManifest,
  mergeManifests,
  loadManifest,
  loadPlatformMigrations,
  loadPlatformPaths,
  loadPlatformOwnership,
  trackedPlatformPaths,
  platformPathsProblems,
  writePlatformPaths,
  migrationFiles,
  migrationNameProblems,
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
  if (
    flag !== "--replay-order" &&
    flag !== "--check" &&
    flag !== "--write-platform-paths"
  ) {
    console.error(
      "usage: node scripts/module-manifest.cjs --replay-order [module,module,...] | --check | --write-platform-paths"
    );
    process.exit(2);
  }
  try {
    if (flag === "--write-platform-paths") {
      if (loadAppManifest().app)
        throw new Error(
          `${PLATFORM_PATHS} is the platform's (synced unchanged) — an app never regenerates it`
        );
      console.log(`✓ ${PLATFORM_PATHS}: ${writePlatformPaths()} files`);
      process.exit(0);
    }
    const manifest = loadManifest();
    const files = migrationFiles();
    const problems = migrationNameProblems(files, manifest, loadPlatformMigrations());
    if (problems.length > 0) throw new Error(problems.join("\n"));
    if (flag === "--check") {
      const listProblems = platformPathsProblems(manifest);
      if (listProblems.length > 0) throw new Error(listProblems.join("\n"));
      console.log(
        `✓ module manifest (${moduleIds(manifest).length} modules, ${manifest.appModules.length} the app's) and ${files.length} migration names`
      );
      process.exit(0);
    }
    const selected = list ? list.split(",").filter(Boolean) : moduleIds(manifest);
    process.stdout.write(replayOrder(manifest, files, selected).join("\n") + "\n");
  } catch (err) {
    for (const line of err.message.split("\n")) console.error(`✗ ${line}`);
    process.exit(1);
  }
}
