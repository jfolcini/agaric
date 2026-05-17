# PEND-44 — push test coverage to OpenSSF Silver thresholds

**Goal**: lift `test_branch_coverage80` and `test_statement_coverage90` on the OpenSSF Best Practices Silver tier (and the equivalent vitest gates) from current to over-threshold.

## Current state

- **Vitest merged coverage** (3-shard, merged via `scripts/merge-vitest-coverage.mjs`):
  - lines: ~88% (gate in `vitest.config.ts` is ≥80% → green; Silver wants ≥90%)
  - statements: ~87%
  - branches: **~78.99%** (gate is ≥75% → green; Silver wants ≥80%)
  - functions: ~87%
- **Rust coverage** (cargo-llvm-cov in `_validate.yml`): wired but not measured yet. Will land after the first instrumented CI run.

## Acceptance criteria

1. Merged vitest coverage shows ≥ 90% lines, ≥ 90% statements, ≥ 80% branches on `main` for three consecutive CI runs (run-to-run variance ~0.3% is normal).
2. Rust llvm-cov line coverage ≥ 80% across `src-tauri/src/`.
3. Coverage gates in `vitest.config.ts` raised to match:
   - `lines: 90, functions: 90, statements: 90, branches: 80`
4. `pending/REVIEW-LATER.md` rows for `test_statement_coverage90` + `test_branch_coverage80` removed once flipped to Met on the bestpractices.dev form (project 12870).

## Approach

**Branch coverage first (~1% gap, lower effort)**:

- Download the latest `vitest-coverage-merged` artifact from a passing CI run.
- Sort `coverage-summary.json` by `branches.pct` ascending; ignore files <50 LOC (trivial sites).
- The bottom-N files with the worst branch coverage are the targets. Likely candidates based on past structure:
  - error-path branches in `src/lib/notify.ts` and `src/lib/tauri.ts` (rare `catch` blocks not exercised)
  - flag-gated UI affordances in `src/components/SettingsView.tsx` and similar
  - i18n fallback branches in `src/lib/i18n/*`
- Add one focused test per uncovered branch; favour `describe.each` over hand-rolled `it()` repetition. Each test should target a single branch and assert one specific outcome.

**Statement coverage next (~2% gap, more work)**:

- Same bottom-N approach but sorted by `lines.pct`. Bigger files dominate the gap (a 200-LOC file at 70% costs more than a 30-LOC file at 50%).
- Likely candidates: large editor / tag / sync UI files where component-render paths are mostly tested but the "menu opened then closed without selection" sub-paths aren't.
- This is mostly UI test work — `userEvent.click` + assertions. Use the existing axe(container) audit pattern from `AGENTS.md` for each new render.

**Rust coverage**:

- Wait for the first cargo-llvm-cov CI run (after this commit lands and 0.1.31 cuts).
- If line coverage is already ≥ 80%, nothing to do.
- If < 80%, target the lowest-coverage modules using `cargo llvm-cov nextest --html` locally and add tests until the threshold is met.

## Out of scope (separate items)

- Branch coverage > 80% (Silver is the explicit target; Gold's 90% is its own item).
- E2E coverage measurement — Playwright doesn't easily integrate with vitest's istanbul reports; tracked separately if/when we want it.
- Coverage gating on PRs — the gate stays informational for now; flip to PR-blocking once the threshold is comfortably above the floor (n=10 consecutive green runs).

## Estimated cost

S–M (2–6 h) — branch coverage probably 2 h focused, statement coverage probably 4–6 h depending on which files end up dominating the bottom of the sort.

## Tracking

REVIEW-LATER row will be added (see the `test_statement_coverage90` / `test_branch_coverage80` entries against project 12870 on bestpractices.dev).
