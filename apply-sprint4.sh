#!/bin/bash
# Sprint 4: Redis + Infrastructure Hardening — Apply Script
# Run from ~/platform-foundation on feature/phase2-sprint4 branch
#
# Usage:
#   cd ~/platform-foundation
#   git checkout develop && git pull
#   git checkout -b feature/phase2-sprint4
#   tar xzf ~/Downloads/sprint4-redis-infrastructure-hardening.tar.gz
#   bash apply-sprint4.sh

set -euo pipefail

echo "=== Sprint 4: Redis + Infrastructure Hardening ==="
echo ""

# ─── Step 1: Verify extraction ───
echo "1. Verifying file structure..."
for f in \
  platform/cache/types.ts \
  platform/cache/memory-cache.ts \
  platform/cache/redis-cache.ts \
  platform/cache/health-probe.ts \
  platform/cache/index.ts \
  platform/rate-limit/types.ts \
  platform/rate-limit/memory-limiter.ts \
  platform/rate-limit/redis-limiter.ts \
  platform/rate-limit/index.ts \
  platform/auth/password-policy.ts \
  platform/gdpr/types.ts \
  platform/gdpr/hard-purge.ts \
  platform/gdpr/index.ts \
  __tests__/cache.test.ts \
  __tests__/rate-limit.test.ts \
  __tests__/password-policy.test.ts \
  __tests__/gdpr-hard-purge.test.ts \
  supabase/migrations/009_gdpr_purge_log.sql; do
  if [ ! -f "$f" ]; then
    echo "  ❌ MISSING: $f"
    exit 1
  fi
done
echo "  ✅ All 18 source files present"
echo ""

# ─── Step 2: Quality gate ───
echo "2. Running quality gate..."
npm run format 2>&1 || true
npm run format:check
npm run typecheck
npm run lint
npm test
echo "  ✅ Quality gate passed"
echo ""

# ─── Step 3: Commit ───
echo "3. Ready to commit. Suggested command:"
echo ""
echo '  git add -A && git commit -m "feat: Redis + Infrastructure Hardening (Phase 2, Sprint 4)'
echo ''
echo 'New modules:'
echo '  platform/cache/ — CacheProvider interface + InMemory + Redis (Upstash)'
echo '  platform/rate-limit/ — RateLimiter interface + InMemory + Redis (sliding window ZSET)'
echo '  platform/auth/password-policy.ts — NIST SP 800-63B password validation'
echo '  platform/gdpr/ — PurgePipeline + audit trail'
echo ''
echo 'Observability integration:'
echo '  platform/cache/health-probe.ts — Redis health wired into HealthRegistry'
echo ''
echo 'Database:'
echo '  supabase/migrations/009_gdpr_purge_log.sql — purge audit table (RLS: super_admin only)'
echo ''
echo 'Tests: +X new (cache, rate-limit, password-policy, gdpr-hard-purge)"'
echo ""

echo "=== Done. After commit, push and PR: feature/phase2-sprint4 → develop ==="
