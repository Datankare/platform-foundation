# Authenticator setup showed only the key, on screen by default

| Field        | Detail                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-180-authenticator-setup-showed-no-qr-code`                                                                                                     |
| Source       | TASK-180 (signing in to playform-dev)                                                                                                                |
| Area (tier)  | UI — dead-ends or hides the reason (Medium)                                                                                                          |
| Review input | `components/admin/MfaEnrollment.tsx` as of `c4771be` (added in `908d64a`, for the October 2026 audit's item A-9: staff sign in with a second factor) |
| Fixed in     | `43d14c0`                                                                                                                                            |

## What the diff did

The staff second-factor enrolment screen.

## The defect

It showed the base32 key and the otpauth:// text, nothing to scan, with the secret visible to anyone nearby; a setup call that could not reach the server was an unhandled rejection with no message.

## Where

`components/admin/MfaEnrollment.tsx:99` (the key in `<code>`), `:103` (the URI as text), as of `c4771be`.

## How it was caught

The owner signing in to playform-dev — not a test.

## The finding a reviewer should have produced

**Important** — `components/admin/MfaEnrollment.tsx:99` — the screen offers nothing to scan and shows the TOTP secret by default; an authenticator app cannot be set up the usual way, and the secret is exposed on screen. Draw the URI as a QR code, put the key behind "Can't scan? Show key", and say when setup cannot reach the server.

## Scoring

- **Caught (2):** Names the missing QR code or the secret shown by default.
- **Partial (1):** Comments on layout only.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
