## Session 910 — #82 (PEND-66): replace execCommand with TipTap-aware insert (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct build + 1 explore + 1 review |
| **Items closed** | #82 |
| **Items modified** | — |
| **Tests added** | +3 (TipTap / Range-fallback / input branches) |
| **Files touched** | 5 |

**Summary:** Replaced the deprecated `document.execCommand('insertText', …)` used to insert `[[Page Title]]` links from the command palette (#82 / PEND-66) with the maintainer-decided Path B: a three-way branch on the previously-focused element — TipTap-managed contenteditable → `editor.chain().focus().insertContent(text).run()` (joins the undo history), plain `<input>`/`<textarea>` → native value splice (unchanged), any other contenteditable → Selection/Range fallback (documented undo-loss "Path A"). The single roving `Editor` lived only in `BlockTree`'s ref, so a small module-singleton registry (`src/editor/active-editor.ts`) bridges it to the app-level palette.

**Files touched (this session):**
- `src/editor/active-editor.ts` (new — `getActiveEditor`/`setActiveEditor` registry)
- `src/components/BlockTree.tsx` (publish the roving editor to the registry on its `focus` event; guarded unmount clear)
- `src/components/CommandPalette.tsx` (`insertPageLinkInto` 3-way branch; drop `execCommand`; doc/comment updates)
- `src/components/__tests__/CommandPalette.test.tsx` (replaced the execCommand test with TipTap-branch + Range-fallback + `<input>` tests; `afterEach` clears the registry)
- `src/components/__tests__/BlockTree.test.tsx` (mock editor gains `.on`/`.off`/`.isFocused` to match the real TipTap `Editor` API now used)

**Verification:**
- `npx vitest run` CommandPalette + BlockTree — 283 tests, all pass. tsc clean, oxlint clean, axe unchanged.
- Acceptance criteria met: no `execCommand` left in the palette (grep-confirmed); the TipTap insert joins undo (Cmd+Z removes the link); popover a11y semantics unchanged.

**Process notes:**
- **Review caught a blocking architectural defect:** my first cut keyed the registry on *mount*, assuming one app-wide editor. False — the journal **week/month views mount one `BlockTree` (each with its own roving editor) per day**, so a mount-keyed singleton would return the last-mounted editor (not the focused one) and the unmount cleanup would clobber a live instance. Fixed by re-keying to the editor's **`focus`** event (never cleared on blur, since opening the palette blurs the editor yet that editor is still the target) and guarding the unmount clear with `if (getActiveEditor() === editor)`. The registry doc now states it holds the *most-recently-focused* roving editor, not "the single editor."
- Verified `src/lib/slash-commands.ts` was already free of `execCommand`/`insertContent` — no scope creep needed.

**Commit plan:** single commit / pushed.
