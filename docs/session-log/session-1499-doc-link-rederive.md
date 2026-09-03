# Session 1499 — the deep-checks `cargo doc` lane was red on `main`

`scheduled-deep-checks` run 33721360413 failed its pre-push `prek` stage on one
rustdoc error: `src/commands/block_cleanup.rs` linked
`[rederive_page_and_space_ids]` as a local item, and the helper lives in
`agaric_store::block_descendants` now. Only that lane denies
`rustdoc::broken_intra_doc_links`, and the pushes that moved the helper skipped
the pre-push hook, so nothing on the PR path could have caught it.

The link now names the crate path. Four plain-backtick citations of the old
`commands::block_cleanup::` address in `dispatch.rs`, `reconciliation_oracle.rs`
and `move_convergence_tests.rs` were repointed in the same pass; the
dead-symbol-citation guard does not see them because the symbol still exists,
just elsewhere.

Verified with the hook's own command,
`RUSTDOCFLAGS="-D rustdoc::broken_intra_doc_links" cargo doc --workspace --no-deps`:
exit 0, six crates documented, warnings unchanged.
