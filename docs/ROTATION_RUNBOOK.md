# Credential Rotation Runbook

Procedures for rotating external service credentials. Each rotation is logged with date, project ID, and operator.

---

## GitHub — Playform sync token

### Current State

| Item          | Value                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Token         | Fine-grained personal access token `playform-foundation-sync`, owner Datankare                                           |
| Stored as     | Playform Actions secret `FOUNDATION_SYNC_TOKEN`                                                                          |
| Used for      | Opening the `auto-sync/foundation-*` pull request in Playform (reading platform-foundation needs no token: it is public) |
| Access        | Datankare/playform only — Contents and Pull requests: read and write                                                     |
| **Expires**   | **2027-01-18**                                                                                                           |
| **Rotate by** | **2027-01-04** (two weeks before expiry)                                                                                 |

### Rotation History

| Date       | Event                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 2026-10-09 | Stored value was stale; sync had failed for 12 days (TASK-121). Fresh value tested and stored. |
| 2026-10-20 | Old token deleted while trimming its access; replaced with a Playform-only token.              |
| 2026-10-20 | Regenerated the same day after its value appeared in a screenshot. Expiry 2027-01-18.          |

### Rotation Procedure

1. GitHub → Settings → Developer settings → Fine-grained tokens → `playform-foundation-sync` →
   **Regenerate token** (90 days). Copy it; never screenshot the page that shows it.
2. Store it without displaying it — the value is tested before it is stored:

   ```zsh
   read -rs "T?Paste token (hidden): "; echo; code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $T" https://api.github.com/repos/Datankare/playform); echo "token check: $code"; [ "$code" = 200 ] && printf %s "$T" | gh secret set FOUNDATION_SYNC_TOKEN --repo Datankare/playform && echo "secret stored"; unset T; pbcopy < /dev/null
   ```

3. Run the sync (`gh workflow run sync-from-foundation.yml --ref develop` in Playform) and confirm it
   succeeds.
4. Update **Expires**, **Rotate by** and the history above.

If the token lapses, the sync fails and opens a "Sync from platform-foundation is failing" issue in
Playform (verified 2026-10-20, issue #573).

---

## ACRCloud — Song Identification

### Current State

| Field          | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Project name   | `playform-prod-songid`                                           |
| Region         | `us-west-2`                                                      |
| Host           | `identify-us-west-2.acrcloud.com`                                |
| Audio Engine   | Audio Fingerprinting                                             |
| 3rd Party IDs  | Spotify, YouTube                                                 |
| Buckets        | ACRCloud Music                                                   |
| Include Works  | No                                                               |
| Env vars       | `ACRCLOUD_HOST`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET` |
| Env var scope  | Production only (TASK-044: each environment its own project)     |
| Vercel project | playform                                                         |

Each environment has its own project (TASK-044, done in TASK-203): production
`playform-prod-songid` (above); staging `playform-staging-songid` in the `playform-staging` Vercel
project, created by the owner (SECURITY_DEBT TASK-044's steps), with its own row in Playform's
credential register; dev runs `SONG_ID_PROVIDER=mock` — no credential, no paid call. Rotate each
project on its own, in its own Vercel project.

### Rotation History

| Date       | Project Name         | Project ID            | Action                               | Operator  |
| ---------- | -------------------- | --------------------- | ------------------------------------ | --------- |
| 2026-04-25 | playform-prod-songid | (see private runbook) | New paid project, rotated from trial | Raman Sud |
| 2026-03-?? | (trial)              | 99216                 | Initial trial setup                  | Raman Sud |
| 2026-04-25 | (trial)              | 99216                 | DEPROVISIONED                        | Raman Sud |

### Rotation Procedure

**Pre-flight (read-only, no production impact):**

1. Verify env var names: `grep -rn "ACRCLOUD" platform/ app/ --include="*.ts"`
2. Confirm secrets not in `platform_config`: `grep -in "acrcloud" supabase/migrations/*.sql`
3. Verify provider reads creds at constructor (not per-request): check `acrcloud-identify.ts`

**Provision new project:**

1. ACRCloud console → Create Project
2. Name: `playform-prod-songid` (or `playform-{env}-songid` for per-env projects)
3. Settings: Recorded Audio, Audio Fingerprinting, ACRCloud Music bucket, Spotify + YouTube
4. Capture new `host`, `access_key`, `access_secret` in private runbook (NEVER in chat, repo, or shared docs)
5. ACRCloud does not support self-service secret rotation — to rotate, delete and recreate the project

**Local smoke test:**

1. Record or copy a ≥10s audio clip of a mainstream song (see G-VOICE-001)
2. Create temp creds file outside any git repo (`/tmp/...`)
3. HMAC-SHA1 signed POST to `/v1/identify` with new creds
4. Expect `status.code: 0` with song metadata
5. Delete temp creds file immediately after
6. Never `cat` credential files in chat, screen-share, or recorded sessions — use length-only verification

**Vercel cutover:**

1. Update `ACRCLOUD_ACCESS_KEY` and `ACRCLOUD_ACCESS_SECRET` in the Vercel project of that project's environment only (production: `playform`; staging: `playform-staging`)
2. Leave `ACRCLOUD_HOST` unchanged (same region)
3. Redeploy that environment — uncheck "Use existing Build Cache"
4. Smoke-test via Playform UI — play a song, verify match appears

**Cleanup:**

1. Deprovision old project in ACRCloud console
2. Delete any local credential artifacts (`rm /tmp/acrcloud-rotation/*`)
3. Update this runbook with new rotation history entry

### Credit (TASK-212, N-77)

The account is prepaid, and the credit — not a key — is what runs out. ACRCloud offers no API that
reports the balance (its console API has projects, buckets and a daily statistic; its
identification answers carry no quota header — docs.acrcloud.com, "Identification API",
"Console API → Base Projects", "Error Codes"), so the platform counts what ACRCloud bills — "Valid
Requests = Requests with results + Requests with no results / 2" (docs.acrcloud.com, FAQ
"Definition of Terms") — in `provider_usage` (migration 069), from the first request after 069.

1. **Set the budget.** In the ACRCloud console → Billing, read the credit left and the price per
   1,000 requests of the plan; divide, keep about a fifth back for the time a top-up takes, and
   set the result as `ACRCLOUD_CREDIT_ALERT_AT` in each Vercel project that runs
   `SONG_ID_PROVIDER=acrcloud` (a whole number of valid requests). Redeploy.
2. **At the budget** the alert `credentials.acrcloud_credit_low` is raised once (log, metric, error
   report), and `/api/health` lists `song-id-credit` as degraded until the budget is raised.
3. **After a top-up**, raise `ACRCLOUD_CREDIT_ALERT_AT` by the valid requests the new credit buys
   and redeploy. The count is never reset or edited by hand. Read it (the SQL Editor, read-only):

   ```sql
   select billable_halves / 2.0 as valid_requests, since from public.provider_usage where provider = 'acrcloud';
   ```

### Gotchas (from TASK-026 rotation)

- **Audio clip duration:** ACRCloud needs ≥10s for reliable matching. 5s clips return `code: 1001`. See G-VOICE-001.
- **Markdown auto-formatting:** Pasting hostnames from rich-text sources can inject `[text](url)` link syntax. Verify env files before sourcing.
- **Never `cat` credential files in shared contexts:** Use `awk -F= '{print $1, "length:", length($2)}' creds.env`
- **Vercel build cache:** Must uncheck "Use existing Build Cache" during redeploy after env var change.
- **`ACRCLOUD_HOST` doesn't change** if staying in the same region. Don't update unnecessarily.
- **ACRCloud has no self-service secret rotation.** Must delete and recreate the project to get new credentials.

---

_Last updated: October 20, 2026 (Playform sync token replaced; TASK-121)_
