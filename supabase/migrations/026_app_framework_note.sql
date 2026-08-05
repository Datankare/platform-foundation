-- ============================================================================
-- Phase 5, Sprint 2 — Correct the 018_app_framework tracking note
-- Migration: 026_app_framework_note.sql
--
-- 025 recorded 018_app_framework.sql as 'absent', which is accurate about the file and
-- misleading about the schema: migration 022 created app_sessions, so the objects 018 would
-- have created do exist. Without this note a reader concludes the table is missing.
--
-- Idempotent and re-runnable.
-- ============================================================================

update applied_migrations
   set note = 'Authored 2026-07-26, never applied. Its objects DO exist: migration 022 created app_sessions. Absent refers to the file, not the schema.'
 where filename = '018_app_framework.sql';

-- ── Self-record (migration 025 convention) ──────────────────────────────────

insert into applied_migrations (filename, confidence, note)
values (
  '026_app_framework_note.sql',
  'verified',
  'Amends the 018_app_framework tracking note. Self-recorded on application.'
)
on conflict (filename) do update
  set confidence = 'verified',
      recorded_at = now();
