# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub: on this repository, open **Security → Report a vulnerability**
(private vulnerability reporting is enabled). Include what you found, where (file, route or
version), how to reproduce it, and the impact you expect.

What to expect:

| Step                    | Target                                                   |
| ----------------------- | -------------------------------------------------------- |
| Acknowledgement         | Within 5 business days                                   |
| Assessment and severity | Within 10 business days of acknowledgement               |
| Fix or mitigation       | Prioritised by severity; HIGH and CRITICAL first         |
| Disclosure              | Coordinated with you, through a GitHub security advisory |

This project currently has one maintainer, so the targets above are honest best efforts rather
than contractual commitments.

## Supported versions

| Version            | Supported                                                        |
| ------------------ | ---------------------------------------------------------------- |
| Latest 3.x release | Yes                                                              |
| Earlier versions   | No — upgrade to the latest release (see `docs/RELEASE_NOTES.md`) |

## How security is managed here

- **Tracked debt.** Every consciously deferred security item is recorded with a severity, a plan
  and a deadline in [`docs/SECURITY_DEBT.md`](docs/SECURITY_DEBT.md).
- **Automated checks on every change.** CodeQL and Semgrep static analysis, a production
  dependency audit that blocks merges, a full-history secret scan (gitleaks), and GitHub secret
  scanning with push protection.
- **Controls mapped to OWASP Top 10** in [`docs/OWASP_CONTROLS.md`](docs/OWASP_CONTROLS.md).
- **No resource identifiers or credentials in the repository.** Configuration is read from the
  environment; see [`docs/ENV_REFERENCE.md`](docs/ENV_REFERENCE.md).
