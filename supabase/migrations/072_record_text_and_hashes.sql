-- 072_record_text_and_hashes.sql — no model words about what a person wrote, and no unkeyed hash
-- of it, in a record (TASK-215, audit A-5, A-6)
--
-- 1. The classifier model's own words (A-5). Every moderation decision kept the model's free-text
--    reason — `classifierOutput.rawReason` (migration 067 moved the older `reason` there) — in
--    content_safety_audit.classifier_output and in a review case's moderation_result. A model's
--    words on why can quote or paraphrase what the person wrote, and the erasure never reached
--    them. The code no longer keeps them (prompts/safety/classify-v1.ts drops the reason after
--    checking it); what moderators and appeals use — the categories, the severity, the confidence,
--    the platform's note as a catalog key — is unchanged. Here they are removed from every row
--    written before, `reason` with them wherever one is left.
-- 2. The screened text's hash (A-6). content_safety_audit.input_hash was an unkeyed SHA-256 of the
--    screened text: a guess of what someone wrote is confirmed by hashing it, and the hash was kept
--    after the account's erasure. The code now keeps an HMAC-SHA256 under RECORD_HASH_KEY
--    (`hmac-sha256:<key id>:<hex>`, platform/auth/record-hash.ts), and erasure clears it on the
--    erased account's decisions — so the column may now be empty. The unkeyed hashes written
--    before cannot be rehashed without the text, and nothing matches on them: they are cleared.
-- 3. A re-link's subject hints (A-6). An identity re-link record (audit_log, admin_action,
--    details.type 'identity_relinked') kept the subjects it changed as an unkeyed SHA-256 prefix
--    (`sha256:<16 hex>`) in previousSubject, newSubject and mergedAccount — confirmed by hashing a
--    candidate subject. The code now writes the keyed form; each unkeyed hint left is set to null
--    (the record of the re-link stands: who, when, why, which pool, its outcome).
--
-- Idempotent: each statement changes only rows that still hold what it removes (a second run
-- matches none); dropping NOT NULL again is a no-op. Locks: content_safety_audit ACCESS EXCLUSIVE
-- for the instant its NOT NULL is dropped (no table rewrite), then ROW EXCLUSIVE while the matching
-- rows of it, review_queue and audit_log are updated (one pass each). lock_timeout 5 s: on a busy
-- table it fails rather than queueing others behind it; run it again. Apply it as ONE run.

set local lock_timeout = '5s';

-- ── 1. The model's own words ──────────────────────────────────────────────────────────────────
update public.content_safety_audit
   set classifier_output = classifier_output - 'rawReason' - 'reason'
 where jsonb_typeof(classifier_output) = 'object'
   and classifier_output ?| array['rawReason', 'reason'];

update public.review_queue
   set moderation_result = jsonb_set(
         moderation_result, '{classifierOutput}',
         (moderation_result -> 'classifierOutput') - 'rawReason' - 'reason')
 where jsonb_typeof(moderation_result -> 'classifierOutput') = 'object'
   and (moderation_result -> 'classifierOutput') ?| array['rawReason', 'reason'];

-- ── 2. The screened text's hash: keyed, or none ──────────────────────────────────────────────
alter table public.content_safety_audit alter column input_hash drop not null;

comment on column public.content_safety_audit.input_hash is
  'The screened text as HMAC-SHA256 under RECORD_HASH_KEY (hmac-sha256:<key id>:<hex>, TASK-215); null when the account was erased or the record predates the key. Never the text, never an unkeyed hash.';

update public.content_safety_audit
   set input_hash = null
 where input_hash is not null
   and input_hash !~ '^hmac-sha256:[0-9a-f]{16}:[0-9a-f]{64}$';

-- ── 3. A re-link's unkeyed subject hints ─────────────────────────────────────────────────────
update public.audit_log
   set details = details
     || case when details ->> 'previousSubject' like 'sha256:%'
             then jsonb_build_object('previousSubject', null) else '{}'::jsonb end
     || case when details ->> 'newSubject' like 'sha256:%'
             then jsonb_build_object('newSubject', null) else '{}'::jsonb end
     || case when details ->> 'mergedAccount' like 'sha256:%'
             then jsonb_build_object('mergedAccount', null) else '{}'::jsonb end
 where details ->> 'type' = 'identity_relinked'
   and (details ->> 'previousSubject' like 'sha256:%'
     or details ->> 'newSubject' like 'sha256:%'
     or details ->> 'mergedAccount' like 'sha256:%');

insert into public.applied_migrations (filename, confidence, note, checksum)
values (
  '072_record_text_and_hashes.sql',
  'verified',
  'TASK-215 (audit A-5, A-6): the classifier model''s own words removed from every moderation record; content_safety_audit.input_hash keyed (RECORD_HASH_KEY) or empty — the unkeyed hashes cleared; a re-link''s unkeyed subject hints set to null.',
  'sha256:14a5e1e1c92196b5e075b0b4eb84b7267db4816d11dc3bb5706ddbb5d7576667'
)
on conflict (filename) do update set checksum = excluded.checksum;
