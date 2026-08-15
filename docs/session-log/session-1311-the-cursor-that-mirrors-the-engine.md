# Session 1311

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

### Left open deliberately

The `groupBy` branch returns early for a non-null cursor without ever calling
`decodeCursor`, so a malformed cursor on a grouped query is still silently accepted. That
path is a stub — it does not implement grouped pagination at all yet — so this is not a
regression this change introduced, and #3899 is scoped to the flat keyset path. Filed
separately rather than left implied by the `Closes` line.
