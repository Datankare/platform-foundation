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

The engineering process of §3a (TASK-200) adapts these, each named where it is used there:

- the design check asks, before the code, what would make the change fail — the **premortem** of
  **Gary Klein**, _Performing a Project Premortem_ (Harvard Business Review, September 2007) — in
  the form of a checklist with required answers, after **Atul Gawande**, _The Checklist
  Manifesto_ (Metropolitan Books, 2009);
- the consumer sweep and the screen tests' fixtures made by the real route handlers follow
  **Ian Robinson**, _Consumer-Driven Contracts: A Service Evolution Pattern_ (martinfowler.com,
  2006): a provider's change is checked against what its consumers rely on;
- schema-first inputs follow **Alexis King**, _Parse, don't validate_ (2019,
  <https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/>): the boundary turns the
  input into a declared shape before anything reads it;
- every guard proves it can fail is the rule of a test seen failing before it is trusted, from
  **Kent Beck**, _Test-Driven Development: By Example_ (Addison-Wesley, 2002).

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

## 3a. The engineering process: enforced, not optional (TASK-200)

**Why.** The access-control batch (TASK-194) took 23 independent review rounds. Its findings came
back to six causes: a fix tested only against a mock response the real route never returns; a
changed status, code or shape whose callers and screens were not all updated; a guard test that
could never fail; questions not asked before the code — who can reach the path, what a race does,
what happens when a dependency is down, what an erasure leaves behind, what each screen shows for
each response; a change that could weaken an existing tenant's protection (applying a value that
had been ignored); a handler reading an input its schema does not declare. Each became a rule.
None is optional or best effort: **what a machine can check fails the build; the rest is a
blocking rule in REVIEW.md** (rules 10–17, and 18–24 for how a change is reviewed).

| Rule                         | What it requires                                                                                                                                                                                                              | Enforced by (fails on a planted violation)                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Design check              | The task's TASKS entry carries a **Design check**: reach (roles, operator, agents, guests), races, each dependency down, erasure leftovers, every screen × every response, journeys touched, "weakens a tenant's protection?" | `scripts/process-check.mjs` (CI **Layer 0f**, both repositories): a code commit or merge naming no task; an entry without the block, a field missing or unanswered; an entry the change does not touch — `__tests__/process-check.test.ts`. REVIEW.md 11–12 |
| 2. Consumer sweep            | A changed status, code or shape updates every caller and screen                                                                                                                                                               | Codes: `refusal-coverage` (every code a route returns is handled by every screen that calls it). Statuses: `route-status-registry` (a hand-built error status is the registry's). Shape: REVIEW.md 10, the design check's _Screens × responses_             |
| 3. No fake-only screen tests | A screen test answers fetch with a route's own reply                                                                                                                                                                          | `route-fixtures` makes `__tests__/fixtures/route-responses.json` by calling the route handlers and fails on drift; `fake-fetch-bodies` counts hand-written bodies against `fake-fetch-baseline.json` (R-81; never raised: process-check). REVIEW.md 14      |
| 4. Every guard can fail      | A scan is tagged `@guard <class>` and has a `[self-test]` that plants a violation and asserts it is reported                                                                                                                  | `guard-self-tests`: an untagged scan, a guard with no running `[self-test]` that calls the scan with an input. REVIEW.md 15                                                                                                                                 |
| 5. Schema first              | A route reads its JSON body with `readJsonBody(request, SCHEMA)`, unknown keys refused before any field is read                                                                                                               | `api-route-body-schema` against `body-schema-baseline.json` (R-82; never raised: process-check); an open schema node without `openBecause` read closed; S1's `input-keys-guard` for the command bar and config tools. REVIEW.md 16                          |
| 6. Hostile tests by default  | A route test file added or changed names `[hostile:role]`, `[hostile:self]`, `[hostile:store-down]` and `[hostile:id-spelling]` cases, or waives one with a reason                                                            | `scripts/process-check.mjs`, on the files the change touches (old files are not all failed at once). REVIEW.md 13                                                                                                                                           |
| 7. Self-review recorded      | The entry's **Self-review** lists the consumers checked and the hostile re-read                                                                                                                                               | `scripts/process-check.mjs`. REVIEW.md 17                                                                                                                                                                                                                   |

**The blocks.** In the task's entry, each a bold line and a list, every field four words or more
that is no placeholder: it does not start with a marker (`TBD`, `TODO`, `FIXME`, `XXX`, `n/a`, an
ellipsis, "to be decided") and holds no unfilled template slot (`<describe …>`, `<reason>`) — read
with its code spans taken out, so prose may name a marker or quote a waiver's syntax. A task whose change touches a high-tier path — a gate or
a security boundary: the `high` paths of `scripts/risk-tiers.json` at the merge base, and always
`.github/`, the risk tiers, this check's own files, `REVIEW.md`, `CLAUDE.md`, `.gitattributes` —
also carries a **Threat model** (REVIEW.md 18), written and agreed before the code:

```markdown
**Design check**

- **Reach:** …
- **Races:** …
- **Dependencies down:** …
- **Erasure leftovers:** …
- **Screens × responses:** …
- **Journeys touched:** …
- **Weakens a tenant's protection?** …

**Self-review**

- **Consumers checked:** …
- **Hostile re-read:** …

**Threat model**

- **Boundary:** …
- **Bypasses:** …
- **Forgeries:** …
- **Legitimate flows:** …
- **Agreed before code:** …
```

**What it is for.** The check catches **our own mistakes** — a commit without its task, an entry
without its blocks, a baseline raised, a route test without its hostile cases — not an attacker.
These repositories have one person who can push (the owner); outsiders are kept out by GitHub: 2FA,
branch rulesets (no force-push or deletion of `main`, `staging`, `develop`; `v*` tags admin-only)
and the owner merging every pull request. Protections against a pull request author without owner
rights were built and then removed (TASK-200, "Deliberately not built"): that actor does not exist
here, and each such protection's trigger to build it again is a second contributor with push or
pull-request rights.

**How CI knows the task.** The commit subject names it in the task group it ends with —
`(TASK-nnn)`, `(TASK-1, TASK-2)`, Playform's `(platform TASK-nnn)`, a squash merge's ` (#n)` after it
allowed; a `TASK-nnn` anywhere else in the subject is a mention and names nothing (a revert,
`Revert "<subject>"`, names its reverted subject's group). The entry is in `docs/TASKS.md` or in a
register the app names in `scripts/process-check.app.json` (`taskRegisters`: Playform's
`docs/PLAYFORM_TASKS.md`, sync-excluded with its config, so a sync that overwrites `TASKS.md` with
platform-foundation's never removes an app's entry; a register is a markdown file that is neither
code nor one of the process's own files). A commit touching the process's own files — the script and
its app settings, the risk tiers, `.github/CODEOWNERS` and the workflows (an ordinary change that
names its task, none special) — names its task as a code commit does. A commit pushed without its
task (develop takes no force-push, so its subject cannot change) is adopted by its task's entry with
a line `**Commits:** <sha, seven hex or more>` (a whole hex word, at the start of the commit's sha);
the finding says so. An app's `(platform TASK-nnn)` names platform-foundation's task: its entry,
synced into `docs/TASKS.md`, must be complete, and the app's work is recorded in an entry of the
app's own register that references `platform TASK-nnn` and that the change touches — that entry, the
app's own, carries the **Threat model** when the change touches a high-tier path — so the sync comes
first, then the app's commit. Not judged: a sync commit, by its subject alone
(`chore(sync): inherit platform-foundation <ref> @ <40-hex sha>`, a squash's ` (#n)` allowed — the
platform's commits were judged where they were made), and a commit authored by `dependabot[bot]`
and committed by it or GitHub (it cannot name a task; one a person amended is judged); a route test
file in either is still held to its hostile cases. Never amend an app's own change into a sync
commit: its subject alone exempts it. A revert of a revert (`Reapply "…"`, git 2.43+) is a revert. The check
reads every commit from the merge base of the base and the head — a pull request's base branch and
its own head (never the synthetic merge CI checks out), a push's `before` — to the head; after a
force-push, since the merge base with `origin/staging`, and it says so. A commit is judged unless it
was made before the rule: an ancestor of the first commit that brought `scripts/process-check.mjs`
into the head's history. A merge is judged by what it changes itself: what differs from git's own
re-merge of its parents (`git show --remerge-diff`). A clean merge changes nothing, even of a file
both parents edited; an evil merge or a conflict's resolution touching code needs a task in its
subject. An octopus merge is judged by the paths whose result differs from every parent; a git older
than 2.36 refuses a two-parent merge rather than guess. A true revert (`Revert "…"`, "This reverts
commit <sha>.") is the exact inverse of one commit already on the base, or of one earlier in the same
range (judged there: the pair is a net no-op): it changes exactly the files that commit changed (a
merged pull request: against its first parent, as GitHub's Revert button does), each still as that
commit left it and each back to what it was before it. It needs no task, and passes when it touches
the entry, removes it, or leaves it exactly as it was before the reverted commit. A partial revert, a
revert over a later edit, or one of a commit outside the base and the range is judged as any commit,
and its finding says what passes. The task registers are left out of the file-for-file test (nearly
every commit edits one); the entry is judged on its own. Run it locally:
`node scripts/process-check.mjs --base origin/develop`.

**The baselines never loosen.** The same check compares each ratchet baseline at the head with the
later of the merge base and the rule's first commit (a baseline raised before the rule existed is its
starting point — a first promotion carries such commits): `body-schema-baseline.json` and `fake-fetch-baseline.json` (no count above the base's,
per file or in total), `open-input-register.json` (no open input node added, the count not
above), `refusal-coverage-baseline.json` (no gap added, the count not above),
`screen-literal-baseline.json` (the count not above) and `coverage-baseline.json` (each floor there
and none below the base's; the margin not above). A file git sees renamed keeps its key's count under
its new name (a gap its caller or route under the new one), never more. A key re-keyed by hand (a file
split, or renamed below git's similarity threshold) passes only with evidence and when nothing rises:
a new key in a counts baseline or the register only when a key of the base went with its file
(deleted, or renamed by git, in the change), the total does not rise and no existing key rises; a new
gap only when it takes the route and code of a removed gap whose caller went, and the gaps are no more
than before. `journey-exemptions.json` is compared by its own test
(`JOURNEY_BASE`). A file the base does not have yet is not compared (the change that introduces it).
So a scan widened to find more of what it counts fixes what it found in the same change: its
baseline cannot rise to make room. The script and the workflows are High tier; the baselines are not
(they change with routine work, and rule 4 already holds their direction).
`workflow-hygiene` checks that CI still runs the step (a deep checkout, then
`node scripts/process-check.mjs --base …` with no `continue-on-error` or `if:`): a guard against our
own slip, not against a change written to defeat it.

**The hostile tags.** The title of a running `it(…)`, `test(…)` or `describe(…)` carries
`[hostile:role]` (a role that must be refused), `[hostile:self]` (the actor aiming at itself),
`[hostile:store-down]` (a store or dependency failing) and `[hostile:id-spelling]` (an id in another
case, padded, or malformed) — a tag in a comment, a skipped or `.todo` test does not count; a
template title counts by its static text. A case that cannot apply is waived on a line of a real
comment (not text in a string or template): `hostile:<tag> n/a: <why, four words or more>`, the
reason on that line. A route test file is one that imports an `app/api/…/route` module (a quoted or
a template-literal specifier), or imports a test helper (`__tests__/helpers/…`) that does.

**Schema first, with no open door.** `readJsonBody(request, SCHEMA)` never reads the body itself as
open: a top-level `{}` takes no key, marked or not. Below the top, an open node — no type,
properties, items or enum — takes any keys only when it says why, `openBecause: "<four words or
more>"`, and every such node is listed with its reason in `open-input-register.json`
(`open-input-register` guard; the register never grows against the base). Unmarked, it is read
closed. The body-schema scan sees a read under any name: an import alias,
`errors.readJsonObject(…)`, `.json()` on any request-typed parameter or a name bound to one,
`request.clone().json()`, `new Response(request.body).json()`, `JSON.parse(await request.text())`.

**What no machine checks, and why.** Whether a design-check or threat-model answer is true (and
whether the threat model came before the code), and whether a route's `[hostile:…]` test fails
without the code it guards (mutation testing runs on the gate's own code, below, not on every
route); whether every caller handles a changed body _shape_ (TypeScript catches a typed caller, not
a screen reading `res.json()` as `unknown`); whether a change weakens an existing tenant (a judgement
on intent). These are REVIEW.md rules 10–17, each an Important finding.

**How a change to a gate is reviewed (REVIEW.md 18–24, blocking).** TASK-200 itself took five
review rounds; these are what those rounds kept teaching.

1. **A threat model before code** for any gate or security boundary — its boundary, the bypasses
   and forgeries it must refuse, the legitimate flows it must pass — agreed with the owner before
   the first commit. Mechanised in part: process-check refuses a task touching a high-tier path
   whose entry has no complete **Threat model** block; that it came first is the reviewer's to
   check. A threat model names actors that really exist for these repositories: today the owner
   (the only person who can push), the agents working for him, and the users and tenants of the
   running system. A finding that depends on an actor who does not exist — a pull request author
   without owner rights, while there is none — is out of scope, not a residual. (The practice is
   described at length in Adam Shostack, _Threat Modeling: Designing for Security_, Wiley, 2014.)
2. **Three lenses each round**, run in parallel by separate reviewers: security bypass, legitimate
   flows, and test validity with mutation.
3. **A coverage table from each reviewer:** what it covered — each changed file or rule, the attacks
   or flows tried, the result — so a gap in the review is visible.
4. **Fix the class.** A finding is fixed across its whole class, every sibling form, and the fix says
   how the class was searched.
5. **Attack your own fix.** The fixer tries to get past each fix before handing it back and writes the
   attempts down, in the entry's Self-review.
6. **Mutation testing on gate and security code — a manual check.** `scripts/process-check.mjs` is
   mutated by StrykerJS (`stryker.config.mjs`, `@stryker-mutator/core` pinned exactly): run it by
   hand (`npm run test:mutation`) whenever `process-check.mjs` changes; the score must be 90% or
   more. An equivalent mutant is marked in the script with its reason (or, when its line also holds
   a mutant a test kills, left to survive and listed in the Self-review). The runner is a fast
   built-ins-only suite (`__tests__/process-check.mutation.mjs`) that drives the script in-process
   over cached git fixtures, stopping at its first failing case: the jest suite spawns the script
   per case and is too slow per mutant. (Mutation testing goes back to DeMillo, Lipton and Sayward,
   "Hints on Test Data Selection: Help for the Practicing Programmer", IEEE Computer, 1978.)
7. **The stop rule.** A round with no Important and no Low finding (REVIEW.md rule 2 defines both)
   ends the review; each Nit of that last round is still fixed, and verified by a test, not by
   another round.

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

`.github/workflows/security-review.yml` runs our own security review,
`scripts/security-review.mjs` (TASK-204, N-86), on every pull request to `develop`, `staging` and
`main`. Until 2026-11-08 it ran Anthropic's open-source action
[`anthropics/claude-code-security-review`](https://github.com/anthropics/claude-code-security-review)
(pinned to `0c6a49f`, its `main` of 2026-02-11, no release tags); that commit hard-coded a retired
model for its API check (`claudecode/claude_api_client.py:62`) that no input could change, and no
newer release existed, so it was replaced before its exception's review-by date (2026-12-31).
What the action did is kept: a model reviews the PR's diff for security issues, the findings are
posted on the PR, and the check fails while any is open.

- **Credit.** The review prompt and the second, false-positive pass are adapted from that action:
  Anthropic, **"Claude Code Security Reviewer"** (`claudecode/prompts.py` and
  `claudecode/findings_filter.py`, MIT licence), github.com/anthropics/claude-code-security-review.
- **How it works.** The diff is git's own (`base...head`, from a checkout with the full history),
  reviewed in parts of at most 120,000 characters (a file split at its hunks). The model is
  `MODEL_REGISTRY.standard`, read from `platform/ai/types.ts` with its own settings — no workflow
  names a model, and the weekly model check covers it. A finding is kept only when it names a
  changed file, is at confidence ≥ 0.8, and a second call confirms it. One comment per PR,
  updated on each push. Exit 0 (no findings), 1 (findings), 2 (no review: the API failed, an
  answer was unreadable or cut off, or the diff was past the bound) — 2 is a failure, never a pass.
  It installs nothing: Node's own `fetch`, no package at run time (the action installed Claude
  Code and Python requirements unpinned).
- **It fails its check; blocking is planned.** The script's exit is the check: it fails when a
  finding is open, and when no review could be made. Every push is reviewed again
  (`synchronize`), and a clean review clears the check. To make the check stop a merge, it must be
  a required status check in branch protection — an owner setting, planned.
- **A false positive** is answered in the PR's "Review rounds" section with its reason. There is
  no way to mark one finding resolved, so the check stays red: until it is a required
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
  GitHub gives a fork's PR no secrets and a read-only token. The review runs only when the PR's
  head is a branch of this repository; a fork's PR is never reviewed, so its check fails. The diff
  is untrusted input to a model (prompt injection: the action's README said the same of itself),
  so only trusted branches are reviewed; the prompt marks the diff as data, and the reply is read
  only as bounded JSON whose text is escaped before it is posted.
- **Its model.** The registry's standard tier (`claude-sonnet-5-5` today), read by the script; the
  model check (`scripts/check-model-ids.mjs`) fails any model a workflow names that is not a
  registry model, and carries no action exception any more (TASK-204: an exception for an action
  no workflow uses fails the run). On 2026-10-28 the action had sent Playform's
  `ANTHROPIC_API_KEY` — the playform-dev app key — to its retired model (Anthropic's notice).
- **A pull request too large to review (TASK-197, TASK-204).** The diff is read locally, so the
  action's 406 is gone; a diff past the script's bound (24 parts of 120,000 characters) is not
  reviewed in part. The check fails with: "the diff is too large to review within the bound … A
  repository admin must review the diff manually and, if satisfied, merge using the ruleset's
  admin bypass (GitHub records the bypass)." That is the whole procedure: the admin reads the
  diff (locally, `git diff base...head`, when the web view refuses it too), and merges past the failing check with the ruleset's bypass; GitHub's
  audit log and the PR's timeline record who bypassed. There is no label, acknowledgement or
  re-run that turns the check green — an in-workflow acknowledgement was built and removed after
  three review rounds (the owner's decision, TASK-197 round 3): each version could be forged or
  replayed.
- **CI keys (owner action, TASK-197).** Give each repository a CI-only Anthropic key (its own
  workspace or key, with its own spend limit) for its `ANTHROPIC_API_KEY` secret — never an app's
  deployment key — so a CI tool's calls are neither billed to nor reported against an app.

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
Status: the cases are written and the scorer is built (`scripts/review-eval.mjs`, the **Reviewer
eval** workflow, TASK-204); **no scored run is recorded yet** — the first needs the
`ANTHROPIC_API_KEY` secret and is an owner step (TASK-183, Open).

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

_Last updated: November 1, 2026 (TASK-200 — the engineering process, §3a)_

_Previously updated: October 27, 2026 (TASK-183)_
