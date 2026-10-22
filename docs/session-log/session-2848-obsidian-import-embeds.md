# Session 2848 — import reads Obsidian embeds, and links anchors across a folder's notes

This is #6032's embed item: Obsidian and Logseq embeds, and references into another file of the same import.

## What changed

- **Obsidian embeds.**
  - A block whose whole content is `![[Note]]` imports as an embed block of that page (`{{embed [[ULID]]}}`). That is the form typing `![[` writes since #6044.
  - `![[Note#Heading]]` embeds the heading's block, and `![[Note#^id]]` embeds the block carrying that `^id`.
  - An anchor that names no block embeds the page.
  - An embed inside other text becomes a link, or a block reference where its anchor names a block, since an embed is a whole block.
  - A target with a file extension is still an attachment.
- **Anchors across a folder's notes, in any import order.**
  - A `#Heading`, `^id` or Logseq `id::` anchor in a note imported later can't be resolved while an earlier note imports, so the folder import defers those links and resolves them in one closing pass.
  - That pass is a new IPC, `link_import_anchors`. It takes the anchors the import collected and the blocks it deferred.
  - Those anchors can't be read back from the database: `^id` markers and `id::` uuids are stripped from stored text, so the folder runner carries them, as it already carries `collapsed` ids.
  - Until the pass runs, the deferred placeholders (`[[ULID#anchor]]`, raw `((uuid))`) are inert for every reader. No link row is written, FTS and export leave them verbatim, and an embed of one renders the unresolved chip.
- **Logseq `{{embed ((uuid))}}`** to a block in another file of the folder is now an embed of it, where it used to import as `{{embed }}`.

## Review

There was a separate high-risk review. It found no correctness defect in the production code. It changed tests, the fixture and one doc sentence:

- **Fenced code.** It added a fenced-code case, showing that `![[…]]` inside a fence stays as typed.
- **Cancel.** The cancel test now asserts the closing pass still runs for the notes imported before the cancel.
- **Mock waiver.** The builder had waived the new command in the mock's coverage list. The reviewer replaced that with a backend-authored fixture, `link_import_anchors.json`. It covers headings, `^id`, an anchor naming nothing, a resolved and a stripped uuid, foreign-space and missing blocks, and the warnings. It is backend-only on the mock, like `markdown_imports` (#5071).
- **Real backend.** The real-backend spec now imports `![[topic#^step]]`, which only the closing pass can link, and asserts that the embed shows that block alone.

## Shown red

- the whole-block embed branch disabled;
- the embed rewrite dropped from `parse_import_payload`;
- the closing pass's `^id` lookup, and then its uuid lookup, returning nothing;
- the fenced-code guard removed;
- the runner sending no anchors;
- the runner skipping the pass on cancel;
- e2e-tauri with the closing call disabled.

## Gates

- clippy, fmt and `cargo doc` with the CI denies;
- `SQLX_OFFLINE` check; the regenerated `bindings.ts` is byte-identical;
- the whole workspace nextest in six partitions, and the doc tests;
- vitest over `src/lib`, the mock, `src/components/settings` and `src/__tests__`;
- both typechecks, lint and prek over the changed files;
- `import-obsidian-vault.e2e.ts` on the real backend.

## Decided, not changed

- **The closing pass is not atomic.** It writes one edit per block and warns and continues, as `resolve_anchor_links` and the attachment ingest already do after commit. A crash in the pass leaves the inert placeholders.
- **A multi-file pick that is not a folder pick does not defer.** Its cross-file `^id` links still become page links, with a warning, as before.
