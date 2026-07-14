## What

<!-- One sentence: what this PR delivers. -->

## Why

<!-- The business/architecture reason — which ADR, roadmap item, or principle drives this. -->

## Root cause & failure mode

<!-- FIXES ONLY (delete for features). What actually broke, why, and how it failed —
     did it fail loudly, or silently? "What changed" is the diff; this is the reason
     the diff exists. See L23. -->

## GenAI Principles

<!-- Which principles this work satisfies (P1–P18), or "N/A — no GenAI surface." -->

## Changes

<!-- Module/file-level summary — what changed and why, not a file list. -->

## Tests

<!-- New test count, key coverage changes. Coverage must not decrease. -->

## Gate

<!-- Actual result: suites, tests, coverage vs floor. -->

```bash
npm run format:check && npx tsc --noEmit && npx eslint . && npx jest
```

## Dependencies

<!-- What must merge before this. What depends on this. -->
