# PEND-52 — In-page find (`Ctrl+F`) — third search surface

> The smallest missing piece of Agaric's search story. Adds a browser-style find-in-page toolbar that overlays the current page editor (Journal or PageView), highlights matches in real-time, and supports next/prev navigation. **Reclaims `Ctrl+F`** for in-page find (the universal binding) and rebinds the global find-in-files view to `Ctrl+Shift+F` (matching VSCode).
>
> Paired with PEND-50 (find-in-files view) and PEND-51 (palette). After this plan ships, Agaric has the standard three-surface search story: `Ctrl+F` in-page, `Ctrl+Shift+F` across-files, `Cmd+K` palette.

## Why this plan exists

Today `Ctrl+F` opens the global `SearchPanel` view. For a user reading a multi-thousand-word page who wants to jump to "the part about X", that's the wrong tool — it dumps them out of the page into a results list. Every browser, editor, and word processor binds `Ctrl+F` to *in-page find* by convention. Coming from VSCode, Obsidian, Notion, Logseq, or any modern app, users *expect* `Ctrl+F` to highlight matches in the page they're already reading.

## Keyboard binding migration

| Binding | Before | After |
|---|---|---|
| `Ctrl+F` | Opens global find-in-files view | **Opens in-page find toolbar** (this plan) |
| `Ctrl+Shift+F` | (unbound) | **Opens global find-in-files view** (PEND-50; rebind happens here) |
| `Cmd/Ctrl+K` | (unbound) | Opens palette (PEND-51) |
| `F3` / `Shift+F3` | (unbound) | Next / previous in-page match (this plan) |
| `Enter` / `Shift+Enter` *(when toolbar focused)* | n/a | Next / previous in-page match (this plan) |
| `Esc` *(when toolbar visible)* | n/a | Close toolbar, restore editor focus |

Both bindings are landed together in the same PR so the help dialog and the live behaviour are never inconsistent.

## Design

### UX

A thin toolbar slides in from the top of the editor viewport when `Ctrl+F` is pressed. The currently-open page stays visible behind it (no view replacement; no overlay over content). Matches are highlighted inline in the rendered prose; the "current" match has a stronger highlight (accent background) and the editor auto-scrolls to keep it in view.

```text
┌─────────────────────────────────────────────────────────────┐
│  [find in page…                ] [Aa Ab| .*]  3 of 12  ↑ ↓ ✕│  ← thin overlay at top
├─────────────────────────────────────────────────────────────┤
│  …earlier in the page…                                       │
│  …kicked off the **alpha** review on Friday with the team…   │  ← non-current match
│  …builds gate on this PR, the [[alpha cohort]] depends on…   │  ← current match
│  …the **alpha** cohort is the test bed for v2 feedback…      │  ← non-current match
└─────────────────────────────────────────────────────────────┘
```

- **Input** auto-focuses on toolbar open; whatever was selected in the page becomes the initial query (browser convention).
- **Toggle row** mirrors PEND-50's `Aa` / `Ab|` / `.*` for consistency (same icons, same i18n keys, same semantics). Regex uses the same Rust `regex` crate but compiled in JS via the `regex-wasm` package, or — simpler — uses the JS native `RegExp` with the same `size_limit` (catastrophic backtracking is technically possible, but the corpus is one page, so the worst case is a single hang of the page editor — recoverable, not corrupting).
- **Match counter** (`3 of 12`) updates live as the user types.
- **Navigation arrows** (`↑` / `↓`) cycle through matches; same keybindings (`F3` / `Shift+F3`) work without focusing the arrows.
- **Close button** (`✕`) and `Esc` both dismiss the toolbar and restore editor focus to the previously-focused block.
- **Empty result** renders the counter as `0 of 0` in a muted tone — no error toast, just visual feedback.
- **Frontend-only.** No new IPC, no SearchFilter changes, no backend at all. This is a TipTap/ProseMirror integration plan.

### Match highlighting via ProseMirror Decorations

The TipTap document is a ProseMirror tree. Highlighting matches without modifying the document is the textbook use of ProseMirror's `Decoration` API. **Verified: no existing `Decoration` usage in `src/editor/`** — this is greenfield ProseMirror integration. The plan describes it in concrete steps, not as "follow the existing pattern."

- A new TipTap extension (`src/editor/extensions/in-page-find.ts`) registers a ProseMirror plugin (`Plugin` + `PluginKey` from `@tiptap/pm/state`, the standard import used by other extensions).
- The plugin holds find state in its plugin state: `{ query, caseSensitive, wholeWord, isRegex, currentIndex, matches: Match[], decorations: DecorationSet }`.
- **The Plugin's `apply(tr, value, oldState, newState)` handler explicitly re-runs the matcher when needed:**
  - `tr.docChanged` → re-walk the doc + recompute matches + rebuild `DecorationSet` from scratch.
  - `tr.getMeta(findPluginKey)` is set (toolbar dispatched a query/toggle change) → recompute.
  - Otherwise → `value.decorations.map(tr.mapping, tr.doc)` (mapping-only update; positions stay valid through unrelated edits but matches don't change).
- **Decoration auto-mapping clarification**: `DecorationSet.map()` only adjusts existing decoration positions through transactions. It does NOT recompute matches at the new positions. Without `tr.docChanged` recomputation, edited text won't surface new matches — the plan handles this explicitly above.
- The matcher walks `doc.descendants((node, pmPos) => ...)` collecting text-node strings with their ProseMirror positions. The query (literal / case-folded / whole-word-wrapped / regex) runs **per text node**, not against concatenated content. This matches the locked-in edge case "matches do not span blocks" and avoids the byte-offset → ProseMirror-position mapping problem entirely.
- Decoration emission: `Decoration.inline(textNodePos + matchStart, textNodePos + matchEnd, { class: 'find-match' })`. The currently-focused match gets `.find-match-current` instead.
- CSS for `.find-match` and `.find-match-current` lives in **`src/index.css`** (existing global stylesheet convention; the repo has no `src/styles/` directory). Use `@layer components` for the rules.

**No third-party dep required.** ProseMirror Decorations are core API. We avoid `prosemirror-search` (community package) to keep the dep tree lean and the implementation under our control — the find-in-page surface is shallow enough that owning it is cheaper than vendoring. **Budget**: if Phase 1 + 2 implementation exceeds 350 LOC of plugin + UI code, switch to `prosemirror-search` (~3 KB gzipped, well-tested).

### Regex hang mitigation — real plan, not a shrug

JS `RegExp` is backtracking-based; pathological patterns can hang the main thread indefinitely on long inputs, blocking the whole UI (not just the find toolbar). Mitigations in v1:

1. **Cap the regex pattern length** to 1 KB. Longer patterns reject with `findInPage.regexTooLong` inline error.
2. **Cap each text-node match length** to 10 KB. Text nodes longer than that are skipped with a console warning; the toolbar shows "Some long passages skipped" once per session.
3. **Cooperative chunking**: walking the doc.descendants is batched in 50-node chunks via `requestIdleCallback` (fallback `setTimeout(0)`); between chunks, the toolbar updates its counter so the user sees progress. If the user types again before completion, the in-flight walk aborts via a `cancelled` flag on the plugin state.

These three caps together bound the worst case to a few hundred ms even on adversarial input. Document the trade-off in `docs/SEARCH.md`: "regex matching is non-anchored by default; for long pages, anchor your regex to keep matches fast."

### Component layout

- New `src/components/InPageFind.tsx` — the toolbar UI; input + toggles + counter + arrows + close. Mounts/unmounts via `useInPageFindStore`.
- New `src/editor/extensions/in-page-find.ts` — the TipTap extension that registers the ProseMirror plugin and exposes commands (`find.setQuery`, `find.nextMatch`, `find.prevMatch`, `find.close`).
- New `src/stores/useInPageFindStore.ts` — Zustand: `{ open: boolean, query: string, currentIndex: number, totalMatches: number, toggles: { caseSensitive, wholeWord, isRegex } }`.
- New CSS file `src/styles/find-in-page.css` — `.find-match` (subtle accent background) + `.find-match-current` (stronger accent + underline).
- Mounted at the same level as the existing editor (Journal / PageView wrappers).
- Updated `src/hooks/useAppKeyboardShortcuts.ts:221` — rebind `Ctrl+F` from `setView('search')` to `useInPageFindStore.getState().open()`. Add `Ctrl+Shift+F` → `setView('search')` (the PEND-50 view).

### Edge cases

- **Empty page.** No-op; counter shows `0 of 0`.
- **Query crosses block boundaries.** Each ProseMirror text node is searched independently; matches do not span blocks. (A user looking for `end of paragraph 1 start of paragraph 2` won't find it. Acceptable — same as VSCode's editor.)
- **Match inside an inline code mark / tag pill.** Highlighted normally; the decoration sits on the underlying text node regardless of marks.
- **User edits while toolbar is open.** Plugin re-runs on the next doc transaction; counter and current-index update. If the current match disappears, current jumps to the nearest remaining match (or to 0 if none).
- **Regex with no matches anywhere.** Counter `0 of 0`, no scroll, no error.
- **Regex that fails to compile.** Inline red border on the input + tooltip with the JS `RegExp` error message. Counter shows `—` until the regex is valid.

### Mobile

Same toolbar shape, invoked via a `Find in page` menu entry on the page action sheet (long-press on the page header). **Verify the action sheet's existing items before scheduling** — open question Q1.

**Virtual-keyboard handling** is non-trivial on iOS: fixed-position elements are NOT pushed up by the soft keyboard; they're hidden under it. The toolbar must use the `window.visualViewport` API (MDN: search for "VisualViewport") to anchor itself above the keyboard:

```typescript
const offset = window.visualViewport
  ? window.visualViewport.height - window.innerHeight  // negative when keyboard up
  : 0
toolbarRef.current.style.transform = `translateY(${offset}px)`
```

Subscribed via `window.visualViewport?.addEventListener('resize', ...)` on mount. Tested on iOS Safari (the worst case); Android Chrome handles fixed-position more gracefully but the same code is safe there.

## Coherence with PEND-50 / PEND-51

| Concern | This plan | PEND-50 | PEND-51 |
|---|---|---|---|
| Scope | Current page | Whole vault | Whole vault, navigation-focused |
| Container | Thin toolbar overlay | Full view | Dialog/Sheet |
| Toggles | `Aa` / `Ab\|` / `.*` (same icons) | `Aa` / `Ab\|` / `.*` | none |
| Filters | none | inline syntax + chips | none |
| Highlighting | ProseMirror Decorations | FTS5 `snippet()` + `<mark>` | (inherits PEND-50's grouped component) |
| Backend | none | extended `search_blocks` | extended `search_blocks` |
| Keyboard | `Ctrl+F` (this plan rebinds from PEND-50) | `Ctrl+Shift+F` (rebind landed here) | `Cmd/Ctrl+K` |

The visual language (toggle icons, accent colours for matches, regex error UX) is shared with PEND-50 so users move between surfaces without re-learning.

## Phase split

### Phase 1 — Toolbar + literal-string find (S, ~6-8 h)

- `InPageFind.tsx` + `useInPageFindStore` + the ProseMirror plugin + the keyboard rebind.
- Literal-string search only (no toggles yet). Case-insensitive default.
- Next/prev navigation + match counter + Esc-to-close + selection-as-initial-query.
- Tests: open / type / count / arrow / Esc / re-open / multi-page (state resets across page navigation).

### Phase 2 — Toggle row (S, ~3-4 h)

- `Aa` / `Ab|` / `.*` toggles using the same icons as PEND-50.
- Regex compile + error feedback inline.
- Tests: case-sensitive narrows; whole-word ASCII; regex happy path; invalid regex shows error.

### Phase 3 — Docs (S, ~0.5 h)

- KeyboardShortcuts help dialog: add `Ctrl+F` + `Ctrl+Shift+F` + `F3` / `Shift+F3` rows; note the rebinding for users coming from prior versions.
- `docs/SEARCH.md` (created in PEND-50): add an "In-page find" section with the bindings table.
- One-line release-note entry: "`Ctrl+F` now finds in the current page; use `Ctrl+Shift+F` to search across all pages."

## Cost / Impact / Risk

- **Cost:** Phase 1 ~6-8 h. Phase 2 ~3-4 h. Phase 3 ~0.5 h. **Total M (~10-13 h, ~1.5 days).**
- **Impact:** **High.** Closes the single most-surprising omission for users coming from any other editor. Makes long pages (Journal entries with many blocks, archive pages, the `AGENTS.md` doc rendered in-app) actually scannable.
- **Risk:** **Low.** Frontend-only, additive, no backend touch. The riskiest seam is the keyboard rebinding — but it follows universal convention, and the migration is announced in one help-dialog row + a release note line. Recoverable: a user can always click into the global search via the sidebar.

## Open questions

1. **Mobile entry point.** Long-press menu on the page header is the assumed answer, but the existing mobile UX hasn't been audited for "what actions live on the page header menu?" — verify before scheduling.
2. **Replace?** Out of scope (see the search-and-replace decision in `pending/IDEAS.md`). If we ever add it, the in-page-find toolbar grows a second input row.
3. **Selection-as-initial-query** when no text is selected: restore the *previous* query (browser/VSCode behaviour). **Locked: yes.**
4. **Cross-surface regex feature divergence (KNOWN LIMITATION).** This plan uses **JS native `RegExp`** for in-page find; PEND-55's find-in-files view uses the **Rust `regex` crate**. The two engines have different feature sets:
   - JS RegExp: backtracking, supports lookbehind (modern engines), supports `\d` `\w` `\b` Unicode-aware by default.
   - Rust regex: linear-time, **no lookaround**, **no back-references**, `\b` is ASCII-only by default (requires `(?u:\b)` for Unicode).
   - A user writing the same regex pattern in both surfaces may get different results. Document explicitly in `docs/SEARCH.md`'s "Regex differences between surfaces" section. Not fixable without `regex-wasm` (~80 KB gzipped) on the frontend or a Rust-via-WASM compile.

## Toolbar a11y

- `role="toolbar"` on the toolbar container, `aria-label={t('findInPage.toolbarLabel')}`.
- Each toggle has `aria-pressed={isActive}`.
- Match counter element has `role="status"` and `aria-live="polite"` so screen readers announce "3 of 12 matches" updates.

## Related

- `pending/PEND-50-search-vscode-ux.md` — the rebind to `Ctrl+Shift+F` happens here, in the same PR.
- `pending/PEND-51-search-palette-dialog.md` — `Cmd+K` palette, the third surface.
- `pending/IDEAS.md` — search-and-replace is filed here.
- `src/editor/` — TipTap extensions; the new `in-page-find.ts` lives alongside.
- `src/hooks/useAppKeyboardShortcuts.ts:221` — the keyboard binding rebind site.
