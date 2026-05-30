## Session 917 — #211 P2-11: rebind strike to `Ctrl+Shift+S` (legacy `Ctrl+Shift+X` alias) (2026-05-30)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-05-30 |
| **Subagents** | orchestrator-direct |
| **Items closed** | — (partial: #211 P2-11 only; umbrella stays open) |
| **Items modified** | #211 |
| **Tests added** | +1 (legacy-alias binding) + 3 updated (BUG-31 default, dialog render, slash chip) |
| **Files touched** | 7 |

**Summary:** Rebound the strikethrough shortcut from the low-mnemonic `Ctrl+Shift+X` to `Ctrl+Shift+S` (#211 P2-11). The legacy `Ctrl+Shift+X` keeps working for one release.

Design choice — **keep the catalog binding single, alias in the editor only.** The matcher supports ` / `-separated alternatives, but encoding the alias as `Ctrl+Shift+S / Ctrl+Shift+X` in the catalog `keys` string would ripple through every display/validation path that splits on `+` (the shortcuts dialog's `renderKeys`, the per-row chip `formatChordTokens`, the rebind settings UI, `findConflicts`). Instead:
- **Catalog**: `strikethrough` = `Ctrl + Shift + S` (clean single binding — display, tooltip, chips, conflict-detection all stay correct).
- **Editor** (`StrikeWithShortcut`): registers the configurable primary (`Mod-Shift-s`) **plus** a hardcoded `Mod-Shift-x` legacy alias, both firing `toggleStrike`. The hardcoded alias is trivially deletable next release.

This is the minimal correct surface: the legacy chord is an editor-only transitional concession, not a catalog data-format change.

**Files touched:** `src/lib/keyboard-config/catalog.ts` (rebind), `src/editor/use-roving-editor.ts` (`StrikeWithShortcut` dual binding), `src/lib/i18n/toolbar.ts` (tip → `Ctrl+Shift+S`), plus test updates: `keyboard-config.test.ts` (BUG-31 default → S), `KeyboardShortcuts.test.tsx` (dialog renders S), `SuggestionList.test.tsx` (the `/strike` chip resolves to S), `use-roving-editor.test.ts` (new: asserts both `Mod-Shift-s` and `Mod-Shift-x` are bound).

**Verification:** 289 tests across the affected suites green; tsc + oxlint + oxfmt clean.

**Process notes:**
- The **help-dialog Formatting group** item is effectively already satisfied — `KeyboardShortcuts.tsx` groups dynamically by `category`, and `keyboard.category.editorFormatting` ("Editor Formatting") already renders the mark shortcuts (inline code / strike / highlight / underline). The remaining "marks are also available via the bubble/slash menu" note is co-owned with #214.
- **#211 status:** P0-2 (#246), P0-5 (#249) merged; P2-5 underline (#250) + this (P2-11) open. After both land, only the paste-as-markdown affordance (gap #7) and the #214-owned discoverability surface remain — the umbrella is nearly closeable.

**Commit plan:** single commit / pushed.
