# Session 1193 — Invert the typing serialization pipeline (hot-path debounce)

**Date:** 2026-07-22
**Branch:** `perf/typing-hotpath-debounce`
**Closes:** #2938

## Summary

Typing serialized the whole document and committed a React render on (nearly) every
keystroke. This inverts the pipeline: the editor `update` event becomes a pure
change *signal* that only re-arms debounce timers via refs; serialization
(`getMarkdown()`) happens on demand when a debounce/flush fires. What is persisted is
unchanged — only *when/how often* serialization happens.

## The change

- `src/editor/use-roving-editor.ts` — `handleEditorUpdate` no longer does
  `getJSON()`+`serialize()` and drops its rAF coalescing; it just fires a no-arg
  `onUpdateRef.current?.()`. The handle member `setOnMarkdownChange((md)=>…)` is
  renamed `setOnUpdate(()=>…)` (the callback carries no markdown).
- `src/hooks/useDraftAutosave.ts` — signature `(blockId, content)` →
  `(blockId, rovingEditorRef)`; returns `{ discardDraft, onContentChange }`. The
  2000ms draft debounce is now imperative and serializes on demand at fire time
  (guarded by `activeBlockId === id`); empty-clear detection uses the cheap
  `editor.isEmpty`. Max-latency cap + version counter preserved.
- `src/hooks/useDebouncedContentCommit.ts` — drops `liveContent`; returns
  `{ schedule }`; `commitNow` re-reads the editor at fire time.
- `src/components/editor/EditableBlock.tsx` — removes `liveContent` state + its rAF
  effect; a single focused effect registers `setOnUpdate(() => { if activeBlockId
  !== blockId return; onContentChange(); scheduleContentCommit() })`.

## Invariants preserved (verified by tests + review)

- **#1489 (no render inside dispatch):** now structural — the hot path touches only
  refs/timers, zero React state, zero serialize. Strictly fewer renders.
- **Crash-safety flushes:** unmount final-save (Effect B), pagehide/visibilitychange
  (Effect C), and blur (`useEditorBlur`, untouched) all serialize the *live* editor on
  demand at flush time. `useRovingEditor` owns the TipTap `useEditor` in `BlockTree`;
  `EditableBlock` is a descendant, so React's child-first unmount means the editor is
  still alive when Effect B reads it — no destroyed-editor read, no lost final save
  (reviewer-validated).
- Version counter, `DRAFT_MAX_LATENCY_MS` cap, #1065 discard-marker, #1015 identity
  guard, #2600/#2675 commit baseline all intact.

## Review fixes (were red before review)

The `setOnMarkdownChange → setOnUpdate` rename left consumers broken — the branch was
**red on tsc (205 errors) and oxlint**. Fixed all: 5 test files building fake
`RovingEditorHandle`s (TS2741/TS2353), a 6th file (`useEditorBlur.test.ts`) still
calling the old `useDraftAutosave(blockId, content)` signature, and two
`react-hooks/exhaustive-deps` errors on Effects B/C (documented suppressions —
`[blockId]` keying is load-bearing for #715 and the refs are referentially stable).

## Verification

`tsc -b --noEmit` 0 errors; `oxlint` clean; vitest 511 pass on touched files, 5501
pass across the full editor/block-tree/hooks suites. "No serialize per keystroke" and
"flush persists latest content / block-switch doesn't overwrite the old row" tests are
non-tautological (fail against the pre-fix code).
