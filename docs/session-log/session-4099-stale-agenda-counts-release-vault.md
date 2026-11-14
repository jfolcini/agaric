# Session 4099 — the agenda counts follow a date write; the release vault holds an attachment, a compaction and a peer; release.sh writes it

Finishes #6567: the stale-views box, the upgrade-path box and the release step, as the maintainer decided them on 2026-11-13.

## Stale views after a local write

Session 4071 measured the windows at the command layer. This one looked at the running app.

- **The agenda counts go stale on screen.** The week view's per-day due count (`useBatchCounts`, `count_agenda_batch_by_source`) is the reader that is mounted beside an editor that can set a date. In the app the whole-cache rebuild takes about 35 ms per thousand dated blocks (29 to 36 ms at 1K, 94 and 109 ms at 3K, debug build), so it passes the 150 ms debounce near 4,500. The Due panel reads the same cache but lists other pages' blocks only and is mounted in the daily view alone, so no local write changes it while it is on screen.
- **The fix is the event the views already hear, sent twice.** A property command's wrapper emits `block:properties-changed` at once, and again after `flush_background`, as the post-sync sink waits before its `blocks:changed`. `useBatchCounts` now reads the property counter as well as the graph one. No new event, store or queue.
- **Not covered:** writes that emit no property event and move the agenda (undo and redo, delete and restore, an import) still re-read once, a debounce after the write. That is the change-feed plan's.
- **Search does not go stale on screen.** The one view that writes while its results are listed is the replace run; with the index held back a second the replaced rows still left the list unasked. A spec written for it passed on the unfixed tree and was not kept: nothing showed it red.
- **The Tags view does not either.** It appends its own create without reading back, and nothing mounted with it adds a tag to a block.

## The seam

Seeding thousands of dated blocks through commands is not something a spec can do. After one batch of a thousand creates and a batch date write, the settled oracle reported 472 blocks missing from `fts_blocks` and every `agenda_cache` row; 200-block batches that set the date in the create ended in `database is locked`; a Markdown import of 1,000 dated tasks logged `background queue full, dropping task` and showed no result in a minute. At a rate the app kept up with, 9,000 blocks would take about ten minutes. No vault of that size was watched going stale: the sizes come from timing the rebuild.

So `run_background` has a debug-only delay (`AGARIC_E2E_BACKGROUND_DELAY_MS`), and `wdio.conf.ts` sets it for the specs in `SPECS_WITH_A_SLOW_MATERIALIZER`. `agenda-count-after-write.e2e.ts` was red on the unfixed tree, green with the fix, and red again with the second event sent without the wait.

## The release vault

- The generator now ages its ops a year and runs the release's own compaction (the daily job's command), then writes an edit, an attachment and the Work page after it. The age is the one thing no command writes; the README says so.
- The peer row is written by `peer_refs::bind_endpoint_id`, the function the pairing handshake pins with, and the device list's two commands. Pairing itself needs a second device on the wire.
- `counts.txt` holds the release's own block and op counts and its compaction frontier, so a release whose commands write a different number of ops does not fail the test on `main`.
- Reds, each by a throwaway migration or mutation at head: the watermark deleted; the peer's key nulled; the attachment read from another directory. A stored path rewritten by a migration is caught by the oracle (`attachment_blobs.on_disk_path`) before the byte read.
- Two assertions were written and deleted. A rewound apply cursor did not red "boot rewound nothing": head's boot heals it. `MIN(seq)` above the frontier cannot fail unless the op count already has.

## release.sh

The script writes the vault from `HEAD` before the bump, runs the upgrade test over it, stages it, and `bump-version.sh` accepts a staged vault as the one exception to its clean-tree rule. The test opens the one vault there is; `gen-release-vault.sh` replaces the old one.

- `docs/BUILD.md` and the issue spoke of the script's self-test. There is none: `bump-version.sh --self-test` was removed some time ago. `src/__tests__/release-vault-step.test.ts` runs the real `release.sh` in a scratch repository with the long steps stubbed, and the real `bump-version.sh` as far as its identity gate.
- The staging line in `release.sh` is covered by that test; that `git commit` then takes the index is git's.

## Traps

- Two heavy jobs at once (`npm ci` beside a `cargo check`) got the cloud container killed and restarted. Commits and the scratchpad survived; the running gates did not.
- `git merge origin/main` under a running gate chain: killing the cargo of one step let the chain go on to the next step on the merged tree. Stop the shell that runs the chain, not the cargo.
- oxfmt rewrites a staged test file and aborts the commit once; stage it again.

## What ran

After the last merge of `main`: full vitest, `npm run typecheck`, `npm run lint`, both halves of `cargo nextest run --workspace` (the bindings drift test among them), `SQLX_OFFLINE=true cargo check --workspace --all-targets`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --doc --workspace`. The real-backend lane ran locally for `agenda-count-after-write.e2e.ts` alone, before that merge; the rest of that lane and Playwright are CI's (`just e2e-related` selects both whole).
