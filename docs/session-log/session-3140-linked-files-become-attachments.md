# Session 3140 — A linked file imports as an attachment

The last of three #6032 items this session took, after #6200 (the bibliography title) and #6202 (CommonMark image destinations, resolved from the note's folder).

**What was wrong.** Only `![…](…)` and `![[…]]` were attachment refs.
- A `[paper](paper.pdf)` link in a folder or Obsidian import stayed a dead link.
- Joplin shipped no bytes for a resource link and warned with a count.
- Every ingested file was rewritten to an image token, so an embedded PDF (`![[x.pdf]]`, an Evernote PDF) drew a broken image.

**What shipped.**
- **Detection.** One image-or-link scan on both sides (`MARKDOWN_LINK_OPEN_RE` plus `link_destination`, and the TS twin) reads a link as a ref when it names a file. That excludes a `#fragment`, a URL with a scheme, and a note extension (`NOTE_EXTENSIONS`, now in `import-attachments.ts`), since a note is a page link.
  - An `attachment:` link stays skipped: its id belongs to the database that wrote it.
  - A link that matches no shipped file stays as written, with no warning, because links point anywhere.
- **Token.** A link stays a link, `[label](attachment:<id>)`. An embed is an image token only for an `image/*` file, and a link to it otherwise.
- **Rendering.** The static renderer draws a parsed `attachment:` href as a file link. The editor admits it (`isAllowedUri`). Clicking it downloads the file through `openAttachmentLink` (attachment-utils).
- **MIME types.** `guess_attachment_mime` gained audio, zip and tar, which the allow-list already took.
- **Joplin.** A resource link ships its bytes, and the file-link warning and its keys are gone. A linked resource with a note extension (`log.txt`) is written as an embed, because a resource is never a note and a link to it would read as a page link.
- **ZIP export.** An asset path with a space or a parenthesis is now written as `<…>`, so it re-imports. Before, it was not a valid destination.
- **Export.** The rule that skips an attachment whose id is already in the block's content covers the new link token, so nothing is listed twice.

**Left as is.**
- `rewrite_block_attachment_refs` replaces the first textual copy of a ref, which can be one inside inline code. This predates the change.
- A Notion page's link to its database CSV now attaches the CSV as text.

**Tests and reds.**
- **Vectors:** both sides failed on the link rows first.
- **Rust:** `import_attaches_a_linked_file_as_a_file_link_6032` went red when every token was forced to an image, when the export dedupe was dropped, and when a linked PNG was turned into an image. A MIME line deleted from the table reddened the new asserts.
- **vitest:** jex-import (a link ships, and a `.txt` link), export-graph (`<…>` round trip), attachment-utils, the renderer and the editor link.
- **Playwright:** `e2e/attachment-link-6032.spec.ts` on the mock.
- **e2e-tauri:** two cases in `import-formats.e2e.ts`. They are not run here (no tauri-driver); CI's lane is their first run.

**Ran:** vitest over `src/lib`, `src/components` and `src/editor`; typecheck and lint; nextest filtered to attachment, ingest, import, vectors, export, markdown and jex; clippy over the workspace and all targets; the strict rustdoc check; prek over the range; and three Playwright specs.

**Trap.** Disk is a fixed allowance. Test executables with stale hashes pile up in `target/debug/deps` across `cargo test`, nextest and clippy runs; deleting them freed several GB where `incremental` freed little.
