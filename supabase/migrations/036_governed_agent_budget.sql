-- ============================================================================
-- Phase 5, Sprint 6.5 — Governed Agent Budget Caps (ADR-048 M1)
-- Migration: 036_governed_agent_budget.sql
--
-- Moves the agent daily cost cap and per-trajectory step cap onto the governed,
-- permission-tiered config surface (P13). Applied as a platform ceiling that can
-- only TIGHTEN the per-agent default (min-wins) — lowering tightens spend
-- platform-wide; it cannot raise an agent above its own default. Seeded at the
-- loosest default so seeding introduces no regression. Both keys join
-- dual_control_keys: raising a spend/step ceiling is a catastrophic-spend action
-- requiring an independent human hold (ADR-039/040 F2b-2).
-- ============================================================================

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
VALUES
  (
    'agent.budget.max_cost_per_day', '10', '10',
    'Platform ceiling on agent daily spend (USD). Applied as the most-restrictive of this ceiling and each agent''s per-class default: lowering it tightens spend platform-wide; it cannot raise an agent above its own default. Governs the ADR-048 cost cap.',
    'agents', 'number', '0.01', '1000', 'safety'
  ),
  (
    'agent.budget.max_steps_per_trajectory', '15', '15',
    'Platform ceiling on steps per agent trajectory. Most-restrictive of this ceiling and each agent''s per-class default. Governs the ADR-048 step cap.',
    'agents', 'number', '1', '100', 'safety'
  )
ON CONFLICT (key) DO NOTHING;

UPDATE platform_config
SET value = (value::jsonb || '["agent.budget.max_cost_per_day","agent.budget.max_steps_per_trajectory"]'::jsonb)::text
WHERE key = 'config.dual_control_keys'
  AND NOT (value::jsonb @> '["agent.budget.max_cost_per_day"]'::jsonb);

insert into applied_migrations (filename, confidence, note)
values (
  '036_governed_agent_budget.sql',
  'verified',
  'ADR-048 M1: governs agent daily cost cap and per-trajectory step cap via platform_config (safety tier, min-wins platform ceiling over per-agent defaults). Adds both keys to config.dual_control_keys.'
);
