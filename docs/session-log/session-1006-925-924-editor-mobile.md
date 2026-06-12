# Session 1006 — #921 f1 + #925 f2/f3/f4 + #924 f7 (editor / mobile)

- **#921 f1** (frozen dynamic placeholder) — already on main (`use-roving-editor.ts`
  `placeholderRef` + `Placeholder.configure({ placeholder: () => placeholderRef.current })`)
  with tests; verified.
- **#925 f2** (soft-keyboard hints) — already on main (`editorProps.attributes` set
  `enterkeyhint`, `autocapitalize:'sentences'`, `autocorrect:'on'`, `spellcheck`, `inputmode`)
  with test; verified.
- **#924 f7** (suggestion items select on mouseup) — source already had
  `onPointerDown preventDefault` on the item button; **added the missing test**.
- **#925 f4** (SelectionBubbleMenu collides with native Android selection handles) —
  **fixed**: gate `shouldShow` on `!useIsTouch()` so the floating bubble is suppressed on
  coarse pointers (desktop unchanged). Tests for touch-absent / fine-pointer-present.
- **#925 f3** (formatting toolbar not pinned above keyboard) — **fixed**: touch-only
  `visualViewport`-based pinning (`fixed inset-x-0 bottom-0`, translated up by the computed
  keyboard inset); desktop stays `relative`. Logic unit-tested (mocked visualViewport);
  final placement wants a device eyeball.

Verification: `vitest` FormattingToolbar + SelectionBubbleMenu + SuggestionList (182) +
use-roving-editor (81) green; `tsc -b` clean.
