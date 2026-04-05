# moderation

Content safety — multi-layer defense architecture (ADR-016).

## Status

🚧 **Placeholder** — Blocklist + structured classifier in Phase 2, Sprint 2. Human review queue in Phase 4.

## Target Structure (ADR-016)

```
platform/moderation/
  ├── blocklist.ts         — Keyword/pattern pre-screen (instant, zero-cost)
  ├── classifier.ts        — Structured LLM classifier (categories, confidence, severity)
  ├── middleware.ts         — Universal safety middleware for all input surfaces
  ├── audit.ts             — Full audit trail (input hash, classifier output, action)
  └── types.ts             — SafetyCategory, Severity, ClassifierOutput, AuditRecord
```

## Multi-Layer Pipeline (ADR-016)

```
User input
  → Layer 1: Blocklist scan (instant, zero-cost, catches known patterns)
  → Layer 2: LLM classifier (structured categories + confidence score)
  → Layer 3: Content rating filter (age-appropriate — Phase 3)
  → Decision: allow / warn / block / escalate-to-human
  → Audit: full record per decision
```

---

_See [ADR-016](../../docs/adr/ADR-016-content-safety-architecture.md) and [ADR-005](../../docs/adr/ADR-005-content-safety.md) for architecture context._
