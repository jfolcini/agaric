# Session 1677 — three read waivers lifted

#3830 tracks the read commands waived from conformance pinning. Three of
them had waiver strings that described a scope, not a blocker, and now have
`queries` steps: `count_trash`, `list_property_defs`, `get_property_def`.
`list_drafts` stays waived because the mock has no drafts table (a step
would pin an empty list on both sides); `list_spaces` stays waived because
the runners' space ids are not relabelled (the single-space scope reason in
its string is still the true one).

`count_trash` returns a bare number, which the row-token grammar had no
place for. A scalar `RowsLocation` (`{ kind: 'value', head }`) renders it as
one `count_trash#value=5` token through the same `attr_value` / `attrValue`
path every other attribute takes, so the JS/Rust number-rendering guard
applies. The step sits in `query_trash_and_page_listings.json`, whose seed
already tombstones five rows across four cohorts, so it pins rows against
roots; making the mock count roots reddens it. It does not pin the space
filter: every seeded block is in the one test space, so a global count
agrees, and the same is true of `list_trash` beside it.

The property-definition reads needed a registry to read. A fixture may now
carry `seed.property_defs`, inserted through `create_property_def_inner` on
the backend and into the mock's map on the other side. The backend's
migrations pre-seed around twenty builtin declarations while the mock's map
starts empty, so the seed phase first clears the table for a fixture that
declares the section; the other fixtures are untouched, and the reviewer
confirmed that by re-authoring all of them and diffing the parsed JSON. The
new `query_property_defs.json` seeds two defs out of key order, sets a
property that the seeded select gates on both stacks, and pins the sorted
list, one hit and one miss.

That fixture found a real mock divergence: `list_property_defs` served
insertion order where the backend sorts `ORDER BY key ASC`. The mock now
sorts with the existing `compareBinary`. Nothing else consumed the order.

Two things noticed and left: the existing `seed.properties` section is used
by no fixture and would diverge on `op_log_digest` the first time it was,
because the backend seed appends an op and the mock writes its map directly;
and a `count_trash` of zero would render one non-empty token and slip past
the vacuity guard, which is why the chosen count is five.

## Verified

- Rust `cargo nextest run --workspace -E 'test(conformance)'`: 95 passed,
  by the builder and by the reviewer, including the `SWEPT_ARM_COUNT`
  denominator at 38.
- vitest over `src/lib/tauri-mock/__tests__/conformance*`: 6 files, 131
  passed, twice; the mock's own suite, 44 files, 854 passed.
- `npm run typecheck` exit 0, twice.
- Falsified on copies, restored `cmp`-clean: the mock counting cohorts
  instead of rows, and roots instead of rows; a fabricated hit on the
  `get_property_def` miss; `options` dropped from the list items; the sort
  removed; the seeded `value_type` changed on the Rust side. A Rust arm that
  ignored the scope stayed green (see above).
- Not run locally: the full suites (CI carries them; the laptop is in use).
