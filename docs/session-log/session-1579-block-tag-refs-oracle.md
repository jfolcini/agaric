# Session 1579 — the `block_tag_refs` reconciliation oracle (#3345)

## Why this one, now

#3345's checklist listed `block_tag_refs` as blocked on #4679 ("generator emits
no tag refs"). #4679 closed on 2026-09-07: `prepare_chain_b5` now retains
`AddTag`/`RemoveTag`, `PROP_KEYS` carries `scheduled_date` and the space key,
and `OracleCoverage` already counts `block_tag_edges` for exactly this artefact.
Two other rows of that checklist were also stale — `fts_blocks` landed in
#4735 and `blocks.space_id` in #4817. That is recorded on the issue.

## Shape

Artefact 8, built to the pattern `block_links` (#3955) established, because
`block_tag_refs` is the same kind of thing: a base table whose rows are a pure
function of `blocks.content`, maintained by per-block reindexers with no
vault-wide repair behind them.

- `ORACLE_TAG_TOKEN_RE` is an independent copy of production's `TAG_REF_RE`,
  pinned against it over a corpus by `oracle_tag_grammar_matches_production_3345`.
  Copying rather than importing is what makes this a recomputation instead of a
  tautology; the corpus test is what stops the copy drifting silently.
- `fold_block_tag_refs_from_content` applies the four filters production's
  INSERT applies, and the fixture arms every one of them with a token that must
  fail it.
- `reconcile_block_tag_refs` has the MISSING and EXTRA arms, and reports under
  its own banner so a failure is never mistaken for a roll-up artefact's.

## The two things worth getting right

**The space check is asymmetric, and deliberately so.** Production's INSERT
resolves the SOURCE's space through `resolve_block_space` (own column, else the
owning page's) and compares it against the TAG's RAW `blocks.space_id`, with no
owning-page fallback on that side. An oracle that resolved both sides the same
way would be describing a production that does not exist. The fixture carries
`BTR_TAG_PENDING` — a tag whose own `space_id` is NULL under a page that IS in
the space — purely so that the symmetric version is a red test rather than a
plausible-looking refactor.

**The liveness scope is a departure, and deliberately so.** Production reads
`... WHERE deleted_at IS NULL` and treats a missing row as empty content, so its
rule for a tombstoned source is "every row must go". But `ReindexBlockTagRefs`
is enqueued only by the `CreateBlock` and `EditBlock` arms of
`invalidations_for_op` — no delete arm enqueues it — so a soft-deleted block's
rows survive by design. Transcribing production's read literally would make the
EXTRA arm fire on every ordinary deletion, and an oracle that fires on every
delete gets muted. This is the same call `fold_content_link_targets` documents.

## Falsification

Both claims above were mutated against a copy, run, restored and `cmp`-verified:

- tag space resolved symmetrically through the owning page → the acceptance
  test and the EXTRA-arm test both redden.
- EXTRA arm scoped by liveness (production's literal read) → the tombstoned-
  source test reddens, and only that one.

Each mutant reddened its own test and left the others green, so the three tests
are discriminating rather than merely present.

## Left on #3345

`agenda_cache`, `projected_agenda_cache` and `tags_cache.usage_count`. All three
are now unblocked by #4679; `tags_cache.usage_count` is the natural next one,
since it folds `block_tags ∪ block_tag_refs` and this artefact supplies the
independent derivation of the second half.
