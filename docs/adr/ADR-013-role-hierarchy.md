# ADR-013: Role Hierarchy & Separation of Duties

## Status: Accepted

## Date: 2026-03-31

## Context

The admin UI needs a clear separation between governance operations
(who can do what) and day-to-day operational administration (player
management, audit viewing). Without separation, any admin could
escalate their own privileges.

## Decision

### Role Hierarchy (highest to lowest)

| Role            | Purpose           | Scope                          |
| --------------- | ----------------- | ------------------------------ |
| super_admin     | Access governance | Roles, config, all permissions |
| admin           | Operational       | Players, entitlements, audit   |
| registered/free | Normal player     | Gameplay, profile              |
| guest           | Anonymous         | Time-limited play              |

### Permission Assignment

**super_admin only** (governance):

- `admin_manage_roles` — create/edit/delete roles
- `admin_manage_config` — platform config (guest policy, password policy)

**admin + super_admin** (operational):

- `can_access_admin` — access admin UI
- `admin_view_audit` — view audit trail
- `admin_manage_players` — edit player roles, view data
- `admin_manage_entitlements` — manage entitlement groups

### Anti-Elevation Rules

1. `super_admin` cannot be assigned through the admin UI — database only
2. No user can change their own role
3. Role changes are audit-logged with actor and target

## Consequences

- Requires database access to create the first super_admin
- Admin users cannot accidentally or maliciously escalate privileges
- Clear audit trail for all role changes
