# E2E test bit-rot follow-ups — 2026-05-13

> **Status:** **open** — pre-existing e2e failures surfaced during the
> 0.1.20 release prep. Distinct from my session's SQL audit /
> limit-clamp work; these tests were already failing before any of my
> changes. Filed here so the bit-rot is tracked rather than perpetually
> bumping the "11 e2e tests fail" count in CI.

## Closed this session

- **`e2e/smoke.spec.ts` "sidebar has all expected nav items"** — was
  asserting a `Conflicts` nav-item that PEND-09 Phase 5 (Session 700,
  commit `12e45fd9`) deleted. Removed the obsolete assertion. (Fixed
  in commit on top of dfc56605.)
- **`e2e/editor-lifecycle.spec.ts` "navigates between sidebar
  views"** — same root cause; removed the Conflicts navigation step.
- **`e2e/conflict-resolution.spec.ts` (5 tests)** — the entire
  Conflicts feature was deleted in PEND-09 Phase 5. Spec file
  deleted entirely.

## Open

Each of the following failed in `npx playwright test` post-release-prep
on 2026-05-13. None of the assertions are related to changes in this
session's commits (SQL audit batches 1-4 + clippy/biome cleanup +
dependabot bumps). Verified by reading each spec — the failures point
at missing seed data, removed UI affordances, or possible regressions
predating my session.

### 1. Tag-management — missing seed tags

**Spec:** `e2e/tag-management.spec.ts:39`, `:90`, `:112`, `:128`.

**Symptom:** `getByTestId('tag-item-idea')` not found in the Tags
view. The tests expect three seed tags — `work`, `personal`, `idea` —
to be present on a fresh DB.

**Likely cause:** the seed tags either (a) were never seeded by the
current onboarding/bootstrap flow, (b) were removed by an earlier
refactor without updating the e2e fixtures, or (c) depend on a seed
script the e2e harness no longer runs. Grep against
`src-tauri/src/` finds `seed_tag_block` (only in `space.rs` unit
tests) and no production code that writes `idea`/`work`/`personal`
on first boot.

**Fix sketch:** decide whether the seed tags are intended for the
empty-DB UX (then add a backend bootstrap pass that seeds them) or
not (then rewrite the tests to create the tags first before
asserting). The first option is the better UX; favor that.

### 2. `e2e/attachments.spec.ts:140` — delete attachment two-click

Not investigated in detail. Probably a real bug or UI affordance
change (attachments UI was touched in PEND-06 Tier 2). Needs a
fresh look.

### 3. `e2e/graph-view.spec.ts:54` — node-click navigation

Not investigated in detail. PEND-15 (hard space separation) +
PEND-09 Phase 5 deletions both touched graph-relevant code paths;
either could have broken the navigation contract.

### 4. `e2e/templates.spec.ts:211` — template-select insert + toast

Not investigated in detail. Templates were refactored under
PEND-30 D-1 (SortableBlock context-first); check whether the
test's selector still matches the new component shape.

### 5. `e2e/toolbar-and-blocks.spec.ts:381` — Ctrl+Shift+1 priority

Not investigated in detail. Priority keybinding may have moved
or been removed in a recent UX pass.

## When to fix

These should be fixed before they accumulate further bit-rot — each
session that ships an unrelated change has to wade through
unchanged-but-failing tests to know whether THEIR change broke
something. The five sites above are roughly equal-weight; pick them
up in the next dedicated test-hygiene pass.

## Cost

- Tag-management seed: **S** if we decide to seed in production (~2h);
  **S** if we update the test to create the tags first (~1h).
- Each of the other 4: **S** (~1-2h to investigate + fix), assuming
  no real regression.

## Related

- Session 707 release prep — this session, where the e2e failures
  were rediscovered.
- PEND-09 Phase 5 (Session 700, commit `12e45fd9`) — removed the
  Conflicts UI; was the root cause of 7 of the 11 failures (smoke,
  editor-lifecycle, conflict-resolution).
