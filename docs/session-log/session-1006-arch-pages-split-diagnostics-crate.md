# Session 1006 — arch: pages.rs split (#644-B) + diagnostics-bin crate (#645 freebie)

Maintainer-directed arch work after Phase 10. Two disjoint PRs, each adversarially reviewed.

## Maintainer decisions applied (2026-06-11)
- **#644 → Option B:** split `commands/pages.rs` ONLY; leave `loro/engine.rs` (cohesive,
  externally clean).
- **#645 → target end-state is Option C** (decouple-first lean core), **deferred**; **do the
  freebie now** = carve the diagnostics bins into their own crate to prove the workspace wiring.
- **#763 → split:** re-scoped to item 1 (conformance corpus); items 2/3/4 → #886/#887/#888.

## Shipped (PRs)

- **`refactor(commands)` #644-B** — split the 2,683-LOC `commands/pages.rs` into
  `commands/pages/{mod,aliases,markdown,links,listing,metadata}.rs`. Behavior-preserving
  verbatim move; reviewer's per-item structural diff: **52 items, 0 missing, 0 body diffs**
  after path re-qualification. All `crate::commands::pages::*` paths preserved via glob
  re-export, so `lib.rs`'s `invoke_handler!` (11 refs) + `commands/mod.rs` (3 `pub use`
  blocks) resolve unchanged. `src/lib/bindings.ts` **byte-identical** and
  `ts_bindings_up_to_date` passes (the registration order is unchanged — unlike #642 which
  moved TYPES). The `pagination/block_row_columns.rs` BlockRow column-drift guard (it
  `include_str!`'d pages.rs) re-anchored to `pages/markdown.rs` + `pages/listing.rs`,
  EXPECTED_HITS=15 preserved (1+2 query_as! sites, none leaked). AGENTS.md +
  docs/architecture/filters.md + docs/dnd-ux-review.md citations repointed. 584 tests, clean.
  Closes #644 (Option B scope; loro/engine deferred).

- **`build(diagnostics)` #645 freebie** — extracted the two diagnostics bins
  (`op_log_histogram`, `audit_cross_space_refs`) out of the `agaric` app crate into a new
  `agaric-diagnostics` workspace-member crate (`src-tauri/diagnostics/`, dep `agaric = {path
  = ".."}`). Bins byte-identical; use only public `agaric_lib::` APIs. App `Cargo.toml` drops
  the two `[[bin]]` entries + the dead `diagnostics` feature; `members = [".", "diagnostics"]`.
  No CI/script/hook invoked them, so nothing to repoint. sqlx `.sqlx` cache (workspace-root)
  resolves for the new crate (verified offline + online). 28 bin tests pass; app still builds
  without them; clippy clean. **Proves the multi-crate workspace wiring** for the eventual
  Option-C core carve. Refs #645 (freebie only; the Tauri-free core carve stays deferred).
  - Minor follow-up: the `check-dynamic-sql` hook only scans `src-tauri/src/`, so the audit
    bin's 1 dynamic-SQL site is now outside guard scope (read-only diagnostics tool — low risk;
    widen the hook glob to `src-tauri/diagnostics/` when the core carve lands more crates).

## Remaining arch backlog
#645 core carve (Option C — deferred), #644 loro/engine + commands/pages-deep slices (deferred),
#709 tag re-key (plan), #139 space-filter SQL fragment, #877 (147-component migration), #882
(tx-core extraction). Next non-arch: #763 item 1 (conformance corpus), #833 (docs CI fast-path,
gate-sensitive — maintainer to review).
