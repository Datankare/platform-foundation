-- 033_escalation_sla.sql — Escalation SLA + remedial-action config (ADR-041 D1/D2/D5).
--
-- Bounds how long a review item may sit in pending/claimed after Guardian fails closed to
-- `escalate` (ADR-039 F3c). The reaper (reapOverdueEscalations) reads these keys; `block` is the
-- fail-closed remedial default and the reaper never resolves an item to `allow`. All four keys are
-- safety-tier and are added to config.dual_control_keys (D5) so the SLA / remedial policy itself
-- cannot be weakened without a second human. No schema change: review items already carry
-- created_at / status, so the SLA is computed, not stored.

INSERT INTO platform_config (key, value, default_value, description, category, value_type, permission_tier) VALUES
  ('moderation.escalation_sla_hours', '24', '24',
   'Max hours a review item may stay in pending/claimed before the reaper applies the remedial action (ADR-041). Clamped to [min,max]; on read failure the min is used (fail-closed).',
   'moderation', 'number', 'safety'),
  ('moderation.escalation_sla_min_hours', '1', '1',
   'Lower clamp + fail-closed value for escalation_sla_hours (ADR-041 D1).',
   'moderation', 'number', 'safety'),
  ('moderation.escalation_sla_max_hours', '168', '168',
   'Upper clamp for escalation_sla_hours (ADR-041 D1) — caps an accidental effectively-infinite SLA.',
   'moderation', 'number', 'safety'),
  ('moderation.escalation_remedial_action', '"block"', '"block"',
   'Reaper action on an over-SLA item: block (fail-closed default) or escalate_higher (re-queue + notify). Never allow. Allowed-set validated in the config reader (ADR-041 D2).',
   'moderation', 'string', 'safety')
ON CONFLICT (key) DO NOTHING;

-- D5: dual-control these safety-tier controls (ADR-041 D5 / ADR-039). Append idempotently,
-- preserving existing order; the membership guard makes a re-run a no-op.
UPDATE platform_config
SET value = value || '["moderation.escalation_sla_hours","moderation.escalation_sla_min_hours","moderation.escalation_sla_max_hours","moderation.escalation_remedial_action"]'::jsonb
WHERE key = 'config.dual_control_keys'
  AND NOT (value ? 'moderation.escalation_remedial_action');

insert into applied_migrations (filename, confidence, note)
values (
  '033_escalation_sla.sql',
  'verified',
  'Seeds escalation SLA (24h; clamp 1..168) + remedial action (block) and dual-controls them (ADR-041 D1/D2/D5).'
);
