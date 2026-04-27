# platform/voice — Module Gotchas

> Per L17: Module-specific bugs go here. Global patterns go to ENGINEERING_LEARNINGS.md.

---

## G-VOICE-001: ACRCloud `code: 1001 No Result` is usually audio quality, not credentials

**Date:** 2026-04-25 (TASK-026 rotation)

**What broke:** During ACRCloud credential rotation, repeated `code: 1001 No Result` responses despite valid credentials. Diagnosis took multiple attempts before identifying the real cause.

**Root cause:** ACRCloud requires 10–15 seconds of clean audio for reliable fingerprint matching. The smoke test used 5-second mic recordings. ACRCloud's SDK defaults to 10 seconds; their docs recommend 10–20 seconds.

**The fix:** Use ≥10s audio clips for identification. A 12-second clip starting 30s into a known ABBA track matched immediately with score 58.

**Standing rule:** When debugging song-ID failures, confirm clip duration (≥10s) before suspecting credentials, project setup, or catalog coverage.

**See also:** TASK-038 (verify `useAudioRecorder` records ≥10s before identify call).

---

## G-VOICE-002: ffmpeg not installed on local dev Macs by default

**Date:** 2026-04-25 (TASK-026 rotation)

**What broke:** Local audio smoke testing blocked — `ffmpeg` not installed despite `ffmpeg.datankare.com` (ECS Fargate) being the production audio conversion service.

**The fix:** `brew install ffmpeg` — installs in ~2 min on Apple Silicon. Not a production dependency, but needed for local audio debugging, test fixture creation, and credential rotation smoke tests.

**Standing rule:** Any developer working on `platform/voice/` should have ffmpeg locally. Add to onboarding docs when they exist.

---

_Last updated: April 25, 2026 (TASK-026 rotation)_
