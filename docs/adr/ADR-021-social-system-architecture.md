# ADR-021: Social System Architecture

**Status:** Accepted
**Date:** 2026-04-29
**Decision Makers:** Raman Sud
**Sprint:** Phase 4 Sprint 4a

## Context

The platform needs social features — groups, memberships, and invitations — as the foundation for collaborative experiences. Six autonomous agents (Guardian, Matchmaker, Gatekeeper, Concierge, Analyst, Curator) will operate on this social fabric starting in Sprint 4b.

Key requirements:

1. **Group lifecycle** — create, archive, suspend with ownership controls
2. **Membership management** — join via invite, leave, role-based (owner/admin/member)
3. **Invite workflow** — explicit accept/decline, no auto-join (P10: human oversight)
4. **Agent-ready schema** — metadata JSONB for agent memory (P8, P16)
5. **Content screening hooks** — every social write is a screenable surface (P4)
6. **Provider-aware persistence** — Supabase for production, in-memory for tests (P7)

## Decision

### Data Model

Three tables in Migration 015:

- **groups** — id, name (3–100 chars), description (≤500 chars), metadata (JSONB), owner_id, status (active/archived/suspended), timestamps
- **group_memberships** — soft-delete via `left_at` (NULL = active). Unique partial index on `(group_id, user_id) WHERE left_at IS NULL` prevents duplicate active memberships
- **group_invites** — status (pending/accepted/declined/expired). Unique partial index on `(group_id, invitee_id) WHERE status = 'pending'` prevents duplicate pending invites

### Architecture Layers

1. **Types** (`platform/social/types.ts`) — domain vocabulary: Group, Membership, GroupInvite, SocialStore interface
2. **Store implementations** — InMemorySocialStore (test default), SupabaseSocialStore (production via raw fetch)
3. **Service layer** — GroupService (validation, content screening hook, ownership checks), InviteService (authorization, accept→addMember coordination)
4. **Provider registry** — `SOCIAL_STORE` env var slot, same pattern as `MODERATION_STORE`

### Content Screening (P4)

GroupService accepts an optional `ScreenContentFn` callback. When provided (Sprint 4b), every group name and description is screened through the Guardian before persistence. The hook is at the service layer, not the store layer — stores are dumb persistence.

### Invite Authorization (P10)

InviteService enforces:

- Inviter must be an active member of the group
- Invitee must not already be an active member
- Self-invite is rejected
- Group must be active
- Only the invitee can accept or decline
- Accepting auto-adds as member with "member" role

### RLS Policies

- Members see their own groups and group memberships
- Owners can update their groups
- Invitees see and can update their own invites
- Group members can see and create invites for their groups
- Service role has full access (agent operations are server-side)

## Consequences

- Social agents (Sprint 4b) operate on typed interfaces, not raw SQL
- Group metadata JSONB is the extension point for per-group agent memory
- All social writes can be screened without touching the store layer
- Re-joining after leaving creates a new membership record (audit trail preserved)

## Related

- ADR-016: Content Safety Architecture (Guardian screening)
- ADR-022: Agent Runtime (trajectory persistence)
- AGENT_ARCHITECTURE.md (Cluster 3: Social agents)
