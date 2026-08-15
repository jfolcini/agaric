# Session 1314

## The cursor that mirrors the engine

#3900 and #3899 are two divergences in the mock's `run_advanced_query` cursor. The issue
proposed a fix. The fix that shipped is not the one it proposed, and the reason is worth
recording, because "the issue said to" is not a justification.

### What the issue proposed

Stamp a sort discriminator into the cursor and reject a mismatch, the way
`list_pages_with_metadata`'s cursor already stamps a `position` and validates it. That
would also give #3899 — the silent restart on a malformed cursor — a natural place to
raise from.

### Why it was not done

Because the engine does not do that. Reading `agaric-store/src/query/engine.rs`:

- `QueryCursor::decode` (`:180-195`) validates base64 → UTF-8 → JSON → version, in that
  order, each with its own `AppError::Validation`. There is no discriminator and no
  cross-sort check anywhere in it.
- `keyset_predicate` (`:417-442`) reads `cursor.values[i]` **positionally** against the
  *current* request's `terms[i]`. It never resolves an anchor row by id.

Adding a discriminator would have made the mock *stricter* than the thing it stands in
for. The mock's whole purpose is to diverge from the backend as little as possible, so a
fix that invents a validation the backend does not perform is a new divergence wearing a
fix's clothes.

The issue text actually contains the answer already — it says the engine "rebuilds the
keyset predicate from the full tuple positionally". The prescription and the diagnosis in
the same issue pointed different directions, and the diagnosis was right.

### What shipped

`compareEntryToCursor`: a positional, lexicographic comparison against the resolved sort
terms, replacing the `idTermIndex` anchor-row lookup. A cursor minted under a different
sort now degrades exactly the way the engine degrades — a deterministic, possibly-wrong
page — instead of silently restarting from row 0 and re-delivering rows.

`decodeCursor` now throws `validationRejection` on malformed, foreign, or version-stale
input, mirroring the engine's four distinct failure modes. That is where #3899 landed:
off the decode, not off a discriminator that does not exist.

### The claim that had to be checked

"Mathematically equivalent to the engine's OR-of-AND keyset predicate" is the load-bearing
claim of the whole change, and lexicographic tuple comparison and an OR-of-AND keyset
predicate are equivalent only under conditions. So it was checked rather than asserted:
NULLS-LAST handling traced through both implementations (both treat NULL as unconditionally
greatest regardless of direction), then a brute-force differential over 500,000 random
cases — nulls, ties, mixed ASC/DESC — comparing lexicographic compare against an explicit
OR-of-AND expansion. Zero mismatches.

One real divergence surfaced from that trace and is recorded rather than fixed: the engine's
`strict_clause` carries a `RANK_EPSILON = 1e-9` band for the FTS `bm25` term, to absorb
SQLite float drift. The mock has no band. It is harmless here because `approximateFtsRank`
is a pure deterministic function of `(content, foldedQuery)`, so re-encoding is
bit-identical — there is no drift to absorb.

### What the differential run could not see

The 500,000-case differential compared lexicographic compare against an OR-of-AND
expansion — two ways of consuming the *same* pair of values. Review found the defect that
sits underneath both: the two sides were not being handed the same value.

`cursorValueFor` is not injective. `LastEditedMs` encodes the getter's `''`
("no op-log activity") to the engine's `Int(0)`, and `Rank` encodes a non-finite rank to
`Null` — both deliberate, both with an engine citation. The resume then decoded those tags
back into raw sort values (`0`, `null`) and compared them against what the getter returns
(`''`, `Infinity`). Neither comes back equal, so a boundary row did not compare equal to
the cursor minted from it — and that equality is the one property a lexicographic keyset
resume actually needs.

The two halves of the failure look nothing alike, which is why the suite missed it. ASC:
every tied sentinel row compares "before the cursor", so the resume runs past all of them
and rows are silently dropped. DESC: the same comparison flips to "after", so the anchor
row re-selects itself and a `while (hasMore)` client never terminates. A fixture with ONE
never-edited row is immune to both.

The fix is to stop requiring an inverse. `compareEntryToCursor` now encodes the ENTRY
through `cursorValueFor` too and compares tagged `CursorValue`s (`compareCursorValue`),
applying the same NULLS-LAST-then-`desc` rule one domain up. Applying the encode to both
operands rather than undoing it on one closes the whole class — `Rank`'s latent case went
green with the same change, without a line about `Rank` in it.

The invariant is now pinned directly, per `CursorKind` and in both directions, through
`JSON.stringify` (the wire is part of the round trip — `Infinity` dies there, not in the
tagging). The case table is a `Record<CursorKind, …>`, so a seventh kind fails to compile
until it has a case.

Also from that review: `decodeCursor` claimed parity with all four of `QueryCursor::decode`'s
failure modes, but a default `TextDecoder` is non-fatal — it substitutes U+FFFD instead of
throwing, so a cursor with ill-formed UTF-8 bytes that still parsed as JSON was accepted
where `String::from_utf8` rejects. `base64UrlToUtf8` grew an opt-in `fatal` flag rather than
a changed default: its two other callers are deliberately lenient, and the doc was the
thing that was wrong about this call site, not about theirs.

### The fix that broke the rule it was written to enforce

Round three found that the round-two fix introduced a crash. `compareCursorValue` reaches
`isNullCursorValue`, which tested `v === undefined` — and `undefined` does not cover
`null`. A cursor of `{"version":1,"values":[null]}` decoded cleanly (an object, `values` is
an array, version 1), then `null.t` threw a raw `TypeError`. `dispatch` wraps handlers in
no try/catch, so it left the IPC boundary as a crash where the #2463 kind-parity rule
requires an `AppError`-shaped rejection — broken by the change written to enforce it, and
contradicting the function's own doc, which promises "never a crash". Pre-diff the same
cursor was benign: `anchorValue?.t` optional-chained away and the query restarted at row 0.

`return v == null || …` fixes the crash and leaves the cause. The cause is that
`compareEntryToCursor` takes `ReadonlyArray<CursorValue>` while `decodeCursor` validated
only that `values` **is an array** — a type-level claim about a value that came off a wire
unchecked. The other way that claim was false is quieter and was already shipping:
`{"t":"Int","v":"abc"}` decoded fine, `a.v - b.v` is `NaN`, no `findIndex` predicate ever
holds, and the caller gets a silently EMPTY page where serde returns
`AppError::Validation` — the mock being *more permissive* than the thing it stands in for,
which is the divergence class #3899 exists to close, one level below the four envelope
modes it enumerated.

So the elements are validated in `decodeCursor` — tag known, payload type matching the tag
(`Int` must be integral, as serde's `i64` requires; `Real` accepts a JSON integer, as
serde's `f64` does) — and rejected there with the engine's own `invalid cursor JSON:`
prefix. `isNullCursorValue` still handles `null` anyway. Defence in depth is the right
trade when the alternative failure is an uncaught `TypeError` crossing an IPC boundary.

The rejection messages are now fixed strings. `describeError` spliced the host runtime's
message in, so bad base64 read "The string to be decoded contains invalid characters"
under jsdom and something else under Node, matching `QueryCursor::decode`'s wording in
neither. Each message keeps the engine's prefix — that is the part that names *which* of
the four modes fired — with a fixed suffix of our own. Distinguishing the first mode from
the second also needed the base64 alphabet checked before the decode call rather than after
it, because one combined call cannot tell them apart, and sniffing the exception type
(`DOMException` vs `TypeError`) would have re-introduced the host-dependence in a new place.

### The unreachability that turned load-bearing

`cursorValueFor` tags a non-finite rank as `Null`, and that tag *disagrees* with how
`compareSortValue` orders the raw value under `Relevance DESC`: `Infinity` is a number
there and the `desc` flip sorts it first, while `Null` is NULLS-LAST in both directions and
sorts last. A row in that state compares before the cursor minted from it, `findIndex`
returns 0, and every page re-delivers the whole set.

It is unreachable — but only because `run_advanced_query` narrows with
`matchesSearchFolded(content, fulltext)` and ranks with
`approximateFtsRank(content, foldForSearch(fulltext))`: the same haystack, the same
`foldForSearch`, the same folded needle, so `includes` being true means `split` finds at
least one occurrence. That is a coupling to `fold-for-search.ts`, a module whose own tests
have no idea it is holding up a keyset invariant. It is now asserted — as a property over a
corpus where folding actually does something (`ß` → `ss` changes length, `İ` decomposes, a
lone combining mark folds to the empty string, which is why the `foldedQuery === ''` branch
is on the reachable path and must return a finite length) — plus an end-to-end
`Relevance DESC` walk that terminates. Breaking the coupling in either half turns both red.

### Left open deliberately

The `groupBy` branch returns early for a non-null cursor without ever calling
`decodeCursor`, so a malformed cursor on a grouped query is still silently accepted. That
path is a stub — it does not implement grouped pagination at all yet — so this is not a
regression this change introduced, and #3899 is scoped to the flat keyset path. Filed as
#3917 rather than left implied by the `Closes` line.
