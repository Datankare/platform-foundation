# App Environment Reference

<!-- Consumer-owned: platform-foundation ships this file as a template. A consuming app lists
     docs/APP_ENV_REFERENCE.md in its sync exclude list and fills it in. -->

The settings this app reads in addition to the platform's ([ENV_REFERENCE.md](ENV_REFERENCE.md)), and
the values it selects for the platform's settings in each environment. Same rules: name, whether it is
required, default, valid values. Never write a secret's value here — name where it is kept.

`__tests__/docs-integrity.test.ts` reads this file together with ENV_REFERENCE.md: every environment
variable the code reads must be documented in one of the two.

## Settings of the app's own

This app reads no settings beyond the platform's.

## Platform settings, as this app deploys them

platform-foundation is a template and has no deployments of its own; a consuming app records here,
per environment, which provider each `*_PROVIDER` / `*_STORE` setting selects.
