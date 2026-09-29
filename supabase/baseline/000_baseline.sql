-- ============================================================================
-- Platform Foundation — schema baseline
-- supabase/baseline/000_baseline.sql
--
-- Builds a NEW database with everything migrations 001–037 produce, as that schema actually
-- exists: taken from the Playform dev database on 2026-09-29 (Postgres 17.6), then audited
-- for ownership. The numbered chain cannot build a database from zero — several early
-- migrations were never applied as written (see supabase/baseline/README.md) — so a new
-- instance runs this file, then only migrations numbered 038 and later.
--
-- Excluded from dev's schema (not PF's):
--   * Playform-owned: agent_delegation_grant, agent_delegation_audit (Playform 034).
--   * Supabase-generated: rls_auto_enable() (the project's automatic-RLS option).
--   * Supabase-managed: schema public, default privileges.
-- Excluded from dev's seed: the hand-made 'tester' role and its one role_permission.
-- Included although no numbered migration creates it: user_devices (001 created
-- player_devices; the rename was applied by hand) and the vector extension (017 needs it).
--
-- Run once, on an empty Supabase project, as postgres (SQL Editor or psql). Not idempotent
-- by design: it refuses to run over an existing schema (first statement below).
-- baseline-covers-through: 037
-- Regenerate only by the procedure in supabase/baseline/README.md; do not hand-edit.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.users') IS NOT NULL OR to_regclass('public.applied_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'baseline: this database already has a schema — the baseline is for new databases only';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- ── Session settings (as pg_dump restores) ──────────────────────────────────
SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

-- ── Schema ─────────────────────────────────────────────────────────────────
--
-- Name: account_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.account_status AS ENUM (
    'active',
    'warned',
    'restricted',
    'suspended',
    'banned'
);


ALTER TYPE public.account_status OWNER TO postgres;

--
-- Name: audit_action; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.audit_action AS ENUM (
    'role_changed',
    'permission_granted',
    'permission_revoked',
    'entitlement_granted',
    'entitlement_revoked',
    'entitlement_expired',
    'profile_updated',
    'profile_viewed_by_admin',
    'password_changed',
    'password_reset',
    'mfa_enabled',
    'mfa_disabled',
    'device_registered',
    'device_removed',
    'account_created',
    'account_deleted',
    'account_converted_from_guest',
    'consent_granted',
    'consent_revoked',
    'admin_action',
    'login_success',
    'login_failed',
    'guest_nudge_shown',
    'guest_locked_out'
);


ALTER TYPE public.audit_action OWNER TO postgres;

--
-- Name: config_approval_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.config_approval_status AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired'
);


ALTER TYPE public.config_approval_status OWNER TO postgres;

--
-- Name: content_type; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.content_type AS ENUM (
    'translation',
    'generation',
    'transcription',
    'extraction',
    'profile',
    'social',
    'ai-output'
);


ALTER TYPE public.content_type OWNER TO postgres;

--
-- Name: group_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.group_status AS ENUM (
    'active',
    'archived',
    'suspended'
);


ALTER TYPE public.group_status OWNER TO postgres;

--
-- Name: invite_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.invite_status AS ENUM (
    'pending',
    'accepted',
    'declined',
    'expired'
);


ALTER TYPE public.invite_status OWNER TO postgres;

--
-- Name: member_role; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.member_role AS ENUM (
    'owner',
    'admin',
    'member'
);


ALTER TYPE public.member_role OWNER TO postgres;

--
-- Name: moderation_action; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.moderation_action AS ENUM (
    'allow',
    'warn',
    'block',
    'escalate'
);


ALTER TYPE public.moderation_action OWNER TO postgres;

--
-- Name: moderation_trigger; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.moderation_trigger AS ENUM (
    'blocklist',
    'classifier',
    'content-rating',
    'context',
    'none'
);


ALTER TYPE public.moderation_trigger OWNER TO postgres;

--
-- Name: parental_consent_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.parental_consent_status AS ENUM (
    'not_required',
    'pending',
    'granted',
    'denied'
);


ALTER TYPE public.parental_consent_status OWNER TO postgres;

--
-- Name: profile_visibility; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.profile_visibility AS ENUM (
    'private',
    'friends',
    'public'
);


ALTER TYPE public.profile_visibility OWNER TO postgres;

--
-- Name: screening_direction; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.screening_direction AS ENUM (
    'input',
    'output'
);


ALTER TYPE public.screening_direction OWNER TO postgres;

--
-- Name: trajectory_scope; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.trajectory_scope AS ENUM (
    'group',
    'user',
    'platform'
);


ALTER TYPE public.trajectory_scope OWNER TO postgres;

--
-- Name: trajectory_status; Type: TYPE; Schema: public; Owner: postgres
--

CREATE TYPE public.trajectory_status AS ENUM (
    'running',
    'completed',
    'failed',
    'paused',
    'indeterminate'
);


ALTER TYPE public.trajectory_status OWNER TO postgres;

--
-- Name: agent_budget_consume(text, public.trajectory_scope, text, text, numeric, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) RETURNS TABLE(used_usd numeric, used_steps integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into agent_budgets as b
    (agent_id, scope_type, scope_id, period, used_usd, used_steps)
  values
    (p_agent_id, p_scope_type, p_scope_id, p_period, p_delta_usd, p_delta_steps)
  on conflict (agent_id, scope_type, coalesce(scope_id, ''), period)
  do update
    set used_usd   = b.used_usd + p_delta_usd,
        used_steps = b.used_steps + p_delta_steps,
        updated_at = now()
  returning b.used_usd, b.used_steps
    into used_usd, used_steps;

  return next;
end;
$$;


ALTER FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) OWNER TO postgres;

--
-- Name: FUNCTION agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer); Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) IS 'Atomic budget accumulation (TASK-063). Returns the totals AFTER the increment. Never read-modify-write a spend counter from application code.';


--
-- Name: get_current_user_id(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.get_current_user_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT id FROM users WHERE cognito_sub = auth.uid()::text LIMIT 1;
$$;


ALTER FUNCTION public.get_current_user_id() OWNER TO postgres;

--
-- Name: guest_allowance_consume(text, integer); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.guest_allowance_consume(p_guest_id text, p_limit integer) RETURNS TABLE(allowed boolean, used integer)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare
  v_used integer;
begin
  if p_guest_id is null or p_guest_id !~ '^guest_[a-z0-9]{32}$' then
    raise exception 'guest_allowance_consume: invalid guest id';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'guest_allowance_consume: invalid limit';
  end if;

  insert into guest_usage as g (guest_id, translations_used)
  values (p_guest_id, 1)
  on conflict (guest_id) do update
    set translations_used = g.translations_used + 1,
        last_used_at      = now()
    where g.translations_used < p_limit
  returning g.translations_used into v_used;

  if v_used is null then
    -- At the limit: the conditional update matched nothing. Report the current count.
    select g.translations_used into v_used from guest_usage g where g.guest_id = p_guest_id;
    return query select false, coalesce(v_used, p_limit);
  else
    return query select true, v_used;
  end if;
end;
$_$;


ALTER FUNCTION public.guest_allowance_consume(p_guest_id text, p_limit integer) OWNER TO postgres;

--
-- Name: has_permission(text); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.has_permission(permission_code text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM users p
    JOIN role_permissions rp ON rp.role_id = p.role_id
    JOIN permissions perm ON perm.id = rp.permission_id
    WHERE p.cognito_sub = auth.uid()::text
      AND perm.code = permission_code
      AND p.deleted_at IS NULL

    UNION

    SELECT 1
    FROM users p
    JOIN user_entitlements pe ON pe.user_id = p.id
    JOIN entitlement_permissions ep ON ep.entitlement_group_id = pe.entitlement_group_id
    JOIN permissions perm ON perm.id = ep.permission_id
    WHERE p.cognito_sub = auth.uid()::text
      AND perm.code = permission_code
      AND pe.revoked_at IS NULL
      AND (pe.expires_at IS NULL OR pe.expires_at > now())
      AND p.deleted_at IS NULL
  );
$$;


ALTER FUNCTION public.has_permission(permission_code text) OWNER TO postgres;

--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 FROM users p
    JOIN roles r ON r.id = p.role_id
    WHERE p.cognito_sub = auth.uid()::text
      AND r.name = 'admin'
      AND p.deleted_at IS NULL
  );
$$;


ALTER FUNCTION public.is_admin() OWNER TO postgres;

--
-- Name: update_agent_budgets_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_agent_budgets_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_agent_budgets_updated_at() OWNER TO postgres;

--
-- Name: update_groups_updated_at(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_groups_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_groups_updated_at() OWNER TO postgres;

--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: postgres
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION public.update_updated_at_column() OWNER TO postgres;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_approval_policy; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agent_approval_policy (
    id uuid NOT NULL,
    version integer NOT NULL,
    default_approver text DEFAULT 'user'::text NOT NULL,
    rules jsonb DEFAULT '[]'::jsonb NOT NULL,
    decided_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.agent_approval_policy OWNER TO postgres;

--
-- Name: agent_budgets; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agent_budgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    agent_id text NOT NULL,
    scope_type public.trajectory_scope DEFAULT 'platform'::public.trajectory_scope NOT NULL,
    scope_id text,
    period text NOT NULL,
    budget_tokens integer DEFAULT 0 NOT NULL,
    used_tokens integer DEFAULT 0 NOT NULL,
    budget_usd numeric(12,6) DEFAULT 0 NOT NULL,
    used_usd numeric(12,6) DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    used_steps integer DEFAULT 0 NOT NULL
);


ALTER TABLE public.agent_budgets OWNER TO postgres;

--
-- Name: TABLE agent_budgets; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.agent_budgets IS 'Per-agent per-scope budget tracking (P12). Period is YYYY-MM format.';


--
-- Name: COLUMN agent_budgets.scope_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_budgets.scope_id IS 'Scoped entity id. TEXT rather than UUID: the platform types this as a string and does not constrain it to uuid form.';


--
-- Name: COLUMN agent_budgets.period; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_budgets.period IS 'Budget period, YYYY-MM-DD. Daily, matching BudgetConfig.maxCostPerDay (TASK-063).';


--
-- Name: COLUMN agent_budgets.budget_tokens; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_budgets.budget_tokens IS 'Token budget for this period. 0 = unlimited.';


--
-- Name: COLUMN agent_budgets.budget_usd; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_budgets.budget_usd IS 'USD budget for this period. 0 = unlimited.';


--
-- Name: COLUMN agent_budgets.used_usd; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_budgets.used_usd IS 'Accumulated spend for the period. NUMERIC(12,6) so sub-hundredth-of-a-cent step costs do not truncate to zero.';


--
-- Name: COLUMN agent_budgets.used_steps; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_budgets.used_steps IS 'Steps consumed in the period. Observability only (P12) — the per-trajectory step limit is enforced by runtime.ts, not by budget. Distinct from used_tokens, which this table has always had and nothing yet writes.';


--
-- Name: agent_trajectories; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.agent_trajectories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trigger text NOT NULL,
    scope_type public.trajectory_scope DEFAULT 'platform'::public.trajectory_scope NOT NULL,
    scope_id text,
    status public.trajectory_status DEFAULT 'running'::public.trajectory_status NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    total_cost jsonb DEFAULT '{"usd": 0, "tokens": 0, "apiCalls": 0}'::jsonb NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    subject_kind text NOT NULL,
    subject_id text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_trajectories_subject_kind_check CHECK ((subject_kind = ANY (ARRAY['agent'::text, 'session'::text])))
);


ALTER TABLE public.agent_trajectories OWNER TO postgres;

--
-- Name: TABLE agent_trajectories; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.agent_trajectories IS 'Durable agent execution trajectories (P18). Each row is one agent run.';


--
-- Name: COLUMN agent_trajectories.trigger; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.trigger IS 'What initiated this trajectory (e.g., "group-create", "join-request", "scheduled").';


--
-- Name: COLUMN agent_trajectories.scope_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.scope_type IS 'The scope of this trajectory: group-level, user-level, or platform-level.';


--
-- Name: COLUMN agent_trajectories.scope_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.scope_id IS 'Scoped entity id. TEXT rather than UUID: the platform types this as a string and does not constrain it to uuid form.';


--
-- Name: COLUMN agent_trajectories.steps; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.steps IS 'JSONB array of steps. Each step: {stepIndex, action, boundary, input, output, cost, durationMs, timestamp}.';


--
-- Name: COLUMN agent_trajectories.total_cost; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.total_cost IS 'Accumulated cost: {tokens: int, apiCalls: int, usd: decimal}. Updated after each step.';


--
-- Name: COLUMN agent_trajectories.subject_kind; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.subject_kind IS 'Whether this trajectory is an agent run or an application session (ADR-029 D4).';


--
-- Name: COLUMN agent_trajectories.subject_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.subject_id IS 'The agent id or the session id, per subject_kind. Replaces agent_id.';


--
-- Name: COLUMN agent_trajectories.version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.agent_trajectories.version IS 'Optimistic-concurrency counter for step append. addStep is a CAS: UPDATE ... WHERE version = expected.';


--
-- Name: app_sessions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.app_sessions (
    id text NOT NULL,
    state jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    produced_by text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.app_sessions OWNER TO postgres;

--
-- Name: TABLE app_sessions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.app_sessions IS 'ActivitySession versioned state (ADR-028 D2/D5). Authoritative system of record; trajectory persistence is separate (platform/agents).';


--
-- Name: COLUMN app_sessions.version; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_sessions.version IS 'Optimistic-concurrency counter. Commits are CAS: UPDATE ... WHERE version = expected (ADR-028 D5).';


--
-- Name: COLUMN app_sessions.produced_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_sessions.produced_by IS 'operationId of the action that produced this version — reconstructible-state guarantee (ADR-028 D2).';


--
-- Name: COLUMN app_sessions.meta; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.app_sessions.meta IS 'Session shape that is not state: definitionId, participants, budget, turn, status. Required for loadSession (TASK-071) and for turn durability.';


--
-- Name: applied_migrations; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.applied_migrations (
    filename text NOT NULL,
    confidence text NOT NULL,
    note text,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT applied_migrations_confidence_check CHECK ((confidence = ANY (ARRAY['verified'::text, 'assumed'::text, 'absent'::text])))
);


ALTER TABLE public.applied_migrations OWNER TO postgres;

--
-- Name: TABLE applied_migrations; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.applied_migrations IS 'What is known about each migration file. Query this before writing or applying a migration (TASK-065).';


--
-- Name: COLUMN applied_migrations.confidence; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.applied_migrations.confidence IS 'verified = application confirmed by introspection. assumed = inferred from object presence only, NOT evidence of application. absent = known not applied.';


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    action public.audit_action NOT NULL,
    actor_id uuid,
    target_id uuid,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.audit_log OWNER TO postgres;

--
-- Name: TABLE audit_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.audit_log IS 'Immutable audit trail. Append-only — never updated or deleted.';


--
-- Name: config_pending_approvals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.config_pending_approvals (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    config_key text NOT NULL,
    current_value jsonb,
    proposed_value jsonb NOT NULL,
    requested_by uuid,
    change_comment text NOT NULL,
    impact_summary text,
    status public.config_approval_status DEFAULT 'pending'::public.config_approval_status NOT NULL,
    reviewed_by uuid,
    review_comment text,
    reviewed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.config_pending_approvals OWNER TO postgres;

--
-- Name: TABLE config_pending_approvals; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.config_pending_approvals IS 'Two-person approval for safety-critical config changes. Built in but disabled by default.';


--
-- Name: consent_records; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.consent_records (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    consent_type text NOT NULL,
    consent_version text NOT NULL,
    granted boolean NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    ip_address inet,
    user_agent text
);


ALTER TABLE public.consent_records OWNER TO postgres;

--
-- Name: TABLE consent_records; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.consent_records IS 'Player consent records — GDPR purpose limitation.';


--
-- Name: content_safety_audit; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.content_safety_audit (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    input_hash text NOT NULL,
    direction public.screening_direction DEFAULT 'input'::public.screening_direction NOT NULL,
    content_type public.content_type DEFAULT 'generation'::public.content_type NOT NULL,
    content_rating_level integer DEFAULT 1 NOT NULL,
    user_id text,
    triggered_by public.moderation_trigger DEFAULT 'none'::public.moderation_trigger NOT NULL,
    classifier_output jsonb,
    categories_flagged text[] DEFAULT '{}'::text[] NOT NULL,
    confidence double precision DEFAULT 1.0 NOT NULL,
    severity text DEFAULT 'low'::text NOT NULL,
    action_taken public.moderation_action DEFAULT 'allow'::public.moderation_action NOT NULL,
    reasoning text DEFAULT ''::text NOT NULL,
    severity_adjustment integer DEFAULT 0 NOT NULL,
    context_factors text[] DEFAULT '{}'::text[] NOT NULL,
    attribute_to_user boolean DEFAULT true NOT NULL,
    classifier_cost_usd double precision DEFAULT 0.0 NOT NULL,
    trajectory_id text NOT NULL,
    agent_id text NOT NULL,
    pipeline_latency_ms integer DEFAULT 0 NOT NULL,
    request_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_safety_audit_content_rating_level_check CHECK (((content_rating_level >= 1) AND (content_rating_level <= 3)))
);


ALTER TABLE public.content_safety_audit OWNER TO postgres;

--
-- Name: TABLE content_safety_audit; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.content_safety_audit IS 'ADR-016: Immutable audit trail for every Guardian moderation decision. Phase 4 Sprint 2.';


--
-- Name: deletion_manifest; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.deletion_manifest (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    module_name text NOT NULL,
    table_names text[] NOT NULL,
    description text,
    registered_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.deletion_manifest OWNER TO postgres;

--
-- Name: TABLE deletion_manifest; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.deletion_manifest IS 'GDPR deletion manifest — modules register their player data tables.';


--
-- Name: document_embeddings; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.document_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chunk_id text NOT NULL,
    document_id text NOT NULL,
    content text NOT NULL,
    chunk_index integer DEFAULT 0 NOT NULL,
    start_offset integer DEFAULT 0 NOT NULL,
    end_offset integer DEFAULT 0 NOT NULL,
    embedding public.vector(1536),
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scope_key text DEFAULT ''::text NOT NULL
);


ALTER TABLE public.document_embeddings OWNER TO postgres;

--
-- Name: effect_ledger; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.effect_ledger (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id text NOT NULL,
    effect_key text NOT NULL,
    effect_type text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    idempotency_key text NOT NULL,
    request jsonb DEFAULT '{}'::jsonb NOT NULL,
    receipt jsonb,
    error text,
    attempts integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    CONSTRAINT effect_ledger_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'failed'::text, 'indeterminate'::text]))),
    CONSTRAINT effect_ledger_type_check CHECK ((effect_type = ANY (ARRAY['externalCall'::text, 'sendMessage'::text])))
);


ALTER TABLE public.effect_ledger OWNER TO postgres;

--
-- Name: entitlement_groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.entitlement_groups (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    code text NOT NULL,
    display_name text NOT NULL,
    description text,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.entitlement_groups OWNER TO postgres;

--
-- Name: TABLE entitlement_groups; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.entitlement_groups IS 'Named entitlement groups with optional expiry.';


--
-- Name: entitlement_permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.entitlement_permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    entitlement_group_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.entitlement_permissions OWNER TO postgres;

--
-- Name: TABLE entitlement_permissions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.entitlement_permissions IS 'Permissions granted by each entitlement group.';


--
-- Name: group_invites; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    inviter_id uuid NOT NULL,
    invitee_id uuid NOT NULL,
    status public.invite_status DEFAULT 'pending'::public.invite_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


ALTER TABLE public.group_invites OWNER TO postgres;

--
-- Name: TABLE group_invites; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.group_invites IS 'Invitations to join groups. P10: requires explicit accept/decline — no auto-join.';


--
-- Name: COLUMN group_invites.resolved_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.group_invites.resolved_at IS 'When the invite was accepted, declined, or expired. NULL = still pending.';


--
-- Name: group_memberships; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.group_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role public.member_role DEFAULT 'member'::public.member_role NOT NULL,
    joined_at timestamp with time zone DEFAULT now() NOT NULL,
    left_at timestamp with time zone
);


ALTER TABLE public.group_memberships OWNER TO postgres;

--
-- Name: TABLE group_memberships; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.group_memberships IS 'Tracks user membership in groups. left_at set on leave/removal (soft delete).';


--
-- Name: COLUMN group_memberships.left_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.group_memberships.left_at IS 'When user left or was removed. NULL = active member. Queries for active members filter WHERE left_at IS NULL.';


--
-- Name: groups; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    owner_id uuid NOT NULL,
    status public.group_status DEFAULT 'active'::public.group_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT groups_description_check CHECK ((char_length(description) <= 500)),
    CONSTRAINT groups_name_check CHECK (((char_length(name) >= 3) AND (char_length(name) <= 100)))
);


ALTER TABLE public.groups OWNER TO postgres;

--
-- Name: TABLE groups; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.groups IS 'Social groups — core organizational unit for social features.';


--
-- Name: COLUMN groups.metadata; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.groups.metadata IS 'Extensible JSONB metadata for agent context (P8, P16). Agents store per-group context here.';


--
-- Name: COLUMN groups.owner_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.groups.owner_id IS 'The user who created this group. Only the owner can archive.';


--
-- Name: guest_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.guest_config (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    nudge_after_seconds integer DEFAULT 3600 NOT NULL,
    grace_period_seconds integer DEFAULT 1800 NOT NULL,
    lockout_after_seconds integer DEFAULT 5400 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.guest_config OWNER TO postgres;

--
-- Name: TABLE guest_config; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.guest_config IS 'Admin-configurable guest lifecycle thresholds.';


--
-- Name: guest_usage; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.guest_usage (
    guest_id text NOT NULL,
    translations_used integer DEFAULT 0 NOT NULL,
    first_used_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT guest_usage_translations_used_check CHECK ((translations_used >= 0))
);


ALTER TABLE public.guest_usage OWNER TO postgres;

--
-- Name: TABLE guest_usage; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.guest_usage IS 'Per-guest consumption of the guest translate allowance (ADR-050 D4). Guest ids are platform-minted and namespaced (guest_ + 128 bits). Service role only.';


--
-- Name: password_policy; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.password_policy (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    role_id uuid,
    user_id uuid,
    rotation_days integer DEFAULT 90 NOT NULL,
    min_length integer DEFAULT 12 NOT NULL,
    require_uppercase boolean DEFAULT true NOT NULL,
    require_lowercase boolean DEFAULT true NOT NULL,
    require_number boolean DEFAULT true NOT NULL,
    require_special boolean DEFAULT true NOT NULL,
    password_history_count integer DEFAULT 5 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT password_policy_check CHECK ((((role_id IS NULL) AND (user_id IS NULL)) OR ((role_id IS NOT NULL) AND (user_id IS NULL)) OR ((role_id IS NULL) AND (user_id IS NOT NULL))))
);


ALTER TABLE public.password_policy OWNER TO postgres;

--
-- Name: TABLE password_policy; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.password_policy IS 'Password rotation policy. Global → role → individual override chain.';


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    code text NOT NULL,
    display_name text NOT NULL,
    description text,
    category text DEFAULT 'general'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.permissions OWNER TO postgres;

--
-- Name: TABLE permissions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.permissions IS 'Capabilities catalog. Extensible via Admin UI.';


--
-- Name: platform_config; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.platform_config (
    key text NOT NULL,
    value jsonb NOT NULL,
    description text,
    category text DEFAULT 'general'::text NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    default_value jsonb,
    value_type text DEFAULT 'string'::text NOT NULL,
    min_value jsonb,
    max_value jsonb,
    allowed_values jsonb,
    permission_tier text DEFAULT 'standard'::text NOT NULL
);


ALTER TABLE public.platform_config OWNER TO postgres;

--
-- Name: COLUMN platform_config.default_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.platform_config.default_value IS 'Intended default value (from seed migration). Separate from current value.';


--
-- Name: COLUMN platform_config.value_type; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.platform_config.value_type IS 'Drives UI input widget: string, number, boolean, string_enum, json_array.';


--
-- Name: COLUMN platform_config.min_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.platform_config.min_value IS 'Minimum allowed value (for numbers). Null for non-numeric types.';


--
-- Name: COLUMN platform_config.max_value; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.platform_config.max_value IS 'Maximum allowed value (for numbers). Null for non-numeric types.';


--
-- Name: COLUMN platform_config.allowed_values; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.platform_config.allowed_values IS 'For string_enum: JSON array of allowed values. Null for free-form types.';


--
-- Name: COLUMN platform_config.permission_tier; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.platform_config.permission_tier IS 'standard = admin can change. safety = super_admin or config_manage_safety required.';


--
-- Name: platform_config_history; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.platform_config_history (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    config_key text NOT NULL,
    previous_value jsonb,
    new_value jsonb NOT NULL,
    changed_by uuid,
    change_comment text NOT NULL,
    change_source text DEFAULT 'admin_ui'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.platform_config_history OWNER TO postgres;

--
-- Name: TABLE platform_config_history; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.platform_config_history IS 'Full audit trail for every config change. Who changed what, from what, to what, and why.';


--
-- Name: proposals; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    operation_id text NOT NULL,
    session_id text NOT NULL,
    trajectory_id text NOT NULL,
    label text NOT NULL,
    status text DEFAULT 'proposed'::text NOT NULL,
    actor_id text NOT NULL,
    actor_role text NOT NULL,
    effects jsonb DEFAULT '[]'::jsonb NOT NULL,
    effective_risk text NOT NULL,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_version integer,
    decided_by text,
    decided_at timestamp with time zone,
    decision_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposals_status_check CHECK ((status = ANY (ARRAY['proposed'::text, 'approved'::text, 'rejected'::text, 'superseded'::text])))
);


ALTER TABLE public.proposals OWNER TO postgres;

--
-- Name: purge_log; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.purge_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purge_id text NOT NULL,
    user_id text NOT NULL,
    requested_by text NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    steps_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    total_deleted integer DEFAULT 0 NOT NULL,
    requested_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT purge_log_reason_check CHECK ((reason = ANY (ARRAY['user-request'::text, 'admin-action'::text, 'account-deletion'::text, 'legal-order'::text]))),
    CONSTRAINT purge_log_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in-progress'::text, 'completed'::text, 'failed'::text, 'partial'::text])))
);


ALTER TABLE public.purge_log OWNER TO postgres;

--
-- Name: TABLE purge_log; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.purge_log IS 'GDPR purge audit trail. Records all data deletion operations for regulatory compliance.';


--
-- Name: review_queue; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.review_queue (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    source text NOT NULL,
    priority text DEFAULT 'normal'::text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    moderation_result jsonb NOT NULL,
    target_user_id uuid NOT NULL,
    request_id text NOT NULL,
    explanation_chain jsonb,
    appeal_reason text,
    original_decision_id text,
    claimed_by text,
    claimed_at timestamp with time zone,
    resolved_by text,
    resolved_at timestamp with time zone,
    decision text,
    reviewer_notes text,
    modified_action text,
    previous_account_status text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    related_strike_id text
);


ALTER TABLE public.review_queue OWNER TO postgres;

--
-- Name: TABLE review_queue; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.review_queue IS 'Human-review queue (ADR-024): escalations, ban reviews, and appeals awaiting a moderator decision. Service-role only; the app layer enforces can_moderate.';


--
-- Name: COLUMN review_queue.previous_account_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.review_queue.previous_account_status IS 'Account status before the reviewed decision; an overturn restores to this (falling back to active) rather than blanket-resetting.';


--
-- Name: COLUMN review_queue.related_strike_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.review_queue.related_strike_id IS 'Strike a ban_review actioned. AUDIT / FORENSICS ONLY — NEVER the lookup key for expiry (use user_strikes.guardian_decision_id). Lets a review row record which strike it actioned without joining to user_strikes.';


--
-- Name: role_inheritance; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.role_inheritance (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    role_id uuid NOT NULL,
    inherits_from_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT role_inheritance_check CHECK ((role_id <> inherits_from_id))
);


ALTER TABLE public.role_inheritance OWNER TO postgres;

--
-- Name: TABLE role_inheritance; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.role_inheritance IS 'Optional role inheritance. Not assumed linear.';


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.role_permissions (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    role_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    granted_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.role_permissions OWNER TO postgres;

--
-- Name: TABLE role_permissions; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.role_permissions IS 'Role-to-permission assignments.';


--
-- Name: roles; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.roles (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    name text NOT NULL,
    display_name text NOT NULL,
    description text,
    is_default boolean DEFAULT false NOT NULL,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.roles OWNER TO postgres;

--
-- Name: TABLE roles; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.roles IS 'Platform role definitions. Exactly one role per player.';


--
-- Name: user_ai_context; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_ai_context (
    user_id text NOT NULL,
    preferences jsonb DEFAULT '{}'::jsonb NOT NULL,
    patterns text[] DEFAULT '{}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.user_ai_context OWNER TO postgres;

--
-- Name: user_devices; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_devices (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    device_name text,
    is_trusted boolean DEFAULT false NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.user_devices OWNER TO postgres;

--
-- Name: TABLE user_devices; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.user_devices IS 'Devices a user has signed in from.';


--
-- Name: user_entitlements; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_entitlements (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    entitlement_group_id uuid NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    granted_by uuid,
    revoked_by uuid
);


ALTER TABLE public.user_entitlements OWNER TO postgres;

--
-- Name: TABLE user_entitlements; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.user_entitlements IS 'Maps users to entitlement groups with time-bounded grants.';


--
-- Name: user_feature_restrictions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_feature_restrictions (
    user_id uuid NOT NULL,
    feature text NOT NULL,
    reason text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE public.user_feature_restrictions OWNER TO postgres;

--
-- Name: user_interactions; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id text NOT NULL,
    input text NOT NULL,
    output text NOT NULL,
    feature text NOT NULL,
    rating integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_interactions_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


ALTER TABLE public.user_interactions OWNER TO postgres;

--
-- Name: user_strikes; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.user_strikes (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    category text NOT NULL,
    severity text DEFAULT 'medium'::text NOT NULL,
    moderation_audit_id uuid,
    trajectory_id text NOT NULL,
    agent_id text NOT NULL,
    reason text NOT NULL,
    expires_at timestamp with time zone,
    expired boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    guardian_decision_id text
);


ALTER TABLE public.user_strikes OWNER TO postgres;

--
-- Name: TABLE user_strikes; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.user_strikes IS 'Per-user, per-category strike tracking. Drives the account consequences ladder. Each strike links to a moderation audit record and Sentinel trajectory. Strikes can expire (configurable per severity). Expired strikes are not counted.';


--
-- Name: COLUMN user_strikes.category; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.category IS 'Safety category that triggered this strike (harassment, sexual, violence, etc.).';


--
-- Name: COLUMN user_strikes.severity; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.severity IS 'Severity of the violation (low, medium, high, critical).';


--
-- Name: COLUMN user_strikes.moderation_audit_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.moderation_audit_id IS 'Links to content_safety_audit record for the decision that triggered this strike.';


--
-- Name: COLUMN user_strikes.trajectory_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.trajectory_id IS 'P18: Sentinel trajectory ID for this strike decision.';


--
-- Name: COLUMN user_strikes.agent_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.agent_id IS 'P15: Sentinel agent instance that recorded this strike.';


--
-- Name: COLUMN user_strikes.expires_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.expires_at IS 'When this strike expires. NULL = never expires (for critical severity).';


--
-- Name: COLUMN user_strikes.expired; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.expired IS 'Denormalized expiry flag. Updated by cron or on-read. Avoids time-based queries on every check.';


--
-- Name: COLUMN user_strikes.guardian_decision_id; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.user_strikes.guardian_decision_id IS 'Guardian decision (moderationResult.trajectoryId) that caused this strike. CANONICAL link used to resolve the strike when a decision is overturned on human review. Distinct from trajectory_id (the Sentinel agent trajectory). Nullable for strikes recorded before migration 020.';


--
-- Name: users; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.users (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    cognito_sub text,
    guest_token text,
    email text,
    display_name text,
    avatar_url text,
    real_name text,
    role_id uuid NOT NULL,
    language_preference text DEFAULT 'en'::text NOT NULL,
    timezone text DEFAULT 'UTC'::text NOT NULL,
    profile_visibility public.profile_visibility DEFAULT 'private'::public.profile_visibility NOT NULL,
    display_name_visibility public.profile_visibility DEFAULT 'private'::public.profile_visibility NOT NULL,
    avatar_visibility public.profile_visibility DEFAULT 'private'::public.profile_visibility NOT NULL,
    language_visibility public.profile_visibility DEFAULT 'private'::public.profile_visibility NOT NULL,
    timezone_visibility public.profile_visibility DEFAULT 'private'::public.profile_visibility NOT NULL,
    email_opt_in boolean DEFAULT false NOT NULL,
    push_notifications_enabled boolean DEFAULT false NOT NULL,
    date_of_birth date,
    age_verified boolean DEFAULT false NOT NULL,
    age_verified_at timestamp with time zone,
    parental_consent_status public.parental_consent_status DEFAULT 'not_required'::public.parental_consent_status NOT NULL,
    parental_consent_email text,
    content_rating_level integer DEFAULT 1 NOT NULL,
    mfa_enabled boolean DEFAULT false NOT NULL,
    email_verified boolean DEFAULT false NOT NULL,
    guest_play_seconds integer DEFAULT 0 NOT NULL,
    guest_nudge_shown_at timestamp with time zone,
    guest_locked_out_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    deleted_at timestamp with time zone,
    account_status public.account_status DEFAULT 'active'::public.account_status NOT NULL,
    restricted_until timestamp with time zone,
    suspended_until timestamp with time zone,
    banned_at timestamp with time zone,
    ban_reason text,
    status_changed_by text,
    status_changed_at timestamp with time zone,
    coppa_enforcement_active boolean DEFAULT false NOT NULL
);


ALTER TABLE public.users OWNER TO postgres;

--
-- Name: TABLE users; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON TABLE public.users IS 'Core user record. Every user including guests.';


--
-- Name: COLUMN users.account_status; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.account_status IS 'Current account status. Drives feature access and content restrictions.';


--
-- Name: COLUMN users.restricted_until; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.restricted_until IS 'When restriction expires. NULL = not restricted. Restriction = read-only, no generation/modification.';


--
-- Name: COLUMN users.suspended_until; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.suspended_until IS 'When suspension expires. NULL = not suspended. Suspension = no platform access.';


--
-- Name: COLUMN users.banned_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.banned_at IS 'When permanent ban was applied. NULL = not banned. Ban requires human review to lift.';


--
-- Name: COLUMN users.ban_reason; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.ban_reason IS 'Human-readable reason for ban. Shown in appeal interface.';


--
-- Name: COLUMN users.status_changed_by; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.status_changed_by IS 'Who changed the status — user ID of admin, or agent ID of Sentinel.';


--
-- Name: COLUMN users.status_changed_at; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.status_changed_at IS 'When status was last changed.';


--
-- Name: COLUMN users.coppa_enforcement_active; Type: COMMENT; Schema: public; Owner: postgres
--

COMMENT ON COLUMN public.users.coppa_enforcement_active IS 'TRUE when user is under 13 AND parental consent is not granted. Set by COPPA service on age verification and consent changes. The consent gate checks this single boolean, not the compound condition.';


--
-- Name: agent_approval_policy agent_approval_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_approval_policy
    ADD CONSTRAINT agent_approval_policy_pkey PRIMARY KEY (id);


--
-- Name: agent_approval_policy agent_approval_policy_version_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_approval_policy
    ADD CONSTRAINT agent_approval_policy_version_key UNIQUE (version);


--
-- Name: agent_budgets agent_budgets_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_budgets
    ADD CONSTRAINT agent_budgets_pkey PRIMARY KEY (id);


--
-- Name: agent_trajectories agent_trajectories_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.agent_trajectories
    ADD CONSTRAINT agent_trajectories_pkey PRIMARY KEY (id);


--
-- Name: app_sessions app_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.app_sessions
    ADD CONSTRAINT app_sessions_pkey PRIMARY KEY (id);


--
-- Name: applied_migrations applied_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.applied_migrations
    ADD CONSTRAINT applied_migrations_pkey PRIMARY KEY (filename);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: config_pending_approvals config_pending_approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.config_pending_approvals
    ADD CONSTRAINT config_pending_approvals_pkey PRIMARY KEY (id);


--
-- Name: consent_records consent_records_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_pkey PRIMARY KEY (id);


--
-- Name: content_safety_audit content_safety_audit_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.content_safety_audit
    ADD CONSTRAINT content_safety_audit_pkey PRIMARY KEY (id);


--
-- Name: deletion_manifest deletion_manifest_module_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deletion_manifest
    ADD CONSTRAINT deletion_manifest_module_name_key UNIQUE (module_name);


--
-- Name: deletion_manifest deletion_manifest_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.deletion_manifest
    ADD CONSTRAINT deletion_manifest_pkey PRIMARY KEY (id);


--
-- Name: document_embeddings document_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.document_embeddings
    ADD CONSTRAINT document_embeddings_pkey PRIMARY KEY (id);


--
-- Name: effect_ledger effect_ledger_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.effect_ledger
    ADD CONSTRAINT effect_ledger_pkey PRIMARY KEY (id);


--
-- Name: entitlement_groups entitlement_groups_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_groups
    ADD CONSTRAINT entitlement_groups_code_key UNIQUE (code);


--
-- Name: entitlement_groups entitlement_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_groups
    ADD CONSTRAINT entitlement_groups_pkey PRIMARY KEY (id);


--
-- Name: entitlement_permissions entitlement_permissions_entitlement_group_id_permission_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_permissions
    ADD CONSTRAINT entitlement_permissions_entitlement_group_id_permission_id_key UNIQUE (entitlement_group_id, permission_id);


--
-- Name: entitlement_permissions entitlement_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_permissions
    ADD CONSTRAINT entitlement_permissions_pkey PRIMARY KEY (id);


--
-- Name: group_invites group_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_invites
    ADD CONSTRAINT group_invites_pkey PRIMARY KEY (id);


--
-- Name: group_memberships group_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_pkey PRIMARY KEY (id);


--
-- Name: groups groups_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_pkey PRIMARY KEY (id);


--
-- Name: guest_config guest_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guest_config
    ADD CONSTRAINT guest_config_pkey PRIMARY KEY (id);


--
-- Name: guest_usage guest_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guest_usage
    ADD CONSTRAINT guest_usage_pkey PRIMARY KEY (guest_id);


--
-- Name: password_policy password_policy_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_policy
    ADD CONSTRAINT password_policy_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_code_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_code_key UNIQUE (code);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: platform_config_history platform_config_history_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_config_history
    ADD CONSTRAINT platform_config_history_pkey PRIMARY KEY (id);


--
-- Name: platform_config platform_config_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_pkey PRIMARY KEY (key);


--
-- Name: user_devices player_devices_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT player_devices_pkey PRIMARY KEY (id);


--
-- Name: user_devices player_devices_player_id_device_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT player_devices_player_id_device_id_key UNIQUE (user_id, device_id);


--
-- Name: user_entitlements player_entitlements_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_entitlements
    ADD CONSTRAINT player_entitlements_pkey PRIMARY KEY (id);


--
-- Name: users players_cognito_sub_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT players_cognito_sub_key UNIQUE (cognito_sub);


--
-- Name: users players_guest_token_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT players_guest_token_key UNIQUE (guest_token);


--
-- Name: users players_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT players_pkey PRIMARY KEY (id);


--
-- Name: proposals proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.proposals
    ADD CONSTRAINT proposals_pkey PRIMARY KEY (id);


--
-- Name: purge_log purge_log_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.purge_log
    ADD CONSTRAINT purge_log_pkey PRIMARY KEY (id);


--
-- Name: purge_log purge_log_purge_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.purge_log
    ADD CONSTRAINT purge_log_purge_id_key UNIQUE (purge_id);


--
-- Name: review_queue review_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_pkey PRIMARY KEY (id);


--
-- Name: role_inheritance role_inheritance_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_inheritance
    ADD CONSTRAINT role_inheritance_pkey PRIMARY KEY (id);


--
-- Name: role_inheritance role_inheritance_role_id_inherits_from_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_inheritance
    ADD CONSTRAINT role_inheritance_role_id_inherits_from_id_key UNIQUE (role_id, inherits_from_id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_role_id_permission_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_permission_id_key UNIQUE (role_id, permission_id);


--
-- Name: roles roles_name_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_name_key UNIQUE (name);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: user_ai_context user_ai_context_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_ai_context
    ADD CONSTRAINT user_ai_context_pkey PRIMARY KEY (user_id);


--
-- Name: user_entitlements user_entitlements_user_id_entitlement_group_id_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_entitlements
    ADD CONSTRAINT user_entitlements_user_id_entitlement_group_id_key UNIQUE (user_id, entitlement_group_id);


--
-- Name: user_feature_restrictions user_feature_restrictions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_feature_restrictions
    ADD CONSTRAINT user_feature_restrictions_pkey PRIMARY KEY (user_id, feature);


--
-- Name: user_interactions user_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_interactions
    ADD CONSTRAINT user_interactions_pkey PRIMARY KEY (id);


--
-- Name: user_strikes user_strikes_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_strikes
    ADD CONSTRAINT user_strikes_pkey PRIMARY KEY (id);


--
-- Name: app_sessions_id_version_idx; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX app_sessions_id_version_idx ON public.app_sessions USING btree (id, version);


--
-- Name: idx_agent_approval_policy_version; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_agent_approval_policy_version ON public.agent_approval_policy USING btree (version DESC);


--
-- Name: idx_audit_log_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_log_action ON public.audit_log USING btree (action);


--
-- Name: idx_audit_log_actor; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_log_actor ON public.audit_log USING btree (actor_id) WHERE (actor_id IS NOT NULL);


--
-- Name: idx_audit_log_created; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_log_created ON public.audit_log USING btree (created_at);


--
-- Name: idx_audit_log_target; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_audit_log_target ON public.audit_log USING btree (target_id) WHERE (target_id IS NOT NULL);


--
-- Name: idx_budgets_agent_period; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_budgets_agent_period ON public.agent_budgets USING btree (agent_id, period);


--
-- Name: idx_budgets_scope; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_budgets_scope ON public.agent_budgets USING btree (scope_type, scope_id);


--
-- Name: idx_budgets_unique; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_budgets_unique ON public.agent_budgets USING btree (agent_id, scope_type, COALESCE(scope_id, ''::text), period);


--
-- Name: idx_consent_player; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_consent_player ON public.consent_records USING btree (user_id);


--
-- Name: idx_cpa_config_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_cpa_config_key ON public.config_pending_approvals USING btree (config_key);


--
-- Name: idx_cpa_requested_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_cpa_requested_by ON public.config_pending_approvals USING btree (requested_by) WHERE (requested_by IS NOT NULL);


--
-- Name: idx_cpa_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_cpa_status ON public.config_pending_approvals USING btree (status);


--
-- Name: idx_csa_action_taken; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_action_taken ON public.content_safety_audit USING btree (action_taken);


--
-- Name: idx_csa_agent_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_agent_id ON public.content_safety_audit USING btree (agent_id);


--
-- Name: idx_csa_content_type; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_content_type ON public.content_safety_audit USING btree (content_type);


--
-- Name: idx_csa_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_created_at ON public.content_safety_audit USING btree (created_at DESC);


--
-- Name: idx_csa_direction; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_direction ON public.content_safety_audit USING btree (direction);


--
-- Name: idx_csa_input_hash; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_input_hash ON public.content_safety_audit USING btree (input_hash);


--
-- Name: idx_csa_rating_action; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_rating_action ON public.content_safety_audit USING btree (content_rating_level, action_taken);


--
-- Name: idx_csa_request_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_request_id ON public.content_safety_audit USING btree (request_id);


--
-- Name: idx_csa_trajectory_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_trajectory_id ON public.content_safety_audit USING btree (trajectory_id);


--
-- Name: idx_csa_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_csa_user_id ON public.content_safety_audit USING btree (user_id) WHERE (user_id IS NOT NULL);


--
-- Name: idx_effect_ledger_operation; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_effect_ledger_operation ON public.effect_ledger USING btree (operation_id, effect_key);


--
-- Name: idx_effect_ledger_unresolved; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_effect_ledger_unresolved ON public.effect_ledger USING btree (status, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'indeterminate'::text]));


--
-- Name: idx_embeddings_document_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_embeddings_document_id ON public.document_embeddings USING btree (document_id);


--
-- Name: idx_embeddings_metadata; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_embeddings_metadata ON public.document_embeddings USING gin (metadata);


--
-- Name: idx_embeddings_scope_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_embeddings_scope_key ON public.document_embeddings USING btree (scope_key);


--
-- Name: idx_embeddings_vector; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_embeddings_vector ON public.document_embeddings USING ivfflat (embedding public.vector_cosine_ops) WITH (lists='100');


--
-- Name: idx_groups_owner_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_groups_owner_id ON public.groups USING btree (owner_id);


--
-- Name: idx_groups_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_groups_status ON public.groups USING btree (status);


--
-- Name: idx_interactions_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_interactions_created_at ON public.user_interactions USING btree (created_at DESC);


--
-- Name: idx_interactions_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_interactions_user_id ON public.user_interactions USING btree (user_id);


--
-- Name: idx_invites_group_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_invites_group_id ON public.group_invites USING btree (group_id);


--
-- Name: idx_invites_invitee; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_invites_invitee ON public.group_invites USING btree (invitee_id);


--
-- Name: idx_invites_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_invites_pending ON public.group_invites USING btree (group_id, invitee_id) WHERE (status = 'pending'::public.invite_status);


--
-- Name: idx_memberships_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_memberships_active ON public.group_memberships USING btree (group_id, user_id) WHERE (left_at IS NULL);


--
-- Name: idx_memberships_group_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memberships_group_id ON public.group_memberships USING btree (group_id);


--
-- Name: idx_memberships_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_memberships_user_id ON public.group_memberships USING btree (user_id);


--
-- Name: idx_pch_changed_by; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pch_changed_by ON public.platform_config_history USING btree (changed_by) WHERE (changed_by IS NOT NULL);


--
-- Name: idx_pch_config_key; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pch_config_key ON public.platform_config_history USING btree (config_key);


--
-- Name: idx_pch_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_pch_created_at ON public.platform_config_history USING btree (created_at DESC);


--
-- Name: idx_platform_config_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_platform_config_category ON public.platform_config USING btree (category);


--
-- Name: idx_player_devices_player; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_player_devices_player ON public.user_devices USING btree (user_id);


--
-- Name: idx_player_entitlements_expiry; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_player_entitlements_expiry ON public.user_entitlements USING btree (expires_at) WHERE ((expires_at IS NOT NULL) AND (revoked_at IS NULL));


--
-- Name: idx_proposals_live; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX idx_proposals_live ON public.proposals USING btree (operation_id) WHERE (status = 'proposed'::text);


--
-- Name: idx_proposals_operation; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_proposals_operation ON public.proposals USING btree (operation_id);


--
-- Name: idx_proposals_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_proposals_status ON public.proposals USING btree (status, created_at DESC);


--
-- Name: idx_proposals_trajectory; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_proposals_trajectory ON public.proposals USING btree (trajectory_id);


--
-- Name: idx_purge_log_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_purge_log_status ON public.purge_log USING btree (status);


--
-- Name: idx_purge_log_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_purge_log_user_id ON public.purge_log USING btree (user_id);


--
-- Name: idx_review_queue_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_created_at ON public.review_queue USING btree (created_at DESC);


--
-- Name: idx_review_queue_original_decision; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_original_decision ON public.review_queue USING btree (original_decision_id) WHERE (original_decision_id IS NOT NULL);


--
-- Name: idx_review_queue_pending; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_pending ON public.review_queue USING btree (priority, created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_review_queue_source; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_source ON public.review_queue USING btree (source);


--
-- Name: idx_review_queue_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_status ON public.review_queue USING btree (status);


--
-- Name: idx_review_queue_target_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_review_queue_target_user ON public.review_queue USING btree (target_user_id);


--
-- Name: idx_strikes_active; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_strikes_active ON public.user_strikes USING btree (user_id, expired) WHERE (expired = false);


--
-- Name: idx_strikes_category; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_strikes_category ON public.user_strikes USING btree (user_id, category) WHERE (expired = false);


--
-- Name: idx_strikes_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_strikes_created_at ON public.user_strikes USING btree (created_at DESC);


--
-- Name: idx_strikes_user_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_strikes_user_id ON public.user_strikes USING btree (user_id);


--
-- Name: idx_trajectories_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trajectories_created_at ON public.agent_trajectories USING btree (created_at DESC);


--
-- Name: idx_trajectories_scope; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trajectories_scope ON public.agent_trajectories USING btree (scope_type, scope_id);


--
-- Name: idx_trajectories_started_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trajectories_started_at ON public.agent_trajectories USING btree (started_at DESC);


--
-- Name: idx_trajectories_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trajectories_status ON public.agent_trajectories USING btree (status);


--
-- Name: idx_trajectories_subject; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_trajectories_subject ON public.agent_trajectories USING btree (subject_kind, subject_id);


--
-- Name: idx_user_entitlements_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_entitlements_user ON public.user_entitlements USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: idx_user_feature_restrictions_user; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_user_feature_restrictions_user ON public.user_feature_restrictions USING btree (user_id);


--
-- Name: idx_users_account_status; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_account_status ON public.users USING btree (account_status) WHERE (account_status <> 'active'::public.account_status);


--
-- Name: idx_users_cognito_sub; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_cognito_sub ON public.users USING btree (cognito_sub) WHERE (cognito_sub IS NOT NULL);


--
-- Name: idx_users_coppa_enforcement; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_coppa_enforcement ON public.users USING btree (coppa_enforcement_active) WHERE (coppa_enforcement_active = true);


--
-- Name: idx_users_created_at; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_created_at ON public.users USING btree (created_at);


--
-- Name: idx_users_email; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_email ON public.users USING btree (email) WHERE (email IS NOT NULL);


--
-- Name: idx_users_guest_token; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_guest_token ON public.users USING btree (guest_token) WHERE (guest_token IS NOT NULL);


--
-- Name: idx_users_role_id; Type: INDEX; Schema: public; Owner: postgres
--

CREATE INDEX idx_users_role_id ON public.users USING btree (role_id);


--
-- Name: uq_embeddings_scope_chunk; Type: INDEX; Schema: public; Owner: postgres
--

CREATE UNIQUE INDEX uq_embeddings_scope_chunk ON public.document_embeddings USING btree (scope_key, chunk_id);


--
-- Name: entitlement_groups set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.entitlement_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: guest_config set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.guest_config FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: password_policy set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.password_policy FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: permissions set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.permissions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: review_queue set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.review_queue FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: roles set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: users set_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: agent_budgets trg_agent_budgets_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_agent_budgets_updated_at BEFORE UPDATE ON public.agent_budgets FOR EACH ROW EXECUTE FUNCTION public.update_agent_budgets_updated_at();


--
-- Name: groups trg_groups_updated_at; Type: TRIGGER; Schema: public; Owner: postgres
--

CREATE TRIGGER trg_groups_updated_at BEFORE UPDATE ON public.groups FOR EACH ROW EXECUTE FUNCTION public.update_groups_updated_at();


--
-- Name: config_pending_approvals config_pending_approvals_config_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.config_pending_approvals
    ADD CONSTRAINT config_pending_approvals_config_key_fkey FOREIGN KEY (config_key) REFERENCES public.platform_config(key) ON DELETE CASCADE;


--
-- Name: config_pending_approvals config_pending_approvals_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.config_pending_approvals
    ADD CONSTRAINT config_pending_approvals_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.users(id);


--
-- Name: config_pending_approvals config_pending_approvals_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.config_pending_approvals
    ADD CONSTRAINT config_pending_approvals_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: consent_records consent_records_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.consent_records
    ADD CONSTRAINT consent_records_player_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: entitlement_groups entitlement_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_groups
    ADD CONSTRAINT entitlement_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: entitlement_permissions entitlement_permissions_entitlement_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_permissions
    ADD CONSTRAINT entitlement_permissions_entitlement_group_id_fkey FOREIGN KEY (entitlement_group_id) REFERENCES public.entitlement_groups(id) ON DELETE CASCADE;


--
-- Name: entitlement_permissions entitlement_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.entitlement_permissions
    ADD CONSTRAINT entitlement_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: group_invites group_invites_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_invites
    ADD CONSTRAINT group_invites_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_invites group_invites_invitee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_invites
    ADD CONSTRAINT group_invites_invitee_id_fkey FOREIGN KEY (invitee_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_invites group_invites_inviter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_invites
    ADD CONSTRAINT group_invites_inviter_id_fkey FOREIGN KEY (inviter_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: group_memberships group_memberships_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.groups(id) ON DELETE CASCADE;


--
-- Name: group_memberships group_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.group_memberships
    ADD CONSTRAINT group_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: groups groups_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.groups
    ADD CONSTRAINT groups_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: guest_config guest_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.guest_config
    ADD CONSTRAINT guest_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: password_policy password_policy_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_policy
    ADD CONSTRAINT password_policy_player_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: password_policy password_policy_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.password_policy
    ADD CONSTRAINT password_policy_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: platform_config_history platform_config_history_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_config_history
    ADD CONSTRAINT platform_config_history_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES public.users(id);


--
-- Name: platform_config_history platform_config_history_config_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_config_history
    ADD CONSTRAINT platform_config_history_config_key_fkey FOREIGN KEY (config_key) REFERENCES public.platform_config(key) ON DELETE CASCADE;


--
-- Name: platform_config platform_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.platform_config
    ADD CONSTRAINT platform_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: user_devices player_devices_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_devices
    ADD CONSTRAINT player_devices_player_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_entitlements player_entitlements_entitlement_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_entitlements
    ADD CONSTRAINT player_entitlements_entitlement_group_id_fkey FOREIGN KEY (entitlement_group_id) REFERENCES public.entitlement_groups(id) ON DELETE CASCADE;


--
-- Name: user_entitlements player_entitlements_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_entitlements
    ADD CONSTRAINT player_entitlements_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_entitlements player_entitlements_player_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_entitlements
    ADD CONSTRAINT player_entitlements_player_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_entitlements player_entitlements_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_entitlements
    ADD CONSTRAINT player_entitlements_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES public.users(id);


--
-- Name: users players_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT players_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id);


--
-- Name: review_queue review_queue_target_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.review_queue
    ADD CONSTRAINT review_queue_target_user_id_fkey FOREIGN KEY (target_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: role_inheritance role_inheritance_inherits_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_inheritance
    ADD CONSTRAINT role_inheritance_inherits_from_id_fkey FOREIGN KEY (inherits_from_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: role_inheritance role_inheritance_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_inheritance
    ADD CONSTRAINT role_inheritance_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: user_feature_restrictions user_feature_restrictions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_feature_restrictions
    ADD CONSTRAINT user_feature_restrictions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_interactions user_interactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_interactions
    ADD CONSTRAINT user_interactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.user_ai_context(user_id) ON DELETE CASCADE;


--
-- Name: user_strikes user_strikes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.user_strikes
    ADD CONSTRAINT user_strikes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_entitlements Admins can read all player entitlements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read all player entitlements" ON public.user_entitlements FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: users Admins can read all players; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read all players" ON public.users FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: audit_log Admins can read audit log; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read audit log" ON public.audit_log FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: deletion_manifest Admins can read deletion manifest; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Admins can read deletion manifest" ON public.deletion_manifest FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: entitlement_groups Entitlement groups are readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Entitlement groups are readable by all authenticated users" ON public.entitlement_groups FOR SELECT TO authenticated USING (true);


--
-- Name: entitlement_permissions Entitlement permissions are readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Entitlement permissions are readable by all authenticated users" ON public.entitlement_permissions FOR SELECT TO authenticated USING (true);


--
-- Name: guest_config Guest config is readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Guest config is readable by all authenticated users" ON public.guest_config FOR SELECT TO authenticated USING (true);


--
-- Name: password_policy Password policy is readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Password policy is readable by all authenticated users" ON public.password_policy FOR SELECT TO authenticated USING (true);


--
-- Name: permissions Permissions are readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Permissions are readable by all authenticated users" ON public.permissions FOR SELECT TO authenticated USING (true);


--
-- Name: user_devices Players can delete their own devices; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can delete their own devices" ON public.user_devices FOR DELETE TO authenticated USING ((user_id = public.get_current_user_id()));


--
-- Name: consent_records Players can insert their own consent records; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can insert their own consent records" ON public.consent_records FOR INSERT TO authenticated WITH CHECK ((user_id = public.get_current_user_id()));


--
-- Name: audit_log Players can read their own audit entries; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can read their own audit entries" ON public.audit_log FOR SELECT TO authenticated USING ((target_id = public.get_current_user_id()));


--
-- Name: consent_records Players can read their own consent records; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can read their own consent records" ON public.consent_records FOR SELECT TO authenticated USING ((user_id = public.get_current_user_id()));


--
-- Name: user_devices Players can read their own devices; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can read their own devices" ON public.user_devices FOR SELECT TO authenticated USING ((user_id = public.get_current_user_id()));


--
-- Name: user_entitlements Players can read their own entitlements; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can read their own entitlements" ON public.user_entitlements FOR SELECT TO authenticated USING ((user_id = public.get_current_user_id()));


--
-- Name: users Players can read their own record; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can read their own record" ON public.users FOR SELECT TO authenticated USING (((cognito_sub = (auth.uid())::text) AND (deleted_at IS NULL)));


--
-- Name: users Players can update their own record; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Players can update their own record" ON public.users FOR UPDATE TO authenticated USING (((cognito_sub = (auth.uid())::text) AND (deleted_at IS NULL))) WITH CHECK (((cognito_sub = (auth.uid())::text) AND (deleted_at IS NULL)));


--
-- Name: role_inheritance Role inheritance is readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Role inheritance is readable by all authenticated users" ON public.role_inheritance FOR SELECT TO authenticated USING (true);


--
-- Name: role_permissions Role permissions are readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Role permissions are readable by all authenticated users" ON public.role_permissions FOR SELECT TO authenticated USING (true);


--
-- Name: roles Roles are readable by all authenticated users; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY "Roles are readable by all authenticated users" ON public.roles FOR SELECT TO authenticated USING (true);


--
-- Name: agent_approval_policy; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.agent_approval_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_approval_policy agent_approval_policy_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY agent_approval_policy_service_all ON public.agent_approval_policy USING ((auth.role() = 'service_role'::text));


--
-- Name: agent_budgets; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.agent_budgets ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_trajectories; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.agent_trajectories ENABLE ROW LEVEL SECURITY;

--
-- Name: app_sessions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.app_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: app_sessions app_sessions_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY app_sessions_service_all ON public.app_sessions USING ((auth.role() = 'service_role'::text));


--
-- Name: applied_migrations; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.applied_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: applied_migrations applied_migrations_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY applied_migrations_service_all ON public.applied_migrations USING ((auth.role() = 'service_role'::text));


--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: agent_budgets budgets_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY budgets_service_all ON public.agent_budgets USING ((auth.role() = 'service_role'::text));


--
-- Name: config_pending_approvals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.config_pending_approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_records; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.consent_records ENABLE ROW LEVEL SECURITY;

--
-- Name: content_safety_audit; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.content_safety_audit ENABLE ROW LEVEL SECURITY;

--
-- Name: config_pending_approvals cpa_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY cpa_service_all ON public.config_pending_approvals USING ((auth.role() = 'service_role'::text));


--
-- Name: deletion_manifest; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.deletion_manifest ENABLE ROW LEVEL SECURITY;

--
-- Name: document_embeddings; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.document_embeddings ENABLE ROW LEVEL SECURITY;

--
-- Name: effect_ledger; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.effect_ledger ENABLE ROW LEVEL SECURITY;

--
-- Name: effect_ledger effect_ledger_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY effect_ledger_service_all ON public.effect_ledger USING ((auth.role() = 'service_role'::text));


--
-- Name: entitlement_groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.entitlement_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: entitlement_permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.entitlement_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: group_invites; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: group_memberships; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.group_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: groups; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

--
-- Name: groups groups_insert_auth; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY groups_insert_auth ON public.groups FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: groups groups_select_member; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY groups_select_member ON public.groups FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.group_memberships
  WHERE ((group_memberships.group_id = groups.id) AND (group_memberships.user_id = auth.uid()) AND (group_memberships.left_at IS NULL)))));


--
-- Name: groups groups_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY groups_service_all ON public.groups USING ((auth.role() = 'service_role'::text));


--
-- Name: groups groups_update_owner; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY groups_update_owner ON public.groups FOR UPDATE USING ((owner_id = auth.uid()));


--
-- Name: guest_config; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.guest_config ENABLE ROW LEVEL SECURITY;

--
-- Name: guest_usage; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.guest_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: group_invites invites_insert_member; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY invites_insert_member ON public.group_invites FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.group_memberships
  WHERE ((group_memberships.group_id = group_invites.group_id) AND (group_memberships.user_id = auth.uid()) AND (group_memberships.left_at IS NULL)))));


--
-- Name: group_invites invites_select_invitee; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY invites_select_invitee ON public.group_invites FOR SELECT USING ((invitee_id = auth.uid()));


--
-- Name: group_invites invites_select_member; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY invites_select_member ON public.group_invites FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.group_memberships
  WHERE ((group_memberships.group_id = group_invites.group_id) AND (group_memberships.user_id = auth.uid()) AND (group_memberships.left_at IS NULL)))));


--
-- Name: group_invites invites_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY invites_service_all ON public.group_invites USING ((auth.role() = 'service_role'::text));


--
-- Name: group_invites invites_update_invitee; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY invites_update_invitee ON public.group_invites FOR UPDATE USING ((invitee_id = auth.uid()));


--
-- Name: group_memberships memberships_select_member; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY memberships_select_member ON public.group_memberships FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.group_memberships gm
  WHERE ((gm.group_id = group_memberships.group_id) AND (gm.user_id = auth.uid()) AND (gm.left_at IS NULL)))));


--
-- Name: group_memberships memberships_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY memberships_service_all ON public.group_memberships USING ((auth.role() = 'service_role'::text));


--
-- Name: password_policy; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.password_policy ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_config_history pch_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY pch_service_all ON public.platform_config_history USING ((auth.role() = 'service_role'::text));


--
-- Name: permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_config; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.platform_config ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_config_history; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.platform_config_history ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_config platform_config_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY platform_config_service_all ON public.platform_config USING ((auth.role() = 'service_role'::text));


--
-- Name: proposals; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: proposals proposals_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY proposals_service_all ON public.proposals USING ((auth.role() = 'service_role'::text));


--
-- Name: purge_log; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.purge_log ENABLE ROW LEVEL SECURITY;

--
-- Name: purge_log purge_log_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY purge_log_service_all ON public.purge_log USING ((auth.role() = 'service_role'::text));


--
-- Name: review_queue; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.review_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: review_queue review_queue_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY review_queue_service_all ON public.review_queue USING ((auth.role() = 'service_role'::text));


--
-- Name: role_inheritance; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.role_inheritance ENABLE ROW LEVEL SECURITY;

--
-- Name: role_permissions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: roles; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;

--
-- Name: document_embeddings service_role_embeddings; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY service_role_embeddings ON public.document_embeddings TO service_role USING (true);


--
-- Name: user_interactions service_role_interactions; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY service_role_interactions ON public.user_interactions TO service_role USING (true);


--
-- Name: user_ai_context service_role_user_context; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY service_role_user_context ON public.user_ai_context TO service_role USING (true);


--
-- Name: user_strikes strikes_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY strikes_service_all ON public.user_strikes USING ((auth.role() = 'service_role'::text));


--
-- Name: agent_trajectories trajectories_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY trajectories_service_all ON public.agent_trajectories USING ((auth.role() = 'service_role'::text));


--
-- Name: user_ai_context; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_ai_context ENABLE ROW LEVEL SECURITY;

--
-- Name: user_devices; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;

--
-- Name: user_entitlements; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_entitlements ENABLE ROW LEVEL SECURITY;

--
-- Name: user_feature_restrictions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_feature_restrictions ENABLE ROW LEVEL SECURITY;

--
-- Name: user_feature_restrictions user_feature_restrictions_service_all; Type: POLICY; Schema: public; Owner: postgres
--

CREATE POLICY user_feature_restrictions_service_all ON public.user_feature_restrictions USING ((auth.role() = 'service_role'::text));


--
-- Name: user_interactions; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_interactions ENABLE ROW LEVEL SECURITY;

--
-- Name: user_strikes; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.user_strikes ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: public; Owner: postgres
--

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: pg_database_owner
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) TO anon;
GRANT ALL ON FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) TO authenticated;
GRANT ALL ON FUNCTION public.agent_budget_consume(p_agent_id text, p_scope_type public.trajectory_scope, p_scope_id text, p_period text, p_delta_usd numeric, p_delta_steps integer) TO service_role;


--
-- Name: FUNCTION get_current_user_id(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.get_current_user_id() TO anon;
GRANT ALL ON FUNCTION public.get_current_user_id() TO authenticated;
GRANT ALL ON FUNCTION public.get_current_user_id() TO service_role;


--
-- Name: FUNCTION guest_allowance_consume(p_guest_id text, p_limit integer); Type: ACL; Schema: public; Owner: postgres
--

REVOKE ALL ON FUNCTION public.guest_allowance_consume(p_guest_id text, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.guest_allowance_consume(p_guest_id text, p_limit integer) TO service_role;


--
-- Name: FUNCTION has_permission(permission_code text); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.has_permission(permission_code text) TO anon;
GRANT ALL ON FUNCTION public.has_permission(permission_code text) TO authenticated;
GRANT ALL ON FUNCTION public.has_permission(permission_code text) TO service_role;


--
-- Name: FUNCTION is_admin(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.is_admin() TO anon;
GRANT ALL ON FUNCTION public.is_admin() TO authenticated;
GRANT ALL ON FUNCTION public.is_admin() TO service_role;


--
-- Name: FUNCTION update_agent_budgets_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_agent_budgets_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_agent_budgets_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_agent_budgets_updated_at() TO service_role;


--
-- Name: FUNCTION update_groups_updated_at(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_groups_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_groups_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_groups_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: TABLE agent_approval_policy; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.agent_approval_policy TO anon;
GRANT ALL ON TABLE public.agent_approval_policy TO authenticated;
GRANT ALL ON TABLE public.agent_approval_policy TO service_role;


--
-- Name: TABLE agent_budgets; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.agent_budgets TO anon;
GRANT ALL ON TABLE public.agent_budgets TO authenticated;
GRANT ALL ON TABLE public.agent_budgets TO service_role;


--
-- Name: TABLE agent_trajectories; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.agent_trajectories TO anon;
GRANT ALL ON TABLE public.agent_trajectories TO authenticated;
GRANT ALL ON TABLE public.agent_trajectories TO service_role;


--
-- Name: TABLE app_sessions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.app_sessions TO anon;
GRANT ALL ON TABLE public.app_sessions TO authenticated;
GRANT ALL ON TABLE public.app_sessions TO service_role;


--
-- Name: TABLE applied_migrations; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.applied_migrations TO anon;
GRANT ALL ON TABLE public.applied_migrations TO authenticated;
GRANT ALL ON TABLE public.applied_migrations TO service_role;


--
-- Name: TABLE audit_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.audit_log TO anon;
GRANT ALL ON TABLE public.audit_log TO authenticated;
GRANT ALL ON TABLE public.audit_log TO service_role;


--
-- Name: TABLE config_pending_approvals; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.config_pending_approvals TO anon;
GRANT ALL ON TABLE public.config_pending_approvals TO authenticated;
GRANT ALL ON TABLE public.config_pending_approvals TO service_role;


--
-- Name: TABLE consent_records; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.consent_records TO anon;
GRANT ALL ON TABLE public.consent_records TO authenticated;
GRANT ALL ON TABLE public.consent_records TO service_role;


--
-- Name: TABLE content_safety_audit; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.content_safety_audit TO anon;
GRANT ALL ON TABLE public.content_safety_audit TO authenticated;
GRANT ALL ON TABLE public.content_safety_audit TO service_role;


--
-- Name: TABLE deletion_manifest; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.deletion_manifest TO anon;
GRANT ALL ON TABLE public.deletion_manifest TO authenticated;
GRANT ALL ON TABLE public.deletion_manifest TO service_role;


--
-- Name: TABLE document_embeddings; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.document_embeddings TO anon;
GRANT ALL ON TABLE public.document_embeddings TO authenticated;
GRANT ALL ON TABLE public.document_embeddings TO service_role;


--
-- Name: TABLE effect_ledger; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.effect_ledger TO anon;
GRANT ALL ON TABLE public.effect_ledger TO authenticated;
GRANT ALL ON TABLE public.effect_ledger TO service_role;


--
-- Name: TABLE entitlement_groups; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.entitlement_groups TO anon;
GRANT ALL ON TABLE public.entitlement_groups TO authenticated;
GRANT ALL ON TABLE public.entitlement_groups TO service_role;


--
-- Name: TABLE entitlement_permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.entitlement_permissions TO anon;
GRANT ALL ON TABLE public.entitlement_permissions TO authenticated;
GRANT ALL ON TABLE public.entitlement_permissions TO service_role;


--
-- Name: TABLE group_invites; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.group_invites TO anon;
GRANT ALL ON TABLE public.group_invites TO authenticated;
GRANT ALL ON TABLE public.group_invites TO service_role;


--
-- Name: TABLE group_memberships; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.group_memberships TO anon;
GRANT ALL ON TABLE public.group_memberships TO authenticated;
GRANT ALL ON TABLE public.group_memberships TO service_role;


--
-- Name: TABLE groups; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.groups TO anon;
GRANT ALL ON TABLE public.groups TO authenticated;
GRANT ALL ON TABLE public.groups TO service_role;


--
-- Name: TABLE guest_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.guest_config TO anon;
GRANT ALL ON TABLE public.guest_config TO authenticated;
GRANT ALL ON TABLE public.guest_config TO service_role;


--
-- Name: TABLE guest_usage; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.guest_usage TO anon;
GRANT ALL ON TABLE public.guest_usage TO authenticated;
GRANT ALL ON TABLE public.guest_usage TO service_role;


--
-- Name: TABLE password_policy; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.password_policy TO anon;
GRANT ALL ON TABLE public.password_policy TO authenticated;
GRANT ALL ON TABLE public.password_policy TO service_role;


--
-- Name: TABLE permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.permissions TO anon;
GRANT ALL ON TABLE public.permissions TO authenticated;
GRANT ALL ON TABLE public.permissions TO service_role;


--
-- Name: TABLE platform_config; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.platform_config TO anon;
GRANT ALL ON TABLE public.platform_config TO authenticated;
GRANT ALL ON TABLE public.platform_config TO service_role;


--
-- Name: TABLE platform_config_history; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.platform_config_history TO anon;
GRANT ALL ON TABLE public.platform_config_history TO authenticated;
GRANT ALL ON TABLE public.platform_config_history TO service_role;


--
-- Name: TABLE proposals; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.proposals TO anon;
GRANT ALL ON TABLE public.proposals TO authenticated;
GRANT ALL ON TABLE public.proposals TO service_role;


--
-- Name: TABLE purge_log; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.purge_log TO anon;
GRANT ALL ON TABLE public.purge_log TO authenticated;
GRANT ALL ON TABLE public.purge_log TO service_role;


--
-- Name: TABLE review_queue; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.review_queue TO anon;
GRANT ALL ON TABLE public.review_queue TO authenticated;
GRANT ALL ON TABLE public.review_queue TO service_role;


--
-- Name: TABLE role_inheritance; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.role_inheritance TO anon;
GRANT ALL ON TABLE public.role_inheritance TO authenticated;
GRANT ALL ON TABLE public.role_inheritance TO service_role;


--
-- Name: TABLE role_permissions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.role_permissions TO anon;
GRANT ALL ON TABLE public.role_permissions TO authenticated;
GRANT ALL ON TABLE public.role_permissions TO service_role;


--
-- Name: TABLE roles; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.roles TO anon;
GRANT ALL ON TABLE public.roles TO authenticated;
GRANT ALL ON TABLE public.roles TO service_role;


--
-- Name: TABLE user_ai_context; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_ai_context TO anon;
GRANT ALL ON TABLE public.user_ai_context TO authenticated;
GRANT ALL ON TABLE public.user_ai_context TO service_role;


--
-- Name: TABLE user_devices; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_devices TO anon;
GRANT ALL ON TABLE public.user_devices TO authenticated;
GRANT ALL ON TABLE public.user_devices TO service_role;


--
-- Name: TABLE user_entitlements; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_entitlements TO anon;
GRANT ALL ON TABLE public.user_entitlements TO authenticated;
GRANT ALL ON TABLE public.user_entitlements TO service_role;


--
-- Name: TABLE user_feature_restrictions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_feature_restrictions TO anon;
GRANT ALL ON TABLE public.user_feature_restrictions TO authenticated;
GRANT ALL ON TABLE public.user_feature_restrictions TO service_role;


--
-- Name: TABLE user_interactions; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_interactions TO anon;
GRANT ALL ON TABLE public.user_interactions TO authenticated;
GRANT ALL ON TABLE public.user_interactions TO service_role;


--
-- Name: TABLE user_strikes; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.user_strikes TO anon;
GRANT ALL ON TABLE public.user_strikes TO authenticated;
GRANT ALL ON TABLE public.user_strikes TO service_role;


--
-- Name: TABLE users; Type: ACL; Schema: public; Owner: postgres
--

GRANT ALL ON TABLE public.users TO anon;
GRANT ALL ON TABLE public.users TO authenticated;
GRANT ALL ON TABLE public.users TO service_role;



-- ── Seed: governance configuration (roles, permissions, config) ───────────────

INSERT INTO public.deletion_manifest (id, module_name, table_names, description, registered_at) VALUES ('07bebb81-0390-47a8-a772-347fa01a5033', 'auth', '{players,player_devices,consent_records}', 'Core auth and player profile data', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.deletion_manifest (id, module_name, table_names, description, registered_at) VALUES ('3df01511-bf78-4b9c-a7e8-a9ecaa22ba9b', 'permissions', '{role_permissions,player_entitlements}', 'Player role and entitlement assignments', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.deletion_manifest (id, module_name, table_names, description, registered_at) VALUES ('928fcb04-b308-4e56-b2b1-a274b5bca6f1', 'audit', '{audit_log}', 'Audit trail entries (anonymized on deletion, not fully removed)', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('04ce5944-f567-42e3-9f17-5275c64a92c5', 'can_play', 'Can Play', 'Access gameplay', 'gameplay', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('2d3f8c48-10e7-44dc-b277-1de209bc514f', 'can_translate', 'Can Translate', 'Use translation feature', 'gameplay', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('884f599a-f944-4cd4-ab38-4e19befa6093', 'can_create_group', 'Can Create Group', 'Form player groups', 'social', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('ee31019b-d4e5-4e89-b5d3-63af955a764c', 'can_view_profile', 'Can View Profile', 'View own profile', 'profile', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('43c6fa08-ac97-40b6-890a-68a88cfc45bf', 'can_edit_profile', 'Can Edit Profile', 'Edit own profile fields', 'profile', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('c79e882f-9662-4dcf-bc82-df97366e1378', 'can_export_data', 'Can Export Data', 'Download own data (GDPR)', 'privacy', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('4f55510e-e631-431f-aa18-ffb6ba9dc9ed', 'can_delete_account', 'Can Delete Account', 'Delete own account (GDPR)', 'privacy', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('d1064e98-9b7b-4a11-a4d3-806cb079da82', 'can_access_admin', 'Can Access Admin', 'Access admin UI', 'admin', '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('3fe86a54-d123-48a2-a038-b69c6e4b7b07', 'config_view', 'View Configuration', 'View all platform configuration entries and history', 'admin', '2026-04-22 21:46:41.293731+00', '2026-04-22 21:46:41.293731+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('4c994f84-417b-41cc-8988-24282fd5d84d', 'config_manage_standard', 'Manage Standard Config', 'Edit standard-tier configuration entries', 'admin', '2026-04-22 21:46:41.293731+00', '2026-04-22 21:46:41.293731+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('4ad968bf-2791-4d95-a10b-066aef9d50c9', 'config_manage_safety', 'Manage Safety Config', 'Edit safety-critical configuration entries (moderation, strikes, COPPA)', 'admin', '2026-04-22 21:46:41.293731+00', '2026-04-22 21:46:41.293731+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('5d3128fc-d43d-4b17-bf1e-c9863c68a567', 'can_moderate', 'Can Moderate', 'Review and resolve escalated moderation items and appeals', 'moderation', '2026-05-31 22:01:31.684603+00', '2026-05-31 22:01:31.684603+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('35ef59cc-f625-46c2-a483-d92a3c2a9095', 'admin_view_audit', 'View Audit Log', 'Read audit trail entries', 'admin', '2026-03-30 02:26:16.933408+00', '2026-06-01 00:38:34.888539+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('2244cc39-49a4-49fb-8fea-78ecb569f3c4', 'admin_manage_roles', 'Manage Roles', 'Create, edit, delete roles and role-permission mappings', 'admin', '2026-03-30 02:26:16.933408+00', '2026-06-01 00:38:34.888539+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('61cb707c-cb7c-4a1e-9eed-8a48e772cef6', 'admin_manage_entitlements', 'Manage Entitlements', 'Create, grant, revoke entitlement groups', 'admin', '2026-03-30 02:26:16.933408+00', '2026-06-01 00:38:34.888539+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('7a1b3bd4-8ca5-48b1-99dd-91bb15d199a7', 'admin_manage_config', 'Manage Config', 'Edit governance config (password policy, guest config)', 'admin', '2026-06-01 00:38:34.888539+00', '2026-06-01 00:38:34.888539+00');
INSERT INTO public.permissions (id, code, display_name, description, category, created_at, updated_at) VALUES ('5f25965b-d938-48c1-95b1-32a37ecbc3c1', 'admin_manage_users', 'Manage Users', 'Edit user roles and view user data', 'admin', '2026-06-01 00:38:34.888539+00', '2026-06-01 00:38:34.888539+00');
INSERT INTO public.guest_config (id, nudge_after_seconds, grace_period_seconds, lockout_after_seconds, updated_by, updated_at) VALUES ('99529dc4-3200-45bf-b690-62f65b725c7a', 3600, 1800, 5400, NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('2e9fbb42-97f2-4124-bc22-3183bdf71769', 'guest', 'Guest', 'Anonymous player with persistent token. Time-limited play, no translate.', false, 0, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('ab5ec681-547a-4c02-b0a7-3137313382ac', 'free', 'Free', 'Registered player with email verified. Full access, ad-supported.', true, 1, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('596c9f9b-1d93-4597-9205-f24cea8a7f83', 'daily', 'Daily', 'Paid — 24-hour access pass.', false, 2, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('57728fff-85f9-4458-b3f5-ac96e7a0b593', 'monthly', 'Monthly', 'Paid — monthly subscription.', false, 3, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('c3f5559f-1637-48bc-8742-21920e139397', 'annual', 'Annual', 'Paid — annual subscription.', false, 4, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('2c96263a-eba5-41af-b3d5-3088daec1f53', 'lifetime', 'Lifetime', 'Paid — one-time purchase, permanent access.', false, 5, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('9de4502e-b3d9-4a9b-ba63-ed92f30552c2', 'admin', 'Admin', 'Platform operator. Full access + admin UI.', false, 6, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('d3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', 'super_admin', 'Super Admin', 'Governance access. Cannot be self-assigned via the UI.', false, 7, '2026-06-01 00:38:34.888539+00', '2026-06-01 00:38:34.888539+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('e2517f29-2e76-4663-a2b4-b30be77fbc67', 'moderator', 'Moderator', 'Reviews escalated moderation decisions and user appeals. No governance access.', false, 8, '2026-05-31 22:15:36.651568+00', '2026-06-06 13:55:48.439431+00');
INSERT INTO public.roles (id, name, display_name, description, is_default, sort_order, created_at, updated_at) VALUES ('1e00ee1e-085c-4840-8921-4d32c52716f3', 'safety_approver', 'Safety Approver', 'Independent approver for dual-controlled safety-config changes (ADR-040). Views and co-signs safety changes; cannot manage users, entitlements, or roles.', false, 4, '2026-09-26 21:53:58.967204+00', '2026-09-26 21:53:58.967204+00');
INSERT INTO public.password_policy (id, role_id, user_id, rotation_days, min_length, require_uppercase, require_lowercase, require_number, require_special, password_history_count, created_at, updated_at) VALUES ('68117574-dda1-498d-812e-5d3b34840f20', NULL, NULL, 90, 12, true, true, true, true, 5, '2026-03-30 02:26:16.933408+00', '2026-03-30 02:26:16.933408+00');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('maintenance_mode', 'false', 'When true, all non-admin requests return 503', 'system', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', 'false', 'boolean', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('signups_enabled', 'true', 'When false, new registrations are blocked', 'system', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', 'true', 'boolean', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('max_devices_per_player', '5', 'Maximum devices a player can register', 'limits', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '5', 'number', '1', '20', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('rate_limit_rpm', '60', 'Default API rate limit (requests per minute)', 'limits', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '60', 'number', '10', '1000', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('default_language', '"en"', 'Default UI language code', 'i18n', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"en"', 'string', NULL, NULL, '["en", "hi", "es", "fr", "de", "ja", "ko", "zh", "pt", "ar"]', 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('supported_languages', '["en", "hi", "es", "fr", "de", "ja", "ko", "zh", "pt", "ar"]', 'Languages available in the platform', 'i18n', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '["en", "hi", "es", "fr", "de", "ja", "ko", "zh", "pt", "ar"]', 'json_array', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('guest_session_limit', '10', 'Max sessions before guest lockout', 'guest', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '10', 'number', '1', '100', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('guest_nudge_after', '3', 'Sessions before showing registration nudge', 'guest', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '3', 'number', '1', '50', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level1.block_severity', '"medium"', 'Minimum severity to BLOCK for Level 1 (under 13). Options: low, medium, high, critical.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"medium"', 'string_enum', NULL, NULL, '["low", "medium", "high", "critical"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level2.block_severity', '"high"', 'Minimum severity to BLOCK for Level 2 (13-17).', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"high"', 'string_enum', NULL, NULL, '["low", "medium", "high", "critical"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level3.block_severity', '"critical"', 'Minimum severity to BLOCK for Level 3 (18+).', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"critical"', 'string_enum', NULL, NULL, '["low", "medium", "high", "critical"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level1.warn_severity', '"low"', 'Minimum severity to WARN for Level 1 (under 13).', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"low"', 'string_enum', NULL, NULL, '["low", "medium", "high", "critical"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level2.warn_severity', '"medium"', 'Minimum severity to WARN for Level 2 (13-17).', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"medium"', 'string_enum', NULL, NULL, '["low", "medium", "high", "critical"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level3.warn_severity', '"high"', 'Minimum severity to WARN for Level 3 (18+).', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"high"', 'string_enum', NULL, NULL, '["low", "medium", "high", "critical"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level1.escalate_below', '0.7', 'Classifier confidence threshold for escalation (Level 1). Range: 0.0-1.0.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '0.7', 'number', '0.0', '1.0', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level2.escalate_below', '0.6', 'Classifier confidence threshold for escalation (Level 2). Range: 0.0-1.0.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '0.6', 'number', '0.0', '1.0', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.level3.escalate_below', '0.5', 'Classifier confidence threshold for escalation (Level 3). Range: 0.0-1.0.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '0.5', 'number', '0.0', '1.0', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.translation_severity_reduction', '1', 'Severity levels to reduce for translation content. Range: 0-3.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '1', 'number', '0', '3', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.blocklist_only_surfaces', '[]', 'Content types that skip classifier (blocklist only). JSON array.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '[]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.transcription_severity_reduction', '1', 'Severity levels to reduce for transcription content. Range: 0-3.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '1', 'number', '0', '3', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.extraction_severity_reduction', '1', 'Severity levels to reduce for extraction content. Range: 0-3.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '1', 'number', '0', '3', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_warn_threshold', '1', 'Strikes before user warning. Range: 1-10.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '1', 'number', '1', '10', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_suspend_threshold', '3', 'Strikes before suspension. Range: 1-20.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '3', 'number', '1', '20', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_ban_threshold', '4', 'Strikes before permanent ban. Range: 1-50.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '4', 'number', '1', '50', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.classifier_effort', '"standard"', 'Default effort tier for LLM classifier. Options: low, standard, max.', 'moderation', NULL, '2026-04-22 15:05:11.951098+00', '2026-04-22 15:05:11.951098+00', '"standard"', 'string_enum', NULL, NULL, '["low", "standard", "max"]', 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('config.require_two_person_approval', 'false', 'When true, safety-critical config changes require super_admin approval before taking effect.', 'system', NULL, '2026-04-22 21:46:41.293731+00', '2026-04-22 21:46:41.293731+00', 'false', 'boolean', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('config.approval_expiry_days', '7', 'Pending approval requests expire after this many days.', 'system', NULL, '2026-04-22 21:46:41.293731+00', '2026-04-22 21:46:41.293731+00', '7', 'number', '1', '30', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_expiry_low_days', '90', 'Days until a low-severity strike expires. 0 = never expires.', 'moderation', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '90', 'number', '0', '365', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_expiry_medium_days', '180', 'Days until a medium-severity strike expires. 0 = never expires.', 'moderation', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '180', 'number', '0', '365', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_expiry_high_days', '365', 'Days until a high-severity strike expires. 0 = never expires.', 'moderation', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '365', 'number', '0', '730', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.strike_expiry_critical_days', '0', 'Days until a critical-severity strike expires. 0 = never expires.', 'moderation', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '0', 'number', '0', '730', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.restriction_duration_hours', '24', 'Duration of content restriction (read-only mode) in hours.', 'moderation', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '24', 'number', '1', '168', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.suspension_duration_days', '7', 'Duration of account suspension in days.', 'moderation', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '7', 'number', '1', '30', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('coppa.blocked_features', '["translate", "transcribe", "identify_song", "generate", "upload_file"]', 'Features blocked for under-13 users without parental consent. JSON array of feature identifiers.', 'coppa', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', '["translate", "transcribe", "identify_song", "generate", "upload_file"]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('coppa.enforcement_enabled', 'true', 'Master switch for COPPA enforcement. When false, consent gate is bypassed (for development only).', 'coppa', NULL, '2026-04-24 23:49:53.518739+00', '2026-04-24 23:49:53.518739+00', 'true', 'boolean', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('song_id.min_duration_seconds', '10', 'Minimum recording duration in seconds before song identification is attempted. ACRCloud requires 10s+ for reliable fingerprint matching. Below this threshold, the API returns 422.', 'voice', NULL, '2026-04-26 19:32:02.702273+00', '2026-04-26 19:32:02.702273+00', '10', 'number', '5', '60', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('song_id.max_duration_seconds', '60', 'Maximum recording duration in seconds for song identification. Limits upload size and API cost. ACRCloud recommends 10-20s; 60s is generous upper bound.', 'voice', NULL, '2026-04-26 19:32:02.702273+00', '2026-04-26 19:32:02.702273+00', '60', 'number', '10', '120', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('profile.screened_fields', '["displayName", "realName"]', 'Profile fields that require Guardian screening before write. Field names must match ProfileUpdate keys.', 'safety', NULL, '2026-04-28 16:37:38.543388+00', '2026-04-28 16:37:38.543388+00', '["displayName", "realName"]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('profile.max_display_name_length', '50', 'Maximum length for display names. Enforced before Guardian screening.', 'safety', NULL, '2026-04-28 16:37:38.543388+00', '2026-04-28 16:37:38.543388+00', '50', 'number', '1', '200', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('profile.max_real_name_length', '100', 'Maximum length for real names. Enforced before Guardian screening.', 'safety', NULL, '2026-04-28 16:37:38.543388+00', '2026-04-28 16:37:38.543388+00', '100', 'number', '1', '300', NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('account_status.restricted_features', '["translate", "transcribe", "identify_song", "generate", "upload_file", "update_profile"]', 'Features blocked for users with account_status = restricted.', 'safety', NULL, '2026-04-28 16:37:38.543388+00', '2026-04-28 16:37:38.543388+00', '["translate", "transcribe", "identify_song", "generate", "upload_file", "update_profile"]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('account_status.suspended_features', '["*"]', 'Features blocked for users with account_status = suspended. ["*"] means all features.', 'safety', NULL, '2026-04-28 16:37:38.543388+00', '2026-04-28 16:37:38.543388+00', '["*"]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.appeal_window_hours', '72', 'Hours after a decision during which a user may file an appeal. Range: 1-720.', 'moderation', NULL, '2026-05-31 22:01:31.684603+00', '2026-05-31 22:01:31.684603+00', NULL, 'string', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.review_claim_timeout_hours', '24', 'Hours a claimed review item may sit before it auto-releases back to pending. Range: 1-168.', 'moderation', NULL, '2026-05-31 22:01:31.684603+00', '2026-05-31 22:01:31.684603+00', NULL, 'string', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.appeal_reason_min_length', '20', 'Minimum number of characters required in an appeal reason. Range: 1-1000.', 'moderation', NULL, '2026-05-31 22:01:31.684603+00', '2026-05-31 22:01:31.684603+00', NULL, 'string', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.budget.default_tokens_per_month', '100000', 'Default monthly token budget per agent per scope', 'limits', NULL, '2026-06-07 14:36:35.646285+00', '2026-06-07 14:36:35.646285+00', '100000', 'number', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.budget.default_usd_per_month', '5.00', 'Default monthly USD budget per agent per scope', 'limits', NULL, '2026-06-07 14:36:35.646285+00', '2026-06-07 14:36:35.646285+00', '5.00', 'number', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.trajectory.max_steps', '50', 'Maximum steps per trajectory before forced completion', 'limits', NULL, '2026-06-07 14:36:35.646285+00', '2026-06-07 14:36:35.646285+00', '50', 'number', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.trajectory.retention_days', '90', 'Days to retain completed trajectories before archival', 'limits', NULL, '2026-06-07 14:36:35.646285+00', '2026-06-07 14:36:35.646285+00', '90', 'number', NULL, NULL, NULL, 'standard');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.capability_features', '[["full-pipeline", ["identify_song", "translate", "speak"]], ["translate", ["translate"]], ["identify-song", ["identify_song"]], ["transcribe", ["transcribe"]], ["speak", ["speak"]]]', 'Capability -> required account-status features, as [capability, features[]] pairs. evaluateCapability reads this; the built-in fallback in lib/agent-capabilities.ts covers a config outage. Kept in sync with that fallback.', 'agent', NULL, '2026-09-26 21:50:16.244721+00', '2026-09-26 21:50:16.244721+00', '[["full-pipeline", ["identify_song", "translate", "speak"]], ["translate", ["translate"]], ["identify-song", ["identify_song"]], ["transcribe", ["transcribe"]], ["speak", ["speak"]]]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.escalation_sla_hours', '24', 'Max hours a review item may stay in pending/claimed before the reaper applies the remedial action (ADR-041). Clamped to [min,max]; on read failure the min is used (fail-closed).', 'moderation', NULL, '2026-09-26 21:52:31.889363+00', '2026-09-26 21:52:31.889363+00', '24', 'number', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.escalation_sla_min_hours', '1', 'Lower clamp + fail-closed value for escalation_sla_hours (ADR-041 D1).', 'moderation', NULL, '2026-09-26 21:52:31.889363+00', '2026-09-26 21:52:31.889363+00', '1', 'number', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.escalation_sla_max_hours', '168', 'Upper clamp for escalation_sla_hours (ADR-041 D1) — caps an accidental effectively-infinite SLA.', 'moderation', NULL, '2026-09-26 21:52:31.889363+00', '2026-09-26 21:52:31.889363+00', '168', 'number', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('moderation.escalation_remedial_action', '"block"', 'Reaper action on an over-SLA item: block (fail-closed default) or escalate_higher (re-queue + notify). Never allow. Allowed-set validated in the config reader (ADR-041 D2).', 'moderation', NULL, '2026-09-26 21:52:31.889363+00', '2026-09-26 21:52:31.889363+00', '"block"', 'string', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('config.dual_control_keys', '["signups_enabled", "moderation.strike_ban_threshold", "moderation.blocklist_only_surfaces", "config.require_two_person_approval", "config.dual_control_keys", "moderation.escalation_sla_hours", "moderation.escalation_sla_min_hours", "moderation.escalation_sla_max_hours", "moderation.escalation_remedial_action", "agent.budget.max_cost_per_day", "agent.budget.max_steps_per_trajectory", "guest.translate_allowance"]', 'Config keys whose changes require a runtime hold + independent human approval (ADR-039 dual-control), in addition to the two-person domain gate.', 'system', NULL, '2026-09-26 21:51:58.544982+00', '2026-09-26 21:51:58.544982+00', '[]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.trusted_agents', '[["agent:conductor", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}], ["agent:concierge", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}], ["agent:curator", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}], ["agent:analyst", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}]]', 'Governed trusted-agent registry: agentId -> {owner, scopes[], status}, as [agentId, record] pairs. agentAuthorized reads this; the built-in fallback in lib/agent-identity.ts covers a config outage. Kept in sync with that fallback.', 'agent', NULL, '2026-09-26 21:53:00.541463+00', '2026-09-26 21:53:00.541463+00', '[["agent:conductor", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}], ["agent:concierge", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}], ["agent:curator", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}], ["agent:analyst", {"owner": "first-party", "scopes": ["full-pipeline", "translate", "identify-song", "transcribe", "speak"], "status": "active", "maxTokenTtl": 300}]]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.delegation.max_ttl_seconds', '900', 'Global hard cap (seconds) on delegation token lifetime. Effective TTL is min(requested_ttl, per-agent maxTokenTtl, this). The absolute ceiling no agent can exceed.', 'agent', NULL, '2026-09-26 21:55:13.088543+00', '2026-09-26 21:55:13.088543+00', '900', 'number', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.budget.max_cost_per_day', '10', 'Platform ceiling on agent daily spend (USD). Applied as the most-restrictive of this ceiling and each agent''s per-class default: lowering it tightens spend platform-wide; it cannot raise an agent above its own default. Governs the ADR-048 cost cap.', 'agents', NULL, '2026-09-26 21:57:41.575974+00', '2026-09-26 21:57:41.575974+00', '10', 'number', '0.01', '1000', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('agent.budget.max_steps_per_trajectory', '15', 'Platform ceiling on steps per agent trajectory. Most-restrictive of this ceiling and each agent''s per-class default. Governs the ADR-048 step cap.', 'agents', NULL, '2026-09-26 21:57:41.575974+00', '2026-09-26 21:57:41.575974+00', '15', 'number', '1', '100', NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('account_status.known_features', '["generate", "identify_song", "transcribe", "translate", "tts", "speak", "update_profile", "upload_file", "view_profile", "view_dashboard", "agent_process_content", "agent_approve", "agent_delegate"]', 'The canonical set of features that exist. Access checks fail closed on any feature not in this list. Union of route feature literals and the capability->feature map. Kept in sync with setKnownFeaturesFallback() in instrumentation.ts.', 'account_status', NULL, '2026-09-26 21:49:09.813716+00', '2026-09-26 21:49:09.813716+00', '["generate", "identify_song", "transcribe", "translate", "tts", "speak", "update_profile", "upload_file", "view_profile", "view_dashboard", "agent_process_content", "agent_approve", "agent_delegate"]', 'json_array', NULL, NULL, NULL, 'safety');
INSERT INTO public.platform_config (key, value, description, category, updated_by, updated_at, created_at, default_value, value_type, min_value, max_value, allowed_values, permission_tier) VALUES ('guest.translate_allowance', '5', 'Translate requests a guest may make before signing in (one per request, whatever the number of target languages). Enforced before any paid call; at the limit the guest is asked to sign in. The platform clamps it to 1–10 whatever this row says.', 'guest', NULL, '2026-09-28 20:55:15.636009+00', '2026-09-28 20:55:15.636009+00', '5', 'number', '1', '10', NULL, 'safety');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('f5d93ec0-d9d9-4328-b72f-4004b0fad974', '2e9fbb42-97f2-4124-bc22-3183bdf71769', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('1876bfe1-0449-4f7c-9eaf-ea0a14b1b65a', 'ab5ec681-547a-4c02-b0a7-3137313382ac', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('11ce9f30-7a91-4a07-a34e-f074dcd16231', '596c9f9b-1d93-4597-9205-f24cea8a7f83', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('38169468-ddc7-45bf-97e0-a4591f2e2760', '57728fff-85f9-4458-b3f5-ac96e7a0b593', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('ca0cd896-c218-4203-b234-ded24cb4c7c6', 'c3f5559f-1637-48bc-8742-21920e139397', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('4660708e-69d2-4bf8-998f-38ca98cca04c', '2c96263a-eba5-41af-b3d5-3088daec1f53', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('94f03c9d-740b-49a4-a50a-da031d2ecbdf', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('1c17946f-c482-4cd4-a773-afb30baa1034', 'ab5ec681-547a-4c02-b0a7-3137313382ac', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('59789d1a-48dc-4c6e-9112-1ea453e3ba04', '596c9f9b-1d93-4597-9205-f24cea8a7f83', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('96b5a8fa-9053-4de8-b73a-5dc534344f13', '57728fff-85f9-4458-b3f5-ac96e7a0b593', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('d15a18c0-1f30-49ff-810f-6807aeabc9ab', 'c3f5559f-1637-48bc-8742-21920e139397', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('fcac3a75-cb9c-41d7-8659-d60233890cd2', '2c96263a-eba5-41af-b3d5-3088daec1f53', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('a0d85ec3-f37f-4081-964f-1739d9d3d688', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('5ffb3b55-3171-43ca-9601-122c922bf307', 'ab5ec681-547a-4c02-b0a7-3137313382ac', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('9d350ca3-324a-4eb6-8564-efc7d79b2c5f', '596c9f9b-1d93-4597-9205-f24cea8a7f83', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('eacc8988-3b93-4d44-be2d-94a98ef91231', '57728fff-85f9-4458-b3f5-ac96e7a0b593', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('68bb61eb-b596-472c-b7b9-16b0d085c795', 'c3f5559f-1637-48bc-8742-21920e139397', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('a7cf4164-a7bf-46bd-8920-b448ed46882f', '2c96263a-eba5-41af-b3d5-3088daec1f53', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('6c9f3650-e95a-436e-946a-c813cc136d1e', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('4f29c708-c918-40f0-b25d-ff3ec12c039b', '2e9fbb42-97f2-4124-bc22-3183bdf71769', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('ca6fd114-f410-403b-a7f3-24c0158dda3c', 'ab5ec681-547a-4c02-b0a7-3137313382ac', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('d0dd32d2-226d-4ef5-9a65-9436b67b316e', '596c9f9b-1d93-4597-9205-f24cea8a7f83', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('2280fa43-b9c5-42a4-8dd1-14ab88b5f5f3', '57728fff-85f9-4458-b3f5-ac96e7a0b593', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('946cd312-62c5-44c5-9eac-a2bccff9320b', 'c3f5559f-1637-48bc-8742-21920e139397', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('563ca80c-87cd-4989-bbf0-fbe04960b372', '2c96263a-eba5-41af-b3d5-3088daec1f53', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('3b855efd-8648-4697-87fa-11c60b0139fd', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('4398e20c-4047-43e7-ad25-09db95380eea', 'ab5ec681-547a-4c02-b0a7-3137313382ac', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('ed59d57d-a0c1-4409-8b2a-0ca8d3273566', '596c9f9b-1d93-4597-9205-f24cea8a7f83', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('5f1246a5-1964-446b-ad18-880ac46ae0f8', '57728fff-85f9-4458-b3f5-ac96e7a0b593', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('abc1ba8f-a6ea-4669-b78d-e246bb36a5e5', 'c3f5559f-1637-48bc-8742-21920e139397', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('6b469805-d3d5-4e46-9e8c-a158444f6e4f', '2c96263a-eba5-41af-b3d5-3088daec1f53', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('56d06c39-85f3-45b7-8400-b5dd1f286866', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('5935692c-c009-487a-8425-2bd801c35914', 'ab5ec681-547a-4c02-b0a7-3137313382ac', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('67dd386e-40b9-4446-9a08-9b54091d282a', '596c9f9b-1d93-4597-9205-f24cea8a7f83', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('502405b9-a9fb-4f67-b639-ab39139b12e7', '57728fff-85f9-4458-b3f5-ac96e7a0b593', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('a0f421eb-5c75-4698-b6d9-bdd6c63f7975', 'c3f5559f-1637-48bc-8742-21920e139397', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('c28f0bfb-0599-4cff-93ed-3f5b74cf4a8c', '2c96263a-eba5-41af-b3d5-3088daec1f53', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('ccdd08ba-0d0a-48b7-a331-ddfd1f023674', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('4056755f-ad10-406e-b473-8af2d83c2a66', 'ab5ec681-547a-4c02-b0a7-3137313382ac', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('9b7285e0-8ff5-48ac-b38a-23259a634924', '596c9f9b-1d93-4597-9205-f24cea8a7f83', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('b5ea166a-bb6a-40f3-a589-2127eab2d177', '57728fff-85f9-4458-b3f5-ac96e7a0b593', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('e0beaaf0-ad9d-4ec9-aae9-fc0e009f44e0', 'c3f5559f-1637-48bc-8742-21920e139397', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('32e18155-e839-4db9-bdfa-e518b70dae9a', '2c96263a-eba5-41af-b3d5-3088daec1f53', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('e29877e1-763d-4916-aea9-b5aae13c71ba', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('6a6c3624-5d01-45f6-927a-bfaa766ad90e', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', 'd1064e98-9b7b-4a11-a4d3-806cb079da82', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('8fa35b40-3742-4a94-942e-174e67a25db2', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '61cb707c-cb7c-4a1e-9eed-8a48e772cef6', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('b1b62f83-070e-4f0c-9919-95ce07fb4d51', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '35ef59cc-f625-46c2-a483-d92a3c2a9095', NULL, '2026-03-30 02:26:16.933408+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('d102fe75-2fc0-4b53-8fa5-4ec872e6918a', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '3fe86a54-d123-48a2-a038-b69c6e4b7b07', NULL, '2026-04-22 21:46:41.293731+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('06242884-2ea2-48ed-b821-85bb67024baf', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '4c994f84-417b-41cc-8988-24282fd5d84d', NULL, '2026-04-22 21:46:41.293731+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('62ef26fd-878f-41c2-b1ef-fb445895c150', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '5d3128fc-d43d-4b17-bf1e-c9863c68a567', NULL, '2026-05-31 22:01:31.684603+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('560d7424-e457-421e-b0eb-252f411be6ff', 'e2517f29-2e76-4663-a2b4-b30be77fbc67', 'd1064e98-9b7b-4a11-a4d3-806cb079da82', NULL, '2026-05-31 22:15:36.651568+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('48632fb8-88b0-41e8-b262-5d95d7d2fcc2', 'e2517f29-2e76-4663-a2b4-b30be77fbc67', '5d3128fc-d43d-4b17-bf1e-c9863c68a567', NULL, '2026-05-31 22:15:36.651568+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('8ff0d6eb-6b8d-4fbc-98b3-d3f3594875f1', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '4c994f84-417b-41cc-8988-24282fd5d84d', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('3d4f8796-7940-4b9f-87fb-2f925a03fbce', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '2d3f8c48-10e7-44dc-b277-1de209bc514f', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('df8df73b-c68a-4578-b698-9b7ab556ae46', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', 'ee31019b-d4e5-4e89-b5d3-63af955a764c', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('f54c36ad-7705-47f3-ad9a-cf2ef76c6ef9', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', 'c79e882f-9662-4dcf-bc82-df97366e1378', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('fee6ec95-a111-43d3-b6a6-c3ac9ba21923', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '7a1b3bd4-8ca5-48b1-99dd-91bb15d199a7', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('4c21c8ca-156e-4d27-bfe4-da5756c2f028', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '04ce5944-f567-42e3-9f17-5275c64a92c5', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('260f49d7-2e6f-49be-a234-8412ef34d843', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '4ad968bf-2791-4d95-a10b-066aef9d50c9', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('f8a804a6-b2a4-454a-b116-c02b333c1f6d', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '35ef59cc-f625-46c2-a483-d92a3c2a9095', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('2c7ce292-bae5-4733-a55c-28bb527471f2', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '61cb707c-cb7c-4a1e-9eed-8a48e772cef6', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('19a0488e-183d-4f02-b9fd-2eca96aa9843', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '5f25965b-d938-48c1-95b1-32a37ecbc3c1', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('c236481e-3c77-4895-bfcf-7d71f8eca77f', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '4f55510e-e631-431f-aa18-ffb6ba9dc9ed', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('e4a259ab-5a9e-4a65-b302-3b9754f97660', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '884f599a-f944-4cd4-ab38-4e19befa6093', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('7be0d127-dd31-45c9-9951-72986d3dbefd', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '5d3128fc-d43d-4b17-bf1e-c9863c68a567', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('de1e1070-b2d1-4819-933a-8f5016332452', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '2244cc39-49a4-49fb-8fea-78ecb569f3c4', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('f48a5c20-0141-4880-b7b8-3e318f03fa69', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', 'd1064e98-9b7b-4a11-a4d3-806cb079da82', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('0eb384e9-04df-4b3f-9804-6080ee6e7de1', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '43c6fa08-ac97-40b6-890a-68a88cfc45bf', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('3658a046-e451-4e6a-9a30-f40a9e4b616e', 'd3b8d659-1ab5-42f4-a3af-ebb7cb4dff3f', '3fe86a54-d123-48a2-a038-b69c6e4b7b07', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('712e9385-1803-468a-9450-32a8d105b5f8', '9de4502e-b3d9-4a9b-ba63-ed92f30552c2', '5f25965b-d938-48c1-95b1-32a37ecbc3c1', NULL, '2026-06-01 00:38:34.888539+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('2ef39fba-51ee-4814-a4e8-976a0c83cd7c', '1e00ee1e-085c-4840-8921-4d32c52716f3', 'd1064e98-9b7b-4a11-a4d3-806cb079da82', NULL, '2026-09-26 21:53:58.967204+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('3714a3ca-cb12-4221-88dc-c2224ce7425e', '1e00ee1e-085c-4840-8921-4d32c52716f3', '3fe86a54-d123-48a2-a038-b69c6e4b7b07', NULL, '2026-09-26 21:53:58.967204+00');
INSERT INTO public.role_permissions (id, role_id, permission_id, granted_by, created_at) VALUES ('20a1e5d0-cf34-4fb1-bcfb-57c863c744c4', '1e00ee1e-085c-4840-8921-4d32c52716f3', '4ad968bf-2791-4d95-a10b-066aef9d50c9', NULL, '2026-09-26 21:53:58.967204+00');

-- ── Migration record ───────────────────────────────────────────────────────
-- Everything 001–037 produces is present; record it so tooling that reads
-- applied_migrations (TASK-065) sees a complete history.
INSERT INTO public.applied_migrations (filename, confidence, note)
VALUES
  ('001_identity_access_foundation.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('002_seed_data.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('003_rls_policies.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('004_dynamic_roles.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('005_super_admin_separation.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('006_platform_config.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('007_seed_separation.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('008_rename_player_to_user.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('009_gdpr_purge_log.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('010_content_safety_audit.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('011_config_management.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('012_account_consequences.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('013_song_id_config.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('014_profile_screening_config.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('015_social_data_model.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('016_agent_runtime.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('017_embedding_store.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('018_app_framework.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('018_human_review.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('019_review_queue_updated_at.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('020_strike_review_linkage.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('021_reconcile_permission_vocabulary.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('022_agent_runtime_reconcile.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('023_agent_budget_consume.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('024_agent_budget_used_steps.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('025_migration_tracking.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('026_app_framework_note.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('027_proposals.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('028_effect_ledger.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('029_session_meta.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('030_approval_policy.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('031_user_feature_restrictions.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('032_dual_control_keys.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('033_escalation_sla.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('034_safety_approver_role.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('035_embedding_store_scope.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('036_governed_agent_budget.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).'),
  ('037_guest_translate_allowance.sql', 'verified', 'Covered by supabase/baseline/000_baseline.sql (dev schema 2026-09-29).');

INSERT INTO public.applied_migrations (filename, confidence, note)
VALUES ('000_baseline.sql', 'verified', 'Schema baseline: this database was built from it, not from the numbered chain.');

SELECT pg_catalog.set_config('search_path', '"$user", public', false);
