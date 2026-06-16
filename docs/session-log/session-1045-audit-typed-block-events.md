# Session 1045 — audit fix #1251: editor event producers use the typed dispatchBlockEvent

2026-06-16. From the 2026-06 Opus quality audit (architecture/type-safety, low).
`/loop /batch-issues` run.

## Problem
Two editor-side producers hand-built the event name as a raw string instead of the typed
`dispatchBlockEvent`/`BLOCK_EVENTS` helper, defeating its compile-time-safety purpose (a
typo'd event name would silently no-op):
- `use-roving-editor.ts` — `document.dispatchEvent(new CustomEvent(\`set-priority-${level}\`))`
- `BlockInlineControls.tsx` `DateChip` — `eventName: string` + bare `CustomEvent(eventName)`,
  called with `"open-due-date-picker"` / `"open-scheduled-date-picker"`.

## Fix (behavior-preserving)
- `use-roving-editor.ts` → `dispatchBlockEvent(\`SET_PRIORITY_${level}\`)` (template-literal
  type resolves to `SET_PRIORITY_1|2|3`, all `BLOCK_EVENTS` keys).
- `DateChip.eventName` narrowed to `keyof typeof BLOCK_EVENTS`; dispatch via
  `dispatchBlockEvent`; call sites pass the typed keys.
- Event names, target (`document`), and payload (no `detail`) are byte-identical — verified.
  No additions to `BLOCK_EVENTS` needed. The 5 other `new CustomEvent` sites are distinct
  `window`-based systems (out of scope).

## Verification
Parametrized tests assert each producer emits exactly the matching `BLOCK_EVENTS` constant;
existing literal-name listener tests still pass (proves byte-identical names). Reviewer
independently confirmed name + target + payload identity. Full frontend suite 12744 passed;
tsc + oxlint clean.
