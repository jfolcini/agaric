# Session 1203 — Push-based filing loop for mutation-testing survivors

**Date:** 2026-07-23
**Branch:** `ci/mutation-survivor-filing`
**Closes:** #2947

## Summary

Mutation-testing survivors (cargo-mutants for Rust, StrykerJS for frontend) surfaced only in
the weekly CI step summary, so triage was pull-based — someone had to open the summary. This
adds a push-based loop that files or updates a **single** tracking GitHub issue when NEW
survivors appear, so regressions in mutation coverage surface without anyone watching.

## The change (2 files, purely additive)

- **`scripts/file-mutation-survivors.mjs`** (new, pure Node built-ins) — parses
  `src-tauri/mutants-out/missed.txt` (cargo-mutants) and every StrykerJS `mutation.json`
  (`Survived` mutants), diffs the current set against the known set stored in the tracking
  issue's own body (between `<!-- mutation-survivors:begin/end -->` markers — so only
  `issues: write` is needed, no committed baseline). Finds the one tracking issue by **exact
  title match** (preferring OPEN, reopening a CLOSED one rather than duplicating), and on new
  survivors edits the body (refreshed known-set) + posts a comment listing just the new ones
  (the trend). No-op gate is strictly `newOnes.length === 0`, so a purely-resolved week stays
  silent. `--dry-run` + `--known-body-file` flags make every path testable without touching
  GitHub.
- **`.github/workflows/scheduled-deep-checks.yml`** — new `file-mutation-survivors` job,
  `needs: [mutants, mutants-frontend]`, `if: always() && github.event_name == 'schedule'` (so
  `workflow_dispatch`/PR can never touch the real issue), `permissions: { contents: read,
  issues: write }`, artifact downloads `continue-on-error`. Uses `secrets.GITHUB_TOKEN`.

## Verification

Script-level (dry-run fixtures, run by builder AND reviewer): create (no existing issue),
idempotent no-op (re-run against own rendered body), update (new + resolved), resolved-only
no-op, missing-input robustness, malformed-JSON skip, and the body-marker round-trip parse —
all correct. YAML parses; `zizmor` 0 findings; labels `testing`/`github-actions` confirmed to
exist. Review also fixed 18 oxlint violations in the script (encoding casing, `.at()`,
`toSorted()`, switch-case braces) so it passes the lint gate. **Not locally verifiable:** the
real weekly `schedule` run making live `gh issue` calls against real artifact shapes — a
CI-only behavior; everything else was validated via the script's dry-run harness.
