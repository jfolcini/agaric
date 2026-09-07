# Session 1582 — the `tags_cache` reconciliation oracle (#3345)

## What

Artefact 9. `tags_cache` now reconciles against a from-base fold, in both
directions, with its own banner so a failure is never mistaken for a sibling
artefact's.

This is the third of the four #3345 rows that #4679 unblocked, and it builds
directly on Artefact 8 (#4823): `usage_count` counts the union of `block_tags`
and `block_tag_refs`, and the second of those now has an oracle of its own.

## What the fold transcribes

From `DESIRED_TAGS_SQL` (`agaric-store/src/cache/tags.rs`), folded in Rust
rather than re-expressed as SQL so it is an independent recomputation:

- a row per LIVE `block_type = 'tag'` block with NON-NULL content — a
  NULL-content tag gets no row at all;
- `usage_count` is `COUNT(*)` over a `UNION` — not `UNION ALL`, so distinct
  `(tag, source)` pairs — of the explicit and inline arms, each keeping only
  pairs whose SOURCE block is live;
- an unused tag still gets a row, via the `LEFT JOIN` + `COALESCE(…, 0)`;
- duplicate names collapse (#626): among live tags sharing a name only the
  smallest `id` survives, because `tags_cache.name` is UNIQUE while
  `blocks.content` is not.

## The one that is easy to get subtly wrong

Identity is `normalize_tag_name` — NFC → full-Unicode lowercase → NFC — and NOT
`COLLATE NOCASE`. SQLite folds ASCII only, so `#Σ` and `#σ` were merged by the
Loro sync engine (which keys its tag map on the same normalisation) yet SPLIT
into two cache rows, colliding on `UNIQUE(name)` forever. That is #1990, and a
fixture built from ASCII case-variants alone cannot tell the two rules apart.
So the fixture's duplicate pair is `Σigma` / `σigma`, and the test asserts the
pair really is a non-ASCII case variant, so it cannot silently decay into an
ASCII one that proves nothing.

## Reading `block_tag_refs` as STORED, not re-derived

The fold reads the `block_tag_refs` table rather than re-deriving it from
content, even though Artefact 8 supplies that derivation. Layering is the
point: each artefact audits one derivation step, so a stale inline-ref row is
reported against the table that owns it instead of being misattributed to this
roll-up.

## Falsification

Each mutated against a copy, run, restored, `cmp`-verified:

- tie-break reversed (largest id wins) → both tests redden.
- source-liveness filter dropped → the count assertion reddens, naming the
  `UNION`-vs-`UNION ALL` claim.

## Left on #3345

`agenda_cache` and `projected_agenda_cache`. Both unblocked by #4679; both
share the `date_column_rows` non-vacuity counter that #4679 added for them.
