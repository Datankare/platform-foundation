# AI engineering — how a change is built, reviewed and handed over

How changes to this platform are made and checked when an AI agent writes most of the code and one
person owns the repository. The roles:

- **The AI engineer** — a coding agent (Claude) that writes the change, its tests and its docs,
  and runs the per-change review protocol (§3) before handing the change over.
- **The owner** — the one human. The owner decides what is built, reads the evidence, and
  promotes develop → staging → main in the GitHub GUI. The owner is accountable for every change
  that ships, whoever typed it.

This page says what is in place, what was adapted, what was declined and what is only planned.
Where it says "planned", nothing runs yet.

## 1. Acknowledgement

This process follows **_How the Claude Code team does code review_**, by **Addy Osmani, Morgan
Westlee Lunt and Qing Wang** (claude.dev Blog, 15 October 2026 —
<https://claude.dev/blog/solving-code-review-at-anthropic/>). The article describes how the team
behind Claude Code reviews code that Claude mostly writes: verification before review, a short
`CLAUDE.md` and a `REVIEW.md`, several finder agents with a separate verifier, severity tags, a
blocking security review, risk tiers set by the change rather than its author, round caps, and
turning incidents into an eval set for the reviewer. Its goal is the least human review time that
does not raise reverts or incidents. The figures it reports are Anthropic's, measured on its own
repositories; none of them is claimed here.

The formal-verification plan has its own source, credited in [ASSURANCE](ASSURANCE.md) §7 and not
repeated here: _LLMs are making formal software verification feasible at a much larger scale_
(Anthropic Frontier Red Team, with Theorem, 22 October 2026).

## 2. The article's practices, and what this repository does with each

| Practice in the article                                                                 | Here                       | How, here                                                                                                                                                                                                                                                     | Why                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verification before review: run the checks and show the output, not "done"              | Adopted                    | Every change carries its gate output and commands (§5); CLAUDE.md: "verify before claiming"                                                                                                                                                                   | A claim without output cannot be reviewed                                                                                                                                                                                                          |
| A short `CLAUDE.md`: stack, conventions, goals, non-goals, pointers                     | Adopted                    | [CLAUDE.md](../CLAUDE.md) in each repository, with the standing rules                                                                                                                                                                                         | Every agent and reviewer loads it                                                                                                                                                                                                                  |
| `REVIEW.md`: what failure looks like, capped nits, skipped paths, file:line, a count    | Adopted                    | [REVIEW.md](../REVIEW.md) in each repository                                                                                                                                                                                                                  | The reviewer needs the repository's failure modes, not generic advice                                                                                                                                                                              |
| Fix a recurring finding at the source                                                   | Adopted                    | A finding that recurs becomes a test, a lint rule, or a line in CLAUDE.md or REVIEW.md — the repositories' existing "findings become tests" rule (ASSURANCE)                                                                                                  | A check that runs does not depend on a reviewer remembering                                                                                                                                                                                        |
| A second agent reviews the diff in a fresh context before the PR                        | Adopted                    | The finders of §3, each in a fresh context                                                                                                                                                                                                                    | The author's context carries its blind spots                                                                                                                                                                                                       |
| AI review on every PR (Code Review for Claude Code; Quick, Standard, Deep)              | Adapted                    | The protocol of §3, run by the AI engineer before handover, at a depth set by the risk tier. Code Review for Claude Code is not part of this setup                                                                                                            | The same depth-by-risk idea, run where the change is made                                                                                                                                                                                          |
| Several finders, a separate verifier vote; only findings judged real are kept           | Adopted                    | §3 steps 2–3                                                                                                                                                                                                                                                  | Unverified findings cost a round each                                                                                                                                                                                                              |
| Severity tags Important, Nit, Pre-existing                                              | Adopted                    | REVIEW.md rule 2; §3                                                                                                                                                                                                                                          | A change is not blamed for what it did not introduce                                                                                                                                                                                               |
| Every finding answered: fixed, or resolved with a reason                                | Adopted                    | §3 step 5; the PR's "Review rounds" section                                                                                                                                                                                                                   | Nothing is dropped silently                                                                                                                                                                                                                        |
| A separate automated security review; open findings block the merge                     | Adapted (blocking planned) | `.github/workflows/security-review.yml` fails its check when the action reports findings, and when a scan is skipped for a fork's PR or while `SECURITY_REVIEW_REQUIRED` is `true` (§4.3). Making it a required check is a branch-protection setting, planned | The article blocks merge on any open bug-review or security-review finding, and clears a false positive with a reason. Here only the security check fails, it doesn't block until it is a required check, and a false positive keeps it red (§4.3) |
| Required CI: lint, types, tests, build                                                  | In place                   | `ci.yml` and the workflows in ASSURANCE §6, before this change                                                                                                                                                                                                | —                                                                                                                                                                                                                                                  |
| The PR template asks how the change was tested and how to undo it                       | Adopted                    | `.github/pull_request_template.md`: Risk tier, Testing, Security, Performance, How to revert, Review rounds                                                                                                                                                   | The evidence the owner reads                                                                                                                                                                                                                       |
| Risk tiers set by the change, not the author, picked by a classifier                    | Adopted                    | `scripts/risk-tier.mjs` and the `review-tier` job (§4)                                                                                                                                                                                                        | The author's confidence is not evidence                                                                                                                                                                                                            |
| Some paths always need a person (sensitive paths, CI workflows)                         | Adopted                    | High tier: the owner's explicit approval at promotion, after reading the evidence                                                                                                                                                                             | These are where one missed defect costs most                                                                                                                                                                                                       |
| Human approvals by tier: none, one, two                                                 | Adapted                    | One owner: the tier sets the automated depth instead (§4); High needs the owner's explicit approval                                                                                                                                                           | There is one human to approve                                                                                                                                                                                                                      |
| A second classifier: does the change need another person anyway?                        | Adapted                    | The AI engineer may raise a tier, never lower it, and says why in the PR                                                                                                                                                                                      | Judgement can see what patterns miss                                                                                                                                                                                                               |
| Lighter paths for trusted authors                                                       | Declined                   | —                                                                                                                                                                                                                                                             | One author; the tier never depends on who wrote the change                                                                                                                                                                                         |
| An agent's approval never counts as a person's                                          | Adopted                    | §4. No agent approves, merges or promotes                                                                                                                                                                                                                     | Accountability stays with a person                                                                                                                                                                                                                 |
| Whoever directed the change is on the hook                                              | Adopted                    | The owner directs every change and promotes it                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                  |
| Approval covers one commit                                                              | Adapted                    | The owner promotes a specific head; `promotion-guard.yml` refuses a PR into `main` unless it is staging's tip, a Route-B branch with staging's tree, or a hotfix cut from main                                                                                | No review approvals are used; the promotion is the approval                                                                                                                                                                                        |
| Merge queue                                                                             | Declined                   | §8                                                                                                                                                                                                                                                            | One author, promotions in series                                                                                                                                                                                                                   |
| Flags, internal-first use, staged release                                               | Adapted                    | Staged environments: develop → staging → main, each deployed by the consuming app. Flags for new behaviour are not a standing practice here                                                                                                                   | Pre-launch: no users to stage a release to                                                                                                                                                                                                         |
| Incident reviews ask which layer should have caught it                                  | Adopted                    | Each eval case records how a miss was caught and the finding that should have caught it (§6)                                                                                                                                                                  | —                                                                                                                                                                                                                                                  |
| Circuit breakers that tighten approval when reverts or incidents rise                   | Declined                   | §8                                                                                                                                                                                                                                                            | The article's team does not have them yet either                                                                                                                                                                                                   |
| Incidents become evals; re-score the reviewer when its prompts, tools or model change   | Adapted                    | [review-evals/](review-evals/) and its rubric (§6). Scored runs are planned: none is recorded yet                                                                                                                                                             | The article keeps a reviewer change only when the score rises; here a change is kept when the score does not fall and noise does not rise                                                                                                          |
| Measure noise: how authors answered each finding; false alarms on known-clean changes   | Planned                    | The "Review rounds" section records fixed / resolved-with-reason per finding; collecting it per milestone is §7. Runs on known-clean changes: not yet                                                                                                         | —                                                                                                                                                                                                                                                  |
| Round cap of three, then reconsider the approach; re-review only the new diff           | Adopted                    | §3 steps 8–9                                                                                                                                                                                                                                                  | §9: a re-link ran three rounds before its approach was questioned                                                                                                                                                                                  |
| Flag the class of bug; no repeated findings                                             | Adopted                    | REVIEW.md rules 4–5; §3 step 6                                                                                                                                                                                                                                | Fixing one instance leaves the next round to find the others                                                                                                                                                                                       |
| Review agents run nightly over existing code                                            | Adapted                    | The independent adversarial reviews at each release and phase close (ASSURANCE §1); no nightly run                                                                                                                                                            | Those reviews already cover existing code                                                                                                                                                                                                          |
| People decide whether to build it; own architecture; read the evidence; own the outcome | Adopted                    | The owner's role (above); CLAUDE.md "match effort to stakes"                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                  |
| Explainers of a code slice on request                                                   | Adapted                    | Asked for when needed; not a standing step                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                  |
| "You land it, you own it"                                                               | Adopted                    | The AI engineer fixes forward what it shipped, within the same rules                                                                                                                                                                                          | —                                                                                                                                                                                                                                                  |
| Raise a different direction early, not as a blocking comment on a finished PR           | Adopted                    | §3 step 9; CLAUDE.md "match effort to stakes"                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                  |
| Measure human time, with reverts and incidents as the guardrail                         | Adapted                    | §7                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                  |

## 3. The per-change review protocol

**Who runs it.** The AI engineer runs this protocol on its own change before handing the change to
the owner. It is a written procedure that the agent follows. No CI job runs it or proves it ran:
the evidence that it ran is the PR's "Review rounds" section. The checks that CI does run are the
`review-tier` job, the security review (§4.3) and the gates in ASSURANCE §1.

1. **Tier.** `node scripts/risk-tier.mjs --base origin/develop` (§4). The depth below follows it.
2. **Finders.** Independent finder agents, each started in a fresh context with only: the diff,
   the change's stated intent, CLAUDE.md, REVIEW.md, and read access to the whole repository. A
   finder sees neither the author's reasoning nor another finder's findings. Low: one finder.
   Medium: two. High: at least three, each with its own focus — correctness against the intent;
   the area's failure from REVIEW.md (the wrong person in, a tenant leak, a replay that fails…);
   and the second paths and hostile input of the [audit brief](audits/BRIEF.md).
3. **Verifier.** A separate agent, in its own fresh context, takes each finding with the code it
   names and votes **real** or **not real**, with file:line. Only findings voted real are kept.
   High: two independent votes; a split goes to a third.
4. **Tags.** Each kept finding is **Important**, **Nit** or **Pre-existing** (REVIEW.md rule 2).
5. **Answer every finding.** Fixed — with the test that fails without the fix — or resolved with
   a reason. Each answer is listed in the PR's "Review rounds" section.
6. **Fix the whole class.** For each Important finding, search for the same pattern elsewhere and
   fix every instance, or file the ones out of scope.
7. **Pre-existing findings are filed, not blamed.** Each goes into [TASKS](TASKS.md) (or the audit
   register) with its evidence; it is not counted against the change.
8. **Rounds.** Round 1 reviews the whole diff. After round 1, each round reviews only the new
   diff — the commits since the previous round.
9. **Round cap: three.** If round 3 still finds an Important defect, the AI engineer stops and
   questions the approach: it tells the owner what keeps failing, and what a simpler approach
   would be. The owner decides.
10. **High only:** an independent adversarial review by an agent that did not build the change
    (the [audit brief](audits/BRIEF.md)), then the owner's explicit approval at promotion.

## 4. Risk tiers

The tier is set from the change's paths and content, never from who wrote it.
`scripts/risk-tier.mjs` reads the patterns from `scripts/risk-tiers.json` (and an app's
`scripts/risk-tiers.app.json`); REVIEW.md points to that file. Any High match makes the change
High; a change of only docs, copy or generated files is Low; anything else is Medium. One rule is
in the script, not the patterns: a change to `.github/`, `scripts/risk-tier*`, `REVIEW.md`,
`CLAUDE.md` or any `.gitattributes` is always High.

| Tier   | Set by                                                                                                                                                                          | Requires                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low    | Docs, copy (`messages/`), generated files                                                                                                                                       | The gates; one finder; the security review                                                                                                                                                          |
| Medium | Ordinary product code                                                                                                                                                           | The gates; hostile tests; two finders and a verifier; screenshots for a UI change; the security review                                                                                              |
| High   | Auth, tenancy and row-level security, migrations, jobs, CI workflows, the secrets and config contract, billing, the paid quota and consent, moderation (and an app's own areas) | The gates; hostile tests; three or more finders, two verifier votes, an independent adversarial review; the security review; the owner's explicit approval at promotion, after reading the evidence |

With one human owner, the tier sets the depth of the automated review, not a count of approvals.
**An agent's approval never counts as the owner's.** The AI engineer may raise a tier (and says
why in the PR); nothing lowers one.

### 4.1 The classifier

```zsh
node scripts/risk-tier.mjs --base origin/develop
git diff --name-only --no-renames origin/develop...HEAD | node scripts/risk-tier.mjs
```

With `--base`, the changed lines are read as well, so an ordinary file that starts using the
owner connection or drops a guard call is High. From stdin only paths count, and the output says
so. Renames are not followed: a file moved out of a High area keeps its old path in the list.
Names are read NUL-separated (`git diff --name-only -z`) and each file's lines with its own
`git diff -U0`, so a name with spaces or quotes is read as it is; a path in git's quoted form
(starting with `"`) is refused. Content patterns are case-sensitive unless an area sets
`"flags": "i"` (tenancy does: SQL is written in upper case here). `--patterns <dir>` reads the
pattern files from `<dir>`. Tests: `__tests__/risk-tier.test.ts`.

### 4.2 The `review-tier` job

`.github/workflows/review-tier.yml`, on every pull request to `develop`, `staging` and `main`:
runs the classifier on the PR's base and head — the base branch's copy of `scripts/risk-tier.mjs`
with the base's pattern files, checked out into a second path, so a PR that edits the script or
the patterns cannot lower its tier through them (a base without the classifier yet gives High) —
writes the tier and reasons to the job summary,
and sets one label, `risk:low`, `risk:medium` or `risk:high`, when the token allows it. The job
holds `contents: read` and `pull-requests: write` and nothing else; a fork's PR gets a read-only
token, so the label step writes a notice instead and the job still passes. It never fails on a
tier: it classifies. It times out after 10 minutes. When the classifier refuses the change (exit
2, such as a path in git's quoted form), the summary says "tier: High (unreadable path:
classification refused)" and the label is `risk:high`.

**What it does not guarantee.** Under `pull_request`, GitHub runs the PR's own copy of
`review-tier.yml` and `security-review.yml`. A PR that changes a workflow can change what runs, so
its tier and its security result are not trustworthy. Any PR touching `.github/` is High by
definition (the hard rule), and its tier comes from the owner running the base classifier
locally, from a clean checkout (use the PR's base branch in place of `develop`):

```zsh
PR=123
git fetch origin develop "+pull/$PR/head:pr-$PR"
git switch --detach origin/develop
node scripts/risk-tier.mjs --base origin/develop --head "pr-$PR"
git switch -
```

The structural fix is planned, not built (ASSURANCE §3): a `pull_request_target` job, which runs
the base's copy of the workflow, that reads the head only as data (`git diff` of fetched commits).
Its tradeoff: it runs with the repository's secrets and a write token, so it must never check
out, install or execute the head's code.

### 4.3 The security review

`.github/workflows/security-review.yml` runs Anthropic's open-source action
[`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review)
on every pull request to `develop`, `staging` and `main`, pinned to commit
`0c6a49f1fa56a1d472575da86a94dbc1edb78eda` (its `main` on 2026-02-11; the repository publishes no
release tags). Inputs: `claude-api-key` (the `ANTHROPIC_API_KEY` secret), `comment-pr: true`
(findings are posted on the PR), `upload-results: true`, `run-every-commit: true`.

- **It fails its check; blocking is planned.** The action itself never fails on findings; it reports a count
  (`findings-count`). The workflow's next step fails the check when that count is not zero, and
  also when the scan ran but left no readable result. A later commit that fixes the finding
  re-runs the scan (`run-every-commit`), and a clean run clears the check. To make the check
  stop a merge, it must be a required status check in branch protection — an owner setting,
  planned.
- **A false positive** is answered in the PR's "Review rounds" section with its reason. The
  action has no way to mark one finding resolved, so the check stays red: until it is a required
  check, a red check does not stop a merge; once it is required, the owner can merge past it as
  an administrator only if branch protection allows administrators to bypass.
- **A skip is never a pass where it matters.** Without the key the job writes a notice and a
  summary and passes — unless the repository variable `SECURITY_REVIEW_REQUIRED` is `true`, when
  it fails. The `ANTHROPIC_API_KEY` secret is set in Playform; it isn't set in
  platform-foundation (TASK-183), so every PR there is skipped with a notice. Once the key is set
  in a repository, set the variable there too: **Settings → Secrets and variables → Actions →
  Variables**, `SECURITY_REVIEW_REQUIRED` = `true`, or
  `gh variable set SECURITY_REVIEW_REQUIRED --body true --repo Datankare/platform-foundation` (or
  `Datankare/playform`).
- **Dependabot PRs do not receive repository secrets** (only Dependabot secrets), so they are
  skipped with that notice — and, when the review is required, they fail: a required check must
  not pass without a scan, so the owner re-runs it after adding the key as a Dependabot secret,
  or merges past it knowingly.
- **Forks get no key, and fail.** The workflow uses `pull_request`, never `pull_request_target`:
  GitHub gives a fork's PR no secrets and a read-only token. The scan runs only when the PR's head
  is a branch of this repository; a fork's PR is never scanned, so its check fails. The action's
  own README says it is not hardened against prompt injection and should review trusted PRs
  only; this is how that holds here.
- **What it installs.** The action installs Claude Code from npm and its Python requirements at
  run time, unpinned by its own workflow; pinning the action's commit does not pin those. It uses
  its built-in default model (`claude-opus-4-1-20250805` at the pinned commit). Recorded in
  ASSURANCE §3.

## 5. The evidence each change carries

The PR description, from `.github/pull_request_template.md`, carries:

- **Risk tier** and the classifier's reasons (and why, if the tier was raised);
- **Testing** — the commands run and their output (the summary lines), and screenshots for any
  change a person sees; in Playform, the `e2e-live/` step a user-facing feature adds;
- **Security** — what the change could expose, and the security review's result;
- **Performance** — the new queries and calls per request, and their bounds;
- **How to revert** — the exact steps, including a migration's;
- **Review rounds** — each round's findings and how each was answered (fixed, or resolved with a
  reason).

## 6. Incidents become the reviewer's eval set

[docs/review-evals/](review-evals/README.md) holds one case per real past miss: what the diff did,
the defect, where it was, how it was caught, and the finding a reviewer should have produced. Its
README has the scoring rubric. When CLAUDE.md, REVIEW.md, this protocol, or the reviewing model or
tools change, the reviewer is run over every case and scored; a change to the reviewer is kept
only when the score does not fall and the noise does not rise (the README's keep rule). Each
new incident, revert or late finding adds a case.
Status: the cases are written; **no scored run is recorded yet** — the first one is planned.

## 7. Metrics

Recorded per milestone, in the table below:

| Milestone | Owner steps | CI re-runs | Reverts | Incidents | Review rounds (median / max) |
| --------- | ----------- | ---------- | ------- | --------- | ---------------------------- |

- **Owner steps:** the commands and console steps the owner had to run.
- **CI re-runs:** runs repeated because a change was not ready.
- **Reverts** and **incidents** are the guardrail: if either rises, the process got cheaper only
  by moving the cost, and the depth goes back up.

No milestone has been recorded yet; the first is the one that carries TASK-183.

## 8. Declined, and why

- **Two-person approval for High changes.** There is one owner. The High tier asks for more
  automated depth and the owner's explicit approval instead.
- **Circuit breakers** that tighten approval when reverts or incidents rise. The article's own
  team does not have them yet. Here the metrics of §7 are read by the owner each milestone.
- **A merge queue.** It stops two separately passing PRs combining into a broken branch. With one
  author and promotions made in series, CI runs on each branch push (`ci.yml` on `develop`,
  `staging` and `main`) instead.

## 9. What prompted this

- **October 2026: server tests passed, real users could not finish.** Signing in to playform-dev
  found that the authenticator setup could not work — software-token MFA was off in the pool (a
  configuration miss) and the screen showed no QR code (TASK-180); an account without a date of
  birth got "Could not start a translation session." instead of a screen asking for it
  (Playform); and password reset showed "Password Reset" when the server had refused it
  (TASK-181). The server-side tests passed throughout. What changed: the refusal-coverage check
  (TASK-181), Playform's live journey check (its `docs/LIVE_JOURNEY_CHECK.md`, in the private Playform repository), and the rule
  that every user-facing feature adds its `e2e-live/` step.
- **A re-link ran three review rounds before its approach was questioned.** The identity re-link
  (TASK-174) went through reviews 15, 16 and 17; review 16 changed the approach (the subject
  became the Cognito `sub`, TASK-177) and review 17 found more (TASK-178). Only then did the owner
  ask whether a pre-launch platform needed that much machinery. Hence the round cap (§3 step 9)
  and the CLAUDE.md rule to ask whether something matters before building it.

## 10. How it ties to the rest

- [ASSURANCE](ASSURANCE.md) §1 lists the protocol under "every change" and the security review
  and `review-tier` under "every PR"; §3 records what is not done (circuit breakers, the key in
  platform-foundation, the action's unpinned installs); §6 lists the security review with the
  other GitHub checks.
- ASSURANCE §7 (planned) adds machine-checked specifications for the job queue, dual control,
  tenant isolation and sessions. Once one exists, a High change to that state machine keeps its
  specification passing.
- In Playform, the live journey check (`docs/LIVE_JOURNEY_CHECK.md` there, in the private Playform repository) is the evidence for a
  user-facing feature: real users through the real identity pool on each playform-dev deployment.

_Last updated: October 27, 2026 (TASK-183)_
