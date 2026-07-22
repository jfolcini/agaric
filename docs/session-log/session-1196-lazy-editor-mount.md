# Session 1196 — Lazy-load the TipTap edit path off cold-start TTI

**Date:** 2026-07-23
**Branch:** `perf/lazy-editor-mount`
**Closes:** #2939

## Summary

`BlockTree` statically imported `useRovingEditor` (the ~50-extension TipTap graph +
`curatedLowlight`), forcing the ~458 kB editor chunk + 71 kB highlight.js chunk onto the
cold-start path, and constructed a full TipTap `Editor` per mounted BlockTree (7 in weekly
journal view) before any block was focused. On mobile webview the parse cost dominates
TTI. This lazy-loads the edit path so pages render read-only immediately and the editor
loads on idle.

## Architecture

- **Facade + lazy host.** `useLazyRovingEditor` returns a drop-in `RovingEditorHandle`
  facade with an identical contract for all consumers. The real editor
  (`RovingEditorHost` → `useRovingEditor` + `EditorSurface`) is reached only via
  `React.lazy(() => import(...))`, prefetched on idle (`requestIdleCallback`, `setTimeout`
  fallback) after first paint.
- **Stub → adopt.** Before the runtime loads, the facade is a stub (`editor: null` →
  `EditableBlock` renders the read-only `StaticBlock`, content stays visible). `mount()`
  buffers the request and triggers the load; on adopt the buffered `mount()`/`onUpdate`
  replay in a `useLayoutEffect` (pre-paint, no flash), so the read-only→editable swap is
  seamless and no pipeline state is lost.
- **`EditorSurface` via context.** `EditableBlock` renders the `EditorContent` portal +
  toolbars through `EditorSurfaceContext` (published once the runtime loads) rather than
  importing `@tiptap` directly.
- **Pure-function extraction.** `computeContentDelta`/`shouldSplitOnBlur` moved to a
  TipTap-free `content-delta.ts` (re-exported for back-compat), removing the editor edge
  from `EditableBlock`/`useEditorBlur`.
- **Selection probe.** `use-block-keyboard` dropped its `@tiptap/pm/state` import; the
  runtime chunk registers `Selection.atStart/atEnd` via a `pm-selection-probe` registry.
- **Read-only highlight.** `marks/code.tsx` dynamically imports `curatedLowlight` inside
  its existing idle upgrade — takes highlight.js off startup for the read-only path too.
- **Chunking.** `vite.config.ts` `manualChunks` → Rolldown-native `codeSplitting.groups`
  with priorities, pinning shared `@floating-ui/dom`+`fast-equals` (needed by startup
  Radix) into a 30 kB `floating-vendor` startup chunk so the editor chunk stays lazy.

## Invariants & tradeoff

The `RovingEditorHandle` contract (all 9 members) is honored by both stub and adopted
facades; hooks still run unconditionally, only the render branch gates on editor liveness.
All crash-safety flushes (unmount/pagehide/visibilitychange/blur), roving focus, and
`#1489/#715/#1015/#1065/#2600/#2675` are preserved (reads happen through refs at fire
time). The one disclosed tradeoff: clicking+typing within the sub-100ms window before the
idle prefetch completes keeps `StaticBlock` up briefly — content stays visible, keystrokes
in that window are dropped cleanly (StaticBlock is non-editable), no data loss, no cursor
misplacement; in practice the editor is prefetched before interaction.

## Verification

Structural bundle guard walks BlockTree's static import graph and asserts it reaches
`StaticBlock`/`EditableBlock` but NOT `use-roving-editor`/`RovingEditorHost`/`EditorSurface`
nor any `@tiptap`/`prosemirror`/`highlight` value import (non-tautological — injecting an
`@tiptap` import fails it). Reviewer confirmed via production build that `dist/index.html`
modulepreloads none of editor/highlight/tiptap/prosemirror; editor (458 kB) + highlight
(71 kB) are lazy chunks. Playwright 24/24 (focus roving, cross-block caret, Enter-split,
indent, click-to-edit, blur-save, autosave, nested-list blur), and the swap was
empirically verified under a forced 3.5 s chunk-load delay (content byte-identical, editor
focused post-swap). vitest 581 pass across editor/block-tree/hooks; tsc + oxlint clean.

## Review fix

The `shouldSplitOnBlur` import move left `useEditorBlur.test.ts` mocking the old
`@/editor/use-roving-editor` path (2 red tests — stale mock only; production behavior was
correct). Retargeted the mock to `@/editor/content-delta` via `importActual`.
