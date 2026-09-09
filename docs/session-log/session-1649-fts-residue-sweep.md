# Session 1649 — the 31 rows that taught the reader to skim

`fts_blocks` carried 31 rows for soft-deleted blocks on the maintainer's real
vault, found by the first real-vault run of the #4886 integrity check.

## The decision the issue asked for

Two answers were open and #4904 required picking one out loud.

Keeping the rows is defensible on its own terms: a restore then needs no
reindexing. But it is not the trade this codebase made. #4733 chose to remove
on delete and re-index on restore, and the oracle's Artefact 8 already states
that rule without a carve-out. Scoping the oracle to live blocks would have
made the check agree with the residue rather than with production.

So: sweep. The rows are unreachable either way — every search read inner-joins
`blocks` and filters `deleted_at IS NULL` — so the real cost is trigram index
size, skewed bm25 statistics, and a permanently noisy integrity report. The
maintainer's first run had 495 divergences of which 31 were this, and telling
them apart from the 464 that mattered took an investigation. A check whose
divergences nobody acts on is a check nobody reads.

## Why nothing already reached them

`RebuildFtsIndex` clears the table and re-derives it, which would sweep them.
It is a member of neither `FULL_CACHE_REBUILD_TASKS` nor any boot path a real
vault hits: boot enqueues it only when `fts_blocks` is ENTIRELY empty, and a
vault carrying residue is by definition not empty.

## The fix

Migration `0118`, one DELETE, the predicate transcribed from
`rebuild_fts_index_from_base`'s membership rule — a block owes a row when it is
live and its content is not NULL. Pure SQL, so no Rust repair was needed; the
`block_links` backfill needed Rust only because it needs the ULID tokenizer.

The test the issue also asked for — that a soft-delete leaves nothing behind —
already exists: `delete_block_inner_de_indexes_the_whole_cohort_4733` and its
five siblings. The gap was the history, not the path.

## Verification

Three mutations of the migration, each red on the arm it breaks, `cmp`-restored
after every one:

- drop the liveness clause — the tombstoned row survives;
- drop the content clause — the content-NULL row survives;
- sweep unconditionally — the live rows go too.

The third is the one that matters: an assertion that only counted what went
away would have waved it through.

Closes #4904.
