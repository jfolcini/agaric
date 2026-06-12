# Session 1014 — journal/editor UX polish (live review batch)

Eight fixes from a live UX review, shipped across three branches (this log covers the
block-controls branch; sibling branches cover pickers/misc and agenda).

This branch (block controls):
- **Empty task checkbox hidden at rest** — `BlockInlineControls.tsx`: the non-task
  (`!todoState`) checkbox now follows the per-block hover/active contract
  (`opacity-0 group-hover/focus-within/[.block-active] :opacity-100`); blocks with a real
  todo state keep their checkbox always visible. Click-to-cycle unchanged.
- **Gutter only on hovered/selected block; multiselect shows only checkboxes** —
  gutter buttons were already per-block hover-gated (no change). In multiselect mode
  (`selectedBlockIds.length > 0`) `BlockGutterControls` renders ONLY the select checkbox
  and `BlockInlineControls` suppresses the task checkbox, so a selection reads clean.
- **Bulk ops via context menu** — `BlockContextMenu` gains `selectedBlockIds` +
  `onBatchDelete`; when >1 blocks are selected and the clicked block is in the selection,
  Delete (reuses the existing batch-delete handler + undo toast), TODO cycle, priority
  cycle, indent/dedent, and move apply to every selected id. Single-block behavior
  unchanged otherwise. Plumbed via `useBlockActions`/context-bags/BlockTree/SortableBlock;
  new i18n keys.

Sibling branches: ux/uimisc (unify @ picker to [[; standalone-agenda right-border;
page-header star+delete always visible) and ux/agenda (journal Agenda excludes current-day
blocks; DuePanel right-border; hide empty Done/backlinks panels).

Verification: vitest green on all touched suites; tsc clean; editor e2e run by the
orchestrator before merge.
