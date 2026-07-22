## Session 1189 — disable strikethrough where it can't apply (code context) (2026-07-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-07-22 |
| **Subagents** | 1 build + 1 review (frontend) |
| **Items closed** | `#2995` |
| **Files touched** | 3 source + 2 test |

**Summary:** The Format menu / selection bubble menu offered a **strikethrough** control
for a code selection/block, but toggling it was a silent no-op (the strike mark is
schema-excluded by inline `code` / `codeBlock`). Fixed by gating the control on
applicability: added `disabledWhenFalse: 'canStrike'` to the Strikethrough entry in the
shared `createMarkToggles` (`toolbar-config.ts`) — reusing the existing Undo/Redo
`disabledWhenFalse`/`canUndo`/`canRedo` convention — and wired
`canStrike: editor.can().toggleStrike()` into both menus' `useEditorState` selectors so the
button greys out (matching the Undo/Redo precedent) in code context. `editor.can()`
correctly covers **both** inline `code` and `codeBlock` (verified empirically in review).

**Files touched:**
- `src/lib/toolbar-config.ts` (shared gate), `src/components/editor-toolbar/FormatMenu.tsx`,
  `src/components/editor-toolbar/SelectionBubbleMenu.tsx` (+ 2 test files)

**Verification:**
- `tsc -b --noEmit` 0 errors; oxlint clean; vitest 157 passed.
- Playwright e2e: `e2e/bubble-marks.spec.ts` + `e2e/selection-bubble.spec.ts` 9/9 (incl.
  strikethrough-via-bubble still applies on normal text) and `e2e/formatting-toolbar-mobile.spec.ts`
  4/4 — no regression from the disabled gate.
- Review empirically confirmed `editor.can().toggleStrike()` is `false` in inline `code`
  and `codeBlock`, `true` in plain text; other mark buttons unaffected.

**Commit plan:** single PR (own branch); merge when green.
