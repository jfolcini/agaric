## Session 916 — #211 P2-5: Underline mark (`Ctrl+U`, stored as `<u>…</u>`) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct build + 1 review |
| **Items closed** | — (partial: #211 P2-5 only; umbrella stays open) |
| **Items modified** | #211 |
| **Tests added** | +13 (serializer/parser round-trip incl. malformed-nesting + literal-`<u>` escaping regression; renderer `<u>`; editor extension toggle/parse) |
| **Files touched** | 16 |

**Summary:** Added Underline — "the single most-expected absent mark" (#211). It's a full vertical slice across the closed mark type system, the hand-written markdown parser/serializer, the static renderer, the TipTap editor, the bubble-menu toolbar, and the keyboard catalog. Since there is no idiomatic Markdown underline delimiter, the storage form is the paired HTML tag `<u>…</u>`, and underline is modelled as the **outermost** mark (wraps bold/italic/strike/highlight).

Key design:
- **`PMMark` union += `UnderlineMark`** (`types.ts`).
- **Parser** (`markdown-parse.ts`): new `inUnderline` flag + `scanUnderline` recognising the distinct `<u>` (open) / `</u>` (close) tokens (unlike the toggle-on-same-delimiter marks). Opens only when not inside, closes only when inside; strays fall through to literal text and `revertUnclosedMarks` reconstructs an unclosed `<u>` (reverted last, since it's outermost).
- **Serializer** (`markdown-serialize.ts`): `<u>` opens first / `</u>` closes last in `emitMarkTransition`/`emitCloseAll`; `markSetFromMarks` carries `underline`.
- **Custom TipTap mark** (`extensions/underline.ts`): no `@tiptap/extension-underline` dependency (node_modules is symlinked/shared, so a dep install would mutate the shared store) — a ~30-line `Mark.create` with `<u>` parse/render, `set/toggle/unsetUnderline` commands, and the configurable `Ctrl+U` shortcut (mirrors the existing `*WithShortcut` marks).
- **Static renderer** (`marks/text.tsx`): `<u>` branch applied last (outermost).
- **Toolbar** (`createMarkToggles`): underline → bubble menu is now 7 marks + Link, within the issue's ≤8-button calm-UI ceiling.
- **Catalog**: `underline` = `Ctrl + U` (no conflict). i18n labels added.

**Review finding acted on (blocker):** the independent reviewer caught that literal `<u>`/`</u>` in *unmarked* text wasn't escaped on serialize, so a doc→md→doc cycle silently turned plain text like `see <u>tag</u> here` into an underlined "tag" — data corruption. Fixed by escaping the leading `<` of the underline tokens in `escapeText` (`\<`) and adding `<` to the parser's `isEscapableChar`, with a doc-level round-trip regression test. (Every other mark already escapes its delimiters; underline had broken that contract.)

**Files touched (this session):** `src/editor/types.ts`, `src/editor/markdown-parse.ts`, `src/editor/markdown-serialize.ts`, `src/editor/extensions/underline.ts` (new), `src/editor/use-roving-editor.ts`, `src/components/RichContentRenderer/marks/text.tsx`, `src/lib/toolbar-config.ts`, `src/lib/keyboard-config/catalog.ts`, `src/lib/i18n/toolbar.ts`, `src/lib/i18n/shortcuts.ts`, `docs/features/editor.md`, plus tests (`markdown-serializer.test.ts`, `use-roving-editor.test.ts`, `RichContentRenderer.test.tsx`, `toolbar-config.test.ts`, `builders.ts`).

**Verification:** serializer/parser (415), renderer/editor/toolbar (525) suites green; property-based round-trip green; tsc + oxlint + oxfmt clean.

**Process notes:**
- Did NOT bundle P2-11 (strike rebind `Ctrl+Shift+X` → `Ctrl+Shift+S` + alias): it needs multi-binding editor wiring (the matcher supports ` / ` alternatives but `configKeyToTipTap` registers a single key), so it's a separate concern — left for a focused follow-up to keep this PR coherent.
- **#211 stays open.** Shipped: P0-2 (PR #246), P0-5 (PR #249), P2-5 (this). Remaining: P2-11 (strike rebind), help-dialog Formatting group + paste affordance, slash-menu placeholder surface (co-owned with #214), and the optional editor `<mark>`-colour alignment.

**Commit plan:** single commit / pushed.
