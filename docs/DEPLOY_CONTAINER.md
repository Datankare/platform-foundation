# Deploying the container image

The platform runs on any host that runs a container (ADR-055). Vercel builds the same commit its
own way and keeps working unchanged. Every other host (AWS ECS, Kubernetes, Docker on a VM) runs
one image built from the repository's `Dockerfile`. CI builds that image from every commit, runs
it against a replayed database and passes the deploy smoke test against it (`ci.yml`, job
**Container image**). A host counts as supported only when that test passes on it.

## 1. What the image is

| Property        | Value                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base            | `ARG BASE_IMAGE`, default `node:24.22.1-trixie-slim`: the official Node 24 image, pinned to a release (§6 shows how to pin its digest too)                                |
| Stages          | `deps` (`npm ci --ignore-scripts`, from the lockfile) → `build` (`next build`, `output: "standalone"`) → `runtime`                                                        |
| Runtime content | `.next/standalone` (the server and only the `node_modules` it traces), `.next/static`, `public/`, `scripts/jobs-worker.mjs`. No source, no dev dependencies, no npm cache |
| User            | UID/GID `10001:10001`, numeric (no passwd entry), so `runAsNonRoot` can verify it. The app's files belong to root and are read-only to the app                            |
| Writes          | `/tmp` and `/app/.next/cache` only (Next.js's image and fetch cache)                                                                                                      |
| Command         | `node server.js`, listening on `0.0.0.0:$PORT` (default 3000)                                                                                                             |
| Signals         | `STOPSIGNAL SIGTERM`; `NEXT_MANUAL_SIG_HANDLE=true`, so the platform's own handler stops the instance (§5)                                                                |
| Health check    | `HEALTHCHECK` on `/api/health/live`, run with `node` (the image has no curl)                                                                                              |
| Baked settings  | `NODE_ENV=production`, `DEPLOYMENT_HOST=container`, `NEXT_MANUAL_SIG_HANDLE=true`, `HOSTNAME=0.0.0.0`, `PORT=3000`, `HOME=/tmp`, `GIT_COMMIT_SHA` (a build argument)      |

The image contains no secrets and reads no `.env` file: `.dockerignore` keeps `.env*`, `.git`,
`node_modules`, build output, tests and docs out of the build context. Every setting is given
when the image runs. The one exception is Next.js's own build keys: every Next.js build writes
random preview-mode and Server Action keys into its output, and so into the image. The platform
uses neither feature (no draft mode, no `"use server"`), so they protect nothing here. Even so,
keep images in a private registry, as you would any build artifact.

## 2. Build

```bash
docker build --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t platform-foundation .
```

`GIT_COMMIT_SHA` (7–40 hex characters) is what `/api/health/live` and `/api/health/ready` report
as `commit`, and what the smoke test compares with `SMOKE_EXPECTED_COMMIT`. Leave it out and
`commit` is `null`. The contract refuses a value that is not a commit hash.

`NEXT_PUBLIC_*` settings are compiled into the browser bundle when the image is built (until 7P
serves them at runtime, ADR-055 D3). Until then, build one image per environment, with the
`NEXT_PUBLIC_*` values set in the build environment. Never pass a secret that way.

## 3. Run

```bash
docker run -d --name app -p 3000:3000 \
  --read-only --tmpfs /tmp --tmpfs /app/.next/cache:uid=10001,gid=10001,mode=0700 \
  --env-file deploy.env \
  platform-foundation
```

`deploy.env` holds the deployment's settings. Use your host's secret store (ECS task secrets,
Kubernetes Secrets), not a file in the repository. The settings are the same as on any host
([ENV_REFERENCE](ENV_REFERENCE.md)). At least these:

| Setting                                            | Notes                                                                                                                                  |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DEPLOYMENT_HOST`                                  | Baked as `container`. Set your host's name (`aws`, `gcp`, …) if you prefer. Never `local` or `ci` on a deployment.                     |
| `AUTH_PROVIDER=cognito` and the Cognito settings   | Production refuses the mock provider (ADR-050 D1).                                                                                     |
| `GUEST_TOKEN_SECRET`, `CRON_SECRET`                | Secrets, 32+ random characters. Both required: without `CRON_SECRET` no timed duty would run, so boot refuses.                         |
| `DATABASE_URL`, `DATABASE_OWNER_URL`               | The request role (`app_tenant`) through a transaction pooler (RDS Proxy on AWS), and the owner (ADR-053 D4).                           |
| `DATABASE_SSL=verify-full` (+ `DATABASE_SSL_CA`)   | `disable` is refused outside `local`/`ci`.                                                                                             |
| Every durable store `=postgres`, `JOB_STORE`       | As on Vercel; `.env.example` lists them.                                                                                               |
| `CACHE_PROVIDER`                                   | `valkey` with `VALKEY_URL=rediss://…` (your own Valkey or Redis), or `upstash` with its two settings. Never `memory`: refused (below). |
| `TENANCY_MODE`, `TENANT_ID` / `TENANT_HOST_HEADER` | Behind an AWS ALB use `TENANT_HOST_HEADER=host`.                                                                                       |
| `TRUSTED_PROXY_HOPS`                               | 1 behind a load balancer alone; 2 with a CDN in front of it.                                                                           |

Boot checks the environment contract and refuses to start, naming every violation. In a
container that also covers `NEXT_MANUAL_SIG_HANDLE` (required with `DEPLOYMENT_HOST=container`),
`GIT_COMMIT_SHA` and the shutdown settings (§5). Apply the migrations before the first deploy
(`docs/TENANCY_OPERATIONS.md`).

Limits kept per process are per instance: the realtime connection guard.

### The shared cache

A deployment shares its cache across instances: sign-outs, role and MFA changes and permission
invalidations are published through it, so a per-instance cache would carry a revocation to one
instance and leave the others serving the revoked token (review 8 L3). `CACHE_PROVIDER=memory` is
therefore refused at boot on every deployment host, a container included (review 9 M5 — this page
said to use it before); the boot error says what to set. Choose one:

| Choice                   | When                                                       | Settings                                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CACHE_PROVIDER=valkey`  | Your host runs Valkey or Redis (ElastiCache, Memorystore…) | `VALKEY_URL=rediss://[user:password@]host:port[/db]` — no `?…` options (refused); `VALKEY_CA_CERT` (PEM) only when a private CA signed the server's certificate |
| `CACHE_PROVIDER=upstash` | No cache server of your own (also what Vercel uses)        | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` — [MIGRATION_v5_to_v6](MIGRATION_v5_to_v6.md) step 3 has the setup                                         |

Valkey: create the cluster with in-transit encryption (TLS) on and an auth token (or an ACL user)
— on ElastiCache, a Valkey serverless cache or a replication group with
`TransitEncryptionEnabled` and an auth token; one cache per environment. The URL holds the
password, so it goes into the container platform's secret store — an ECS task secret from AWS
Secrets Manager, a Kubernetes Secret — and from there into the container's environment; never into
the image, the task definition's plain environment, a file in the repository or a log. The
provider verifies the server's certificate and its name against the URL's host (verify-full);
`redis://` (clear text) is refused outside a local or CI run. Check it after the deploy: `/api/health/ready` reports the cache.

## 4. The job worker

Timed duties run when something calls the job tick (ADR-056 D2). On a container host, run the
worker from the same image with the command overridden. It needs no npm and no database access:

```bash
docker run -d --name worker --no-healthcheck --read-only \
  -e JOBS_WORKER_URL=https://app.example.com -e CRON_SECRET \
  platform-foundation node scripts/jobs-worker.mjs
```

`JOBS_WORKER_URL` must be `https`, or `http` to `localhost` only: run the worker as a sidecar in
the app's task or pod (which share `localhost`), or point it at the public address. Any number of
workers may run. On SIGTERM the worker exits 0 at once: the app finishes the tick it began, so the
worker needs no grace period beyond Docker's default. `CRON_SECRET` is required by the app's
boot as well: a deployment without it would run no timed duty, so it refuses to start.
`JOBS_WORKER_ONCE=1` runs one tick and exits, for a scheduler such as EventBridge or a
Kubernetes CronJob. `--no-healthcheck` is needed because the worker serves no
`/api/health/live`. ECS and Kubernetes ignore the image's `HEALTHCHECK` and use their own probes.

## 5. Health and shutdown

| Endpoint            | Use for                                          | Answers                                                                                                                                                                      |
| ------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/health/live`  | restarts (liveness probe, `HEALTHCHECK`)         | 200 whenever the process answers; asks no dependency                                                                                                                         |
| `/api/health/ready` | routing (load-balancer target health, readiness) | 200 `ready`/`degraded` once boot completed and the database and cache answer; 503 otherwise, with `boot`/`bootStep`, and with `draining: true` once the instance is stopping |

Both report `version` (`platform/version.ts`) and `commit`, never a probe's detail. Point the
load balancer's target health check at `/api/health/ready`, and the liveness probe at
`/api/health/live`, never the other way round.

**Shutdown (ADR-055 D5).** On SIGTERM or SIGINT the instance:

1. answers `/api/health/ready` with 503 (`draining: true`) at once; liveness stays 200. The job
   runner stops claiming, hands back the jobs it claimed but has not started, and tells the
   running attempt to stop;
2. waits `SHUTDOWN_DRAIN_SECONDS` (default 5, 0–300) while the load balancer takes it out of
   rotation;
3. waits until no request is still running — every API route, a job tick included — up to the
   stop deadline (the bound less up to 2 s kept for the next steps), so the pools are never closed
   under a request that finishes in time;
4. flushes buffered metrics (written through the database) and the error reporter;
5. closes the cache, then the database pools;
6. exits 0, or 1 if a step failed or something was still running at the stop deadline.

The whole stop is bounded by `SHUTDOWN_TIMEOUT_SECONDS` (default 9, 1–600, greater than the
drain). Past that bound it exits 1. A second signal joins the stop already under way. Keep the
bound inside the host's grace period, with a second to spare: Docker gives 10 s (`docker stop
-t 10`; raise it with `-t` or `stop_grace_period` in Compose when you raise the bound), ECS
`stopTimeout` (30 s by default), Kubernetes `terminationGracePeriodSeconds` (30 s by default).
A job tick in flight never holds the stop past the bound: whatever its 45-second budget, the
runner waits for its running attempt only until the stop deadline. A job whose handler ignores
its stop signal is left to the process's exit and runs again once its lease lapses. Set the drain at least as
long as the load balancer needs to stop routing: ALB target deregistration delay, or the
readiness probe's period × failure threshold. Example for ECS behind an ALB with a 15 s
deregistration delay: `SHUTDOWN_DRAIN_SECONDS=15`, `SHUTDOWN_TIMEOUT_SECONDS=25`,
`stopTimeout=30`.

A job whose handler is still running when the process exits loses its lease. It runs again after
the lease lapses (ADR-056 D2), which is why jobs are idempotent.

Kubernetes example (a 15 s drain behind a load balancer):

```yaml
spec:
  terminationGracePeriodSeconds: 30
  containers:
    - name: app
      env:
        - { name: SHUTDOWN_DRAIN_SECONDS, value: "15" }
        - { name: SHUTDOWN_TIMEOUT_SECONDS, value: "25" }
```

## 6. Pinning the base image

The default `BASE_IMAGE` pins a Node release (`24.22.1`). A tag can be republished with OS
patches, so two builds of one commit may differ; `BASE_IMAGE_DIGEST` pins the content. Set, the
`Dockerfile` builds `BASE_IMAGE@BASE_IMAGE_DIGEST` and Docker refuses any other content, from
Docker Hub or from a mirror:

```bash
docker buildx imagetools inspect node:24.22.1-trixie-slim --format '{{json .Manifest.Digest}}'
docker build \
  --build-arg BASE_IMAGE_DIGEST=sha256:<digest> \
  --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t platform-foundation .
```

To pin it for every build, set the `ARG BASE_IMAGE_DIGEST=` default in the `Dockerfile` to that
digest. To move to a new Node release, change `ARG BASE_IMAGE` and `ARG BASE_IMAGE_DIGEST` in the
same change.

**CI always builds by digest.** `scripts/pull-base-image.sh` asks Docker Hub's registry for the
tag's digest (a manifest request its pull limit does not count) — when `BASE_IMAGE_DIGEST` is
pinned, the answer must be that digest, or the build fails (the tag moved; the pin decides) —
then pulls that digest with retries, and only when Docker Hub refuses the pull, the same digest
from Google's Docker Hub mirror (`mirror.gcr.io`, TASK-122). It checks the pulled image is that
digest, and never pulls a tag from the mirror: with no pin and no answer from Docker Hub there is
no digest to trust, and it fails. It prints the reference and the digest; the build passes both:

```bash
pulled="$(bash scripts/pull-base-image.sh)"; read -r base digest <<<"$pulled"
docker build --build-arg BASE_IMAGE="$base" --build-arg BASE_IMAGE_DIGEST="$digest" …
```

## 7. Running as non-root

The image runs as `10001:10001` and needs nothing else:

- **Docker**: nothing to add. Do not pass `--user 0`.
- **Kubernetes**: the container's `securityContext` below, with `emptyDir` volumes on `/tmp` and
  `/app/.next/cache`.
- **ECS**: `user: "10001:10001"`, `readonlyRootFilesystem: true`, and volumes or bind mounts on
  `/tmp` and `/app/.next/cache`.

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities: { drop: [ALL] }
```

There is no passwd entry for the user, so `id` prints numbers only. The app never looks itself
up.

## 8. Checking a deployment

```bash
SMOKE_BASE_URL=https://app.example.com SMOKE_EXPECTED_COMMIT="$(git rev-parse HEAD)" \
  node scripts/deploy-smoke.mjs
```

It checks liveness, readiness and the commit, then the features list, an anonymous request being
refused, a signed guest token, and a real translation as that guest. `SMOKE_SKIP_TRANSLATE=1`
skips only the translation, for CI runs without AI credentials. Never set it against a
deployment.
