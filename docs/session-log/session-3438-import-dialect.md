# Session 3438 — an import dialect on import_markdown

#6277 E1, the seam for E2. `import_markdown` takes a required `dialect`, `ImportDialect::Markdown` or `LogseqOrg` (in `agaric_engine::import`, so the reader can branch on it). The front end sends `LogseqOrg` for a Logseq graph pick (#6033 S8's `isLogseqGraph`) and for an `.org` file, and `Markdown` for every other file, ENEX note and JEX note. `ImportUnit.load()` carries the dialect from `mdFilesToUnits` through `useImportRunner` and `importMarkdown`. Nothing reads differently yet. The backend records the dialect in the import's start log line and span, and E2 passes it into `parse_import_payload`. #6317 (#6033 S3) should gate its `STARTED` and `#+BEGIN_` rewrites on `LogseqOrg`.

`import_markdown_inner` keeps its signature and passes `Markdown`, following the `vault_notes` precedent; E2 decides per test. The new `import_markdown_dialects` fixture imports one document under each dialect on both sides, and the existing import fixtures name `Markdown`.

Reds: a DataTab vitest that a graph pick and an `.org` file send `LogseqOrg` and a plain file `Markdown`; the fixture harness panics without the argument. Each routing branch was falsified on its own.

Ran: nextest over the import, conformance, ts_bindings_up_to_date, org and logseq filters (483); clippy; `SQLX_OFFLINE=true cargo check --workspace --all-targets`; vitest over `src/lib` and `src/components/settings`; typecheck.
