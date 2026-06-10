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
# does NOT contain a real axe audit. The positive match requires BOTH
# an `await axe(` call and a `toHaveNoViolations` assertion (#818) —
# the old loose `axe(` pattern was satisfied by a mere COMMENT
# mentioning 'axe(', which defeated the check, and either token alone
# can still appear in a comment.
#
# Opt-out (#818): a test file that genuinely renders no DOM (e.g. a
# hook-wiring test that only asserts store/event plumbing) may carry a
# `// axe-exempt: <reason>` marker — same allow-marker idiom as
# `// allow-raw-tx:` / `# MAINT-99-allow-*`. The reason is mandatory:
# a bare `// axe-exempt:` with nothing after the colon does not count.
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

missing=""
count=0
exempt=0
for f in "$TESTS_DIR"/*.test.tsx; do
  [ -e "$f" ] || continue
  count=$((count + 1))
  # Real audit: an actual axe call AND the assertion. Requiring BOTH
  # tokens (not either) keeps a stray comment mentioning just
  # 'toHaveNoViolations' (or just 'await axe(') from satisfying the
  # check — the same comment-defeat #818 closed for the old loose
  # 'axe(' pattern. Covers both shapes in the tree:
  #   expect(await axe(container)).toHaveNoViolations()
  #   const results = await axe(container); expect(results).toHaveNoViolations()
  if grep -q -E "await[[:space:]]+axe[[:space:]]*\(" "$f" \
    && grep -q "toHaveNoViolations" "$f"; then
    continue
  fi
  # Explicit opt-out with a non-empty reason.
  if grep -q -E "//[[:space:]]*axe-exempt:[[:space:]]*[^[:space:]]" "$f"; then
    exempt=$((exempt + 1))
    continue
  fi
  missing="${missing}${f}"$'\n'
done
missing=${missing%$'\n'}

if [ -n "$missing" ]; then
  echo "ERROR: component test files missing axe(...) audit:"
  while IFS= read -r f; do
    echo "  ${f#"$ROOT/"}"
  done <<<"$missing"
  echo ""
  echo "Every src/components/__tests__/*.test.tsx must include at least one"
  echo "axe audit (expect(await axe(container)).toHaveNoViolations()) per"
  echo "src/__tests__/AGENTS.md:227. Add an 'a11y' it() block following"
  echo "the pattern in that doc, e.g.:"
  echo ""
  echo "  it('has no a11y violations', async () => {"
  echo "    const { container } = render(<MyComponent />)"
  echo "    await waitFor(async () => {"
  echo "      expect(await axe(container)).toHaveNoViolations()"
  echo "    })"
  echo "  })"
  echo ""
  echo "Non-rendering test files (hook-wiring only, no DOM) may opt out"
  echo "with a '// axe-exempt: <reason>' comment instead."
  exit 1
fi

echo "OK: all $count component test files include an axe(...) audit ($exempt axe-exempt)."
