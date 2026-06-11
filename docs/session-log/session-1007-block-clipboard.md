# Session 1007 — Block cut/copy/paste (#913)

Part of the overnight best-in-class UX pass (2026-06-11/12).

## Shipped

- **#913 — block-level cut/copy/paste as indented-markdown subtrees.** Previously the only
  block "copy" was a link/reference; there was no copy-as-markdown-subtree / paste-as-structure
  (the Logseq/Workflowy/Roam standard). Added Ctrl/Cmd+C / +X / +V in **block-select mode**:
  - `src/lib/block-clipboard.ts` — `serializeBlockSubtree` (selection roots + subtrees →
    relative-indented markdown outline, raw block content per line so refs/marks round-trip)
    and `parseIndentedMarkdown` (outline → flat `ParsedBlock[]` with relative parent pointers,
    over-indentation clamped so no orphaning).
  - `src/lib/clipboard.ts` — added `readText()` mirroring `writeText()` (Tauri plugin →
    `navigator.clipboard` fallback).
  - `src/stores/page-blocks.ts` — `pasteBlocks(anchorBlockId, markdown)`: parses the outline
    and materializes it after the anchor via level-by-level `createBlocksBatch` (children
    reference parents created in an earlier batch), `retryOnPoolBusy` + `load()` + undo;
    single-block fallback for non-outline text; anchor-vanish / batch-failure reconcile.
  - `src/hooks/useBlockTreeKeyboardShortcuts.ts` — C/X/V handler gated on block-select mode
    (`!focusedBlockId`, so in-editor text copy/paste passes through) and the #713 per-store
    ownership filter; copy/cut serialize owned selection roots + `writeText` (cut also removes
    the roots, whose subtrees cascade); paste anchors on the last owned selected block,
    `readText` → `pasteBlocks`. `preventDefault` only in the handled branch.
  - Registered `copyBlocks`/`cutBlocks`/`pasteBlocks` in the keyboard catalog + i18n.

## Tests

210 unit tests across `block-clipboard.test.ts` (serialize/parse round-trip), `clipboard.test.ts`
(read/write), `useBlockTreeKeyboardShortcuts.test.ts` (C/X/V wiring + gating), and
`page-blocks.test.ts` (`pasteBlocks`: multi-level insert, nested, anchor-vanish reconcile,
non-outline fallback). `tsc -b` clean.

## Why no e2e

Clipboard is not reliably exercisable in the web/Tauri-mock + headless harness: `readText`
goes through the Tauri clipboard plugin, which the mock does not round-trip, and the
`navigator.clipboard` write/read is permission/focus/timing-flaky in headless chromium. Copy
emits no IPC (only `writeText`), so it has no robust observable signal there either. The
feature is therefore covered at the unit level (where the clipboard lib is mocked) rather than
shipping a flaky e2e.
