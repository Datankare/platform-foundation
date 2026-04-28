-- ============================================================================
-- Phase 4, Sprint 3c — Song Identification Config
-- Migration: 013_song_id_config.sql
--
-- Adds configurable duration limits for song identification recording.
-- ACRCloud requires ≥10s of audio for reliable fingerprint matching.
-- Source: TASK-038 (G-VOICE-001), TASK-026 rotation findings.
-- ============================================================================

INSERT INTO platform_config
  (key, value, default_value, description, category, value_type, min_value, max_value, permission_tier)
VALUES
  (
    'song_id.min_duration_seconds', '10', '10',
    'Minimum recording duration in seconds before song identification is attempted. ACRCloud requires 10s+ for reliable fingerprint matching. Below this threshold, the API returns 422.',
    'voice', 'number', '5', '60', 'standard'
  ),
  (
    'song_id.max_duration_seconds', '60', '60',
    'Maximum recording duration in seconds for song identification. Limits upload size and API cost. ACRCloud recommends 10-20s; 60s is generous upper bound.',
    'voice', 'number', '10', '120', 'standard'
  )
ON CONFLICT (key) DO NOTHING;
