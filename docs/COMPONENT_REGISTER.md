# Component Register

Every third-party component and hosted service the platform depends on, assessed against the
Datankare component rule:

> Open source by default, under an OSI-approved licence (no BSL, SSPL or RSAL), with wide,
> verifiable adoption in mission-critical environments. A proprietary or source-available
> component is allowed only as a **deliberate, recorded choice** with a named exit path.

Each external dependency sits behind a provider interface with a conformance kit (ADR-027), which
is what makes the exit paths below real rather than aspirational.

_Last reviewed: 2026-10-22._

## Libraries and runtime

| Component                                  | Licence          | Verdict |
| ------------------------------------------ | ---------------- | ------- |
| Next.js, React, TypeScript, Tailwind CSS   | MIT              | Pass    |
| Jest, Playwright, fast-check               | MIT / Apache-2.0 | Pass    |
| jose, ajv, intl-messageformat, safe-regex2 | MIT              | Pass    |
| PostgreSQL, pgvector                       | PostgreSQL       | Pass    |
| node-postgres (`pg`)                       | MIT              | Pass    |
| Sentry JavaScript SDK                      | MIT              | Pass    |

## Hosted services

| Service           | Role                                        | Licence / model                                               | Status                               | Exit path                                                                  |
| ----------------- | ------------------------------------------- | ------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| Supabase (hosted) | Postgres (direct, pooled), Realtime         | Apache-2.0 software; hosted processor                         | Deliberate choice                    | Any Postgres 17 + pgvector (schema baseline and migrations are portable)   |
| Vercel            | Hosting                                     | Proprietary                                                   | Deliberate choice                    | Container image on a second host — planned, Sprint 7P (TASK-128)           |
| Upstash Redis     | Cache, rate limiting                        | Proprietary service (REST protocol)                           | Deliberate choice — **flagged**      | Valkey (BSD-3) over the standard Redis protocol — planned, Sprint 7P       |
| Sentry (hosted)   | Error monitoring                            | Server under the Functional Source License (source-available) | Deliberate choice — **flagged**      | Self-hosted alternative or the observability provider slot                 |
| AWS Cognito       | Identity                                    | Proprietary service                                           | Deliberate choice                    | Auth provider interface (ADR-012)                                          |
| Google Cloud      | Translation, text-to-speech, speech-to-text | Proprietary service                                           | Deliberate choice                    | Translation and voice provider interfaces                                  |
| Anthropic         | Language models                             | Proprietary service                                           | Deliberate choice                    | AI provider interface                                                      |
| ACRCloud          | Song identification                         | Proprietary service                                           | Deliberate choice (consumer feature) | Song-identification provider interface; moves out of the core in Sprint 7S |

## Tooling

| Tool                      | Licence                                     | Note                                                                                                                                                                                                                                             |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| gitleaks                  | MIT                                         | Secret scan in CI                                                                                                                                                                                                                                |
| Semgrep (community rules) | LGPL-2.1                                    | Static analysis in CI                                                                                                                                                                                                                            |
| CodeQL                    | GitHub terms (free for public repositories) | Static analysis in CI on platform-foundation. Not run on Playform: code scanning on a private repository needs paid GitHub Code Security (decided 2026-10, for cost); Playform relies on Semgrep and its synced platform code being scanned here |
| OWASP ZAP (baseline scan) | Apache-2.0                                  | Weekly passive scan of a deployed instance (`zap-scan.yml`)                                                                                                                                                                                      |
| OpenTofu (planned)        | MPL-2.0                                     | Infrastructure as code, Sprint 7P — chosen over Terraform (BSL)                                                                                                                                                                                  |

## Changing this register

Adding or replacing a component updates this file in the same commit. A new proprietary or
source-available dependency needs a recorded reason and an exit path before it is merged.
