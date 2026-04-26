#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# Test file naming convention check.
#
# Per src/__tests__/AGENTS.md:81:
#   - Vitest files use .test.ts / .test.tsx
#   - Playwright files use .spec.ts
#   - Property-based tests insert .property before .test
#     (e.g. markdown-serializer.property.test.ts)
#
# Mixing the suffixes — e.g. a Vitest file accidentally named .spec.ts,
# a Playwright file accidentally named .test.ts, or a doubled suffix
# like .test.spec.ts — silently routes the file to the wrong runner
# (or no runner at all). This hook fails if any frontend test file
# violates the naming.
#
# Scope:
#   - src/   : .ts / .tsx files whose basename ends with .test.* or .spec.*
#              must end with .test.ts or .test.tsx, never .spec.*
#   - e2e/   : .ts / .tsx files whose basename ends with .test.* or .spec.*
#              must end with .spec.ts, never .test.* (no .tsx in e2e)
#   - Mixed  : .test.spec.* and .spec.test.* are always a violation.
#
# Files without .test.* / .spec.* in the basename are NOT checked —
# helper modules like src/test-setup.ts, src/vitest-axe.d.ts, and
# e2e/helpers.ts are deliberately not test files and so are not subject
# to the naming rule.
#
# Rust tests (`*_tests.rs`, `tests.rs`, etc.) are out of scope; the
# rule comes from the frontend test doc and only applies to .ts/.tsx.
#
# Usage: scripts/check-test-file-naming.sh
# Exit:  0 = clean, 1 = at least one violation.
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

violations=0

emit() {
  if [ "$violations" -eq 0 ]; then
    echo "ERROR: test file naming convention violations (see src/__tests__/AGENTS.md:81):"
  fi
  echo "  $1"
  violations=$((violations + 1))
}

# Doubled suffix anywhere — always wrong.
while IFS= read -r f; do
  emit "$f  (doubled suffix — pick exactly one of .test.* or .spec.*)"
done < <(find src e2e -type f \( -name "*.test.spec.*" -o -name "*.spec.test.*" \) 2>/dev/null)

# src/ — .spec.ts / .spec.tsx are always wrong (those are Playwright).
while IFS= read -r f; do
  emit "$f  (src/ uses .test.ts / .test.tsx — .spec.* is for Playwright in e2e/)"
done < <(find src -type f \( -name "*.spec.ts" -o -name "*.spec.tsx" \) 2>/dev/null)

# e2e/ — .test.ts / .test.tsx are always wrong (those are Vitest).
while IFS= read -r f; do
  emit "$f  (e2e/ uses .spec.ts — .test.* is for Vitest in src/)"
done < <(find e2e -type f \( -name "*.test.ts" -o -name "*.test.tsx" \) 2>/dev/null)

# e2e/ should not contain .tsx test files at all (Playwright is .ts only).
while IFS= read -r f; do
  emit "$f  (e2e/ specs are plain .spec.ts — Playwright does not use JSX)"
done < <(find e2e -type f -name "*.spec.tsx" 2>/dev/null)

if [ "$violations" -gt 0 ]; then
  echo ""
  echo "Convention: Vitest → .test.ts / .test.tsx (under src/)"
  echo "            Playwright → .spec.ts (under e2e/)"
  echo "Rename the offending file(s) to match the runner that owns them."
  exit 1
fi

echo "OK: no test file naming violations."
