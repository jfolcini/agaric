# Session 1724 — the search_blocks dispatch guard follows the #4988 split

The 0.13.0 release run failed in `validate / vitest (1)`: the `#3927`
guard in `conformance-coverage.test.ts` reads `search_with_toggles`'s
three arm conditions out of `toggle_filter.rs`, and #4988 (merged the same
morning) moved `if !toggles.any()` into a new `fts_page_with_toggles`
helper. #4988 was Rust-only, so `detect-changes` classified it
`frontend=false`, the vitest lane never ran, and the guard first fired on
the release tag.

- The guard's third marker is now the fall-through call
  `fts_page_with_toggles(`; the helper's body is asserted to hold
  `if !toggles.any()` so the `no-toggle` label stays truthful.
- `_validate.yml`'s `frontend_re` and the local verify's new
  `RUST_PARSED_BY_TS_RE` route the six Rust files that test parses
  (`commands/{queries,blocks/queries,pages/metadata}.rs`,
  `agaric-store/src/{fts/toggle_filter,fts/metadata_filter,query/engine}.rs`)
  to the vitest lane, so the next Rust-only refactor of one of them runs
  the guard on the PR instead of on the tag.

The 0.13.0 run was cancelled; the tag and its draft are re-cut on the fixed
main.

## Verified

`npx vitest run src/lib/tauri-mock/__tests__/conformance-coverage.test.ts`
25 passed. Falsified on a copy of `toggle_filter.rs`: renaming the helper's
`!toggles.any()` test reddens with the new "moved again" message; hoisting
an `is_regex` branch above the blank-query test reddens with
`["regex","blank-query","no-toggle"]`. Both regexes match
`fts/toggle_filter.rs` and `commands/pages/metadata.rs` and not
`fts/search.rs`; `scripts/verify-ci-equivalent.sh --self-test` passes.
