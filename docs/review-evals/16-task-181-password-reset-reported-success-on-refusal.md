# Password reset showed "Password Reset" when the server refused it

| Field        | Detail                                                                               |
| ------------ | ------------------------------------------------------------------------------------ |
| Case         | `task-181-password-reset-reported-success-on-refusal`                                |
| Source       | TASK-181 (user-facing gap audit, batch 2)                                            |
| Area (tier)  | UI — dead-ends or hides the reason (Medium)                                          |
| Review input | `components/auth/ForgotPasswordForm.tsx` as of `43d14c0` (since `f2cb6aa`, Sprint 2) |
| Fixed in     | `8944cfe`                                                                            |

## What the diff did

The two-step reset form: send a code, then confirm with the code and a new password.

## The defect

Both steps ignored the result: "send code" advanced when refused, and a wrong or expired code, the password policy or a rate limit still showed "Your password has been reset successfully."

## Where

`components/auth/ForgotPasswordForm.tsx:40–41` (`await onSendCode(…)` then `setStep("code")`) and `:47–48` (`await onConfirmReset(…)` then `setSuccess(true)`), as of `43d14c0`.

## How it was caught

The user-facing gap audit (batch 2), not a test.

## The finding a reviewer should have produced

**Important** — `components/auth/ForgotPasswordForm.tsx:47` — `setSuccess(true)` runs whatever `onConfirmReset` answered: a refused reset is shown as done, and the person cannot sign in with the password they believe they set. Advance only on the server's success and show its message; same at `:41` for the code step.

## Scoring

- **Caught (2):** Says success is shown regardless of the server's answer.
- **Partial (1):** Says errors are not handled, without the false success.
- **Missed (0):** neither; findings elsewhere in the input are counted as noise (README).
