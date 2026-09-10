# Session 1663 — the oracle told the next reader there was no backfill

#4903 asked whether each of the reconciliation oracle's derived artefacts has a
vault-wide derivation. The audit answered it — zero open gaps — and in doing so
found that several load-bearing doc comments had become false. Those were never
fixed. This is that.

## What was wrong

Five claims, each verified against the code before being touched:

- the module header table said `block_links`' reindex writers are "the ONLY
  writers; **there is no vault-wide rebuild**";
- `BLOCK_LINKS_OWNER` — the string a user reads in a divergence report — said
  "There is still **NO** vault-wide rebuild_block_links";
- three separate comments said `block_links_unresolved` is "populated by the
  reindexes that run after the upgrade, **not backfilled**";
- `rebuild_fts_index`'s doc said it is invoked "on explicit user request (e.g.
  'rebuild search index')".

The first four stopped being true when #4905 landed `backfill_block_links`, a
marker-gated boot pass that runs `reindex_block_links_conn` over every live
token-bearing block — which fills the unresolved index through the same writer,
because that writer calls `sync_unresolved_links`.

The fifth was never true. There is no such command: the production callers are
boot with an empty index, an inbound sync too large for per-block fan-out, and
engine reprojection. The two `rebuild_fts_index` call sites under `commands/`
are both below a `#[cfg(test)]`.

## Said once, not corrected five times

The full statement lives in `BLOCK_LINKS_OWNER`, where the decision is. The
header row names the arm; the two MISSING arms now state the reason they can
still legitimately fire — the transient window between an edit landing and its
`ReindexBlockLinks` draining — instead of repeating a fact about backfilling.

Deleted rather than rewritten: the "one wholesale wipe went with the snapshot
restore (#4699)" archaeology, which existed only to justify the now-false claim
above it.

## Why this one was worth doing at all

These are the docs on the module every other derivation is checked against. A
reader who believes `block_links` has no vault-wide repair reaches the wrong
conclusion about what a divergence means — and `BLOCK_LINKS_OWNER` is not a
comment, it is the `owner` field printed beside the divergence itself.

Comment-only, plus that one string. 37 reconciliation tests green, clippy
`-D warnings` clean, no bindings regeneration owed (neither file carries a
`#[tauri::command]` or a specta type).
