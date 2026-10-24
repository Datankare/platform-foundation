#!/usr/bin/env bash
# scripts/pull-base-image.sh — fetch the Dockerfile's base image, by digest, before a CI build
# (ADR-055 D1, TASK-122)
#
# Docker Hub limits anonymous pulls per address, and the limit has failed CI before with nothing
# wrong in the code. So this pulls the base image with retries, and, when Docker Hub still refuses
# an official image, from Google's Docker Hub mirror (mirror.gcr.io). The mirror must never be able
# to substitute other content, so every pull is BY DIGEST and the digest never comes from the
# mirror:
#
#   1. the digest: BASE_IMAGE_DIGEST (the environment, else the Dockerfile's ARG default) when it is
#      pinned; and, for an official image, the tag's current digest asked of Docker Hub's registry
#      (a manifest HEAD request, which its pull limit does not count). Pinned and resolved must be
#      the same digest, or this fails — the tag moved, and the pin decides, not the mirror. With no
#      pin and no answer from Docker Hub there is no digest to trust: this fails rather than pull
#      a tag from the mirror unverified;
#   2. the pull: <image>@<digest> from Docker Hub, with retries, then from the mirror. Docker
#      checks the content against the digest, and this checks the pulled image's RepoDigests name
#      that digest — a mirror that has another one fails.
#
# It prints the reference and the digest on one line; the build passes both on:
#
#   pulled="$(bash scripts/pull-base-image.sh)"; read -r base digest <<<"$pulled"
#   docker build --build-arg BASE_IMAGE="$base" --build-arg BASE_IMAGE_DIGEST="$digest" …
#
# The image given as $1 overrides the Dockerfile's ARG BASE_IMAGE (name:tag, optionally
# @sha256:… — that digest is then the pin). Settings: BASE_IMAGE_DIGEST (sha256:<64 hex>),
# PULL_RETRY_DELAY_SECONDS (default 10: waits 1×, 2× between three attempts).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
arg_default() { sed -nE "s/^ARG $1=(.*)$/\\1/p" "$ROOT/Dockerfile" | head -n 1; }
fail() {
  echo "✗ $*" >&2
  exit 1
}

image="${1:-$(arg_default BASE_IMAGE)}"
[ -n "$image" ] || fail "no ARG BASE_IMAGE default in the Dockerfile"
pin="${BASE_IMAGE_DIGEST-$(arg_default BASE_IMAGE_DIGEST)}"
case "$image" in
  *@*)
    from_ref="${image#*@}"
    image="${image%%@*}"
    [ -z "$pin" ] || [ "$pin" = "$from_ref" ] \
      || fail "BASE_IMAGE_DIGEST ($pin) differs from the digest in $1"
    pin="$from_ref"
    ;;
esac
digest_shape='^sha256:[0-9a-f]{64}$'
if [ -n "$pin" ] && ! [[ "$pin" =~ $digest_shape ]]; then
  fail "BASE_IMAGE_DIGEST must be sha256:<64 hex digits>, got: $pin"
fi
delay="${PULL_RETRY_DELAY_SECONDS:-10}"
name="${image%:*}"
tag="${image##*:}"
{ [ "$name" != "$image" ] && [ -n "$tag" ] && [[ "$tag" != */* ]]; } \
  || fail "the base image must name a tag: $image"

# An official image: no registry host, no namespace (node:…, not ghcr.io/… or org/…).
official=false
[[ "$name" != */* ]] && official=true

# The tag's digest, from Docker Hub's registry itself (official images); empty when it cannot say.
hub_digest() {
  local token headers
  token="$(curl -fsS --max-time 20 \
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/$name:pull" \
    | sed -nE 's/.*"(token|access_token)" *: *"([^"]+)".*/\2/p' | head -n 1)" || return 0
  [ -n "$token" ] || return 0
  headers="$(curl -fsSI --max-time 20 -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json" \
    "https://registry-1.docker.io/v2/library/$name/manifests/$tag")" || return 0
  printf '%s\n' "$headers" | tr -d '\r' \
    | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | head -n 1
}

digest=""
if $official; then
  resolved=""
  for attempt in 1 2 3; do
    resolved="$(hub_digest || true)"
    [ -n "$resolved" ] && break
    echo "… Docker Hub did not say the digest of $image (attempt $attempt)" >&2
    [ "$attempt" = 3 ] || sleep $((attempt * delay))
  done
  if [ -n "$resolved" ]; then
    [[ "$resolved" =~ $digest_shape ]] \
      || fail "Docker Hub answered a malformed digest for $image: $resolved"
    if [ -n "$pin" ] && [ "$pin" != "$resolved" ]; then
      fail "$image is now $resolved on Docker Hub, not the pinned BASE_IMAGE_DIGEST $pin — update the pin on purpose, or keep the old release"
    fi
    digest="$resolved"
  elif [ -n "$pin" ]; then
    echo "… using the pinned digest $pin (Docker Hub could not be asked)" >&2
    digest="$pin"
  else
    fail "cannot verify $image: Docker Hub did not say its digest and BASE_IMAGE_DIGEST is not pinned — a mirror's copy of a tag is never trusted unverified"
  fi
else
  [ -n "$pin" ] || fail "$image is not an official Docker Hub image: pin its digest (BASE_IMAGE_DIGEST)"
  digest="$pin"
fi

# Pull <repo>@<digest> and check the image is that digest: 0 pulled and verified, 1 not pulled,
# 2 pulled but not that digest (never retried, never replaced by the mirror).
pull_verified() {
  local repo="$1"
  docker pull -q "$repo@$digest" >/dev/null 2>&1 || return 1
  if ! docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$repo@$digest" 2>/dev/null | grep -qxF "$repo@$digest"; then
    echo "✗ $repo@$digest was pulled but its content is not that digest" >&2
    return 2
  fi
}

status=0
for attempt in 1 2 3; do
  pull_verified "$name" && status=0 || status=$?
  if [ "$status" = 0 ]; then
    echo "✓ base image: $name:$tag@$digest" >&2
    echo "$name:$tag $digest"
    exit 0
  fi
  [ "$status" = 2 ] && exit 1
  echo "… pull of $name@$digest failed (attempt $attempt)" >&2
  [ "$attempt" = 3 ] || sleep $((attempt * delay))
done

if $official; then
  mirror="mirror.gcr.io/library/$name"
  pull_verified "$mirror" && status=0 || status=$?
  if [ "$status" = 0 ]; then
    echo "✓ base image: $mirror:$tag@$digest (the same digest, from the mirror: Docker Hub refused the pull)" >&2
    echo "$mirror:$tag $digest"
    exit 0
  fi
  [ "$status" = 2 ] && exit 1
  fail "could not pull $name@$digest from Docker Hub or the mirror (the mirror may not have that digest)"
fi
fail "could not pull $name@$digest"
