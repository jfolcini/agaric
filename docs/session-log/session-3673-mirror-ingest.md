# Session 3673 — #6277 H2: the mirror reads edited files back

#5363 slice 2. A page's file edited outside Agaric is read back into the page, and the file keeps its own bytes.

- **Premise check.** The plan said to save with `apply_page_source_inner(merge: true)` against the closest shadow. A shadow, though, is a file text: since A3 it anchors only addressed blocks. The save's `base_source` must be a buffer with every block anchored, because `read_base` compares it with `render_page_document` and `merge_outlines` pairs by id.
  - Maintainer's answer: rebuild a fully anchored base, apply unchanged.
  - The base is stored, not rebuilt. Each `Shadow` keeps the page's buffer from the read its text was written from (`PageFile.buffer`). Re-deriving the anchors would copy the writer's anchor rules: a code line's anchor on its own line, escapes around the marker.
  - A shadow written by slice 1 has no buffer. It serves, against the page's current buffer, only while the page still renders as that text; otherwise the file stays diverged.
- **The ingest** (`mirror/ingest.rs`):
  - A file is read once two ticks read the same bytes.
  - It must be UTF-8; a BOM is dropped and line ends become LF; an empty file is refused.
  - Each line takes its anchor's id, or `pair_unanchored_lines` gives it one, pairing against the shadow closest to the file in lines. An editor that kept an older text open then doesn't undo Agaric's newer edit.
  - The save goes through `apply_page_source_inner` with `merge`, against that shadow's buffer. Its op refs go out in a `mirror:ingested` event, which `useMirrorIngestEvents` puts on the page's undo stack.
  - A refused file isn't retried until its bytes change.
  - A file moved by a rename while edited outside is read in at its old path first, then moved.
- **The writer keeps bytes** (`mirror/splice.rs`). Every write splices the render over the newest shadow: only blocks that read differently take the render's lines. "Reads differently" covers content, properties, depth, `is_code`, anchor and list number. A splice that doesn't read back as the render, block for block, is replaced by the render.
- **Detection.** Every tick stats each page's file, so an edit to a page nothing else marks dirty is still read.
- **Existing-test edits, approved by the maintainer:**
  - `buffer: None,` in the `Shadow` literal of `a_state_keeps_the_last_three_texts_written_once_each`;
  - step 3 of `e2e-tauri/mirror-outbound.e2e.ts`, which now expects the file read in and the app's edit kept.
- **Ran:**
  - `cargo nextest run -p agaric --lib -E 'test(/mirror::/)'`: 60 passed. Each new test was shown red by its own break (session notes in the PR).
  - The `useMirrorIngestEvents` vitest, red against two breaks.
  - `npm run typecheck`.
  - The e2e-tauri specs did not run here (no `tauri-driver`); CI's `e2e-tauri-gate` is their first run.
- **Left:** H3 (a new file becomes a page); a stat-scan measurement over 10K files.
