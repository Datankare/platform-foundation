#!/usr/bin/env bash
# The scheduled sync's version guard (docs/templates/sync-from-foundation.yml). A consuming app
# copies this file to .github/scripts/sync-version-guard.sh, next to its copy of the workflow.
#
#   sync-version-guard.sh <platform-foundation checkout> <app checkout>
#
# An app may adopt platform-foundation from develop ahead of its release, so the scheduled sync's
# source (the configured ref, normally main) can be OLDER than the platform the app already has.
# Syncing it would open a pull request that silently reverts that work. This compares
# PLATFORM_VERSION in each checkout's platform/version.ts and prints one line for $GITHUB_OUTPUT:
#
#   proceed=true    the source is strictly newer: sync and open the pull request
#   proceed=false   the source is the same version or older: nothing to sync (exit 0)
#
# A missing or malformed version exits 1, so the run fails and the failure alert opens an issue.
set -euo pipefail

version_of() {
  local file="$1/platform/version.ts" v
  [ -f "$file" ] || { echo "sync guard: $file is missing" >&2; return 1; }
  v=$(sed -n 's/^export const PLATFORM_VERSION = "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)";$/\1/p' "$file")
  [ -n "$v" ] && [ "$(printf '%s\n' "$v" | wc -l)" -eq 1 ] || {
    echo "sync guard: no single PLATFORM_VERSION \"X.Y.Z\" in $file" >&2
    return 1
  }
  printf '%s' "$v"
}

[ "$#" -eq 2 ] || { echo "usage: sync-version-guard.sh <source> <target>" >&2; exit 1; }
SRC=$(version_of "$1")
DST=$(version_of "$2")

# Numeric comparison, field by field (no locale or sort -V dependence).
IFS=. read -r s1 s2 s3 <<<"$SRC"
IFS=. read -r d1 d2 d3 <<<"$DST"
if (( 10#$s1 > 10#$d1 || (10#$s1 == 10#$d1 && (10#$s2 > 10#$d2 || (10#$s2 == 10#$d2 && 10#$s3 > 10#$d3))) )); then
  echo "sync guard: platform-foundation $SRC is newer than the app's $DST: syncing" >&2
  echo "proceed=true"
else
  echo "::notice::The app already has platform $DST; the source is $SRC. Nothing to sync (it adopted the platform ahead of its release)." >&2
  echo "proceed=false"
fi
