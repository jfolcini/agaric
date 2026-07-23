# Session 1201 — Rename useBlockKeyboardHandlers → useBlockActionOrchestration

**Date:** 2026-07-23
**Branch:** `refactor/rename-block-keyboard-handlers`
**Closes:** #2933

## Summary

Two distinct layers of block keyboard handling had confusable near-duplicate names in
different conventions: `src/editor/use-block-keyboard.ts` (kebab, the `useBlockKeyboard`
TipTap boundary-key hook) vs `src/hooks/useBlockKeyboardHandlers.ts` (camel, the app-level
move/announce orchestration). Newcomers and grep landed in the wrong file. This renames the
orchestration hook to encode its layer and documents the directory naming convention.

## The change (pure mechanical rename — zero behavior change)

- `src/hooks/useBlockKeyboardHandlers.ts` → `src/hooks/useBlockActionOrchestration.ts`;
  hook identifier `useBlockKeyboardHandlers` → `useBlockActionOrchestration`; its owned,
  file-local interfaces `UseBlockKeyboardHandlersParams`/`Return` →
  `UseBlockActionOrchestrationParams`/`Return`; internal diagnostic `logger` source-tag
  strings updated. `stripLeadingBlockMarker` and the imported `DeleteBlockOpts` (owned by
  `use-block-keyboard.ts`) left untouched.
- Test files renamed to match:
  `useBlockKeyboardHandlers.test.ts` → `useBlockActionOrchestration.test.ts` and
  `useBlockKeyboardHandlers.enter-split-race.test.ts` →
  `useBlockActionOrchestration.enter-split-race.test.ts` (with internal refs updated).
- Importer `src/components/editor/BlockTree.tsx` — import path + call site updated.
  `src/components/journal/DailyView.tsx` — had only a stale comment referencing the old
  name (not a real importer); corrected.
- **`AGENTS.md`** (root) — documented the convention so it stops looking accidental:
  `src/editor/` uses kebab-case hook filenames (`use-block-keyboard.ts`,
  `use-roving-editor.ts`); `src/hooks/` uses camelCase (`useBlockActionOrchestration.ts`,
  `useViewportObserver.ts`). Also fixed one stale doc example in
  `src/components/__tests__/AGENTS.md`.

`src/editor/use-block-keyboard.ts` (the boundary hook `useBlockKeyboard`) is completely
untouched.

## Verification

`tsc -b --noEmit` clean (the primary gate — catches any missed importer); `oxlint` clean;
`vitest run` over the renamed tests + BlockTree + journal suites — **581 pass**;
`grep -rn "useBlockKeyboardHandlers" src/` returns **zero** stragglers.
