# Session 1809 — markdown source mode, phase 2

Phase 2 of #5140 is a read-only "View as Markdown" dialog. It shows the page in the Source grammar that Phase 1b (#5150) added. It was planned against the code first, and the re-plan comment on #5140 records four changes to the 08:32 plan:
- no new query, because `resolve_block_space` already reads a page's space inside a transaction;
- a waiver reason that names the actual blocker;
- the page kebab as the only entry point, because `PageHeader` mounts only in the page-editor view;
- the "same transaction" property pinned through what it buys, since the transaction boundary itself can't be falsified.

**Backend.**
- `get_page_source_inner` shares export's read half, now `load_page_export_data`, and adds `load_name_snapshot` inside the same read transaction.
- `snapshot_page_link_matches` and `snapshot_tags_by_norm` take a connection, so the import write transaction and this read transaction can both call them.
- `render_page_source` and `PageExportData` are private again, because a command now calls them.

**Frontend.**
- `PageSourceDialog` flushes the active draft, then fetches on every open. It holds its load state in a body that mounts only while the dialog is open, so a reopen never shows the previous buffer.
- The kebab item sits right after Export.
- The mock is a deliberate approximation, with a `NOT_YET_PINNED_READ` waiver owned by #5071.

**Review.** An independent reviewer found no defect in the command or the wiring, and fixed two things:
- The buffer's `<pre>` is now a tab stop. Nothing in the Radix scroll area took focus, so a keyboard-only user could not scroll a buffer longer than one screen. jsdom's axe cannot see this.
- The mock now rejects a non-page id with `validation`, as `load_page_row` does. Before, it rendered the block's subtree.

**Falsified against copies.**
- Rust: discarding the loaded snapshot, passing no titles, passing the page id as the space, and keeping one id per title each reddened a test. Swallowing the loader's error reddened both error tests.
- Frontend: 21 of 22 mutations reddened a test. The survivor was a redundant `setKebabOpen(false)`, which mirrors the existing handlers; Radix already closes the popover.
- Playwright: Copy writing an empty string reddens `e2e/page-source.spec.ts`.
- Review fixes: the tab-stop test and the mock's validation test each fail without their line.

**Verified.** The targeted `nextest --workspace` filter passes 342 of 342. The bindings regen left `bindings.ts` byte-identical to the hand-inserted line. `SQLX_OFFLINE=true cargo check --workspace --all-targets` and clippy are clean. The touched vitest files, typecheck, oxlint and two Playwright specs pass. The local pre-push verify was skipped: the session's shared cargo target filled the container's disk allowance, so it could not hold another build. CI is the gate.

**Disk.** Running builders in three worktrees against one shared `CARGO_TARGET_DIR` stored three copies of the workspace crates, and the disk filled twice. Next time, build one tree at a time.
