#!/usr/bin/env node
/**
 * TASK-080 — coverage ratchet with hysteresis.
 *
 * Reads coverage/coverage-summary.json (jest json-summary) and coverage-baseline.json:
 *   - Regression: actual < baseline on any axis -> exit 1 (a fall is a finding, not a new floor).
 *   - Slack:      actual > baseline + margin     -> raise that axis to actual - margin, rewrite
 *                                                    coverage-baseline.json (commit it).
 *   - Otherwise:  within the hysteresis band     -> no change.
 *
 * A baseline is never lowered automatically. This is the mechanism TASK-080 asks for: slack above
 * the margin raises the floor without anyone editing package.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const AXES = ["statements", "lines", "functions", "branches"];

export function evaluateRatchet(actual, baseline, margin) {
  const regressions = [];
  const raised = {};
  const next = { ...baseline };
  for (const axis of AXES) {
    const a = actual[axis];
    const b = baseline[axis];
    if (a < b) {
      regressions.push({ axis, actual: a, baseline: b });
    } else if (a > b + margin) {
      next[axis] = Math.round((a - margin) * 100) / 100;
      raised[axis] = { from: b, to: next[axis] };
    }
  }
  return { regressions, raised, next };
}

function main() {
  const summary = JSON.parse(readFileSync("coverage/coverage-summary.json", "utf8"));
  const actual = Object.fromEntries(AXES.map((x) => [x, summary.total[x].pct]));
  const cfg = JSON.parse(readFileSync("coverage-baseline.json", "utf8"));
  const { regressions, raised, next } = evaluateRatchet(actual, cfg.baseline, cfg.margin);

  if (regressions.length > 0) {
    console.error("Coverage ratchet: REGRESSION below baseline (a fall is a finding):");
    for (const r of regressions) {
      console.error(`  ${r.axis}: ${r.actual}% < baseline ${r.baseline}%`);
    }
    process.exit(1);
  }
  if (Object.keys(raised).length > 0) {
    cfg.baseline = next;
    writeFileSync("coverage-baseline.json", `${JSON.stringify(cfg, null, 2)}\n`);
    console.log("Coverage ratchet: raised baseline (commit coverage-baseline.json):");
    for (const [axis, m] of Object.entries(raised)) {
      console.log(`  ${axis}: ${m.from}% -> ${m.to}%`);
    }
  } else {
    console.log("Coverage ratchet: OK (within hysteresis band, no change).");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
