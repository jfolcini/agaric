# Session 1505 — three Tiger Style rules the repo had already half-learned

Asked whether TigerBeetle's Tiger Style has anything left to teach this repo.
Most of it is already here under other names: bounded queues and channels,
`depth < 100`, validated limits, `panic = "abort"`, units in names, mutation
and property testing. Three items were not, and each had a paper trail.

**Assertions on in release.** Four sites had been promoted from `debug_assert!`
to a release-active check, one at a time, after someone noticed the harm only
happens where the check is compiled out (`filters/assembly.rs`,
`sync_protocol/operations.rs` #3726, `task_handlers.rs` #412,
`fts/filter_builder.rs`). AGENTS.md still only said "no side effects in
`debug_assert!`". The rule is now item 5 under "Patterns caught in review";
the 23 production sites outside test modules (17 still to decide, 6 already
justified) are listed in #4638 with a first-pass classification. An earlier
count of 27 included three sites under `observability.rs`'s `mod tests` and one
in the `#![cfg(test)]` `bulk_equivalence` module.

**A function ceiling.** Clippy's `too_many_lines` at 70, code lines only,
production code, test modules excluded: 142 functions over 70, 80 over 100,
23 over 200. The five longest are `export_page_markdown_inner` (454),
the backlink filter evaluator (396), `apply_snapshot` (380), the Loro sync
handler (347), and `recover_blocks_from_op_log` (345), all on the paths where
a data-loss fix would land. Item 6; sweep and the eventual lint in #4639.
An earlier brace-counting script reported 953 lines for the recovery
function; that figure counted comments and was wrong.

The lint landed in the same PR at the maintainer's request, as a ratchet
rather than after the sweep: `too_many_lines = "warn"` in every member's
`[lints.clippy]`, the threshold in `src-tauri/clippy.toml`, and each of the 142
violators carrying `#[expect(clippy::too_many_lines)]`. Under `-D warnings`
an `expect` that stops firing is an error, so a split cannot leave a stale
marker and a new function over the line fails outright. Test code is exempt:
`#![cfg_attr(test, allow(...))]` at the ten crate roots, `#![allow(...)]` at
the twelve integration-test and bench roots and the four test-util harness
modules, plus the one test-only offer path in `snapshot_transfer.rs` that the
`test-util` feature compiles into the library build. Falsified against a copy
of `recurrence_math.rs` with the workspace build (a single-crate build does
not compile on its own, tokio features unify only at workspace level):
removing one marker fails clippy on that function (75/70); adding one to
`days_in_month` fails `unfulfilled_lint_expectations`; restored, `cmp` clean.

**Release overflow checks.** `overflow-checks = true` in `[profile.release]`.
Tests always ran with checks on, so the flag only changes shipped builds, and
with `panic = "abort"` a wrap becomes an abort. No integer-overflow defect
appears in the session logs, so by "guards earn their keep" this one is
adopted as a principle, not a reaction. Item 7; the audit that turns aborts on
peer- or file-supplied values into `AppError::Validation` is #4640.

Not adopted, and why: static allocation and zero dependencies (a Tauri app
over SQLite and Loro), explicit sized integers over `usize` (churn with no bug
behind it), "two assertions per function" (collides with "no second guard for
the first guard"), full deterministic simulation of sync (the session state
machine is async over the pool; the deterministic `proptest` runner and the
in-process two-peer tests already cover convergence for this threat model).

Verified: `cargo clippy --workspace` with the 70-line threshold, exit 0, the
counts above. No Rust source changed; the flag is exercised by CI's Linux
bundle build.
