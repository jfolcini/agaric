#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# axe-presence check.
#
# Per src/__tests__/AGENTS.md:227, every component test file in
# src/components/__tests__/*.test.tsx must include at least one
# axe(...) audit. Without this, accessibility regressions slip
# through component additions because reviewers can't catch the
# missing audit by eye on every PR.
#
# This script lists every .test.tsx in src/components/__tests__/ that
# does NOT contain an `axe(` call (any whitespace before the paren is
# tolerated to match `await axe(container)`, `axe (container)`, etc.).
# Component tests that genuinely render no DOM (rare — usually pure
# helper modules) should live under a non-component path; this hook
# scopes itself to the components/__tests__/ directory specifically.
#
# Usage: scripts/check-axe-presence.sh
# Exit:  0 = clean, 1 = at least one file missing axe(...).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
TESTS_DIR="$ROOT/src/components/__tests__"

if [ ! -d "$TESTS_DIR" ]; then
  echo "ERROR: $TESTS_DIR does not exist — repo layout changed?"
  exit 2
fi

# grep -L returns 1 when every file matches (nothing printed). The
# `|| true` swallows that so the script doesn't exit under set -e.
missing=$(grep -L -E "axe[[:space:]]*\(" "$TESTS_DIR"/*.test.tsx 2>/dev/null || true)

if [ -n "$missing" ]; then
  echo "ERROR: component test files missing axe(...) audit:"
  while IFS= read -r f; do
    echo "  ${f#"$ROOT/"}"
  done <<<"$missing"
  echo ""
  echo "Every src/components/__tests__/*.test.tsx must include at least one"
  echo "axe(container) audit per src/__tests__/AGENTS.md:227. Add an"
  echo "'a11y' it() block following the pattern in that doc, e.g.:"
  echo ""
  echo "  it('has no a11y violations', async () => {"
  echo "    const { container } = render(<MyComponent />)"
  echo "    await waitFor(async () => {"
  echo "      expect(await axe(container)).toHaveNoViolations()"
  echo "    })"
  echo "  })"
  exit 1
fi

count=$(ls "$TESTS_DIR"/*.test.tsx 2>/dev/null | wc -l)
echo "OK: all $count component test files include an axe(...) audit."
