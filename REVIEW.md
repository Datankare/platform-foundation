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

A PR the security review cannot fetch — GitHub answers 406 for a diff too large to serve; an
app's auto-sync PRs are expected to hit it — fails that check and **has not been reviewed**. A
repository admin reviews the diff by hand and, if satisfied, merges with the ruleset's admin
bypass, which GitHub records. Nothing in the workflow stands in for that review: no label, no
acknowledgement (TASK-197; [AI_ENGINEERING](docs/AI_ENGINEERING.md) §4.3).

## Rules

1. **Evidence.** Every finding names a file and line and says what happens there. A guess from
   a name is not a finding.
2. **Tags.** Each finding is **Important** (a defect this change introduces or exposes that can
   hurt a user, a tenant or a gate), **Low** (a real defect this change introduces or exposes whose
   harm is small or needs an unlikely sequence), **Nit** (style, naming, wording — no defect) or
   **Pre-existing** (a defect the change did not introduce; it is filed, not blamed on the change).
3. **Every finding is listed — every Nit too,** grouped by file when there are many, so all of them
   are fixed in one round (the owner's rule: done means every finding fixed). No cap.
4. **Flag the class, not the instance.** When a defect can recur elsewhere, say where else to
   look; the fix covers every instance.
5. **No repeats.** A finding already answered (fixed, or resolved with a reason) is not raised
   again unless the answer is wrong — then say why.
6. **Bug fixes:** check the root cause is fixed, not the symptom.
7. **CLAUDE.md:** flag code that breaks a convention in it, and any line in it that is out of date.
8. **Skip generated paths:** `platform/modules/platform-paths.json`, `package-lock.json`, the
   baselines (`coverage-baseline.json`, `refusal-coverage-baseline.json`,
   `screen-literal-baseline.json`, `journey-exemptions.json`, `fake-fetch-baseline.json`,
   `body-schema-baseline.json`), the route fixtures (`__tests__/fixtures/route-responses.json`)
   and the generated error docs (`docs/API_ERRORS.md`, `docs/APP_API_ERRORS.md`). One exception:
   a baseline that loosens (a gap added, a floor lowered, an exemption added) weakens a gate and is
   a finding (process-check refuses one that rises; TASK-200). The baselines and
   `platform-paths.json` are not High tier (they change with routine work); the check's script and
   the workflows are.
9. **The summary opens with a count** — "2 Important, 1 Nit, 0 Pre-existing." — and when there
   is nothing to fix it says so plainly: "Nothing to fix."

## Blocking rules — the engineering process (TASK-200)

Each finding under these rules is **Important** and blocks the change. They are what TASK-194's 23
review rounds kept finding; what a machine can check, CI checks
([AI_ENGINEERING](docs/AI_ENGINEERING.md) §3a), and these are the rest.

10. **Every caller moves with its response.** A change to a response's status, code or shape lists
    every caller and screen in its TASKS entry's design check (_Screens × responses_) and updates
    each in the same change. A caller the list misses is a finding. (Codes and statuses are checked
    by `refusal-coverage` and `route-status-registry`; a body's shape is not.)
11. **The design check is true.** Read its answers against the code: who can reach the path (each
    role, the operator, an agent, a guest), what a race does, what each dependency down does, what
    an erasure leaves behind, what each screen shows for each response, which journeys change. A
    wrong or hand-waved answer is a finding.
12. **No existing tenant is weakened.** A change that could lower an existing tenant's protection
    — applying a value that had been ignored, widening a default, dropping a check a tenant relied
    on — says so in the design check and carries a test of that tenant's case.
13. **Hostile tests can fail.** Each `[hostile:…]` test fails without the code it guards; a
    `hostile:<tag> n/a:` waiver's reason is true.
14. **Tested against real responses.** A fix is tested against what the real route answers (a route
    fixture or the route itself), never a body written for the test.
15. **Guards can fail.** A new or changed scan's `[self-test]` plants the violation the scan is for
    and asserts that it is reported.
16. **Inputs are the schema's.** A handler reads only fields its schema declares; a route reads its
    body with `readJsonBody(request, SCHEMA)`.
17. **The self-review was done.** The Self-review block names the consumers actually checked and
    what the hostile re-read found.

## Blocking rules — how a gate is reviewed (TASK-200)

A change to a gate or a security boundary (a High-tier path) is reviewed this way; each breach is
**Important** ([AI_ENGINEERING](docs/AI_ENGINEERING.md) §3a).

18. **A threat model before code.** The entry's **Threat model** — boundary, bypasses, forgeries,
    legitimate flows — was agreed with the owner before the first commit (process-check refuses an
    entry without it; whether it came first is the reviewer's to check). It names actors that really
    exist for this repository — the owner (the only person who can push), the agents working for
    him, the running system's users and tenants. A finding that depends on an actor who does not
    exist (a pull request author without owner rights, while there is none) is out of scope, not a
    residual.
19. **Three lenses a round.** Each review round runs three reviewers in parallel: security bypass,
    legitimate flows, and test validity with mutation — and, for a change to a screen, a fourth:
    usability (rule 25).
20. **A coverage table from each reviewer:** each changed file or rule, the attacks or flows tried,
    the result. A round without the three tables has not happened.
21. **Fix the class.** Each finding is fixed across its whole class, and the fix says how the class
    was searched.
22. **The fixer attacks its own fix** and writes the attempts in the Self-review.
23. **Mutation testing runs on gate and security code** (`stryker.config.mjs`, by hand —
    `npm run test:mutation` — whenever `scripts/process-check.mjs` changes): the score stays at 90%
    or more; an equivalent mutant is marked with its reason, or (when its line also
    holds a mutant a test kills) left to survive and listed in the Self-review.
24. **The stop rule.** A round with no Important and no Low finding (rule 2) ends the review; each
    Nit of that last round is still fixed, and verified by a test, not by another round.

## Blocking rule — the usability lens (TASK-202)

The owner's first walk through the admin console (2026-11-07) found a config screen that could only
search, approvals decided blind (a tool's name and a requester's id), results that vanished after
seconds, people named by raw ids and tables wider than the window. Every test passed: no reviewer
had asked whether a person could do the job on screen. Each breach is **Important**.

25. **The usability lens.** A change to a screen (`app/**/page.tsx`, `components/`, `messages/`)
    is reviewed by a reviewer who asks, for each task the screen exists for, and says so in a
    coverage table (rule 20):
    - **Can a person complete it on screen** — without code, SQL, the browser console or a typed
      command the screen does not explain? Every action the screen offers has its form; every
      refusal says what to do next.
    - **Do they see what they are deciding?** An approval, a confirm or an edit shows what changes:
      the setting and its value now and after, the account and the role from → to, the
      permissions granted — repeated at the confirm step.
    - **Is every person named by address?** Never a raw id, except as a secondary detail.
    - **Do results persist?** Applied, held for approval (by whom), or refused (why) — named by
      what changed, never by a tool's id, and kept until dismissed.
    - **Does it fit?** At 1280 px and at 390 px the page does not scroll sideways; a wide table
      scrolls in its own panel; a cut value can be shown whole.

    The change's author walks each changed admin flow in a browser against a production build
    (`npm run build && npm run start` on a seeded database) before calling it done, and keeps the
    screenshots with the change's record (CLAUDE.md, "Before handing a change to the owner").

## Blocking rule — the owner's Mac (TASK-213)

On 2026-11-10 a commit script failed on the owner's Mac: a shell script used `case` inside `$( )`,
which macOS's bash 3.2 cannot parse, and every gate had run on Linux. Each breach is **Important**.

26. **Shell runs on bash 3.2 and BSD tools.** A change that adds or edits a shell script, a workflow
    step a test executes, or a test that starts `bash` or `sh` is read for what bash 3.2 or BSD
    lacks (`__tests__/shell-portability.test.ts` refuses the known list; a construct it does not
    know is still a finding). A test that runs a workflow step with `bash -c` lists it in that
    file's `EXECUTED_STEPS`; a shell string run any other way (`execSync`, `shell: true`) is a
    finding. The macOS job (`.github/workflows/macos.yml`) must stay green: `npm test` with no
    database and no `CI`, under /bin/bash 3.2, as the owner runs it.
