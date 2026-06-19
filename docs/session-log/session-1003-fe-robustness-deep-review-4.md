# Session 1003 — /batch-issues loop: FE robustness/maintainability, batch 5 (2026-06-19)

## What happened

Fifth batch of the `/loop /batch-issues` run, executed **concurrently with the backend
Rust batch 4** in an isolated worktree (the wider/overlapping-batches approach agreed
with the maintainer mid-run): four more frontend findings from the multi-agent deep
review — one robustness, three maintainability — each on a non-overlapping file, built
by parallel subagents and adversarially reviewed before ship.

## Shipped

Single PR `fix/fe-robustness-deep-review-4`:

- **#1613** — `useHasHardwareKeyboard` could latch true from a soft-keyboard/IME keydown
  on tablets (no `isTrusted`/`keyCode===229`/`Unidentified` filter), demoting the surface
  out of mobile chrome mid-session; added the soft-event guard so only a genuine hardware
  keydown latches.
- **#1650** — the FormattingToolbar's `tooltipWithShortcut`/`getShortcutKeys` machinery
  was dead (`TOOLBAR_SHORTCUT_IDS` was `{}`), so config-button tips hardcoded chords that
  drift; populated the map to mirror the bubble menu exactly (`inlineCode`/`strikethrough`/
  `highlight`) so chords resolve live from the rebindable catalog, and stripped the frozen
  chord suffixes from the i18n tips.
- **#1649** — the `tags` view was assembled inline in `ViewDispatcher` (hand-rolled
  divider + raw `'Filter'` literal), unlike every other delegating case; extracted a
  `TagsView` component using the standard `Separator` and an i18n `tagFilter.sectionLabel`.
- **#1653** — the Label+help+Switch "toggle row" was hand-duplicated with drifted markup
  across `NotificationsTab`/`EditorTab`(×2)/`AutostartRow`; extracted a single
  `ToggleRow` (`components/ui/`) with proper Label↔Switch a11y wiring and replaced all
  four call sites.

## Review pass

Four adversarial reviewers (one per item, none self-reviewing) re-read code, re-ran
targeted suites, and ran `tsc`/`oxlint`. The #1650 reviewer caught and fixed a real
`tsc` cast error in the test (the builder's "tsc clean" claim was false — second time
this run that reviewer tsc-gating caught a builder's missed type error). Others clean.

## Notes

- Ran in worktree `/home/javier/dev/wt-fe5` (node_modules symlinked, dev.db seeded +
  migrated) so it built in parallel with the backend Rust batch 4 in the main checkout;
  the two PR pushes were serialized to avoid the concurrent-heavy-push OOM noted in memory.
- All four touch disjoint files; full frontend suite green (584 files, 13567 passed).
