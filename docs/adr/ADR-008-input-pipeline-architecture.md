# ADR-008 — Input Pipeline Architecture

**Status:** Accepted
**Date:** 2026-03-23
**Origin:** Adapted from Playform ADR-008 — established during Phase 0.5

## Context

The reference implementation extends a single text input to a multi-mode
input pipeline. Architectural decisions were required about where processing
happens (client vs. server), which APIs to use, and how to handle browser
compatibility constraints. These decisions apply to any project built on
Platform Foundation that includes voice or file input.

## Decisions

### 1. Browser Voice Input — Web Speech API

The reference implementation uses the browser's Web Speech API for
real-time voice transcription.

**Rationale:** True streaming transcription requires persistent connections
incompatible with Vercel serverless functions (60s timeout, no persistent
connections). The Web Speech API provides word-by-word transcription
natively in the browser with zero server cost.

**Trade-offs:** Firefox not supported. Quality depends on browser engine.
No server-side logging of transcripts.

**Rejected alternative — Chunked Google STT:** MediaRecorder timeslicing
produces chunks that are not valid standalone audio files — only the first
chunk contains the WEBM container header. Chunks after the first cannot be
decoded by Google STT.

### 2. Server-Side STT — Google STT Batch API

For recorded audio (Identify mode, Upload mode), use Google STT REST batch
API (`speech.googleapis.com/v1/speech:recognize`).

**Auto-detection:** Primary language `en-US` with `alternativeLanguageCodes`
pool. `mul` is not supported by the `latest_long` model.

### 3. File Upload — Vercel-Native Multipart

Upload accepts audio, PDF, TXT, and MD files via multipart POST.
Files are processed in-memory, no persistence.

**PDF extraction:** `pdf-parse` v2 requires `serverExternalPackages` in
`next.config.ts` because `pdfjs-dist` worker files cannot be resolved
by Next.js Webpack bundler in serverless builds.

**4MB limit:** Sufficient for text documents and ~10 minutes of compressed
audio. Larger files require AWS S3 + async processing.

### 4. Notification System — Four-Level Classification

| Level   | Style     | When                                           |
| ------- | --------- | ---------------------------------------------- |
| `error` | Red box   | Network failure, API error, permission denied  |
| `warn`  | Amber box | Partial success with caveat                    |
| `info`  | Gray box  | Informational — no speech detected, empty file |
| `debug` | Hidden    | Development only                               |

**Principle:** Red is reserved for actual failures. Informational states
(silence, empty result) use gray/subtle styling to avoid false alarm.

## Consequences

- Browser voice input works on Chrome/Safari/Edge; Firefox requires
  server-side STT (persistent connections, not available on Vercel)
- File upload works on all browsers, all environments
- PDF extraction requires `serverExternalPackages` configuration
- Notification system is a platform primitive — all features must use
  the four-level classification, not ad-hoc error strings
