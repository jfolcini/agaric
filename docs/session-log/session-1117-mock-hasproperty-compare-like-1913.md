# Session 1117 — tauri-mock HasProperty: ordered + LIKE predicates (#1913)

## Problem

The tauri-mock's `hasPropertyMatches` (`src/lib/tauri-mock/handlers.ts`)
implemented only `Exists` / `NotExists` / `Eq` / `Ne`, and only for `Text` /
`Ref` values. The backend's `compile_has_property`
(`src-tauri/src/filters/primitive.rs`) also compiles the ordered comparisons
`Lt` / `Gt` / `Lte` / `Gte` (`compile_property_compare`) and the `LIKE` matches
`Contains` / `StartsWith` (`compile_property_like`), across all four value types
(`Text`/`Ref`/`Num`/`Date`). The mock hit its `default` branch and returned
`true` for every unimplemented predicate — a silent no-op that admitted every
row, diverging from the backend. Filed as #1913 while scoping the #1908
conformance work (which deliberately covered only the implemented subset).

## Fix — implement the full predicate matrix in the mock

`hasPropertyMatches` now mirrors the backend exactly:

- **Value-column mapping** (`propertyValueColumn`) — the 4-way
  `Text→value_text` / `Ref→value_ref` / `Num→value_num` / `Date→value_date`
  map (backend `property_value_column`), selected by the *query* comparand's
  type.
- **`Eq` / `Ne`** — generalised to all four columns (was Text/Ref only).
- **`Lt` / `Gt` / `Lte` / `Gte`** (`propertyCompareMatches`) — numeric compare
  on a `value_num` comparand, lexical otherwise; the value column is guarded
  `IS NOT NULL` so a row missing that value never spuriously matches (#1280).
- **`Contains` / `StartsWith`** (`propertyLikeMatches`) — SQLite `LIKE` is
  ASCII-case-insensitive and `escape_like` makes the needle literal, so the
  faithful equivalent is an **ASCII-case-insensitive literal substring/prefix**
  test (reusing `asciiLowercase` from `glob-validate.ts`). A `Num` comparand
  short-circuits to no match, mirroring the backend's `1=0` (a numeric column
  has no substring).

Split into small per-predicate helpers to stay under the oxlint complexity cap.

## Conformance lock

Extended the existing `conformance/pages-metadata/tag-property.vectors.json`
(and both asserting tests) rather than adding a new fixture:

- Fixture rows gained `Num` (`score`) and `Date` (`due`) properties; the Rust
  `PropVal` became a typed enum (`Text`/`Ref`/`Num`/`Date`) seeding the matching
  `block_properties` column; the TS seed maps each type to its cell.
- 14 new scenarios cover `Lt`/`Gt`/`Lte`/`Gte` (Num + Date), `Eq`/`Ne` Num,
  `Contains`/`StartsWith` (incl. an ASCII-case-insensitive needle), the
  `IS NOT NULL` guard (a row missing the value), and the `Num`-LIKE
  short-circuit. `Num` values are small exact integers and `Date` values are
  identically-formatted `YYYY-MM-DD`, so numeric/lexical compares agree across
  SQLite and JS (representation-stable).

## Verification

- TS: `tag-property-conformance.test.ts` — 23 scenarios pass (was 9).
- Rust: `pages_tag_property_conformance_matching` — passes (real SQLite query
  path validates the ordered/LIKE/case-insensitive expected sets).
- Broader: `src/lib/tauri-mock` + `src/lib/filters` — 330 pass; `tsgo -b` clean;
  `oxlint` clean.

Closes #1913.
