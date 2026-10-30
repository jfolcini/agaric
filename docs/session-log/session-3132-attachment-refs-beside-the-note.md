# Session 3132 — Attachment refs: CommonMark destinations, resolved beside the note

Two items of #6032, which share one code path in the Markdown import.

**What was wrong.**
- Both scanners (`detect_attachment_refs` in the engine, `scanAttachmentRefs` in the frontend) used one regex that ended a destination at whitespace or `)`.
- So `![](<my image.png>)`, `![](my%20image.png)`, `![](a(1).png)` and any image with a title were never imported. The files shipped and were dropped with no warning.
- Matching tried the vault-root path, then the basename. A ref is normally relative to its note, and the frontend shipped only the first file of a basename. So a folder with two `image.png` could attach the wrong one, silently.

**What shipped.**
- **Scanning:** both sides read the image's opening, then a small destination reader: a `<…>` destination, a bare one with balanced parentheses, an optional `"…"`, `'…'` or `(…)` title, then `)`.
  - The destination is percent-decoded. The engine's `percent_decode`, moved from `markdown.rs`, is now strict about hex, because `from_str_radix` took `%+4`. `percentDecode` in TS matches it byte for byte.
  - A bare `my image.png` stays not an image: CommonMark ends a bare destination at the space, and `image.png` is no title.
- **Matching:** `match_vault_file` and `resolveVaultRef` try the note's folder, then the vault root, then the basename. `..` climbs and fails the step above the root, through `resolve_vault_path`, which `relative_md_link_title` now uses too.
  - The backend's note folder is the page title without the picked folder and the note's name.
  - `ingest_read_counts` resolves with the same folder, or a byte move would starve a second ref.
  - On a basename tie the frontend ships the first two candidates, enough for the backend's warning. Shipping every same-named file of a large export could pass the attachment budget.

**Traps.**
- The Notion page title has its ids stripped, so the backend's note-folder step misses for nested Notion pages. It still lands, because the frontend resolves with the real path and ships only that file.
- A falsification whose `trap` restores a relative path fails once the shell has `cd`'d. Use absolute paths.

**Tests.**
- The shared vectors (`conformance/attachment-refs.vectors.json`) flip the rows #6032 named and add titles, decoding and malformed escapes.
- Rust: `attachment_ref_resolves_note_relative_then_root_then_basename_6032`, and `import_attaches_the_image_beside_the_note_6032`, where two `image.png` are shipped and the note's own one attaches.
- vitest: resolution order, ties and the two-candidate cap.
- e2e-tauri (`import-formats.e2e.ts`): two `my image.png` of different widths in sibling folders, referenced as `<…>` and `%20`. It is not run here, since there is no tauri-driver; CI runs it.
- **Shown red:** dropping the note-folder step (both Rust tests), dropping decoding (the vectors on both sides), the read count with no folder, keeping the picked folder in the note folder, a first-only `byBase`, and the cap.

**Ran:** the vitest `src/lib` suite and typecheck, nextest filtered to attachment, ingest, import, vectors, relative_md and percent, `ts_bindings_up_to_date`, clippy over the workspace and all targets, prek over the range, and five of the Playwright specs `e2e-related` selected.
