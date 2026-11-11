#!/usr/bin/env bash
# The scheduled sync's history guard (docs/templates/sync-from-foundation.yml; TASK-204). A
# consuming app copies this file to .github/scripts/sync-carried-guard.sh, next to its copy of the
# workflow.
#
#   sync-carried-guard.sh <platform-foundation checkout> <app checkout>
#
# The version guard (sync-version-guard.sh) compares PLATFORM_VERSION only. An app that carries
# platform-foundation commits from develop ahead of a release can still be rolled back by a source
# with a newer version that lacks one of them. This finds the newest platform commit the app
# already carries, from the app's own history (newest first, on its checked-out branch):
#
#   - a sync commit, "chore(sync): inherit platform-foundation <ref> @ <40-hex sha>": that sha;
#   - a carried change, a subject ending "(platform TASK-nnn)": the newest platform-foundation
#     commit whose subject ends "(TASK-nnn)", on its develop or the source ref.
#
# and prints one line for $GITHUB_OUTPUT:
#
#   proceed=true    the source strictly descends from that commit: syncing loses nothing
#   proceed=false   the source is that commit, or does not contain it (a sync would roll the app
#                   back past a commit it already has): nothing to sync (exit 0, a notice)
#
# With no such commit in the app's history (an app that never synced), it says so and proceeds:
# the version guard alone decides. A carried task no platform-foundation commit names, or a
# checkout without history, exits 1, so the run fails and the failure alert opens an issue.
# The platform checkout needs its whole history and its develop branch (fetch-depth: 0, then
# `git fetch origin develop`); the app checkout needs its history (fetch-depth: 0).
set -euo pipefail

[ "$#" -eq 2 ] || { echo "usage: sync-carried-guard.sh <source> <target>" >&2; exit 1; }
SRC="$1"
DST="$2"
git -C "$SRC" rev-parse --verify -q HEAD >/dev/null || { echo "sync guard: $SRC is not a git checkout" >&2; exit 1; }
git -C "$DST" rev-parse --verify -q HEAD >/dev/null || { echo "sync guard: $DST is not a git checkout" >&2; exit 1; }
if [ "$(git -C "$DST" rev-parse --is-shallow-repository)" = "true" ] || [ "$(git -C "$SRC" rev-parse --is-shallow-repository)" = "true" ]; then
  echo "sync guard: a shallow checkout cannot show what the app already carries (fetch-depth: 0)" >&2
  exit 1
fi

SOURCE_SHA=$(git -C "$SRC" rev-parse HEAD)
SYNC_SUBJECT='^chore\(sync\): inherit platform-foundation [^ ]+ @ ([0-9a-f]{40})$'
CARRY_SUBJECT='\(platform (TASK-[0-9]+)\)$'

carried=""
how=""
while IFS=$'\t' read -r sha subject; do
  if [[ "$subject" =~ $SYNC_SUBJECT ]]; then
    carried="${BASH_REMATCH[1]}"
    how="its sync commit ${sha:0:7}"
    break
  fi
  if [[ "$subject" =~ $CARRY_SUBJECT ]]; then
    task="${BASH_REMATCH[1]}"
    refs=(HEAD)
    if git -C "$SRC" rev-parse --verify -q refs/remotes/origin/develop >/dev/null; then
      refs+=(refs/remotes/origin/develop)
    fi
    # The reader stops at the first match, so git may end on a closed pipe: not a failure.
    # No `case` in here: bash 3.2 (macOS) cannot parse a case pattern's ")" inside "$( )".
    suffix="($task)"
    carried=$(git -C "$SRC" log --topo-order --format='%H%x09%s' "${refs[@]}" |
      while IFS=$'\t' read -r psha psubject; do
        if [[ "$psubject" == *"$suffix" ]]; then echo "$psha"; break; fi
      done) || true
    if [ -z "$carried" ]; then
      echo "sync guard: the app carries ($task) in ${sha:0:7}, but no platform-foundation commit names ($task)" >&2
      exit 1
    fi
    how="($task), carried in ${sha:0:7}"
    break
  fi
done < <(git -C "$DST" log --format='%H%x09%s' HEAD)

if [ -z "$carried" ]; then
  echo "::notice::The app's history names no platform commit it carries: the version guard alone decides." >&2
  echo "proceed=true"
  exit 0
fi

if [ "$carried" = "$SOURCE_SHA" ]; then
  echo "::notice::The app already carries the source's platform commit ${SOURCE_SHA:0:7} ($how). Nothing to sync." >&2
  echo "proceed=false"
elif git -C "$SRC" merge-base --is-ancestor "$carried" "$SOURCE_SHA" 2>/dev/null; then
  echo "sync guard: the source ${SOURCE_SHA:0:7} contains ${carried:0:7} ($how): syncing" >&2
  echo "proceed=true"
else
  echo "::notice::The source ${SOURCE_SHA:0:7} does not contain platform commit ${carried:0:7}, which the app already carries ($how): a sync would roll the app back. Nothing to sync." >&2
  echo "proceed=false"
fi
