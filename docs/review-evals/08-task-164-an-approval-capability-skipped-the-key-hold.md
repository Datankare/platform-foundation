# A fix's new capability let an approved action skip a key's own hold

| Field        | Detail                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `task-164-an-approval-capability-skipped-the-key-hold`                                                                                                                                        |
| Source       | TASK-164, review 10 finding H1 (on review 9's fix)                                                                                                                                            |
| Area (tier)  | auth (High) — dual control (`platform/action-pipeline`)                                                                                                                                       |
| Review input | [`inputs/08-task-164-an-approval-capability-skipped-the-key-hold.patch`](inputs/08-task-164-an-approval-capability-skipped-the-key-hold.patch) — input reconstructed from pre-release history |
| Fixed in     | `908d64a` (the capability removed: simplified rather than patched)                                                                                                                            |

## What the diff did

Review 9's fix made an approved command-bar action's write prove it was an approved execution: a minted capability, redeemed by the config writer before it decided to hold.

## The defect

The action's approval carried a capability that let the write skip the key's own hold, so an approver without `config_manage_safety` cleared a safety-tier change, and a claim from any approval could write `config.dual_control_keys`. Actions were also still held twice.

## Where

`platform/action-pipeline/approval-capability.ts:96` (`bindApprovedWrite`) and `:128` (`redeemApprovedWrite`), in the reconstructed input (a new file, so the lines are the patch's); the pre-fix file was never public.

## How it was caught

Review 10.

## The finding a reviewer should have produced

**Important** — `platform/action-pipeline/approval-capability.ts` — a capability minted from the action's approval satisfies the config key's hold, but the key's hold has stricter approvers (`config_manage_safety`); an ordinary approval now clears a safety-tier write. Hold each change once, under the key's own rules, and remove the capability.

## Scoring

- **Caught (2):** Says the capability lets a weaker approval satisfy a stronger hold.
- **Partial (1):** Says the mechanism is complex or risky without the bypass.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
