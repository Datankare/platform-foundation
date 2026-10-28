## What

<!-- One sentence: what this PR delivers. -->

## Why

<!-- The business/architecture reason — which ADR, roadmap item, or principle drives this. -->

## Risk tier

<!-- Low / Medium / High, and the reason: paste the review-tier job's reasons, or the output of
     node scripts/risk-tier.mjs --base origin/develop
     If you raised the tier above the classifier's, say why. Nothing lowers a tier.
     What each tier requires: docs/AI_ENGINEERING.md §4. -->

## Root cause & failure mode

<!-- FIXES ONLY (delete for features). What actually broke, why, and how it failed —
     did it fail loudly, or silently? "What changed" is the diff; this is the reason
     the diff exists. See L23. -->

## GenAI Principles

<!-- Which principles this work satisfies (P1–P18), or "N/A — no GenAI surface." -->

## Changes

<!-- Module/file-level summary — what changed and why, not a file list. -->

## Testing

<!-- The evidence, not a claim: each command run and its output (the summary lines), the new
     tests and their hostile cases, coverage against the floor. Screenshots for anything a
     person sees. A user-facing feature in an app: its e2e-live step. -->

```zsh
npm run format:check && npm run typecheck && npx eslint . --max-warnings 0 && npm test
```

## Security

<!-- What this change could expose or weaken (a guard, a tenant boundary, a secret, a gate), how
     the tests refuse it, and the security-review check's result (findings, or "skipped: no key"). -->

## Performance

<!-- New queries and calls per request, and their bounds. "None" if none. -->

## How to revert

<!-- The exact steps: the revert, and for a migration or a setting, what else must be undone. -->

## Review rounds

<!-- Per round (cap 3 — docs/AI_ENGINEERING.md §3): the finding count by tag (Important / Nit /
     Pre-existing), and each finding with how it was answered — fixed (with its test) or resolved
     with a reason. Pre-existing findings: where they were filed. -->

## Dependencies

<!-- What must merge before this. What depends on this. -->
