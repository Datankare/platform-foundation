# Dockerfile — the platform's container image, one image for any host (ADR-055 D1, D5)
#
# Three stages: deps (npm ci, cached on the lockfile), build (next build, standalone output) and
# runtime (Node, the standalone server, its static files and the job worker — no npm install, no
# dev dependencies, no source). The runtime runs as UID/GID 10001, writes only to /tmp and
# /app/.next/cache, and owns its signals (NEXT_MANUAL_SIG_HANDLE=true): on SIGTERM readiness
# flips, the instance drains, telemetry is flushed and the pools close (ADR-055 D5).
#
#   docker build --build-arg GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t platform-foundation .
#   docker run --read-only --tmpfs /tmp --tmpfs /app/.next/cache:uid=10001,gid=10001 \
#     -p 3000:3000 --env-file deploy.env platform-foundation
#   docker run … platform-foundation node scripts/jobs-worker.mjs      # the job worker
#
# BASE_IMAGE: the official Node 24 image, pinned to a release. BASE_IMAGE_DIGEST pins its content
# too: set (here, or as a build argument), the base is BASE_IMAGE@BASE_IMAGE_DIGEST and Docker
# refuses any other content, from Docker Hub or a mirror. CI always builds by digest:
# scripts/pull-base-image.sh asks Docker Hub for the tag's digest (and requires it to equal a
# pinned BASE_IMAGE_DIGEST), pulls that digest — from the mirror only when Docker Hub refuses — and
# passes both arguments on. To pin by hand (docs/DEPLOY_CONTAINER.md §6):
#   docker buildx imagetools inspect node:24.22.1-trixie-slim --format '{{json .Manifest.Digest}}'
#   docker build --build-arg BASE_IMAGE_DIGEST=sha256:<digest> …
# No secret is a build argument or baked in: every setting is given when the image runs
# (docs/DEPLOY_CONTAINER.md).

ARG BASE_IMAGE=node:24.22.1-trixie-slim
# Empty: the tag alone (a local build). Pin it here to make every build use exactly that content.
ARG BASE_IMAGE_DIGEST=

# ---- deps: every dependency, from the lockfile only ----------------------------------------
# The version is pinned by ARG BASE_IMAGE above, which the rule cannot resolve.
# nosemgrep: missing-image-version
FROM ${BASE_IMAGE}${BASE_IMAGE_DIGEST:+@}${BASE_IMAGE_DIGEST} AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
# Install scripts are not run: the build needs none (Next's compiler and sharp ship prebuilt
# binaries as optional dependencies), and a dependency's script is code run with the build's rights.
RUN npm ci --ignore-scripts --no-audit --no-fund

# ---- build: next build (output: "standalone") ------------------------------------------------
# A stage of this file, not an image.
# nosemgrep: missing-image-version
FROM deps AS build
COPY . .
# runtime-cache: an empty directory, copied below as the server's one writable directory.
RUN npm run build && mkdir -p .next/runtime-cache

# ---- runtime: the standalone server only -----------------------------------------------------
# nosemgrep: missing-image-version
FROM ${BASE_IMAGE}${BASE_IMAGE_DIGEST:+@}${BASE_IMAGE_DIGEST} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    DEPLOYMENT_HOST=container \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    HOME=/tmp

# Owned by root and read-only to the app: the process cannot change its own code.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/scripts/jobs-worker.mjs ./scripts/jobs-worker.mjs
# The one directory under /app the server writes (Next's image and fetch cache). Mount a tmpfs
# here, and on /tmp, when the root filesystem is read-only.
COPY --from=build --chown=10001:10001 /app/.next/runtime-cache ./.next/cache

# Last, so a new commit does not invalidate the layers above.
ARG GIT_COMMIT_SHA=""
ENV GIT_COMMIT_SHA=${GIT_COMMIT_SHA}

USER 10001:10001
EXPOSE 3000
STOPSIGNAL SIGTERM
# Liveness only (the process answers); orchestrators route on /api/health/ready. A worker
# container (the command overridden) has no server: run it with --no-healthcheck.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/live',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server.js"]
