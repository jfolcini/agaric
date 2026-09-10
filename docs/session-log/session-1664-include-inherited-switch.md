# Session 1664 — the inherited-tag cache gets a reader

#4548: `block_tag_inherited` was maintained on every block write and read by
no production query — every caller of `query_by_tags` / `query_by_tag_expr`
passed `null` for `include_inherited`. Meanwhile the page header's inherited
chip promised "querying this tag also matches descendants", which was true of
no query in the app.

## What shipped

The maintainer's 2026-09-02 comment narrowed the issue to the pill and the
string, and that is the scope here — not the body's `FilterPrimitive` field,
projection arms, popover chip, or seeding preference.

- `TagFilterPanel` has an "Include inherited tags" switch (Radix `Switch` +
  `Label`, `role="switch"`, keyboard-operable, tooltip carrying the two facts
  a user must know: inheritance is transitive and unbounded, and a `#tag`
  typed in text does not propagate). It sits beside the AND/OR/NOT row and
  survives the composer swap, because both IPCs take one flag for the whole
  query. Default off, so an existing query keeps its result set. The feedback
  line says "(including inherited tags)" when on and is `aria-live="polite"`.
- `pageHeader.inheritedTagHint` now says what is true: the Tags view matches
  an inherited tag only with the switch on.
- Feature doc paragraph in `docs/features/tags-and-links.md`.

## What the issue got wrong about the code

The mock does not ignore `includeInherited` (body item 7): `evalTagQuery` in
`src/lib/tauri-mock/handlers/tags.ts` has honoured it since #3827, and the
`tags_include_inherited_reaches_descendant` conformance query already pins
ON-vs-OFF against the backend. So the descendant pair was pinned at every
level below the UI; the only thing unpinned was that the panel never sent
`true`. No Rust, SQL, bindings or mock change was needed.

## Verified

Falsified against copies: hardcoding `false` in the flat call reddened the
ON test and the rejection test; `null` in the composer call reddened the
composer test; restoring the old hint string reddened the `PageTagSection`
title assertion. Full vitest and typecheck green; no `.rs` touched, so the
Rust lanes are unchanged from `main`.
