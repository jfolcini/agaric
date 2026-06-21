# Session 1113 — tauri-mock sort/cursor behavioural conformance (#1886, slice 1)

## Problem

`src/lib/tauri-mock/handlers.ts` (~3.9k lines) re-implements the backend's
page-listing filter/sort/cursor logic in TypeScript so the e2e suite and many
unit tests can run without the Rust backend. `scripts/check-tauri-mock-parity.mjs`
only diffs IPC handler **names** — it never checks **behaviour**, so a backend
semantics change (sort order, cursor encoding) leaves the mock stale while every
suite stays green (#1886).

## Approach — shared golden vectors, asserted from both sides

The Rust path sorts in SQL (`ORDER BY` keyset) and the mock does it in pure TS
(`compareMetaRows`/`encodeNextCursor`), so the only common denominator is
*observable behaviour*. A single fixture is the contract:

- `conformance/pages-metadata/sort-cursor.vectors.json` — rows + per-sort
  `expectedOrder` + the cursor minted after the first sorted row
  (`expectedCursorAfterFirst`).
- **Rust** (`src-tauri/src/commands/tests/pages_metadata_conformance_tests.rs`)
  seeds a temp DB from `rows` and drives the real `list_pages_with_metadata_inner`:
  asserts (1) ordering == `expectedOrder`, (2) a real cursor round-trip
  (`limit=1`, follow `next_cursor` to exhaustion) reproduces the full order with
  no dupes/drops, (3) `sort_discriminator(sort)` == the fixture `position`.
- **TS** (`src/lib/tauri-mock/__tests__/sort-cursor-conformance.test.ts`) calls
  the real `compareMetaRows`/`encodeNextCursor` (newly `export`ed) against the
  same fixture: asserts ordering and the decoded cursor `id`/`position`/`seq`,
  plus that the four wire-sort discriminators are pairwise-distinct (the
  cross-mode `RequiresRefresh` precondition).

If backend semantics change, the Rust side fails; realigning the fixture then
fails the mock side until `handlers.ts` is fixed — drift can no longer hide.

## Scope (staged, per the issue's "start with cursor + sort")

- **In:** the four **wire** sorts — `default`, `recently-modified`, `most-linked`,
  `most-content` — ordering + cursor discriminator (`position`/`seq`).
- **Excluded by design:** `alphabetical` never crosses the wire
  (`pageSortWireFor('alphabetical')` → `'default'`), so its mock-only discriminator
  quirk is unreachable and out of scope.
- **Only `id` + `position` (+ `seq` for count sorts) are compared cross-impl.**
  The `recently-modified` key-slot representation legitimately differs (Rust:
  epoch-ms-as-string; mock: ISO string) and is deliberately not asserted across
  languages.
- **Follow-up (slice 2):** filter-primitive evaluation parity (`fbq*`, glob,
  has-property, last-edited) and recently-modified key-slot equality. Tracked in
  #1908; #1886 stays open until that lands.

## Verification

- TS: `sort-cursor-conformance.test.ts` — 9 passed; full `src/lib/tauri-mock`
  vitest green; `check-tauri-mock-parity.mjs` still OK (exports don't perturb it).
- Rust: `pages_metadata_conformance_sort_and_cursor` passes; sibling
  `list_pages_with_metadata` suite green.
- Adversarial review mutation-tested both sides (flipped a sort direction; bumped
  a discriminator; swapped a fixture vector) and confirmed each turns the suite
  RED — the test is not tautological.

Addresses #1886 (slice 1: sort + cursor). Filter-evaluation parity is the
remaining slice; #1886 stays open until that ships.
