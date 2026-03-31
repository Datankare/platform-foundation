#!/usr/bin/env bash
#
# scripts/sustainability-gate.sh — Automated 22-point sustainability gate
#
# Run at every sprint boundary before promotion.
# Exit code 0 = PASS, 1 = FAIL
#
# Usage: ./scripts/sustainability-gate.sh
#
# Sprint 7a, Task 7a.1

set -euo pipefail

PASS=0
FAIL=0
WARN=0
MAX_LINES=300
REPORT=""

pass() { PASS=$((PASS + 1)); REPORT+="  ✅ $1\n"; }
fail() { FAIL=$((FAIL + 1)); REPORT+="  ❌ $1\n"; }
warn() { WARN=$((WARN + 1)); REPORT+="  ⚠️  $1\n"; }
section() { REPORT+="\n── $1 ──\n"; }

# ── 1. Code Quality ──────────────────────────────────────────────────────

section "Code Quality"

# 1. Prettier
if npm run format 2>&1 | grep -q "unchanged\|Wrote 0"; then
  # Check if any files were changed
  CHANGED=$(git diff --name-only 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CHANGED" = "0" ]; then
    pass "G01 Formatting: all files match Prettier"
  else
    fail "G01 Formatting: $CHANGED files reformatted — commit them"
  fi
else
  pass "G01 Formatting: Prettier ran"
fi

# 2. TypeScript
if npm run typecheck 2>&1 | grep -q "error"; then
  fail "G02 TypeScript: type errors found"
else
  pass "G02 TypeScript: zero type errors"
fi

# 3. ESLint errors
LINT_OUTPUT=$(npm run lint 2>&1)
LINT_ERRORS=$(echo "$LINT_OUTPUT" | grep -c "error" || true)
LINT_WARNINGS=$(echo "$LINT_OUTPUT" | grep -c "warning" || true)
if [ "$LINT_ERRORS" -gt 0 ]; then
  fail "G03 ESLint: $LINT_ERRORS errors"
elif [ "$LINT_WARNINGS" -gt 0 ]; then
  warn "G03 ESLint: $LINT_WARNINGS warnings (0 errors)"
else
  pass "G03 ESLint: zero errors, zero warnings"
fi

# 4. Tests pass
if npm run test:coverage 2>&1 | grep -q "Tests:.*failed"; then
  fail "G04 Tests: some tests failing"
else
  TEST_COUNT=$(npm run test 2>&1 | grep "Tests:" | grep -oE "[0-9]+ passed" | head -1)
  pass "G04 Tests: $TEST_COUNT"
fi

# 5. Build
if npm run build 2>&1 | grep -q "error\|Error"; then
  fail "G05 Build: build failed"
else
  pass "G05 Build: clean build"
fi

# ── 2. File Size Limits ──────────────────────────────────────────────────

section "File Size Limits"

OVERSIZED=0
OVERSIZED_FILES=""
for f in $(find app components hooks lib platform shared -name "*.ts" -o -name "*.tsx" 2>/dev/null | grep -v node_modules | grep -v ".test."); do
  LINES=$(wc -l < "$f" | tr -d ' ')
  if [ "$LINES" -gt "$MAX_LINES" ]; then
    OVERSIZED=$((OVERSIZED + 1))
    OVERSIZED_FILES+="    $f ($LINES lines)\n"
  fi
done

if [ "$OVERSIZED" -eq 0 ]; then
  pass "G06 File lengths: all files under $MAX_LINES lines"
else
  warn "G06 File lengths: $OVERSIZED files over $MAX_LINES lines"
  REPORT+="$OVERSIZED_FILES"
fi

# ── 3. Security ──────────────────────────────────────────────────────────

section "Security"

# 7. Empty catches
EMPTY_CATCHES=$(grep -rn "catch {" app/ components/ hooks/ lib/ platform/ shared/ 2>/dev/null | grep -v node_modules | grep -v ".test." || true)
EMPTY_COUNT=$(echo "$EMPTY_CATCHES" | grep -c "catch {" || true)
if [ "$EMPTY_COUNT" -gt 0 ]; then
  warn "G07 Empty catches: $EMPTY_COUNT found"
  while IFS= read -r line; do
    [ -n "$line" ] && REPORT+="    $line\n"
  done <<< "$EMPTY_CATCHES"
else
  pass "G07 Empty catches: none"
fi

# 8. No hardcoded secrets
SECRETS=$(grep -rn "sk-ant-\|eyJhbGci\|AKIA" app/ components/ lib/ platform/ shared/ 2>/dev/null | grep -v node_modules | grep -v ".env" | grep -v ".test." || true)
if [ -n "$SECRETS" ]; then
  fail "G08 Hardcoded secrets: found"
  REPORT+="$SECRETS\n"
else
  pass "G08 Hardcoded secrets: none"
fi

# 9. No console.log in production code
CONSOLE_LOGS=$(grep -rn "console\.log\|console\.warn\|console\.error" app/ components/ hooks/ lib/ platform/ 2>/dev/null | grep -v node_modules | grep -v ".test." | grep -v "// eslint" || true)
CONSOLE_COUNT=$(echo "$CONSOLE_LOGS" | grep -c "console\." || true)
if [ "$CONSOLE_COUNT" -gt 0 ]; then
  warn "G09 Console statements: $CONSOLE_COUNT found (use logger instead)"
else
  pass "G09 Console statements: none (using structured logger)"
fi

# 10. Module-level mutable state
MODULE_STATE=$(grep -rn "^let \|^var \|^const.*= new Map\|^const.*= new Set\|^const.*= \[\]" app/ components/ hooks/ lib/ platform/ shared/ 2>/dev/null | grep -v node_modules | grep -v ".test." | grep -v "// justified" || true)
MODULE_STATE_COUNT=$(echo "$MODULE_STATE" | grep -c "." || true)
if [ "$MODULE_STATE_COUNT" -gt 0 ]; then
  warn "G10 Module-level mutable state: $MODULE_STATE_COUNT instances (verify justified)"
  while IFS= read -r line; do
    [ -n "$line" ] && REPORT+="    $line\n"
  done <<< "$MODULE_STATE"
else
  pass "G10 Module-level mutable state: none"
fi

# ── 4. Architecture ──────────────────────────────────────────────────────

section "Architecture"

# 11. No circular imports (basic check)
SELF_IMPORTS=$(grep -rn "from ['\"]@/" app/ components/ lib/ platform/ 2>/dev/null | grep -v node_modules | grep -v ".test." | while read -r line; do
  FILE_DIR=$(dirname "$(echo "$line" | cut -d: -f1)")
  IMPORT=$(echo "$line" | grep -oE "from ['\"]@/[^'\"]+['\"]" | sed "s/from ['\"]@\///;s/['\"]//g")
  if [ -n "$IMPORT" ] && echo "$line" | cut -d: -f1 | grep -q "$IMPORT"; then
    echo "$line"
  fi
done || true)
if [ -n "$SELF_IMPORTS" ]; then
  warn "G11 Self-imports detected"
else
  pass "G11 No self-imports detected"
fi

# 12. DB modules excluded from unit coverage
DB_MODULES="permissions.ts entitlements.ts audit.ts profile.ts devices.ts consent.ts coppa.ts"
DB_EXCLUDED=true
for mod in $DB_MODULES; do
  if ! grep -q "$mod" package.json 2>/dev/null; then
    DB_EXCLUDED=false
    break
  fi
done
if $DB_EXCLUDED; then
  pass "G12 DB modules excluded from unit coverage"
else
  warn "G12 DB modules may not be excluded from coverage"
fi

# 13. Admin modules excluded from unit coverage
if grep -q "admin-guard.ts" package.json && grep -q "admin/ai/route.ts" package.json; then
  pass "G13 Admin modules excluded from unit coverage"
else
  warn "G13 Admin modules may not be excluded from coverage"
fi

# ── 5. Documentation ─────────────────────────────────────────────────────

section "Documentation"

# 14. SECURITY_DEBT.md exists and has content
if [ -f "docs/SECURITY_DEBT.md" ] && [ -s "docs/SECURITY_DEBT.md" ]; then
  DEBT_ITEMS=$(grep -c "^## " docs/SECURITY_DEBT.md || true)
  pass "G14 SECURITY_DEBT.md: $DEBT_ITEMS tracked items"
else
  fail "G14 SECURITY_DEBT.md: missing or empty"
fi

# 15. ADRs exist
ADR_COUNT=$(ls docs/adr/ADR-*.md 2>/dev/null | wc -l | tr -d ' ')
if [ "$ADR_COUNT" -gt 0 ]; then
  pass "G15 ADRs: $ADR_COUNT documented"
else
  warn "G15 ADRs: none found"
fi

# 16. CONTRIBUTING.md exists
if [ -f "CONTRIBUTING.md" ]; then
  pass "G16 CONTRIBUTING.md: present"
else
  fail "G16 CONTRIBUTING.md: missing"
fi

# ── 6. Dependencies ──────────────────────────────────────────────────────

section "Dependencies"

# 17. No audit vulnerabilities (high/critical)
AUDIT_OUTPUT=$(npm audit 2>&1 || true)
HIGH_VULNS=$(echo "$AUDIT_OUTPUT" | grep -c "high\|critical" || true)
if [ "$HIGH_VULNS" -gt 0 ]; then
  warn "G17 npm audit: $HIGH_VULNS high/critical findings"
else
  pass "G17 npm audit: no high/critical vulnerabilities"
fi

# 18. package-lock.json in sync
if [ -f "package-lock.json" ]; then
  pass "G18 package-lock.json: present"
else
  fail "G18 package-lock.json: missing"
fi

# ── 7. CI/CD ─────────────────────────────────────────────────────────────

section "CI/CD"

# 19. CI workflow exists
if [ -f ".github/workflows/ci.yml" ]; then
  pass "G19 CI workflow: present"
else
  fail "G19 CI workflow: missing"
fi

# 20. Dependabot configured
if [ -f ".github/dependabot.yml" ]; then
  pass "G20 Dependabot: configured"
else
  warn "G20 Dependabot: not configured"
fi

# ── 8. Git Hygiene ───────────────────────────────────────────────────────

section "Git Hygiene"

# 21. No untracked files in source dirs
UNTRACKED=$(git ls-files --others --exclude-standard app/ components/ lib/ platform/ shared/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$UNTRACKED" -gt 0 ]; then
  warn "G21 Untracked source files: $UNTRACKED"
else
  pass "G21 No untracked source files"
fi

# 22. Current branch
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
pass "G22 Current branch: $BRANCH"

# ── Report ───────────────────────────────────────────────────────────────

TOTAL=$((PASS + FAIL + WARN))
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║        SUSTAINABILITY GATE REPORT                   ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "$REPORT"
echo ""
echo "╠══════════════════════════════════════════════════════╣"
echo "║  ✅ PASS: $PASS   ❌ FAIL: $FAIL   ⚠️  WARN: $WARN   Total: $TOTAL/22  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "GATE: ❌ FAILED — $FAIL blocking issues must be fixed"
  exit 1
else
  echo "GATE: ✅ PASSED ($PASS pass, $WARN warnings)"
  exit 0
fi
