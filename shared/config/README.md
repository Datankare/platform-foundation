# shared/config/

Platform-wide configuration constants.

## Convention

**If a value appears in more than one file, it lives in shared/config/.**

- limits.ts — Size limits, character limits, timeouts, rate limits
- apiKeys.ts — Centralized API key retrieval (single source of truth)

Import from here. Never hardcode values in routes or components.
