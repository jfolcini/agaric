# Session 1780 — the mock's string ordering, against SQLite's

`#5093` fixed one site: the mock sorted spaces by locale where the backend
sorts binary. That was never going to be the only one. This sweep went through
every ordering and case-fold in `src/lib/tauri-mock/`, matched each against the
backend clause it stands in for, and pinned what a fixture can reach.

Two rules decide every case. SQLite `BINARY` is a **UTF-8 byte** compare, not a
UTF-16 code-unit one. `COLLATE NOCASE` folds **ASCII only**, so it is not
`toLowerCase()`.

## The helper that was already there

The brief for this work named `compareBinary` in `handlers/shared.ts` as the
reference, and asked for a `compareNoCase` beside it. Both premises were wrong.
`src/lib/sqlite-collation.ts` already exports `compareUtf8Bytes`,
`compareNocase` and `foldAsciiUppercase`, and `shared.ts` already imported two
of them for `compareMetaRows`. `compareBinary` — `a < b ? -1 : a > b ? 1 : 0`
— was a second, weaker spelling of `compareUtf8Bytes`, right for the BMP and
wrong the moment an astral character appears. It is deleted, its five call
sites point at the faithful helper, and no third helper was added.

The codebase already did it; that is where the ladder stops.

## What is pinned, and by what

Twelve sites are now driven by a conformance fixture with a backend-authored
`expected`, each shown red by reverting its handler to the `localeCompare` /
`toLowerCase` / code-unit spelling and watching one named fixture fail. The
seeds discriminate deliberately: `Ärger` against `ärger` (ASCII folding keeps
them apart), `Öl` against `ärger` (an ASCII fold ranks `Ö` first, a Unicode
fold reverses the pair), and halfwidth katakana `ｱ` against the apple emoji
(bytes rank the katakana first, code units the apple). Every probe is seeded so
the wrong answer coincides with insertion order, which means a handler that
dropped its sort entirely is red too.

Four more sites are real and reachable but live in fixtures outside the five
this change touches, so they keep a unit test: the advanced-query title sort,
the backlink text filter, the filtered-blocks tag prefix, and `list_spaces`.
The test file says so in its header rather than implying the sweep pinned
everything.

## Two pins deliberately not written

`list_property_keys` and `list_property_definitions` order property keys, and
the backend validates those keys as `is_ascii_alphanumeric() || '-' || '_'` in
both `append_local_op` and `create_property_def_inner`. Within `[A-Za-z0-9_-]`
UTF-8 bytes and UTF-16 code units are identical, so the comparator change there
cannot diverge through any path a user can drive. A fixture would have gone
green while proving nothing, which is the outcome this harness exists to
prevent.

The same fact retired a test. A parity probe asserting the key tiebreak over
`🍎` and `ｱ` was pinning mock behaviour over input the backend refuses — a
state no user reaches — so it went with the nine that fixtures now cover. The
file is 14 probes down to 4.

## The formatting step the update needs

`CONFORMANCE_UPDATE=1` writes `expected` blocks with
`serde_json::to_string_pretty`, which expands short arrays across lines; the
committed form is oxfmt's, which collapses them. Straight after an update run
the diff was 59 files and 1522 insertions, 54 of them fixtures nobody had
touched. `npx oxfmt --write conformance/fixtures/` takes it back to exactly the
intended files with no content change anywhere else. The churn is formatting,
not corruption, and the answer is the formatter rather than a revert.

## Two more, fixed on evidence

Three further divergences were reported and left on the grounds that nothing
pinned them. Two of the three have a concrete failing input, which is the bar a
finding has to clear, so they are fixed rather than carried.

`textCompare`'s ordered arms in `links.ts` folded for `Contains` and
`StartsWith` while comparing with a raw `<` four lines above, and
`compareProperty` in `shared.ts` did the same. A stored `ア`-width katakana
against a comparand `🍎` makes `Lt` answer the opposite of SQLite. Both
go through `compareUtf8Bytes` now; `compareProperty` splits on type first,
because its numeric arm must stay numeric.

`list_page_aliases_by_prefix` sorted on `x[1].length`, where SQLite's `length()`
counts characters and JS counts UTF-16 units: an alias of three characters
containing an astral one measures four, so it tied with a four-character alias
instead of leading it, and the `[[` picker ordered differently in dev and e2e
than in the app. `Array.from` counts code points instead — not a spread, which
oxlint refuses on a string for splitting grapheme clusters, a unit SQLite does
not count either.

Review then caught that the fix was unfalsifiable: the existing length step uses
same-length aliases on purpose, so reverting it left the suite green. It now has
a step of its own over `z-🍎` (three characters, four units) against `z-ab`
(four and four) — the one place the fixture confounds length with collation
deliberately, because the length key is what it exists to pin. Seeded
wrong-answer-first, so a dropped sort reddens too.

`compareSortKeys` in `blocks.ts` stays. It compares by code unit where the
backend's `cmp_group` is a Rust byte compare, but fixing it means replacing the
titleless-sorts-last sentinel too: under byte ordering no string sorts above
every string, so that group needs a null-aware comparator instead. A design
call, not a one-line change.

## And one the sweep had left behind itself

`foldAsciiUppercase` in `sqlite-collation.ts` and `asciiLowercase` in
`search-query/glob-validate.ts` were the same function, character for
character, and `handlers/shared.ts` ended up importing both. A change whose
whole point is deleting a second spelling of a comparator had left a second
spelling of a fold standing. There is one now, and the test that guarded the
deleted one — `CAFÉ` folding to `cafÉ`, ASCII only — guards the survivor.

## Verified

Full vitest, 837 files and 19,267 tests. Typecheck clean. The conformance
fixture test passes *without* `CONFORMANCE_UPDATE`, which is what establishes
that every `expected` block equals what the backend produces now rather than
what someone typed.
