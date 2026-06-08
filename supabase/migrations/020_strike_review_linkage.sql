-- ============================================================================
-- Migration 020: strike <-> review linkage
--
-- Two linkage columns supporting "overturn on human review -> expire the strike":
--
--   user_strikes.guardian_decision_id
--     The Guardian decision (moderationResult.trajectoryId) that CAUSED this
--     strike. This is the CANONICAL link the code resolves through. On overturn,
--     a review item carries the same Guardian trajectory, so the strike is found
--     via:  guardian_decision_id = review_item.moderationResult.trajectoryId.
--     This works uniformly for every review source (ban_review, appeal) because
--     a strike is keyed to the decision that caused it — NOT to the Sentinel
--     agent's own trajectory (trajectory_id), which differs.
--
--   review_queue.related_strike_id
--     The strike a ban_review actioned, recorded for AUDIT / FORENSICS ONLY.
--     It is NEVER used as the lookup key for expiry (that is guardian_decision_id
--     above). It exists so a review row is self-contained — "this review actioned
--     strike X" — without joining back to user_strikes. Do NOT resolve strikes
--     through this column.
--
-- Both nullable (existing rows predate them); idempotent (ADD COLUMN IF NOT
-- EXISTS), safe to re-run from the dashboard.
--
-- Sprint 6 (follow-up)
-- ============================================================================

ALTER TABLE user_strikes ADD COLUMN IF NOT EXISTS guardian_decision_id TEXT;

COMMENT ON COLUMN user_strikes.guardian_decision_id IS
  'Guardian decision (moderationResult.trajectoryId) that caused this strike. '
  'CANONICAL link used to resolve the strike when a decision is overturned on '
  'human review. Distinct from trajectory_id (the Sentinel agent trajectory). '
  'Nullable for strikes recorded before migration 020.';

ALTER TABLE review_queue ADD COLUMN IF NOT EXISTS related_strike_id TEXT;

COMMENT ON COLUMN review_queue.related_strike_id IS
  'Strike a ban_review actioned. AUDIT / FORENSICS ONLY — NEVER the lookup key '
  'for expiry (use user_strikes.guardian_decision_id). Lets a review row record '
  'which strike it actioned without joining to user_strikes.';
