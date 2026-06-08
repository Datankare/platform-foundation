-- ============================================================================
-- Migration 018: Human Review + Appeals
--
-- Adds the review_queue table that backs the human-oversight surface (ADR-024):
-- escalated moderation decisions, Sentinel ban reviews, and user appeals land
-- here for a human to claim and resolve (uphold / overturn / modify).
--
-- Also:
--   - new `moderator` role + `can_moderate` permission (granted to moderator,
--     admin, and super_admin) — gates the review/appeal-resolution routes (F6)
--   - appeal/review configuration seeded into platform_config (no hardcoded
--     thresholds; admins tune via the config panel / setConfig())
--
-- Columns mirror platform/moderation/review-store.ts (ReviewQueueRow). The app
-- never supplies id/created_at/updated_at — the DB fills them (the Supabase
-- store inserts with return=representation and maps the row back).
--
-- Sprint 6 (Phase 4)
-- ============================================================================

-- ── REVIEW_QUEUE TABLE ──────────────────────────────────────────────────────
-- One row per item needing human review. Vocabulary (stored as TEXT, mirroring
-- user_strikes' style — no enum, validated in the type layer):
--   source   : escalation | ban_review | appeal
--   priority : critical | high | normal
--   status   : pending | claimed | resolved
--   decision : uphold | overturn | modify   (set on resolution)

CREATE TABLE review_queue (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source                  TEXT NOT NULL,
  priority                TEXT NOT NULL DEFAULT 'normal',
  status                  TEXT NOT NULL DEFAULT 'pending',

  -- The automated moderation decision under review (full ModerationResult).
  moderation_result       JSONB NOT NULL,

  target_user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id              TEXT NOT NULL,

  -- Optional reasoning chain captured at decision time (RAG ExplanationChain).
  explanation_chain       JSONB,

  -- Appeal-specific: the user's stated reason + the original decision appealed.
  appeal_reason           TEXT,
  original_decision_id    TEXT,

  -- Claim / resolution lifecycle.
  claimed_by              TEXT,
  claimed_at              TIMESTAMPTZ,
  resolved_by             TEXT,
  resolved_at             TIMESTAMPTZ,
  decision                TEXT,
  reviewer_notes          TEXT,
  modified_action         TEXT,

  -- Account status that existed BEFORE the decision under review, so an
  -- overturn restores the prior status rather than blanket-resetting to active.
  previous_account_status TEXT,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes — sized to the store's query paths (getQueue filters + ordering,
-- claim-timeout sweep, appeal dedup by original decision).
CREATE INDEX idx_review_queue_status ON review_queue (status);
CREATE INDEX idx_review_queue_pending ON review_queue (priority, created_at)
  WHERE status = 'pending';
CREATE INDEX idx_review_queue_target_user ON review_queue (target_user_id);
CREATE INDEX idx_review_queue_source ON review_queue (source);
CREATE INDEX idx_review_queue_original_decision ON review_queue (original_decision_id)
  WHERE original_decision_id IS NOT NULL;
CREATE INDEX idx_review_queue_created_at ON review_queue (created_at DESC);

ALTER TABLE review_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY review_queue_service_all ON review_queue
  FOR ALL USING (auth.role() = 'service_role');

COMMENT ON TABLE review_queue IS
  'Human-review queue (ADR-024): escalations, ban reviews, and appeals awaiting '
  'a moderator decision. Service-role only; the app layer enforces can_moderate.';
COMMENT ON COLUMN review_queue.previous_account_status IS
  'Account status before the reviewed decision; an overturn restores to this '
  '(falling back to active) rather than blanket-resetting.';

-- ── MODERATOR ROLE ──────────────────────────────────────────────────────────
-- roles.name is TEXT since migration 004 (dynamic roles) — plain insert.
-- Sits below admin; reviews moderation items but holds no governance.

INSERT INTO roles (name, display_name, description, is_default, sort_order)
VALUES (
  'moderator',
  'Moderator',
  'Reviews escalated moderation decisions and user appeals. No governance access.',
  false,
  5
)
ON CONFLICT (name) DO NOTHING;

-- ── CAN_MODERATE PERMISSION ─────────────────────────────────────────────────

INSERT INTO permissions (code, display_name, description, category) VALUES
  ('can_moderate', 'Can Moderate',
   'Review and resolve escalated moderation items and appeals', 'moderation')
ON CONFLICT (code) DO NOTHING;

-- ── GRANTS ──────────────────────────────────────────────────────────────────
-- Moderator: can_moderate + admin-surface access + audit read (to see context).

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name = 'moderator'
  AND p.code IN ('can_moderate', 'can_access_admin', 'admin_view_audit')
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- Admin and super_admin also get can_moderate (admin already has admin-surface
-- access; super_admin holds governance-all but predates this permission).

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.name IN ('admin', 'super_admin')
  AND p.code = 'can_moderate'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions rp
    WHERE rp.role_id = r.id AND rp.permission_id = p.id
  );

-- ── APPEAL / REVIEW CONFIG ───────────────────────────────────────────────────
-- Source-of-truth defaults. Code has no hardcoded values — read via getConfig().

INSERT INTO platform_config (key, value, description, category)
VALUES
  ('moderation.appeal_window_hours', '72',
   'Hours after a decision during which a user may file an appeal. Range: 1-720.',
   'moderation'),
  ('moderation.review_claim_timeout_hours', '24',
   'Hours a claimed review item may sit before it auto-releases back to pending. Range: 1-168.',
   'moderation'),
  ('moderation.appeal_reason_min_length', '20',
   'Minimum number of characters required in an appeal reason. Range: 1-1000.',
   'moderation')
ON CONFLICT (key) DO NOTHING;
