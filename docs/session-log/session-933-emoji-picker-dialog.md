## Session 933 — Emoji picker dialog: dataset grouping, recents store, browse-grid component (2026-06-01)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-06-01 |
| **Subagents** | orchestrator-only |
| **Items closed** | — (partial #286) |
| **Items modified** | #286 |
| **Tests added** | +30 (frontend) / +0 (backend) |
| **Files touched** | 9 |

**Summary:** Built the foundation + browse-grid for the emoji picker dialog (#286
sub-issues 1 and 2): a grouped view over the existing curated emoji dataset, a shared
localStorage-backed Recents MRU store, and a reusable `<EmojiPicker>` component (search +
recents row + virtualized categorized grid + Fitzpatrick skin-tone selector + ARIA grid
roles + axe-clean), plus a responsive `<EmojiPickerDialog>` shell (centred Dialog on
desktop, bottom Sheet on mobile). Surface integration (sub-issue 3 — block editor /
page-title / tag-rename insert-at-caret wiring) is intentionally deferred to a follow-up
PR to avoid colliding with the in-flight editor-block work in #217/#312.

**Files touched (this session):**
- `src/editor/emoji-data.ts` — added `EMOJI_GROUPS`, `EmojiGroup`, and `groupedEmoji()`
  (partitions the flat curated list into ordered display buckets via name boundaries;
  backward-compatible — the inline `:` picker still reads `EMOJI`/`searchEmoji` flat).
- `src/editor/__tests__/emoji-data.test.ts` — +3 `groupedEmoji` tests.
- `src/hooks/useEmojiRecents.ts` (new) — shared MRU recents store backed by localStorage
  via `useSyncExternalStore`; `push`/`clear` + standalone `pushEmojiRecent`; cross-window
  `storage` sync; defensive read/parse/write (mirrors `useLocalStoragePreference`).
- `src/hooks/__tests__/useEmojiRecents.test.tsx` (new) — +11 tests.
- `src/components/EmojiPicker/EmojiPicker.tsx` (new) — the picker body.
- `src/components/EmojiPicker/EmojiPickerDialog.tsx` (new) — responsive dialog/sheet shell.
- `src/components/EmojiPicker/emoji-skin-tone.ts` (new) — Fitzpatrick `applySkinTone` +
  `supportsSkinTone` over the tonable hand/body bases in the curated set.
- `src/components/EmojiPicker/index.ts` (new) — barrel.
- `src/components/EmojiPicker/__tests__/emoji-skin-tone.test.ts` (new) — +6 tests.
- `src/components/EmojiPicker/__tests__/EmojiPicker.test.tsx` (new) — +10 tests
  (render, group headers, select, search filter, skin tone applied/not-applied, recents
  insert, recents hidden while searching, axe).
- `src/lib/i18n/editor.ts` — +13 `emojiPicker.*` keys (all user-facing strings i18n'd).

**Decisions:**
- **Dataset (open question in #286):** kept the existing curated `~120`-emoji set rather
  than bundling `emojibase-data`/`emoji-mart` (~150 KB new dep). Local-first favours the
  static set, and the grid is fully virtualized so swapping in a larger dataset later is a
  drop-in (`groupedEmoji()` already buckets whatever `EMOJI` contains). Growing the dataset
  can be its own follow-up without touching the component.
- **Settings gating / trigger placement (open questions):** out of scope here — they belong
  to the surface-integration follow-up. This PR ships only the reusable component + stores.

**Verification:**
- `npx vitest run` — 481 files, 11160 tests passed (full suite, incl. the 30 new tests).
- `npx tsc -b --noEmit` — no errors.
- pre-commit / pre-push hooks — run at commit/push time.

**Process notes:** Worked in an isolated worktree (`agaric-wt-emoji-picker`) off
`origin/main`; node_modules symlinked before first edit. Deliberately avoided all editor
block / picker-footer files to stay clear of #217 (PR #312) and the concurrent DB work.

**Commit plan:** single commit; pushed; PR opened (no merge).
