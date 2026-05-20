# PEND-66 — Replace `document.execCommand('insertText')` in palette page-link insertion

> Tracking PEND. PEND-51's Cmd+K palette uses `document.execCommand('insertText', false, value)` to insert `[[Page Title]]` links into contenteditable when the user picks a page in `[[`-autocomplete mode. **`execCommand` is officially deprecated** but it's the only API that preserves the editor's undo history. The autonomous review session decided to file this for tracking so the maintainer is aware before browsers actually remove support.
>
> **Status (last review 2026-05-20):** still watch-and-act. None of the 4 triggers below have fired. Chrome 130+ ships warnings but no errors; Safari 18 and Firefox 134 unchanged. PEND-73 Phase 3.U8 (selection-range snapshot, shipped 2026-05-20 via PR #43) touched the same code path to plant the snapshotted range before the `execCommand` call without replacing the call itself. No additional action; revisit Q3 2026.

## TL;DR

- **This is a watch-and-act PEND, not an immediate implementation.**
- Today the palette uses `execCommand('insertText')` for contenteditable inserts; modern Selection / Range API works but **breaks undo**.
- No browser has actually removed `execCommand` despite a decade of deprecation warnings; the spec lives at <https://w3c.github.io/editing/docs/execCommand/> as "deprecated" but ubiquitously supported.
- The fix-when-needed: switch to `document.execCommand('insertText', false, value)` → `selection.deleteFromDocument() + range.insertNode(textNode)`, accepting the undo-history loss OR pulling a richer editor integration (TipTap command bridge — needs design).

## Current state — verified

- `src/components/CommandPalette.tsx::insertPageLinkInto` (formerly in `SearchPalette.tsx` — renamed during PEND-61's cmdk refactor) uses `execCommand('insertText', false, '[[Page Title]]')` on the contenteditable branch; cited inline with the rationale comment + the PEND-73 Phase 3.U8 selection-range snapshot wrapping the call.
- TS compiler warns: `'execCommand' is deprecated. [6385]` (ESM bundled output unchanged).
- Browser support: still present in Chrome / Safari / Firefox as of 2026-05-20.
- TipTap (the editor) has its own command API (`editor.chain().focus().insertContent(text).run()`) that preserves undo correctly. But the palette inserts into the **previously-focused element**, which may not be a TipTap instance — could be a plain `<input>`, a `<textarea>`, or a TipTap-managed contenteditable.

## Watch trigger

Act on this PEND when **any one of**:

1. Chrome ships an active console error (not warning) for `execCommand` (signaling imminent removal).
2. The TypeScript / Biome stricter rules graduate the deprecation from `info` to `error`.
3. A browser ships a stable version that gates `execCommand` behind a feature flag.
4. The maintainer observes a real undo-history bug introduced by `execCommand`'s deprecation in shipped Tauri WebViews.

Until one of those fires, this PEND sits in the backlog with no action. Re-check quarterly (or whenever Chrome / Safari release notes mention editing API changes).

## Design — when we have to act

### Path A: Selection / Range API, accept undo loss

```ts
function insertText(value: string, target: Element): void {
  const selection = target.ownerDocument.getSelection()
  if (!selection) return
  if (selection.rangeCount === 0) return
  const range = selection.getRangeAt(0)
  range.deleteContents()
  range.insertNode(document.createTextNode(value))
  // Move cursor to end of inserted text:
  range.collapse(false)
  selection.removeAllRanges()
  selection.addRange(range)
}
```

Pro: forward-compatible. Con: undo stack now skips this insertion; users pressing Cmd+Z don't get the page link back.

### Path B: TipTap-aware bridge

Detect if the previously-focused element is inside a TipTap-managed ProseMirror node; if so, call the editor's command chain (preserves undo). Else fall back to Path A.

```ts
function findTipTapEditor(target: Element): Editor | null {
  // Walk up the DOM until we find a `.ProseMirror` node and resolve to its
  // Editor instance via a WeakMap the editor extension maintains.
  ...
}

function insertText(value: string, target: Element): void {
  const editor = findTipTapEditor(target)
  if (editor) {
    editor.chain().focus().insertContent(value).run()
  } else {
    selectionRangeInsert(value, target)  // Path A
  }
}
```

Pro: preserves undo in the common (TipTap) case. Con: requires a TipTap-aware WeakMap registry — more plumbing.

### Path C: Stay on `execCommand`, defer

If `execCommand` still works in target WebViews when the trigger fires, just suppress the deprecation warning with `// @ts-expect-error -- deprecated but functional` and revisit later. Acceptable as long as Chrome / Safari haven't actually removed it.

## Acceptance criteria (when implementation lands)

- No console errors / deprecation warnings on `execCommand` use in the palette (if Path A or B taken).
- Undo behaviour matches the page-link-insertion expectations: ideally Cmd+Z removes the inserted link; if Path A is taken, document the regression.
- `vitest-axe` audit unchanged (the popover semantics are the same).

## Open questions

1. **When does Chrome actually ship the removal?** Monitor <https://chromestatus.com/feature/5085344283557888> (last checked 2026-05-17).
2. **Is there a Tauri-level shim?** Tauri's IPC could theoretically wire native editor operations; out of scope for this PEND.

## Related

- PEND-51 (landed) — introduced the `execCommand` usage.
- PEND-61 (landed) — renamed `SearchPalette.tsx` → `CommandPalette.tsx` during the cmdk refactor; the `execCommand` call now lives in `CommandPalette.tsx::insertPageLinkInto`.
- PEND-73 Phase 3.U8 (landed 2026-05-20) — snapshots the live selection range at palette open time and restores it before the `execCommand` call so the insert lands at the user's original caret. Did NOT replace the call.
- TipTap docs on `editor.commands.insertContent` — replacement API for TipTap-managed editors.
