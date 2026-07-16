# Session 1165 — Deep-review backlog: frontend + docs batches (2026-07-16)

Batch-issues loop working the #2651–#2737 deep-review backlog, constrained
mid-session to **frontend + docs only** (a parallel session owned the backend via
the #2621 crate split; its schema work made backend conflicts likely for hours).
All builds ran in isolated worktrees with per-item builder + adversarial reviewer
subagents (model tier per cost×risk).

## Shipped (merged)

- **PR #2742** — docs: engine-migration/HeadExchange-invariant/draft-recovery drift
  (Closes #2672, #2673, #2695). Originally a 12-issue docs batch; rebuilt mid-flight
  after the parallel session's #2740/#2741 landed nine of the findings first.
- **PR #2744** — three dialogs (QueryBuilderModal, PairingDialog, SearchHelpDialog)
  routed through `useDialogOrSheet` (Closes #2665). Originally also carried #2664
  reduced-motion work; dropped after #2739 landed the same fix independently.
- **PR #2745** — undo-contract fixes: `handleTurnInto` and `QueryResult.handleBuilderSave`
  routed through `pageStore.edit()` (Closes #2662, #2663). Reviewer caught a real
  residual gap (same-expression save never refetched) and an orphaned i18n key.
- **PR #2746** — emoji dataset (~150 KB) lazy-loaded out of the editor first-paint
  chunk via memoized dynamic import (Closes #2671). Verified by chunk analysis.

## In flight at session end

- **PR #2747** — Ctrl+1-6 freed for space switching; headings → Ctrl+Alt+1-6
  (Closes #2679). Reviewer caught a would-be double-fire: TipTap's stock
  `Mod-Alt-1..6` heading keymap had to be stripped (`HeadingWithoutDefaultShortcuts`).
- **Batch F building**: settings e2e coverage (#2686, #2687) and maintainability
  pair (#2698 phantom re-exports, #2702 NON_DELETABLE_PROPERTIES drift check).

## Abandoned / rescoped

- **Batch A (Rust)** — #2657/#2658/#2659 materializer cache-invalidation trio:
  builder launched, then stopped and unclaimed when the user flagged hours-long
  backend conflict risk from #2621. Left for after the crate split settles.

## Coordination notes (two agents, one repo)

- The parallel session independently fixed overlapping issues (#2739≈#2664+#2697,
  #2740/#2741 ≈ 9 of the 12 docs-drift issues) *after* this session's `in-progress`
  labels went on — claims must be re-checked at PR time, not just at claim time.
  Both affected branches were rebuilt on current main keeping only still-open work;
  the issue-state audit afterwards showed every closed issue with a real fix on main.
- Two `gh pr edit` calls failed silently (GraphQL Projects-classic deprecation error
  while still exiting nonzero output on stderr only) — both PRs then tripped the
  repo reviewer's scope-mismatch check. Fix: `gh api pulls/N -X PATCH` and verify the
  title/body actually changed.
- Reviewer follow-up nit from the other session's #2718 filed as #2748 (dangling
  rustdoc intra-doc links after the task_locals move).

## Verification discipline

Every batch: independent adversarial reviewer re-read the diff, re-ran the full
vitest suite + tsc, and fixed residual gaps before commit. Full-suite runs stayed
in the reviewer (one per item); builders ran targeted tests only. Frontend-only
diffs pushed `--no-verify` per repo convention (pre-push runs the full flaky Rust
suite); remote SHA verified after every push.
