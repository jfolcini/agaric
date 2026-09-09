# Session 1645 — the link graph was three quarters empty on a real vault

The #4886 integrity check ran against the maintainer's actual vault for the
first time and reported 495 divergences. 464 of them were one defect.

## What the report said, and whether to believe it

495 over 1590 blocks, in three artefacts: `fts_blocks.row` 31,
`block_links.row` 230, `block_links_unresolved.row` 234.

A first real-vault run is exactly where a new oracle earns or loses its
credibility, so the report was checked against the vault rather than acted on.
Deriving the expected edge set independently — the production regex,
`(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))`, over live block content — gives 315
tokens against 81 rows in `block_links`: **234 missing, of which 230 have a
live, same-space target**. Those are the oracle's two numbers, to the row, from
a derivation that shares no code with it.

The oracle is right.

## What the user loses

Backlinks. `page_link_cache` and `pages_cache.inbound_link_count` both roll up
from `block_links`, so the hole propagates: 196 of 270 page-link edges were
missing across **130 pages**. A block reading `Spoke with [[…]]`, written in
April, pointed at a live page whose backlink panel did not list it.

## Root cause: nothing has ever derived `block_links` vault-wide

It is maintained only incrementally, by `reindex_block_links` on the write
paths. Migration 0001 creates the table empty, 0061 rebuilds it only to add FK
cascades, `db/recovery/` does not touch it, and there is no
`rebuild_block_links` behind the per-block reindexer the way
`rebuild_block_links_unresolved` sits behind `sync_unresolved_links`. So every
token written before its block was last re-saved is absent, permanently.

Two independent checks pin that as the mechanism rather than something
deleting rows. The vault's own pre-migration backups go 25 -> 47 -> 81: the
count has only ever grown. And the split is temporal — every stored link's
source block dates from 2026-06-11 or later, every missing one from April to
August. All 230 are same-space, so the cross-space filter is not eating them.

This is #3839's defect one storey down, and the provenance is the interesting
part: migration 0110 backfilled `page_link_cache` *because* 0065 "created the
table with NO backfill" — then rebuilt the rollup from `block_links`, which had
the identical hole underneath. The fix inherited the bug it was fixing.

## The fix

A one-shot, marker-gated backfill (`repair.block_links_backfill.v1`, the
`repair.tag_space_misfiled.v1` pattern) that reindexes every link-bearing block
through `reindex_block_links_conn` and, only if the graph moved, rebuilds
`page_link_cache` and the pages-cache counts. Wired into boot beside the #4729
and #4728 repairs, same contract: best-effort, never boot-fatal, retried next
boot.

Rust rather than a migration, which is where this differs from 0110. That one
could be SQL because it transcribed SQL; the source of truth here is
`ULID_LINK_RE`, which deliberately accepts mixed delimiters (`[[ULID))`).
Hand-writing that in a recursive CTE would be a second implementation of the
tokenizer — the thing `cache/mod.rs`'s shared-regex comment exists to prevent.
Reindexing through the production path means the backfill cannot disagree with
the incremental writer about what a link is.

The candidate prefilter is `content LIKE '%[[%' OR content LIKE '%((%'`. It is
not a tokenizer and only has to be a superset: every match of `ULID_LINK_RE`
opens with one of those two pairs.

Gated to run once for the same reason the tag-space repair is. A block whose
tokens are all cross-space or self-referential legitimately produces no row, so
"has tokens but no edges" cannot tell a hole from a converged vault, and there
is no cheap precondition. The damage is historical. A regression that
reintroduces holes is caught by the oracle — which is how this one surfaced.

## Verification

Three tests, each falsified separately against a `cp` backup, restored and
`cmp`-checked:

- deleting the two rollup rebuilds reddens **only** the `page_link_cache`
  assertion, which is what proves `reindex_block_links_conn` does not maintain
  the rollup and the explicit rebuild is load-bearing;
- deleting the marker write reddens **only** the one-shot test (`left: 1,
  right: 0`).

Then against a copy of the real vault, through the production function:
`block_links` 81 -> 311, `block_links_unresolved` 0 -> 4, `page_link_cache`
74 -> 270, pages with backlinks 61 -> 176. `ADDED=230`, matching the oracle's
count and the independent derivation.

The maintainer's live vault was then repaired with the same call, with a
backup taken first, and verified from a fresh read-only snapshot: 1590 blocks
unchanged, 311 links, and the April block's edge present.

## Filed, not fixed here

- **#4903** — the class. Every derived table is incrementally maintained with
  no vault-wide backfill, so each keeps whatever it missed before its handler
  landed, and no test can see it: a fresh test vault has no history and is
  complete by construction. The oracle's 21-artefact table is the audit input.
- **#4904** — the `fts_blocks` 31. All are rows for soft-deleted blocks,
  predating `remove_deleted_cohort_fts` (#4733). Not user-visible — search
  joins `blocks` and filters `deleted_at IS NULL` — but either the sweep or
  the oracle's expectation is wrong, and today they disagree.
