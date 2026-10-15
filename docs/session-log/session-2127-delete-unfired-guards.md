# Session 2127 — Four Python guards that never fired are deleted

#5579 step 1. Before porting the Python guards to `.mjs`, each one was
audited under "Guards earn their keep": a guard that has never fired on a
real defect is deleted, not ported. Four go:

- **`check-command-arity`.** rustc already rejects the defect. specta
  rc.25 implements `SpectaFn` only for `fn(T1..T10)`
  (`impl_typed_command!(T1, …, T10)` in `specta_fn.rs`), and
  `tauri_specta::collect_commands!` expands to `collect_functions!`, so an
  11-argument command fails E0277 instead of compiling and truncating.
  The widest command has 9 arguments, as when the guard landed.
- **`check-op-log-delete`.** It landed as a ratchet with zero violations
  and never fired. The append-only trigger aborts a `DELETE` without the
  bypass sentinel, and the defect it cited (#3310, a prune restarting the
  device seq) is pinned by `prune_to_empty_does_not_restart_seq`. #4556's
  sweep kept this hook; this reverses that call, on the evidence above.
- **`check-space-filter-drift`** and its baseline. #139 deferred the
  guard until a drift bug shipped, and none did. Its only recorded catch
  was its own scope rot (#3255). The shape rule stays covered by the Rust
  test `space_filter_production_sites_match_canonical`. That test walks the
  store and app crates. The hook walked six, but the other four hold no
  `b.space_id` read.
- **`check-elevation-tiers`.** Design-token drift with no failure mode.
  No firing found.

Every live reference moved with them: the six hooks and their WHY lines,
`check-baseline-paths.py`'s declarations, the `pr-merge-result-check.sh`
prerequisite row, the `verify-ci-equivalent.sh` skip lists, the file-source
suite's arity sections, and comments in three Rust files. The
`src-tauri/src/commands/AGENTS.md` line that credited the arity hook now
credits rustc.

Ran: `check-baseline-paths.py` (347 paths, 11 sets), `check-hook-budget.mjs`
(122/140), `test-py-guard-file-source.sh`, and the surviving raw-tx,
dynamic-sql and table-ownership guards live and in self-test.
`git grep` for the four names and the baseline outside `docs/session-log/`
prints nothing.
