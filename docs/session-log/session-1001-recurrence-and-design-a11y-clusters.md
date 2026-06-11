# Session 1001 — recurrence engine fixes + design/a11y cluster

Two disjoint-domain batches shipped in parallel worktrees off `origin/main` (recurrence =
Rust, design = frontend), each adversarially reviewed by a separate subagent that re-ran
the full suite.

## Shipped (PRs)

- **`fix(recurrence)`** — two verified engine bugs (multi-agent backend review findings):
  - **#679** monthly clamp is sticky (Jan-31 → Feb-28 → Mar-28 … forever). The clamp is
    *intentional* (Org-mode in-place shifting: each step bases off the previous shifted
    date, so day-of-month is never restored). It was merely undocumented and pinned by a
    single step. Fix is **doc + test only, no behavior change**: doc comments at the clamp
    site (`parser.rs`) and the sibling-base computation (`compute.rs`), plus a 3-step chain
    test asserting Jan-31 → Feb-28 → Mar-28 with an explicit `assert_ne!(step2, Mar-31)`.
  - **#680** projection's `++` catch-up cap exhaustion silently emitted a stale PAST date.
    `project_block_dates` now tracks a `caught_up` flag: if the 10,000-step budget is
    exhausted, or `shift_date_once` overflows the `MAX_CALENDAR_YEAR` guard, WITHOUT
    reaching a date strictly after `today`, the source is skipped (`continue`) — matching
    the string parser's loud `Err(Validation)` for the same input class. Two regression
    tests (cap-exhaustion, calendar overflow) that each FAIL against pre-fix code, plus a
    happy-path guard confirming a genuinely caught-up source still emits.
  - Reviewer temporarily reverted the skip to confirm the new tests are non-vacuous.
    Full recurrence suite 55/0, clippy clean. Closes #679 #680.

- **`fix(design)`** — three verified design-system bugs (multi-agent frontend review):
  - **#743** all Radix overlay enter/exit animations were dead code — `tw-animate-css` was
    never installed, so Tailwind-4 core emitted nothing for the hundreds of
    `animate-in/fade-in-0/zoom-in-95/slide-in-from-*` tokens. Added `tw-animate-css ^1.4.0`
    + `@import "tw-animate-css";` after the tailwindcss import. Proven live: built CSS now
    contains `animate-in`/`fade-in`/`zoom-in-95`/`slide-in-from` (were 0). The existing
    reduced-motion block now correctly zeroes them.
  - **#744** two WCAG AA failures (independently recomputed twice): `--primary-foreground`
    on `--primary` (light + `.dark`) was 4.09:1; Solarized Light `--muted-foreground` was
    3.89:1. Lowered `--primary` L 0.55→0.50 (now 5.07:1) and Solarized Light
    `--muted-foreground` L 0.58→0.50 (now 5.45:1); passing calibration pairs untouched.
    Added `theme-contrast.test.ts` — a real oklch→sRGB→luminance→WCAG computation over the
    fixed + calibration pairs.
  - **#745** (1) Calendar caption "go to monthly view" navigated to the stale initial
    month — now reads the live displayed month via react-day-picker v10 `useDayPicker()`
    context. (2) Two divergent relative-time formatters (one hardcoded English) collapsed:
    all six consumers migrated onto the i18n `formatRelativeTime`, the hardcoded
    `format.ts` branch + `formatLastSynced` removed (reusing the existing `sidebar.*` keys,
    incl. `lastSyncedNever`). `format.ts` keeps its other exports.
  - Reviewer recomputed the contrast ratios independently, verified the built CSS, the
    react-day-picker API, and that every claimed i18n key exists; fixed one TS18048 in the
    new test that would have red-CI'd. Full frontend suite 11729/0, tsc clean.
    Closes #743 #744 #745.

## Notes

- `npm install tw-animate-css` in the design worktree replaced the symlinked `node_modules`
  with a real directory (npm warns `Removing non-directory` then reinstalls all deps) — the
  safe outcome (a real, complete `node_modules`), not the nested-symlink TS2688 break. CI
  uses `npm ci` from the lockfile regardless.
- Both batches were fully disjoint domains (recurrence module vs `src/` styling +
  components), so they parallelized with zero file contention; the two frontend builders
  shared one worktree but partitioned by file (theming/index.css vs calendar/format).
