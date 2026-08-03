-- ============================================================================
-- Phase 5, Sprint 2 — Migration tracking
-- Migration: 025_migration_tracking.sql
--
-- Closes TASK-065. This database has no CLI-managed migration history, so for three
-- phases "has migration N applied" was answerable only by introspecting objects and
-- inferring. That produced a Sprint 6 audit wrong in both directions, two migrations that
-- had never applied without anyone noticing, and three applied by hand in Sprint 2 with no
-- record of any of them.
--
-- Deliberately NOT supabase_migrations.schema_migrations: that is the Supabase CLI's own
-- table, and hand-populating it would make a future `supabase db push` trust rows nobody
-- verified.
--
-- Idempotent and re-runnable.
-- ============================================================================

create table if not exists applied_migrations (
  filename    text primary key,
  confidence  text        not null,
  note        text,
  recorded_at timestamptz not null default now(),
  constraint applied_migrations_confidence_check
    check (confidence in ('verified', 'assumed', 'absent'))
);

comment on table applied_migrations is
  'What is known about each migration file. Query this before writing or applying a migration (TASK-065).';
comment on column applied_migrations.confidence is
  'verified = application confirmed by introspection. assumed = inferred from object presence only, NOT evidence of application. absent = known not applied.';

alter table applied_migrations enable row level security;

drop policy if exists applied_migrations_service_all on applied_migrations;
create policy applied_migrations_service_all on applied_migrations
  for all using (auth.role() = 'service_role');

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Generated from the migrations directory listing. Confidence is honest: only 022, 023 and
-- 024 were applied and confirmed by introspection in the session that wrote this.
-- 018_app_framework.sql is known absent — 022 had to create app_sessions. Everything else
-- is inferred from object presence, which is not the same as knowing it ran: the Sprint 6
-- audit believed 005/009/015/016 had not landed, and their objects are present now, but
-- nobody knows whether that is because they were applied or because 021 recreated the
-- objects forward.

insert into applied_migrations (filename, confidence, note)
values
  ('001_identity_access_foundation.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('002_seed_data.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('003_rls_policies.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('004_dynamic_roles.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('005_super_admin_separation.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('006_platform_config.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('007_seed_separation.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('008_rename_player_to_user.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('009_gdpr_purge_log.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('010_content_safety_audit.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('011_config_management.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('012_account_consequences.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('013_song_id_config.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('014_profile_screening_config.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('015_social_data_model.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('016_agent_runtime.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('017_embedding_store.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('018_app_framework.sql', 'absent', 'Authored 2026-07-26, never applied. Migration 022 had to create app_sessions.'),
  ('018_human_review.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('019_review_queue_updated_at.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('020_strike_review_linkage.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('021_reconcile_permission_vocabulary.sql', 'assumed', 'Inferred from object presence only. Not evidence of application.'),
  ('022_agent_runtime_reconcile.sql', 'verified', 'Applied and confirmed by introspection, Phase 5 Sprint 2.'),
  ('023_agent_budget_consume.sql', 'verified', 'Applied and confirmed by introspection, Phase 5 Sprint 2.'),
  ('024_agent_budget_used_steps.sql', 'verified', 'Applied and confirmed by introspection, Phase 5 Sprint 2.')
on conflict (filename) do nothing;

-- ── This migration records itself ───────────────────────────────────────────
--
-- Every migration from here on ends with a statement like this one.
-- __tests__/migration-tracking.test.ts fails if one does not.

insert into applied_migrations (filename, confidence, note)
values (
  '025_migration_tracking.sql',
  'verified',
  'Creates this table. Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified',
      recorded_at = now();
