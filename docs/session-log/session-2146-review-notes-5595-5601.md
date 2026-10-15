# Session 2146 — review notes from #5595 and #5601

The non-blocking notes from two merged PRs, plus one dead entry found
while closing #5579.

- **#5601, perSource counting.** `checkDataSources` counted a dangling
  entry as resolved in the verbose listing; `checkEmbeddedSources`
  subtracted it. Both now subtract it, and the comment that defended the
  difference is gone. A new node test runs `-v` over a data file and an
  embedded set, each holding one resolving and one dangling entry, and
  expects `1 path(s)` on both lines. Falsified on a copy: reverting
  either side's subtraction fails that test on the line for that side.
- **#5601, Python leads.** `stringsInLiteral` still looked for
  `NAME = ` and `NAME: ` at the start of a line, the Python declaration
  shapes. Every embedded source is now `.mjs` and declares with `const`
  (all five checked), so both leads are deleted. On the real tree the
  `-v` output is byte-identical before and after.
- **#5595, stale budget docs.** Three comments described the pairing QR's
  endpoint wait as `debounce_window` plus slack: `await_local_endpoint`
  in `sync_scheduler.rs`, the `QR_ENDPOINT_BIND_BUDGET` doc and its call
  site in `pairing.rs`, and the doc on
  `start_pairing_armed_degrades_when_no_endpoint_is_published`. The
  budget is a fixed constant and the dormant waiter spends no window, so
  each now says that. The constant's doc also loses its history.
- **`.py` in the REMOVE AFTER guard.** No `.py` file is tracked any more,
  so `py` leaves `SCAN_EXT_RE` in `check-remove-after-markers.mjs` and the
  hook's `files` in `prek.toml`. The hook's comment now lists `.js` and
  `.mjs`, which it already scanned.

Not acted on:

- `check-doc-code-paths.mjs` keeps `py` in its `file:line` citation
  patterns: those find a stale line-number citation to any file, and
  dropping `py` would only let one through.
- #5602's note: the app's 60 s resync can still make the peer's
  `wait_pulled` return early. The lane passed, and the race is documented
  in the spec; nothing to fix until it flakes.
- #5596's `edit_block` budget: re-measure only if the weekly lane fails
  without a regression.

Ran: `node --test scripts/check-baseline-paths.test.mjs` (13),
`node scripts/check-baseline-paths.mjs`,
`node scripts/check-remove-after-markers.mjs`, `cargo fmt --check`.
