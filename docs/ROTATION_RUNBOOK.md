# Credential Rotation Runbook

Procedures for rotating external service credentials. Each rotation is logged with date, project ID, and operator.

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
| Env var scope  | All environments (Production, Preview, Development)              |
| Vercel project | playform                                                         |

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

1. Update `ACRCLOUD_ACCESS_KEY` and `ACRCLOUD_ACCESS_SECRET` in Vercel dashboard (all environments)
2. Leave `ACRCLOUD_HOST` unchanged (same region)
3. Redeploy production — uncheck "Use existing Build Cache"
4. Smoke-test via Playform UI — play a song, verify match appears

**Cleanup:**

1. Deprovision old project in ACRCloud console
2. Delete any local credential artifacts (`rm /tmp/acrcloud-rotation/*`)
3. Update this runbook with new rotation history entry

### Gotchas (from TASK-026 rotation)

- **Audio clip duration:** ACRCloud needs ≥10s for reliable matching. 5s clips return `code: 1001`. See G-VOICE-001.
- **Markdown auto-formatting:** Pasting hostnames from rich-text sources can inject `[text](url)` link syntax. Verify env files before sourcing.
- **Never `cat` credential files in shared contexts:** Use `awk -F= '{print $1, "length:", length($2)}' creds.env`
- **Vercel build cache:** Must uncheck "Use existing Build Cache" during redeploy after env var change.
- **`ACRCLOUD_HOST` doesn't change** if staying in the same region. Don't update unnecessarily.
- **ACRCloud has no self-service secret rotation.** Must delete and recreate the project to get new credentials.

---

_Last updated: April 25, 2026 (TASK-026 rotation complete)_
