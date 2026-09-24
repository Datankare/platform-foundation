# ADR-045: Governed Image Generation

Status: Proposed (Phase 5 Sprint 6). Decision maker: Raman Sud.
Related: ADR-017 §8 (multimodal surface map), ADR-031 (action-identity lifecycle $\u2014 draft/commit), ADR-040 (held-action & dual-control admin), ADR-041 (escalation SLA), ADR-044 (multimodal provider interface $\u2014 content model + capability descriptor), ADR-046 (multimodal content safety), ADR-047 (provenance & synthetic-media detection). `platform/agents/external-effect.ts`, `platform/agents/approval-policy-store.ts`, `platform/agents/gating.ts`, `platform/admin/pending-approvals.ts`.

---

## 1. The end state

Image generation is a **governed committed effect**, not a plain provider call. Every generation is drafted, screened, risk-classified, and routed by an **admin-controlled policy**: low-risk images auto-commit at the boundary; high-risk images are **held for human Confirm** on the existing dual-control path; prohibited categories never surface. An image is not "real" $\u2014 surfaced, stored, or counted as spend $\u2014 until it is screened, provenance-credentialed, and committed. A retry never double-spends.

This is deliberately **not** a new approval system: generation becomes a new **effect type** on the ADR-031/040/041 held-action substrate. The one thing that is net-new is the generation-specific risk classification and its admin policy.

## 2. Decisions

**D1 $\u2014 Generation is an external effect, not a plain call.** It runs through the `platform/agents/external-effect.ts` machinery: a draft with a derived idempotency key (`effect-ledger`), a downstream `call(idempotencyKey)`, and `reconcile` on retry. Generation **spends money and creates a durable artifact**, which is precisely the class of action P17 requires to be *"durable, idempotent, and explicitly approved."* Idempotency is structural $\u2014 a retried generation returns the prior result, never a second charge.

**D2 $\u2014 Draft → screen → commit; nothing leaks before commit.** The generated image is a **draft** $\u2014 not surfaced, stored, or billed $\u2014 until it passes the ADR-046 `screenModality` output check and is committed. Low-risk drafts auto-commit **at** the boundary (not bypassing it); high-risk drafts are held. _"No agent thinking-out-loud leaks into the real world as a side effect"_ (P17) applies to generated pixels exactly as to any external action.

**D3 $\u2014 Risk classification drives an admin-governed commit policy.** A risk tier $\u2014 computed from requester trust, the input-screen verdict, the output-screen verdict, the target surface, and the content category $\u2014 maps, via an `ApprovalPolicy` (`platform/agents/approval-policy-store.ts`, extended for a generation effect), to a commit path: **low → auto-commit; high → held-for-Confirm** through the ADR-040 dual-control gating (`gating.ts` / `pending-approvals.ts`). The policy and its thresholds are central admin config, independent of app logic (P13), and Confirm is an explicit human authority (P10).

**D4 $\u2014 Two kinds of category rule; screening is never one of them.** *Commit-gating* categories (e.g. `avatar`, `icon` → auto-commit-eligible) are admin-tunable. *Prohibited / forced-escalate* categories are admin-tunable in strictness but **cannot be auto-committed away**. Screening itself is **always-on and non-configurable** $\u2014 the policy governs _commit-gating_, never _whether to screen_ (Standing Rule 11). The **hard-refuse invariants** (CSAM, real-person sexual imagery) live in ADR-046 **above** this tier system and are reachable by no configuration path.

**D5 $\u2014 Provenance is part of commit.** On commit, the ADR-047 C2PA content credential + watermark is attached; an image that is not screened, credentialed, and committed does not exist as far as the platform is concerned. The credential is a schema-validated structured artifact (P6), recorded on the trajectory (P3/P18).

**D6 $\u2014 Reuse, not reinvention.** The idempotent-commit machinery (external-effect / effect-ledger), the risk→approval policy (approval-policy-store), and the held/Confirm flow (gating / pending-approvals) are the ADR-031/040/041 substrate applied to a new effect type. A reviewer rejects any parallel approval queue, ledger, or dual-control path built specifically for images.

## 3. Alternatives considered

(a) **A plain screened provider call** (generate → screen → return) $\u2014 rejected: it makes image generation the one money-spending, state-creating output that bypasses the commitment boundary every other external effect honors. "Plain" is retained only as the *low-tier auto-commit* case $\u2014 auto-commit **at** the boundary, not a path around it.

(b) **A dedicated image-approval system** (its own queue, ledger, admin surface) $\u2014 rejected: it duplicates ADR-040/041 and drifts. Generation is an effect type, not a new governance domain.

(c) **Screening as an admin toggle per category** $\u2014 rejected: it lets safety be configured off, violating Rule 11 and P4. Only _commit-gating_ is tunable; screening is invariant.

(d) **Committing before screening, then retracting on a bad verdict** $\u2014 rejected: a retract is a leak (the image was briefly real). Draft-held-until-committed is the only fail-closed order.

## 4. Conformance (L21)

A generation-lifecycle kit, provider-agnostic:

- a draft is **held** (not surfaced/stored/billed) until commit;
- a block / escalate / screen-error verdict **withholds** $\u2014 no image surfaces (fail-closed);
- a **high-risk-tier** draft routes to a **pending approval**, not auto-commit; a **low-tier** draft auto-commits;
- a **prohibited category** never auto-commits regardless of tier; **hard-refuse** categories never generate at all;
- commit is **idempotent** $\u2014 a retried generation returns the prior artifact and does not double-spend;
- the ADR-047 **provenance credential is attached on commit**, and screening is invoked on **every** generation.

## 5. GenAI / RAMPS / WCAG

- **P17 Cognition-Commitment Boundary (Core):** draft-then-commit, idempotent, approval-gated above a risk threshold $\u2014 the tenet realized for generated media.
- **Support:** P10 (Confirm on high tier, RBAC over the policy), P13 (admin-governed, app-independent policy), P4 (always-on output screening, via ADR-046), P6 (provenance manifest), P3/P18 (metered + trajectory-recorded).
- **RAMPS:** generation is safety-screened, cost-metered, human-overridable, and centrally governed day one.
- **WCAG:** committed images carry a text description / alt-text contract for accessible rendering (consumer-side; PF ships the contract).

## 6. Consequences

- Builds on ADR-044 (content model), ADR-046 (the screening seam it calls before commit), and ADR-047 (the credential attached at commit) $\u2014 and reuses ADR-031/040/041 wholesale rather than rebuilding governance.
- The admin gains a generation risk-policy surface (tiers, category overrides) alongside the existing held-action config; the prohibited/hard-refuse invariants are visible but not editable.
- Deferred: image **editing** loops (edit-then-recommit), **video** generation, and batch generation $\u2014 each is another effect on the same substrate, not a new decision.
