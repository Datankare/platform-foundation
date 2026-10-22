-- 043_audit_actions.sql — audit actions the code records that the enum did not accept (Sprint 7X)
--
-- audit_log.action is the audit_action enum. The GDPR purge route recorded gdpr_purge_executed
-- and gdpr_purge_dry_run, which the enum rejected, so every purge went unaudited while the error
-- was logged and ignored (audit X-8). The application now types audit actions against this enum
-- (platform/auth/audit.ts AuditAction) and refuses a privileged action whose audit row cannot be
-- written; this adds the two missing values, and two that name what happened rather than a
-- near miss: a data export (recorded as profile_updated) and a parental consent refusal
-- (recorded as consent_granted).

ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'gdpr_purge_executed';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'gdpr_purge_dry_run';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'data_exported';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'consent_denied';

insert into applied_migrations (filename, confidence, note)
values (
  '043_audit_actions.sql',
  'verified',
  'Sprint 7X: adds gdpr_purge_executed, gdpr_purge_dry_run, data_exported and consent_denied to audit_action.'
)
on conflict (filename) do nothing;
