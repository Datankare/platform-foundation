# Independent adversarial review — the brief every auditor receives

Used for the release review and the phase-close whole-system review ([ASSURANCE.md](../ASSURANCE.md)).
Give each auditor this brief, one scope (a feature, a service, the data layer, the plumbing, supply
chain — or the dynamic run), read-only access to the code at the commit under review, and nothing
else: no design notes, no summary of what the builders believe is safe. The auditors must not have
built the code.

---

You are an independent, hostile auditor. You did not build this code. Your mandate is to break it.
Do not modify any file.

**Apply every ring below to every feature and service in your scope.**

1. **Identity** — who is the caller? Can it be forged, replayed or confused (user, guest, agent, admin)?
2. **Authorization** — does each path check the right permission? Are there **second paths** to the
   same effect (AI command bar, agents and tools, batch endpoints, admin helpers, database functions)
   with weaker checks? What is the most each role can actually do?
3. **Data integrity and isolation** — can one user read or change another's data? Unsafe database
   grants, owner-rights functions, filter strings built from input, mass assignment, missing
   ownership checks.
4. **Input and injection** — filter or SQL injection, prompt injection reaching tools or privileged
   actions, SSRF, path traversal, unsafe deserialization, unbounded input.
5. **AI and agent governance** — fail-open on error, budget or cap bypass, held-action bypass, tools
   beyond the principal's rights, delegation misuse, model output trusted as authorization.
6. **Privacy and compliance** — personal data or secrets in logs or error bodies, export and erasure
   completeness, age consent, retention, audit records that are missing, forged or silently failing.
7. **Reliability and failure modes** — fail-open paths, security-relevant writes that are
   fire-and-forget, races, missing idempotency, timeouts, unbounded work, per-instance state that
   must be shared.
8. **Contract truth** — what documents, ADRs and comments claim against what the code does; security
   code that exists but is never called; guards stubbed in tests and so never exercised; settings
   read nowhere.

**The dynamic auditor** runs the production build (`scripts/monkey/monkey.mjs` and its own probes):
every route, every handler, every kind of caller, hostile bodies and headers, random sequences.

**Rules**

- Read the code before claiming. Each finding needs file:line evidence and a concrete scenario (who
  does what, what happens). Mark CONFIRMED only if traced end to end; otherwise SUSPECTED, with what
  would confirm it.
- Severity: Critical (privilege escalation, cross-user data access, authentication bypass, cost or
  abuse at scale), High, Medium, Low. No style or naming points.
- Also list what you checked and found sound, briefly.

**Output** (concise markdown, no file dumps)

1. Findings: ID (your scope letter, e.g. A-1) · severity · ring · CONFIRMED/SUSPECTED · file:line ·
   scenario · fix.
2. Coverage: what you checked and found sound.
3. The three systemic patterns you see.

---

**After the review.** Critical and High findings are re-verified against the code before they enter
the register. Each finding gets an ID in the register (`docs/audits/<year>-<month>-REGISTER.md`), a
status, and — when it is fixed — the test that would have caught it. A finding that is still open is
described in the public register without the exploit detail until it is fixed (see
[SECURITY.md](../../SECURITY.md)).
