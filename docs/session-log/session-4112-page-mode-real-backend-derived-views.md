# Session 4112 — page mode on the real backend: search, backlinks, the page's undo, a paste

Last PR of #6714 (after #6716, #6719 and the image fix #6723). The mock derives nothing in the background, so four rows of the comparison could only be covered on the real backend: what the backend makes of a page-mode save.

## Shipped

`e2e-tauri/page-mode-derived-views.e2e.ts`, one vault, four tests:

- a word typed in page mode is found by search, and the word it replaced is not;
- a `[[link]]` typed in page mode lists its block under the linked page;
- the page's undo takes a page-mode edit back and redo puts it back, in the backend and in the open document;
- list lines naming a new page, pasted in page mode, land as blocks linking it, and the page exists.

## The lane runs in a cloud session

#6714 asked whether these specs could be shown red from the cloud. They can, with no repo change: `apt-get install webkit2gtk-driver openbox xdotool`, `cargo install tauri-driver --locked`, then the build `wdio.conf.ts` runs (`npm run tauri -- build --debug --no-bundle …`, with `CARGO_PROFILE_DEV_DEBUG=0 CARGO_INCREMENTAL=0`), and `WDIO_SKIP_TAURI_BUILD=1 bash scripts/e2e-tauri-local.sh <spec>`. The first build took about five minutes on four cores; a rebuild after a frontend or one-crate Rust change takes one to three.

## Traps

- A chip beside the caret shows its `[[…]]` source (the syntax reveal), so a block's text right after typing a link reads `[[Title]]` while the chip is already there. Wait for the chip, not the text.
- Two plain lines are one paragraph to the Rust grammar and land as one block with a line break; the mock's paste spec uses list lines too.
- A mutation that leaves a variable unused fails `tsc -b`, the build stops, and the spec then runs against the previous binary. Two runs were void that way. The wrapper that mutates, rebuilds and runs was a scratch script of this session, not a file in the repo; it now stops when the build fails. A mutated binary also stays on disk after the source is restored: rebuild before trusting a later run.
- Link rows have two writers on an edit: the command's transaction and the background `ReindexBlockLinks`. With the background one off alone the backlink test stays green; with both off it reds. The search test reds with the background one off, but at its first search: that mutation un-indexes every edit, block mode's too.

## Review notes from #6716 and #6719

- "`e2e/page-mode.ts` exports `SCOPE`, but only that module uses it": `page-mode-text.spec.ts` (#6719) imports it. No change.
- "import `SEED_IDS` from `src/lib/tauri-mock/seed.ts` as other specs do": no spec in `e2e/` imports from `src/`; the ones named cite `SEED_IDS` in a comment. The ids stay as constants with that same comment. No change.

## What ran

- The spec on the real backend under Xvfb: four passing. Each test shown red once on a successful rebuild (the PR body lists the mutations), sources restored after.
- `npm run typecheck`, `npm run lint`, `node --test scripts/e2e-related.test.mjs`, `npx vitest run e2e-tauri`, `prek run --hook-stage manual --all-files`.

Not run: the rest of the real-backend lane, the Playwright lane, the full vitest and Rust suites (the diff is one spec and this log).
