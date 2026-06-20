# Session 1111 — /batch-issues loop: round-trippable Markdown export/import (#1446) + #1490 export residual

Last feature of the maintainer's 14-issue list. Built in `wt-1446`, adversarially reviewed
(the reviewer caught + fixed two critical issues — see below).

## Shipped (PR feat/1446)

- **#1446 Part A — export: namespace `/` → nested folders** (`src/lib/export-graph.ts`).
  `titleToZipPath()` splits the page title on `/` into nested folders
  (`Project/Backend/API` → `Project/Backend/API.md`), sanitizing only illegal chars
  per segment (keeps `/`), dropping empty segments; ULID-suffix dedup for true full-path
  collisions preserved. Fixes the data-loss flattening (`Project_Backend_API.md`).
- **#1446 Part B — import: resolve `[[Page Name]]` + folder → namespace**
  (`src-tauri/src/commands/pages/markdown.rs`). `folder_path_to_namespace_title()` maps the
  import path to the namespaced title; a wikilink pre-pass resolves `[[Page Name]]` →
  `[[ULID]]` (exactly-one → link, none → create-once + space property, ambiguous → plain +
  warn), canonical `[[ULID]]` untouched, scoped to the import's space (`AND space_id = ?`).
  `DataSettingsTab.tsx` passes `webkitRelativePath` so a folder/vault import carries the path.
- **#1490 residual — inline-image export portability** (`export-graph.ts`).
  `rewriteInlineAttachments()` emits each `![alt](attachment:<id>)`'s bytes into the ZIP
  under `assets/<id>__<filename>` (once per id) and rewrites the ref to a portable
  depth-matched `../assets/<file>`; unreadable attachments are left as the original ref +
  logged. Added a `read_attachment_meta` command + binding (for the original filename) +
  tauri-mock handler + a single new `.sqlx` entry.

## Review pass — two CRITICAL fixes

- **`.sqlx` cache destruction:** the builder's `cargo sqlx prepare` (run against an
  incomplete compile) deleted 235 of 557 offline-cache entries — CI's
  `cargo sqlx prepare --check` would have failed. Restored all 557 from HEAD, kept the one
  genuinely-new query → a clean addition (zero deletions; `git diff` on `.sqlx` is just the
  new entry).
- **Zip-Slip path traversal (Part A):** `sanitizeSegment` didn't neutralize `.`, so a page
  titled `../../etc/passwd` produced a traversal ZIP entry. Fixed to map any all-dots
  segment to `Untitled` (legal dotted titles like `v1.2.3` preserved); regression test added.
  Import side was not vulnerable (path kept as a title, never an FS path).

Otherwise verified correct: Part A folders + dedup + flat unchanged; Part B import-safety
(no accidental creation, ambiguous→plain, canonical untouched, space-scoped, folder↔namespace
inverse); #1490 asset export (once-per-id, collision-safe, depth-matched, nothing dropped);
the new command/binding/`.sqlx` wiring (`ts_bindings_up_to_date` passes); deferred items
(`#tag`/`((block-ref))` import, import-side `assets/` re-resolution) not half-wired —
round-trip degrades gracefully. clippy `--all-targets` clean; 187 Rust + 9746 FE tests;
tsc + oxlint clean.

## Notes

- Closes #1446 and #1490 (the latter's paste + in-app render shipped in #1434; this adds the
  export-path portability). Deferred follow-ups noted above.
- Adds a Tauri command → the push needs the prebuilt `agaric-mcp` binary (Phase F).
- Branch base is current `origin/main`.
