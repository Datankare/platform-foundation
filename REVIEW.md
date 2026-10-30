# REVIEW.md — what a reviewer checks in platform-foundation

For every reviewer of a change here, agent or person. The process around it (finders, verifier,
rounds, risk tiers) is [docs/AI_ENGINEERING.md](docs/AI_ENGINEERING.md).

## What failure looks like here

| Area                 | It fails when it…                                                 | Tier area (`scripts/risk-tiers.json`) |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| Auth                 | lets the wrong person in or locks the right one out               | `auth`                                |
| Tenancy              | leaks across tenants                                              | `tenancy`                             |
| Migrations           | can't be replayed or loses data                                   | `migrations`                          |
| Jobs                 | runs twice, never, or deadlocks                                   | `jobs`                                |
| Config and workflows | misroutes or weakens a gate                                       | `workflows`, `secrets-config`         |
| Billing and consent  | charges, or uses a child's data, without the right to             | `billing-consent`                     |
| Content moderation   | shows unscreened content, or withholds content without saying why | `moderation`                          |
| Docs                 | it lies                                                           | —                                     |
| UI                   | dead-ends or hides the reason                                     | —                                     |
| Performance          | an unbounded query or a per-request fan-out                       | —                                     |

The High-tier paths and content patterns are in **`scripts/risk-tiers.json`**, the one source:
`scripts/risk-tier.mjs` reads it, and this file does not repeat the patterns.
One rule is in the script itself: a change to `.github/`, `scripts/risk-tier*`, this file,
`CLAUDE.md` or any `.gitattributes` is High whatever the patterns say. CI runs the base branch's
classifier and patterns, but a PR that changes a workflow runs its own copy of that workflow, so
its tier and its security result are not trustworthy: any PR touching `.github/` is High by
definition, and the owner takes its tier from the base classifier run locally
([AI_ENGINEERING](docs/AI_ENGINEERING.md) §4.2).

## Rules

1. **Evidence.** Every finding names a file and line and says what happens there. A guess from
   a name is not a finding.
2. **Tags.** Each finding is **Important** (a defect this change introduces or exposes), **Nit**
   (style, naming, wording — no defect) or **Pre-existing** (a defect the change did not introduce;
   it is filed, not blamed on the change).
3. **Nits are capped** at three per review. Say how many more there were, in one line.
4. **Flag the class, not the instance.** When a defect can recur elsewhere, say where else to
   look; the fix covers every instance.
5. **No repeats.** A finding already answered (fixed, or resolved with a reason) is not raised
   again unless the answer is wrong — then say why.
6. **Bug fixes:** check the root cause is fixed, not the symptom.
7. **CLAUDE.md:** flag code that breaks a convention in it, and any line in it that is out of date.
8. **Skip generated paths:** `platform/modules/platform-paths.json`, `package-lock.json`, the
   baselines (`coverage-baseline.json`, `refusal-coverage-baseline.json`,
   `screen-literal-baseline.json`, `journey-exemptions.json`) and the generated error docs
   (`docs/API_ERRORS.md`, `docs/APP_API_ERRORS.md`). One exception: a baseline that loosens (a
   gap added, a floor lowered, an exemption added) weakens a gate and is a finding.
9. **The summary opens with a count** — "2 Important, 1 Nit, 0 Pre-existing." — and when there
   is nothing to fix it says so plainly: "Nothing to fix."
