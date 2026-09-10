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

## From review

The feedback line is an `aria-live` region so a screen-reader user hears the
new count when the switch flips. It used to return `null` while loading and
remount with the new text — and a live region inserted together with its
content is not announced. It stays mounted across the refetch now, marked
`aria-busy`. The "(including inherited tags)" fragment also moved to the end
of the sentence, and a `muted` prop that was already the `Label` default is
gone.

## Round three

Keeping the live region mounted across a refetch also mounted it during the
FIRST fetch, where `keepPreviousData` has nothing to hold and `resultCount` is
0: the panel read "0 blocks match 1 tag (AND)" over the skeleton for the whole
round trip. The element now stays mounted and busy but says nothing until it
has a count. A test holds the first `query_by_tags` pending and asserts no
"match" text, then the real count after resolution; removing the gate reddens
it. Also deleted the `not.toHaveAttribute` in `PageTagSection.test.tsx` that
the exact-equality assertion above it made unfalsifiable.

## Round four

The new hint said "a #tag typed in its text is not" inherited. Agaric's inline
trigger is `@`, and a literal `#tag` produces no tag at all, so the caveat
pointed away from the case it warns about: an inline `@` chip lands in
`block_tag_refs`, which the resolver unions but never inherits. Both strings
now say "an inline `@` tag chip". The "(including inherited tags)" fragment is
also gated on `!loading`, so the previous key's count is never shown under the
new label during the switch's round trip.
