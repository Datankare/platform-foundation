# ADR-055: Deploy Anywhere — One Container Image, Any Host

Status: Proposed (Phase 5 Sprint 7R entry gate, 2026-10-21). Decision maker: Raman Sud.
Related: ADR-032 (singletons), ADR-050 (environment contract), ADR-052 (rate limiting), ADR-053 (tenancy, D4 direct Postgres), ADR-056 (operations baseline), TASK-128, TASK-139, TASK-140, TASK-141. `next.config.ts`, `instrumentation.ts`, `app/api/health`, `platform/providers/**`, `platform/cache/**`, `infra/**`.

---

## 1. Context

The platform has been deployed only on Vercel. The decision of 2026-10-17 keeps Vercel a first-class host and adds AWS, GCP and Azure, AWS first. A survey of the code in October 2026 found the coupling small but with one security consequence:

- **Hosted detection is `VERCEL=1` alone.** It is what makes production refuse the test-harness switches (`E2E_IN_MEMORY_STORES`, `E2E_TEST_DOUBLE_AUTH`, `ADMIN_DEV_BYPASS`). Off Vercel those switches would be accepted in production (TASK-140).
- **The deployed commit** comes only from `VERCEL_GIT_COMMIT_SHA`; the version from `npm_package_version`, unset under a standalone server.
- **No container build:** no Dockerfile, `output: "standalone"` unset, `infra/` placeholders, and no deploy or smoke run in this repository.
- **The cache speaks Upstash REST only and falls back to memory silently in production** (TASK-139); there is no Redis-protocol (Valkey) client.
- **Browser settings (`NEXT_PUBLIC_*`) are built into the bundle**, tying an image to one environment.
- **No graceful shutdown:** buffered metrics are lost on stop.

## 2. Decisions

**D1 — The container image is the portable unit.** A multi-stage image (Node 24, Next.js standalone output, non-root user, read-only root filesystem friendly) is built in CI from every commit. Vercel builds the same commit natively; every other host runs the image. The deploy smoke test (`scripts/deploy-smoke.mjs`) must pass against the image in CI before a host is trusted, and against every deployment after.

**D2 — The environment contract is host-neutral, and safe by default.** `DEPLOYMENT_HOST` (`vercel`, `container`, `local`, `ci`, …) is declared in the contract. The test-harness switches (`E2E_IN_MEMORY_STORES`, `E2E_TEST_DOUBLE_AUTH`) are accepted only with a positive non-hosted marker — `DEPLOYMENT_HOST=local` or `ci` — so a deployment that forgets the setting refuses them rather than accepting them. The commit comes from `GIT_COMMIT_SHA` (baked into the image), then `VERCEL_GIT_COMMIT_SHA`; the version from the `platform/version.ts` constant and the app's own version.

**D3 — One image for every environment.** Browser settings are served at runtime by the server (rendered into the page from the environment), not built into the bundle, so the image promoted from staging to production is the image that was tested. Delivered in 7P, when an image is first promoted between environments; until then images are built per environment.

**D4 — Every provider has a host-neutral implementation.** The data layer is direct Postgres through a transaction-mode pooler (ADR-053 D4): Supabase's pooler on Supabase, RDS Proxy on AWS. The cache and the rate limiter gain a Valkey provider over the standard Redis protocol (7P), passing the same conformance kits. A shared cache selected without its connection is a boot failure in production instead of a fallback to memory. Boot failures are recorded, not just logged (`instrumentation.ts` catches them so the server keeps answering): readiness reports them, so traffic never reaches an instance that did not boot.

**D5 — The process behaves in a container.** On `SIGTERM` the server stops accepting work, flushes buffered metrics and closes pools within a bounded grace period (Next.js's standalone server handles `SIGTERM` itself unless `NEXT_MANUAL_SIG_HANDLE=true`, which the image sets). Health is split: `/api/health/live` (the process answers) and `/api/health/ready` (boot completed, the database and a selected shared cache answer; realtime and module probes report degraded without making the instance unready); orchestrators gate traffic on readiness. Limits kept per process (realtime connection guard) are documented as per instance.

**D6 — Infrastructure as code.** OpenTofu modules under `infra/` provision each host: on AWS the network, ECS, RDS Postgres with point-in-time recovery and RDS Proxy, Valkey, a load balancer, DNS and certificates. CI deploys the same commit to Vercel and AWS and runs the smoke test on both. GCP and Azure follow with the same image and module shape.

## 3. Delivery

- **Sprint 7R:** standalone output, the Dockerfile and `.dockerignore`, `DEPLOYMENT_HOST` (with the harness switches inverted) and `GIT_COMMIT_SHA` in the contract, version from the `platform/version.ts` constant, boot failures recorded for readiness, the cache's production fallback refused, graceful shutdown, the live/ready split with database and cache probes, and a CI job that builds the image, runs it and passes the deploy smoke test against it.
- **Sprint 7P:** OpenTofu for AWS, runtime browser settings, the Valkey provider, CI deploying to both hosts with the smoke test on both, and the audio-conversion service decision.

## 4. Consequences

- Every deployment sets `DEPLOYMENT_HOST`; the E2E harness and local development set `ci` or `local` to use the harness switches.
- `TRUSTED_PROXY_HOPS` is set per host (Vercel 1; a load balancer alone 1; a CDN in front of a load balancer 2).
- A host is supported only when the smoke test passes on it in CI.
