-- 051_social_scheduled_agents.sql — the social module's scheduled agents (ADR-056 D3, ADR-054 D5)
--
-- The analyst (group health) and curator (activity digests) agents had budgets and no schedule
-- (TASK-141). They are now recurring jobs the social module contributes (platform/social/jobs.ts);
-- this migration seeds their governed schedule — operator-only, like the core's (050) — and the
-- one setting a tenant's own administrators may change: whether their tenant's scheduled agents
-- run at all (social.scheduled_agents_enabled, tenant settable). Each run stays inside the
-- agents' governed budgets (ADR-048): a run stops when the budget says so.
--
-- A social-module migration (platform/modules/manifest.json): replayed only when the module is
-- selected. Idempotent: inserted on conflict do nothing, so an operator's or a tenant's later
-- choice stands on a re-run.

insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('jobs.social.analyst.enabled', 'true', 'true',
   'Runs the analyst agent over each active tenant''s groups (group health reports in its trajectories).',
   'jobs', 'boolean', null, null, 'safety', false),
  ('jobs.social.analyst.interval_minutes', '1440', '1440',
   'Minutes between analyst runs.',
   'jobs', 'number', '60', '10080', 'safety', false),
  ('jobs.social.curator.enabled', 'true', 'true',
   'Runs the curator agent over each active tenant''s groups (activity digests in its trajectories).',
   'jobs', 'boolean', null, null, 'safety', false),
  ('jobs.social.curator.interval_minutes', '1440', '1440',
   'Minutes between curator runs.',
   'jobs', 'number', '60', '10080', 'safety', false),
  ('social.scheduled_agents_enabled', 'true', 'true',
   'Whether the scheduled social agents (analyst, curator) run for this tenant. A tenant''s administrators may turn them off.',
   'social', 'boolean', null, null, 'standard', true)
on conflict (key) do nothing;

insert into public.applied_migrations (filename, confidence, note)
values (
  '051_social_scheduled_agents.sql',
  'verified',
  'ADR-056 D3 (TASK-141): governed schedules for the social analyst and curator jobs; social.scheduled_agents_enabled per tenant.'
)
on conflict (filename) do nothing;
