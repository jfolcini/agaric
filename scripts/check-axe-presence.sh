#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
# axe-presence check.
#
# Per src/__tests__/AGENTS.md § Accessibility audit, every component test
# file (`*.test.tsx` under src/components/ and src/editor/) must include at
# least one axe audit. Without this, accessibility regressions slip
# through component additions because reviewers can't catch the
# missing audit by eye on every PR.
#
# A real audit is BOTH an `await axe(` call and a `toHaveNoViolations`
# assertion (#818): either token alone can sit in a comment.
#
# Opt-out (#818): a test file that genuinely renders no DOM (e.g. a
# hook-wiring test that only asserts store/event plumbing) may carry a
# `// axe-exempt: <reason>` marker. The reason is mandatory: a bare
# `// axe-exempt:` with nothing after the colon does not count.
#
# scripts/axe-presence-baseline.txt lists the files that had neither when
# the scan widened past src/components/__tests__/ (#6566). It only
# shrinks: a listed file that gains an audit or an exemption, or is
# deleted, fails until its line is removed.
#
# Usage: scripts/check-axe-presence.sh
# Exit:  0 = clean, 1 = a file missing an audit or a stale baseline line,
#        2 = nothing to scan (repo layout changed).
# ─────────────────────────────────────────────────────────────────────
set -euo pipefail
export LC_ALL=C

cd "$(dirname "$0")/.."
BASELINE=scripts/axe-presence-baseline.txt

mapfile -t files < <(find src/components src/editor -name '*.test.tsx' | sort)
if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: no *.test.tsx under src/components or src/editor — repo layout changed?"
  exit 2
fi
if [ ! -r "$BASELINE" ]; then
  echo "ERROR: $BASELINE is missing or unreadable."
  exit 2
fi

# `|| true`: grep exits 1 when nothing matches, which is an empty list here.
mapfile -t with_axe < <(grep -l -E 'await[[:space:]]+axe[[:space:]]*\(' "${files[@]}" || true)
audited=()
if [ "${#with_axe[@]}" -gt 0 ]; then
  mapfile -t audited < <(grep -l 'toHaveNoViolations' "${with_axe[@]}" || true)
fi
mapfile -t exempt < <(grep -l -E '//[[:space:]]*axe-exempt:[[:space:]]*[^[:space:]]' "${files[@]}" || true)

missing=$(comm -23 <(printf '%s\n' "${files[@]}") <(printf '%s\n' "${audited[@]}" "${exempt[@]}" | sort -u))
listed=$({ grep -v -E '^(#|$)' "$BASELINE" || true; } | sort)
new=$(comm -23 <(printf '%s\n' "$missing") <(printf '%s\n' "$listed"))
stale=$(comm -13 <(printf '%s\n' "$missing") <(printf '%s\n' "$listed"))

if [ -n "$new" ]; then
  echo "ERROR: component test files missing an axe audit:"
  while IFS= read -r f; do echo "  $f"; done <<<"$new"
  echo ""
  echo "Add an 'a11y' it() block following src/__tests__/AGENTS.md § Accessibility audit:"
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
fi
if [ -n "$stale" ]; then
  echo "ERROR: $BASELINE lists files that now audit, are exempt, or are gone:"
  while IFS= read -r f; do echo "  $f"; done <<<"$stale"
  echo "Delete those lines; the baseline only shrinks."
fi
if [ -n "$new" ] || [ -n "$stale" ]; then exit 1; fi

n_listed=$(printf '%s' "$listed" | grep -c . || true)
echo "OK: ${#files[@]} component test files: ${#audited[@]} audit, ${#exempt[@]} axe-exempt, $n_listed grandfathered in $BASELINE."
