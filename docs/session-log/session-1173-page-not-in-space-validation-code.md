# Session 1173 — Code the load_page_subtree membership rejection as PageNotInSpace (#2810)

## Scope

The frontend stale-space heal (`src/stores/page-blocks.ts` `load()` catch) keyed
on `kind === 'validation'` because `load_page_subtree_inner`'s membership
rejection was an **uncoded** `AppError::validation`. That was sound at the time
(malformed ULIDs map to kind `ulid`; the Global-scope `require_active` rejection
is unreachable from `load()`), but fragile: any *future* validation added to
`load_page_subtree` would silently reroute into the heal (soft "moved to another
space" notice + tab pop + recents purge) instead of the generic error path.
Message-regexing was retired in #2251, so a structured code is the right
mechanism. Follow-up from the #2802 adversarial review.

## Change

- `agaric-core/src/error.rs`: added `ValidationCode::PageNotInSpace` (wire string
  `"PageNotInSpace"`); extended the `validation_code_wire_strings_pinned` test.
- `src/commands/pages/listing.rs`: `load_page_subtree_inner` now returns
  `AppError::validation_coded(ValidationCode::PageNotInSpace, …)`. (`get_page_inner`'s
  identical uncoded rejection is intentionally left untouched — it is reachable
  only via the MCP `get_page` tool, never a FE command, so it's out of scope.)
- `src/lib/bindings.ts`: regenerated (specta) — adds `"PageNotInSpace"` to the
  `ValidationCode` union (verified by the repo's `ts_bindings_up_to_date` drift test).
- `src/lib/search-query/validation-codes.ts` (+ pin test): runtime mirror.
- `src/stores/page-blocks.ts`: `load()` catch keys the heal on
  `validationCode(err) === ValidationCode.PageNotInSpace` instead of the generic
  `isValidation(err)`.
- `src/lib/tauri-mock/handlers.ts` (+ conformance pin): mock now throws
  `{ kind: 'validation', code: 'PageNotInSpace', message }` (type-checked against the
  specta `AppError` type — a misspelling is a compile error, not silent drift).

## Tests

Rust: `load_page_subtree_rejects_foreign_space` asserts `code == PageNotInSpace`;
`agaric-core` wire-string pin extended. FE: `page-blocks.test.ts` gains a
discrimination test proving a generic (uncoded) validation does NOT trigger the
heal; conformance test pins the mock's coded shape.

## Review

Independent adversarial review (Sonnet): confirmed the code reaches the FE
(specta drift test passes), the FE discrimination is sound (mutation-tested — the
new test fails if the guard reverts to `kind === 'validation'`), mock/prod parity
is exact, and scope is tight (no other validation site reclassified). Full
workspace suite 5270 passed / 0 failed / 6 skipped; clippy `-D warnings` clean;
vitest 1152 passed; `tsc -b` clean; no `.sqlx` delta; no main-checkout leak.

Closes #2810.
