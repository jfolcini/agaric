# Session 1241 — the follow-ups reviewing produced

`/loop /batch-issues` run, 2026-07-30. Fifth log for the day (1237–1240 precede it).

Every item in this batch was filed by an adversarial review earlier the same day. None came
from the standing backlog. Two of the three reviews then refuted a claim the *builder* had
made, and one refuted the framing of the issue I had written.

## #3213 — the slot-deletion gap on the live and per-row paths

#3194 made the batch replay path delete an inbox slot only once `oplog_vv` provably covers
the frontier the blob declared. `apply_remote` and `replay_inbox_row` still deleted
unconditionally — the #535 violation #3194 exists to prevent, on two paths it could not
reach.

`screen_inbound_blob` now recovers both the #792 fork verdict and the declared frontier from
one decode, and `declared_end_vv` is a single shared definition so batch, live and per-row
cannot drift.

**The claim that mattered most was the one the builder marked unverified.** It had taken
`partial_end_vv`'s exclusivity from #3215's citations rather than the loro source. Review
re-derived it three ways from `loro-internal-1.13.6`: `version.rs:19-23` defines
`VersionVector` as "a right-open interval"; `fast_snapshot.rs:425` sets
`partial_end_vv = oplog.vv()`, the same quantity `oplog_vv()` returns; `:451` uses
`ctr_end()`, documented in `loro-common` as "the exclusive end". Had it been inclusive,
`oplog_shortfall` would have been off by one **in the unsafe direction** at every call site.

**The cost accounting was wrong and got fixed.** The first draft said retention costs "one
row plus one log line per boot". Probing showed three live redeliveries leave three kept
rows — the live path inserts per delivery, before the import — and a kept slot makes every
later no-op import in that space untrusted under the #2264 rule, forcing a whole-tree
reproject. Both are still the right side of the #535 trade, but #3213 exists *because* an
earlier comment dressed a gap up, so the framing is not cosmetic.

Durable quarantine is the piece still missing and needs schema — **#3226**.

## #3220 — the local gate ran nothing for six crates

`test-related-rust.sh` built filters only from `src-tauri/src/*`. A change confined to
`agaric-engine` (425 tests), `agaric-store` (1238), `agaric-sync` (182), `agaric-core` (173),
`agaric-observability` (41) or `diagnostics` (28) produced an empty filter list and ran
**zero** tests while reporting success.

With #3212 (same day), that was the whole hole: the engine had neither a working targeted
gate nor a correct full-suite command.

The load-bearing detail is that a `package(...)` filter must force `--workspace`. Run from
`src-tauri/`, the bare form is scoped to `agaric`, so `-E "package(agaric-engine)"` matches
nothing and — with `--no-tests=pass` already in place — exits 0 having run nothing.
Confirmed empirically: 0 tests / exit 0 without, 425 with. Shipping without that line would
have reproduced the bug one layer down.

Review proved the new self-test non-vacuous by **breaking it twice** — once so
`crate_roots()` emitted the directory name instead of the package name (only the
`diagnostics → agaric-diagnostics` assertion failed), once by deleting the `--workspace`
line (only the #3212 assertion failed).

## #3217 — I mis-diagnosed the issue I filed

Filed as "order-dependent". It is not: the test fails identically alone and in the full file.
It is a wall-clock race, deterministic once crossed — 5/5 failures with 16 cores saturated,
0 idle.

`DensityRow`'s hover-intent prefetch (120 ms debounce) fires a real `load_page_subtree`
call, which under contention lands before the click and **steals the positional
`mockRejectedValueOnce` slot** meant for `delete_block`. That falls through to the base mock
returning `undefined` — and `typedError` wraps any resolved value as `{status:'ok'}`, so
`unwrap` reports **success**. The failed-delete test exercised a successful delete.

I inferred order-dependence from a reviewer's "fails in isolation" without noticing that the
*machine state* differed between those runs, not the test order. The issue title has been
corrected on the record.

That `undefined`-reads-as-success behaviour is the more general hazard and is filed as
**#3225**: a missing mock — which should be the loudest failure in a test — is the quietest.
Three sibling tests currently pass only because they happen not to read the response value.

## Issues filed

#3225, #3226.

## Notes

- Three long Rust pushes were killed mid-verify with no output, at healthy memory (15 GB
  free, no orphaned `rustc`). All three succeeded on retry with `NEXTEST_TEST_THREADS=4`.
  Recorded, not diagnosed.
- Two compiler diagnostics surfaced mid-review and looked like real defects — an unused
  `require_covered` and a missing `doc_for_test`. Both were transient mid-edit state. Worth
  remembering that a reviewer's working tree is not a reviewable artifact until it reports.
- The #3213 builder declined to file its own follow-up issue on the grounds that it would be
  posting content on my behalf, and recommended it instead. That is the right boundary.
