#!/usr/bin/env node
/**
 * TASK-070 / TASK-058 — periodic override reaudit prompt.
 *
 * The 6.5 override register (docs/SECURITY_DEBT.md) and the drift guard (override-audit.mjs) record
 * WHY each override exists and enforce that none is undocumented — but nothing makes anyone revisit
 * whether an override is STILL needed. An override outlives its advisory silently. This emits a
 * markdown triage checklist of every override for the scheduled dependency sweep, so the
 * remove-install-audit reaudit happens on a cadence rather than never. Reporting only.
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const overrides = Object.keys(pkg.overrides ?? {});

const lines = [
  "## Dependency override reaudit (TASK-070)",
  "",
  `${overrides.length} overrides in this repo. For each: remove it, \`npm install\`, \`npm audit\`; ` +
    "if the tree stays clean, the override has expired — drop it. Reasons and removal conditions " +
    "are in `docs/SECURITY_DEBT.md`.",
  "",
  ...overrides.map((o) => `- [ ] \`${o}\` — still required?`),
  "",
  "**Cross-repo (TASK-058):** platform-foundation and Playform maintain overrides independently " +
    "(`package.json` is sync-excluded), so an override added in one is not inherited by the other. " +
    "Reconcile any divergence at this triage.",
];
process.stdout.write(lines.join("\n") + "\n");
