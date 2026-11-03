/**
 * stryker.config.mjs — mutation testing of the engineering-process check (TASK-200; docs/AI_ENGINEERING.md
 * §3a, "Mutation testing on gate code"). A manual check: run it by hand (`npm run test:mutation`)
 * whenever scripts/process-check.mjs changes; the score must be 90% or more (`break`).
 *
 * Scope: scripts/process-check.mjs alone, judged by __tests__/process-check.mutation.mjs — a fast,
 * dependency-free suite that imports the script, drives it in-process over git fixtures it builds
 * once and caches, and stops at its first failing case (a killed mutant costs the cases up to it).
 * The jest suite (__tests__/process-check.test.ts) is not the runner: it spawns the script per case
 * and is too slow for each of the script's mutants, and jest cannot load the script's ES module
 * without a transform. Stryker's command runner runs the suite once per mutant, with the mutant
 * switched on through the environment (inherited by every process the suite starts).
 *
 * An equivalent mutant (no test could tell it apart) is marked in the script with
 * `// Stryker disable next-line <mutator>: <why it is equivalent>` when every mutant of that mutator
 * on its line is equivalent (the comment silences them all); otherwise it survives, and the task's
 * Self-review lists it.
 */
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  mutate: ["scripts/process-check.mjs"],
  testRunner: "command",
  commandRunner: { command: "node __tests__/process-check.mutation.mjs" },
  thresholds: { high: 95, low: 90, break: 90 },
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: "reports/mutation/process-check.json" },
  // Only what the suite reads is copied into Stryker's sandbox.
  ignorePatterns: [
    "/*",
    "!/scripts",
    "/scripts/*",
    "!/scripts/process-check.mjs",
    "!/__tests__",
    "/__tests__/*",
    "!/__tests__/process-check.mutation.mjs",
    "!/package.json",
    // The suite reads TASK-200's entry (it passes its own check).
    "!/docs",
    "/docs/*",
    "!/docs/TASKS.md",
  ],
  tempDirName: ".stryker-tmp",
  cleanTempDir: "always",
  // A mutant that loops (the lexer's, mostly) is a timeout, counted as detected: wait little for it.
  timeoutMS: 5000,
  timeoutFactor: 1.5,
  concurrency: 2,
};
export default config;
