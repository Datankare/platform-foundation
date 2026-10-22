-- 044_daily_paid_quota.sql — a daily cap on paid requests per actor (Sprint 7X, audit X-12)
--
-- The per-minute AI limit (20/min) bounds bursts, not spend: one account could make ~28,800
-- paid requests a day. Every route that makes a paid provider call now also counts the request
-- (which may make several calls) against 'ai.daily_paid_requests_per_actor' over a rolling 24 hours in the shared limiter
-- (platform/rate-limit/daily-quota.ts). Integer 1–10000, default 200, safety tier, dual
-- control. The platform clamps it in code too: an unreadable or invalid value means the
-- default, never "unlimited". A per-user dollar budget needs per-call cost records (TASK-113).

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
VALUES
  (
    'ai.daily_paid_requests_per_actor', '200', '200',
    'Requests that make paid AI calls (model, translation, speech, song ID) one user or guest may make in any 24 hours; one request may make several calls. At the limit the caller gets 429 until requests age out. The platform uses 200 whenever this row is missing or outside 1–10000.',
    'ai', 'number', '1', '10000', 'safety'
  )
ON CONFLICT (key) DO NOTHING;

UPDATE platform_config
SET value = value || '["ai.daily_paid_requests_per_actor"]'::jsonb
WHERE key = 'config.dual_control_keys'
  AND NOT (value @> '["ai.daily_paid_requests_per_actor"]'::jsonb);

insert into applied_migrations (filename, confidence, note)
values (
  '044_daily_paid_quota.sql',
  'verified',
  'Sprint 7X X-12: governed ai.daily_paid_requests_per_actor — paid requests per actor per 24h (1-10000, default 200, safety tier, dual control).'
)
on conflict (filename) do nothing;
