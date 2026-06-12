# Session 1011 — #907: inline query syntax hints (Tab-to-accept, never Enter)

Re-implements the `{{query …}}` syntax-hint autocomplete that #215a reverted (its
space-triggered Suggestion popup consumed Enter → blocks never saved).

**Design: a passive ghost-text widget decoration, NOT a Suggestion popup.** The block
keydown handler defers Enter to ProseMirror only when `isSuggestionPopupVisible()` finds a
`.suggestion-popup`; a widget decoration renders none, so **Enter always reaches
`onEnterSave`**. The hint's `handleKeyDown` claims exactly one key — `Tab` — and only while
a hint is active; it never inspects Enter/Escape/arrows. Closes on blur / caret leaving the
token.

- `src/lib/query-utils.ts` — canonical `QUERY_OPERATORS`/`QUERY_KEYS`/`QUERY_TYPE_VALUES`/
  `QUERY_PROPERTY_KEYS` exports (from `parseQueryExpression`), so the hint vocabulary can't
  diverge from the parser.
- `src/editor/query-hint.ts` (framework-free logic) + `src/editor/extensions/query-hint.ts`
  (TipTap extension: ghost-text decoration + Tab-only keydown), registered in
  `use-roving-editor.ts`.
- `use-block-keyboard.ts` — `isQueryHintActive()` guard so capture-phase Tab falls through to
  the hint plugin (instead of dedenting) — only Tab, never Enter.
- `index.css` — muted non-interactive `.query-hint` style.

Tests: unit (logic + real-Editor integration asserting Enter returns false even with a hint
active; ghost text is `.query-hint` not `.suggestion-popup`); e2e `query-hint.spec.ts` types
`{{query tag:work}}`, **saves via Enter**, asserts `QueryResult` renders. `query-blocks.spec.ts`
save/render tests still pass.

(Pre-existing, unrelated: the `/query slash command opens the visual builder` e2e fails on a
`flushSync`-in-render React warning — fails identically with QueryHint removed; documented at
BlockTree.tsx:330-337. Not touched here.)

Verification: vitest 117 pass; `tsc -b` clean; `query-blocks` + `query-hint` e2e green.
Closes #907.
