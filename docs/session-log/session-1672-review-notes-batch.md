# Session 1672 — review notes from seven merged PRs, in one sweep

The non-blocking notes the reviewer left on #4923, #4925, #4927, #4928,
#4929, #4930 and #4932, batched per `AGENTS.md`: an approved green PR merges
as it stands and its notes ride together afterwards. Plus code-scanning
alert 279, which is one of them.

## What changed, by note

- **#4923** `limit-literal-guard.test.ts` — the name-set derivation keeps the
  match object instead of re-finding the name (the re-search was dead work
  that would have resolved to the first occurrence of a repeated name); the
  scan skips files with no `commands.` member access before tokenising them.
  The reviewer suggested `includes('commands.')`; that would have skipped 39
  of the 867 scanned files whose chain breaks across a line, so the check is
  the same `\s*` regex the call matcher uses. The skip regex that CodeQL
  flagged (alert 279: one anchored alternative beside an unanchored one) is
  two plain tests now.
- **#4925** — the unused `data-testid` on the switch is gone; the
  "(including inherited tags)" fragment is gated on `isPlaceholderData`, the
  signal that names the previous-key window a switch flip opens, instead of
  `loading`, which Load more also sets; the assertion `PageTagSection` made
  redundant is deleted; the a11y test is named for what it renders.
- **#4927** `PropertyDefinitionsList.test.tsx` — the merging `stubInvoke` is
  the flat one the sibling files use. The reviewer read the component right:
  no mutation re-fetches, and every test passes flat.
- **#4928** `history.rs` — the doc that opened mid-sentence states the two
  batched reads and nothing about what they replaced.
- **#4929** — `TITLELESS_SORTS_LAST` sits above the helper's contract block
  it had split; the `#3833` paragraph in `conformance_query.rs` is back on
  the module it documents, and the stray `#[cfg(test)]` is gone; the unlinked
  reader validates `limit` before its empty-needle exit, as `PageRequest::new`
  does before the title lookup, with a step pinning the refusal.
- **#4930** — the `app_data_dir()` clause is deleted from the contract test:
  neither host can vary it, so no drift could redden it.
- **#4932** — the staleness test seeds dropped rows with a null pending
  count, so it pins the coalesce it claimed to; the three `?? 0`s on
  non-nullable `StatusInfo` fields are deleted rather than explained.

## Verified

- TS: `TagFilterPanel`, `PageTagSection`, `StatusPanel`, `conformance-query-backlink-groups`,
  `conformance.test`, `limit-literal-guard`, `PropertyDefinitionsList` — all green;
  `npm run typecheck` exit 0 (the `?? 0` deletions compile against the
  non-nullable fields).
- Rust: `backlink_group_token_tests` (3), `apply_host::contract_tests` (2),
  `conformance_fixtures_match_backend`, `the_write_sweep_denominator_still_matches`
  — 7 passed.
- Falsified on a copy, restored and `cmp`-verified: moving the unlinked
  reader's `pageRequestLimit` back below the empty-needle exit reddens the new
  refusal step.
- Measured, not assumed: `includes('commands.')` would have scanned 146 files
  where the `\s*` regex scans 185; the 39 are chains broken across a line.
- Not run locally: the full suites (CI carries them; the laptop is in use).
