# Session 3216 — Review notes from #6201, #6214, #6220 and #6225

The follow-up PR for the non-blocking notes of the sweep that ended with the Source dialect's deletion (#6225).

**What changed**
- **Duplicate** pins the copy of a legacy `WAITING` task, which the deleted Source-vs-Document oracle covered: such a state has no checkbox and travels as a `todo_state::` line.
- **The read-only `get_page_markdown` description** names the block syntax it writes. It pointed at `append_markdown`, which only the read-write server serves.
- **Names** that still said Source or outline say what they read or write: `PageRead::Buffer`, `push_buffer_bullet`, `push_anchored_bullet`, `summarise_markdown_append`.
- **`interactive_slo`**: `page_mode_read` takes an enum instead of a string with an unreachable `panic!`, so a misspelt read fails to compile instead of losing a weekly bench run.
- **`kind-change-undo.e2e.ts`**: one helper for the bullet `set_property` it wrote three times.
- **Phone page mode** (#6220 review): the lane left of the text took 80 px of a 390 px screen, the chevron and the checkbox each drawing a 44 px box side by side. They keep 44 px as a hit area (`touch-hit-area`) and the lane is 56 px. Desktop and touch tablets are unchanged.

**Dropped, with what was checked**
- `TARGETED_PRELOAD_MAX_IDS` as `MAX_BATCH_BLOCK_IDS`: same cap, but importing it from `ipc-helpers` breaks `useSyncTrigger.test.ts`'s module mock, since `resolve.ts` reads it at load.
- An early `isCancelled()` in `fetchAndCacheLinks`: it changes only a failed chunk's path and came without a test.
- The link bubble "at x=0 on the first tap": it does not reproduce as a first-tap defect; the bubble centres on the caret and floating-ui's `shift()` pushes it to the edge only for a link near it, still directly above the link.
- The journal day's switch row: no menu to host it; the maintainer then asked for one (session 3218).

**Red first**
- the `WAITING` leg with the render dropping the `todo_state::` line;
- the phone lane with the `.page-mode-phone` rules renamed (text offset 80, bound 60) and with `touch-hit-area` dropped (hit tests);
- the phone class keyed on touch alone (component test).

**Suites:** nextest over the whole workspace in two partitions (7331 run); clippy, `SQLX_OFFLINE` check, fmt; vitest over `src/editor`, `src/components/journal`, `src/components/pages`, `src/lib`; typecheck, lint, the manual-stage hooks; Playwright `page-mode-touch`, `page-mode`, `page-mode-gutter`, `page-mode-look`, `page-mode-setting`, `mobile-overflow`, `app-chrome` and every `journal-*` spec. The whole Playwright and WebdriverIO lanes are CI's.
