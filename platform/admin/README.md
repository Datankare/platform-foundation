# platform/admin — Configuration management

The config agent and the two-person approval workflow behind changes to platform
configuration.

## What is here

| File                 | Contents                                                        |
| -------------------- | --------------------------------------------------------------- |
| `types.ts`           | Tool definitions, `TOOL_BOUNDARIES`, approval and history types |
| `config-handlers.ts` | The ten tool implementations the agent invokes                  |
| `config-approval.ts` | Two-person approval: request, approve, reject                   |
| `config-impact.ts`   | What a proposed change would alter in moderation outcomes       |

## The ten tools

Read tools record as **cognition**; write tools record as **commitment**. That classification
is not decorative — a commitment receives governance a cognition does not.

| Cognition                                                                                           | Commitment                                                             |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `search_config`, `get_config`, `get_history`, `compare_to_defaults`, `impact_report`, `bulk_review` | `update_config`, `request_approval`, `approve_change`, `reject_change` |

Every registered tool must appear in `TOOL_BOUNDARIES`.
`__tests__/tool-boundary-coverage.test.ts` asserts it, because an unclassified tool falls back
to `commitment` — conservative, but a guess nobody should reach.

## Safety properties worth knowing

**`update_config` previews by default.** It requires `confirmed: true` to apply, so an agent
that misunderstands an instruction shows you the change rather than making it (P10).

**Approval is two-person.** `approve_change` refuses the super-admin who requested it.

**Permission tiers are checked on every mutation**, not at the start of a session (P13).

## Dependencies

`agents` for tool and trajectory vocabulary, `auth` for the permission tiers. Imported by
`auth` in turn — the admin surface and the auth surface are mutually aware.
