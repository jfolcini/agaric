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

That is the rung the ladder stops at, and the sweep nearly walked past it.

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

## Three divergences found and left

Named here because they are real, not because they are queued.

`compareSortKeys` in `blocks.ts` compares by code unit where the backend's
`cmp_group` is a Rust byte compare. Fixing it means replacing the
`TITLELESS_SORTS_LAST = '￿'` sentinel as well: under byte ordering no
string sorts above every string, so the titleless group needs a null-aware
comparator instead. That is a design call, not a one-line change.

`textCompare`'s ordered arms in `links.ts` and `compareProperty` in `shared.ts`
use inline `<` / `>` where SQLite compares bytes. Same astral-versus-`U+E000`
class, on predicates nothing pins.

`list_page_aliases_by_prefix` sorts on `x[1].length` where SQLite's `length()`
counts characters, not UTF-16 units, so an emoji in an alias reorders the
picker. A real divergence, and not a collation one — the fixture uses a
same-length pair to avoid confounding the two.

## Verified

Full vitest, 837 files and 19,267 tests. Typecheck clean. The conformance
fixture test passes *without* `CONFORMANCE_UPDATE`, which is what establishes
that every `expected` block equals what the backend produces now rather than
what someone typed.
