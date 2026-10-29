# Session 3095 — Edit as Markdown defaults to the Document dialect

This is #5691 G3. G1 (#6162) and G2 (#6175, #6186) built the line-split Document dialect in Rust, in the TS reader and in the mock, behind a `dialect` argument. G3 makes it the default for Edit as Markdown.

**Changed:**
- **Opening and saving:** `PageSourceEditor` and the page store's reload pass `'document'` to `get_page_buffer` and `apply_page_source`.
- **The editing helpers** read the buffer once and write each changed block again through the Document writer: Turn into, task cycle, priority, dates, indent, dedent, move, duplicate and delete. The writer moved into `source-buffer-document.ts`, which the mock already imported. The Rust-authored `document-lines.vectors.json` pins it for both.
- **Keys:**
  - Enter on a paragraph leaves a blank line, so what follows is a new block.
  - On a list line, Enter continues the marker; on a line holding only its marker, it ends the list.
  - Shift+Enter is a line break.
- **Preview** reads through the same grammar.
- **Drafts:** a Source draft migrates to the read-only legacy shape (preference version 3).
- **The maintainer's fence decision** (comment 6489898794): text right under a closing fence stays in the code block.
- **Docs and the `pageSource.hint` copy** describe the new format.

**Not changed:** paste, Agaric's own block copy, MCP `capture` and Duplicate still read and write Source. #6190 moves them, with P (D2), and retires Source if nothing still needs it.

**Review found three defects, fixed before the PR:**
- **The new real-backend spec could not pass.** It read `space_id` off `get_block`, which has none.
- **Enter on an empty `2.` line in the middle of a numbered list** merged the rest of the list into the paragraph typed there: a numbered item past the first cannot interrupt a paragraph. Enter now leaves a blank line under the cursor when a list line follows.
- **Deleting the first numbered child** left `2. b` first under its parent, where it read as the parent's text. Delete now writes the following numbered siblings again.

**Red first:**
- **The four new key and delete tests** fail on the unfixed sources: 4 lines against 5, and `2. two` against `1. two`.
- **The real-backend spec, against a build with the dialect set back to `null`,** fails with every block after `## Plan` one level deeper, and the bullets lose their style.

**Checks on the real backend:**
- **No-op saves:** 13 Rust-written pages saved through `apply_page_source` change nothing and append no ops.
- **Buffer commands:** every command on every block of three pages was saved natively, 573 distinct saves. Each read back exactly as the TS reader predicted.

**Suites:**
- vitest, the whole suite (23,947), and again over `src/editor`, `src/stores`, `src/lib/tauri-mock` and `src/components/pages` after rebasing on #6189 (7,544);
- typecheck, the e2e-tauri typecheck, lint and knip;
- the manual-stage hooks;
- Playwright (180, the page-source, page-mode and markdown specs);
- the native page-source specs and five more on a rebuilt binary.
