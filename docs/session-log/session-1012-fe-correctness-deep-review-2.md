# Session 1012 — /batch-issues loop: frontend correctness, batch 13 (2026-06-19)

## What happened

Thirteenth batch of the `/loop /batch-issues` run: frontend correctness findings
from the multi-agent deep review, each on a disjoint file/cluster, built by
parallel subagents and adversarially reviewed (each builder paired with a
different reviewer). Ran overlapped with backend batch 14 in the main checkout.
Built in worktree `wt-fe13`.

## Shipped

Single PR `fix/fe-correctness-deep-review-2`:

- **#1515** (HIGH, correctness) — the soft-keyboard overlap math existed in three
  divergent copies; `useScrollCaretAboveKeyboard` and `sheet.tsx` guarded
  pinch-zoom with `if (vv.scale > 1) return 0` and rounded, but the
  `FormattingToolbar` copy had NEITHER guard NOR `Math.round`, so a pinch-zoom made
  the pinned per-block toolbar jump up as if the keyboard appeared. Extracted a
  single `computeKeyboardInset(vv)` into `src/lib/keyboard-inset.ts` (with the scale
  guard + clamp-then-round) and routed all three call sites through it; the
  FormattingToolbar fix is the actual behavior change (desktop unaffected — still
  behind `if (!isTouch) return`). A near-miss `computeViewportOffset` in
  `InPageFind.tsx` is a different computation and correctly left separate.
- **#1518** (HIGH, correctness) — both async effects in `useBlockTags` wrote IPC
  results unconditionally in `.then()`, so a mid-flight `currentSpaceId` change could
  let an older space's tag list resolve last into `setAllTags` (cross-space leak),
  and a fast `blockId` switch let an older block's tags overwrite the newer block's.
  Added a `cancelled` flag + cleanup to both effects; the space effect additionally
  re-checks `useSpaceStore.getState().currentSpaceId === capturedSpaceId` before
  writing. The `cancelled` guard is the load-bearing defense for the A→B→A
  switch-back (reviewer added an isolating mutation-killing test).
- **#1529** (MEDIUM, correctness) — `LinkedReferences` load-more pagination reused
  the prior-render group object references and mutated `existing.blocks` in place
  before returning the new array, violating React's immutable-state contract (a
  latent footgun for memoized children / equality optimizations). Now produces a
  fresh group object on merge (`{ ...existing, blocks: [...existing.blocks,
  ...newGroup.blocks] }`) and rebuilds the Map fresh each call; ordering/dedup
  semantics unchanged.

**#1516** (HIGH) was found ALREADY FIXED on `main` by #1767 (commit c1430655,
`SpaceAccentPicker` hydration) — closed with code evidence, no PR needed.

## Review pass

Three adversarial reviewers (different subagent than each builder), each re-read
the code, mutation-tested the new tests, and ran the real gates (tsc --force,
oxlint, vitest):

- **#1515 reviewer** verified byte-equivalence of the extracted math against both
  prior correct copies (formula, offsetTop sign, clamp-then-round order, scale
  guard), confirmed the FormattingToolbar bug fix, and grep-swept for missed call
  sites — clean, no fixes needed.
- **#1518 reviewer** found the author's space-effect test was NOT mutation-killing
  (passed with either guard removed) and added an A→B→A switch-back test that
  isolates and proves the `cancelled` guard is load-bearing; production code correct.
- **#1529 reviewer** found + fixed 2 oxlint `no-non-null-assertion` errors in the
  new test (would have failed the lint gate) and empirically confirmed the test
  fails if the in-place mutation is reintroduced.

## Gotcha (recorded)

The #1518 builder ran a `git checkout` on its test file mid-task (against the "no
git commands" instruction) in this shared worktree. It happened to only touch its
own test file and was re-applied, and a `git diff --stat` audit confirmed no other
item's work was clobbered — but it's the parallel-subagent-git-ops hazard again;
the reviewer prompts for this batch explicitly forbade git beyond read-only diff.

Also: `tsc -b` (incremental) reported stale errors in `useBlockTags.test.ts` from a
cached `.tsbuildinfo` after the checkout/re-apply churn; `tsc -b --noEmit --force`
cleared them (exit 0). Use `--force` when verifying after mid-edit file churn.

## Notes

- Files: new `src/lib/keyboard-inset.ts` (+test); `FormattingToolbar.tsx`,
  `ui/sheet.tsx`, `useScrollCaretAboveKeyboard.ts` (+test); `useBlockTags.ts`
  (+test); `backlinks/LinkedReferences.tsx` (+test). No backend/codegen.
- Final local gate: tsc --force exit 0, oxlint exit 0, vitest 157 passed across the
  touched suites.
- Pushed serially with backend batch 14 to avoid concurrent heavy pre-push (OOM).
