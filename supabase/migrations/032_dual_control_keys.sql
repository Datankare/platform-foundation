-- 032_dual_control_keys.sql — Seed config.dual_control_keys for ADR-039 dual-control (F2b-2).
--
-- The catastrophic subset of safety-tier config keys that earn a RUNTIME hold + independent
-- human approver ON TOP OF config-approval's domain two-person gate (weak-both). A config write
-- to one of these keys raises effectiveRisk to 'restricted', which invokeTool holds until a
-- human clears it. The set is data — edit it via the governance admin, no code change. The key
-- lists itself, so the safety net cannot be quietly removed without tripping the very check.

INSERT INTO platform_config (key, value, default_value, description, category, value_type, permission_tier) VALUES
  ('config.dual_control_keys',
   '["signups_enabled","moderation.strike_ban_threshold","moderation.blocklist_only_surfaces","config.require_two_person_approval","config.dual_control_keys"]',
   '[]',
   'Config keys whose changes require a runtime hold + independent human approval (ADR-039 dual-control), in addition to the two-person domain gate.',
   'system', 'json_array', 'safety')
ON CONFLICT (key) DO NOTHING;

insert into applied_migrations (filename, confidence, note)
values (
  '032_dual_control_keys.sql',
  'verified',
  'Seeds config.dual_control_keys with the catastrophic subset for ADR-039 F2b-2 dual-control.'
);
