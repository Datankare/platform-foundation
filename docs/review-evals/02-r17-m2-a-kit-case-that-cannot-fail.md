# A conformance-kit assertion that passed whatever the provider did

| Field        | Detail                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Case         | `r17-m2-a-kit-case-that-cannot-fail`                                                                                                                      |
| Source       | TASK-178, review 17 finding M2                                                                                                                            |
| Area (tier)  | Medium (a test file); the failure is "it lies"                                                                                                            |
| Review input | [`inputs/02-r17-m2-a-kit-case-that-cannot-fail.patch`](inputs/02-r17-m2-a-kit-case-that-cannot-fail.patch) — input reconstructed from pre-release history |
| Fixed in     | `3994dcf`                                                                                                                                                 |

## What the diff did

TASK-177 added kit cases proving the provider names a token by its `sub` and refuses a GetUser answer for another user.

## The defect

The last `subjectCases` case asserted `payload === null || payload.sub === FEDERATED.sub`: a provider that accepted another user's answer and one that refused it both passed.

## Where

`__tests__/contract/auth-token-verification-contract.ts:334` (the patch's `+` line `payload === null || payload.sub === FEDERATED.sub`), in the reconstructed input; the pre-fix file was never public.

## How it was caught

Review 17. The fix was checked by removing the provider's check and watching the kit fail.

## The finding a reviewer should have produced

**Important** — `__tests__/contract/auth-token-verification-contract.ts:334` — `payload === null || payload.sub === …` is true for both outcomes the case should tell apart, so it cannot fail. Assert `null` for a GetUser answer naming another user, add the answer without `sub`, and show the case failing with the provider's check removed.

## Scoring

- **Caught (2):** Says the assertion is satisfied by both the correct and the incorrect provider.
- **Partial (1):** Flags the line as weak without saying it cannot fail.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
