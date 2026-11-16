# Session 4231 — oxlint `complexity` becomes an error

Cleared every `eslint/complexity` warning on main (34 at f35c8d6) and switched the rule in `.oxlintrc.json` from `warn` to `error` at the same `max: 25`.

## What shipped

- **Lookup tables:** `isFilterPredicate` validates through `FIELD_VALIDATORS`, a `Record` over `FilterPredicate['kind']`, so a new kind without a validator fails to compile. `metaRowMatchesFilter` dispatches through `META_ROW_MATCHERS`. An `Object.hasOwn` gate keeps an inherited name such as `toString` an unknown kind, and the mock's `Priority` and `State` arms share `inOrNullMatches`.
- **Mock handlers:** `set_property`, `create_block`, `run_advanced_query` and the structural-search row filter are split into named helpers. Validation order is unchanged.
- **App functions** (26–29): the smallest split that gets each under the limit. `PairingDialog` puts its `!loading` sections under one gate and gains `formatCountdown`. `PageHeaderMenu` gets `topLevelMenuIds`, and `page-blocks` `load` gets `healStalePageReference`.
- **Scripts:** the two `findMatchingBrace` copies become one in `scripts/lib/rust-scan.mjs`, on its `literalEnd` scanner. `js-scanner.mjs` scans JS, not Rust, so it could not host them. `check-bulk-equivalence`'s `blank()` was a third copy of that scanner and now uses it too. The lexer, the statement-end state machine and the self-test case lists carry a reasoned `oxlint-disable-next-line`.

## What ran

- `npx oxlint` reports no complexity diagnostics, and `npm run typecheck` is clean.
- Vitest over the touched modules: 106 files pass, including every tauri-mock conformance test.
- `prek run --hook-stage manual --all-files` passes.
- `just e2e-related` selects both whole lanes, because `shared.ts` and `wdio.conf.ts` changed, so CI's run is the check.
- Mutation testing. None of these modules is in `stryker.modules.mjs`, so each one, or each function's line range, was registered temporarily and run on main and on the branch with the tauri-mock suite. Survivors, main → branch: `validate.ts` 41 → 33, `shared.ts` 18 → 15, `properties.ts` 13 → 11, `blocks.ts` 32 → 28, `search.ts` 42 → 42.
- Trap: the sandbox leaves out `src-tauri`, which the tauri-mock tests scan, so the mock modules need `inPlace`. An in-place run resets the exec bit on `scripts/*.mjs`; restore it with `git checkout -- scripts`.
