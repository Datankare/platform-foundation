#!/usr/bin/env node
/**
 * scripts/relink-identity.mjs — re-link existing accounts to their identity in a new user pool
 * (TASK-174, ADR-012 amendment; runbook docs/TENANCY_OPERATIONS.md §6)
 *
 *   node scripts/relink-identity.mjs --email <address> \
 *        --created-before <time> --operator <who> --reason <why> \
 *        [--confirm-unverified <account id>]... [--apply]
 *   node scripts/relink-identity.mjs --help
 *
 * Run from a trusted machine, from the repository at the deployed release, with the settings
 * exported in the shell (never written to a file): DATABASE_OWNER_URL (+ DATABASE_SSL, DATABASE_SSL_CA), the
 * pool id and a key that may call ListUsers on it, and the shared cache's settings. A dry run
 * unless --apply. The work is platform/auth/identity-relink-command.ts — the platform's own
 * TypeScript, run by Node directly (--experimental-transform-types, Node ≥ 22.7; this script
 * starts Node with it when it was not given) through scripts/ts-paths-hook.mjs. No build step and
 * no dependency beyond the repository's own (npm ci).
 *
 * Exit: 0 done or nothing to do; 1 refused (nothing changed); 2 usage or settings; 3 the pool or
 * the database could not be reached (nothing changed); 4 applied, some addresses refused and
 * skipped; 5 applied, caches not voided on every instance (≤ 60 s stale); 6 partly applied — run
 * it again; 7 a commit's outcome unknown — run the dry run to verify
 * (platform/auth/identity-relink-command.ts EXIT). A dry run that refused anything exits 1.
 */

import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 7)) {
  process.stderr.write(`✗ Node ≥ 22.7 is required (this is ${process.versions.node})\n`);
  process.exit(2);
}

if (process.features.typescript !== "transform") {
  // Started without TypeScript support: run again with it, same arguments, same environment.
  const again = spawnSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--no-warnings",
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: "inherit", env: process.env }
  );
  process.exit(again.status ?? 3);
}

register(new URL("./ts-paths-hook.mjs", import.meta.url), {
  data: { root: ROOT },
});

const load = (path) => import(pathToFileURL(`${ROOT}${path}`).href);
const { runRelinkCommand } = await load("platform/auth/identity-relink-command.ts");
const code = await runRelinkCommand(process.argv.slice(2), process.env, {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
try {
  const { closeDataPools } = await load("platform/data/index.ts");
  const { closeCache } = await load("platform/cache/index.ts");
  await closeDataPools();
  await closeCache();
} finally {
  process.exit(code);
}
