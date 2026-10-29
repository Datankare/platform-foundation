-- 058_ai_prompt_cache_setting.sql — the governed switch for Anthropic prompt caching, off
-- (TASK-186)
--
-- PR #462 added prompt caching as a per-request flag (AIRequest.promptCache) with nothing above
-- it. A cached prefix must be fixed, tenant-free text; a switch an operator holds is the second
-- key: the orchestrator (platform/ai/orchestrator.ts gatePromptCache) drops a request's flag
-- unless ai.prompt_cache_enabled is true, and a setting that cannot be read is off. Seeded off:
-- turning it on is an operator's change, recorded like any other (platform_config_history).
--
-- Operator-only (tenant_overridable false): it governs a cost and what is sent to the provider,
-- not a tenant's preference. Idempotent: inserted on conflict do nothing, so an operator's later
-- choice stands on a re-run. No table or lock beyond one row of platform_config.

insert into public.platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier, tenant_overridable)
values
  ('ai.prompt_cache_enabled', 'false', 'false',
   'Whether a request may use Anthropic''s prompt cache. Both this and the request''s own promptCache flag must be on, and only a fixed, tenant-free cacheablePrefix is ever cached.',
   'ai', 'boolean', null, null, 'safety', false)
on conflict (key) do nothing;

insert into public.applied_migrations (filename, confidence, note)
values (
  '058_ai_prompt_cache_setting.sql',
  'verified',
  'ai.prompt_cache_enabled (boolean, default false, operator-only): the governed gate above AIRequest.promptCache (TASK-186).'
)
on conflict (filename) do nothing;
