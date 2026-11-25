# Session 4438 — the Loro engine benches become a regression gate

The maintainer asked for the Loro engine benchmarks to fail the weekly run when they regress, in the same gate as the other benchmarks, instead of a separate `continue-on-error` step that only recorded numbers.

What shipped:

- `interactive_slo` gained a `loro_engine` module with four budgeted probes, so `bench-slo` runs them in its gated step and the SLO summary lists them: `export_snapshot`, the boot rehydrate and a cold first sync (`apply_remote` of the snapshot into an empty vault) of one space of 10K blocks after ten rounds of one edit to every block, and a new merge probe. The merge probe has two engines rewrite one block between syncs (A the first word, B the last, through `apply_edit_via_diff_splice`), then exchange `export_update_since` updates through `import_with_changed_purged_tagscope`, over 1,000 rounds.
- The informational step, its `loro-measurements` artifact, `scripts/measure-loro.sh` and the `measure-loro` recipe are gone. `loro_snapshot` and `pulled_vault` stay in `engine_bench` as unbudgeted criterion groups; `docs/architecture/operations.md` § Loro engine cost now gives the `cargo bench` command that `scripts/measure-loro.sh` used to wrap.

Decisions and traps:

- The merge probe keeps the block's text a fixed size. A first version appended a word each round, and its time grew quadratically on loro 1.13.6 too (1,000 rounds 129 ms, 4,000 rounds 1.6 s), because every edit diffs the whole text. With the text a fixed size, the time grows with the round count only when the merge itself grows with the history.
- Sizing, engine paths only, release without LTO on this container, 1,000 rounds: 1.13.6 0.10 s, 1.18.0 0.14 s, 1.13.7 22.4 s. On 1.13.7 the per-round cost climbs (250 rounds 1.3 s, 500 rounds 6.5 s, 2,000 rounds 91 s); on 1.18.0 it stays flat up to 4,000 rounds (0.61 s).
- 10K blocks, not 100K: a cold first sync at 100K takes about half a minute a sample.
- Budgets are the smallest 1-2-5 value at least 3x the worst figure from two runs. One was this container on loro 1.19.1, at load 0: export 0.90 ms, rehydrate 88 ms, cold first sync 3.32 s, merge 126 ms. The other was #7064's `bench-slo` dispatch on 1.18 (run 45619586460, the old measurement step at 10K × 10): export 2.23 ms, rehydrate 34.5 ms, cold first sync 1.05 s. Budgets: export 10 ms, rehydrate 500 ms, cold first sync 10 s, merge 500 ms. The maintainer chose to push on a local smoke rather than wait for this branch's own `bench-slo` dispatch (run 45649660176, on 1.19.1); a red weekly run will be troubleshot then.
- Two dispatch attempts and one cancel returned HTTP 500 from GitHub before going through; the 1.18 dispatch (run 45645003883) was cancelled before it reached the Loro probes, once 1.19.1 had merged.

Ran: the four probes alone through a trimmed `criterion_main!` (restored by a trap) on 1.13.6, 1.18 and 1.19.1, the last with the budgets (all PASS); a falsification that drops B's import from the merge rounds, which reddened the merge shape assertion with `Some("a b999")`; `cargo fmt --all --check`; workspace `cargo clippy --all-targets -D warnings`; the manual-stage hooks over the workflow and docs.
