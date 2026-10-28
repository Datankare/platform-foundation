# The admin console read a panel before it knew the admin could open it

| Field        | Detail                                                                                  |
| ------------ | --------------------------------------------------------------------------------------- |
| Case         | `task-184-the-console-read-a-panel-it-could-not-open`                                   |
| Source       | TASK-184                                                                                |
| Area (tier)  | UI — dead-ends or hides the reason (Medium); the access it shows is auth's              |
| Review input | `app/admin/page.tsx`, `components/admin/AdminShell.tsx`, as of `eba94b8`                |
| Fixed in     | TASK-184 (on develop after `eba94b8`); `__tests__/admin-console-first-section.test.tsx` |

## What the diff did

The admin console: one page that asks `GET /api/admin/session` which permissions the admin
holds, shows only the sections those permit (audit B-14), and reads the open section's data.

## The defect

The open panel started as `"roles"` and its data was read in an effect that did not wait for the
session, so `/api/admin/roles` was requested before the console knew who was asking. While the
session loaded, the shell was rendered with no permissions and fell back to `"users"`, which it
reported as the first section, so `/api/admin/users` was read too. A moderator
(`can_access_admin`, `can_moderate`) was refused both (403) and shown a section heading over data
it could not load; an admin without a second factor saw all three reads refused — the session
(`auth.mfa_required`), roles and users.

## Where

`app/admin/page.tsx:164` (`useState<AdminSection>("roles")`), `app/admin/page.tsx:224–232` (the
read, with no session check), `app/admin/page.tsx:370–376` (the shell rendered while the session
is loading); `components/admin/AdminShell.tsx:162–164` (the `|| "users"` fallback), as of
`eba94b8`.

## How it was caught

Playform's live journey on playform-dev (`e2e-live/staff-journey.live.spec.ts`, Journey B): the
moderator's first section's data read answered 403, not 200. An admin without a second factor saw
all three reads refused in the browser console at page load: the session, roles and users.

## The finding a reviewer should have produced

**Important** — `app/admin/page.tsx:164` — the console opens "roles" and reads it (`:224–232`)
before `/api/admin/session` has answered, and the shell, rendered while loading, falls back to
"users" (`components/admin/AdminShell.tsx:163`): an admin without `admin_manage_roles` or
`admin_manage_users` — the moderator — is refused both reads and sees a heading over nothing.
Open the first section the session permits, from the shell's own section-to-permission mapping,
and read nothing until the session says "admin". Same class: any default chosen before the
permissions it depends on are known.

## Scoring

- **Caught (2):** Names the read made before the session answers, or the default section a role
  may not open, with the 403 it causes.
- **Partial (1):** Says the default section ignores permissions, without the early read.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
