# Session 1373 — `block_links_unresolved` gets the derived-state machinery its sibling already had (2026-08-22)

| Metadata | Value |
|----------|-------|
| **Date** | 2026-08-22 |
| **Subagents** | orchestrator + one implementation agent (single worktree, `claude/unresolved-derived-state`) |
| **Items closed** | `#4218`, `#4229`, `#4217` |
| **Tests added** | +0 (frontend) / +7 (backend) |
| **Files touched** | 8 source + 4 `.sqlx` caches |

**Summary:** #4210 shipped `block_links_unresolved` (migration `0112`, for #4118) as derived state with none of the surrounding machinery `block_links` already has. Three issues, one shape: a snapshot restore wiped it with no rebuild behind it (#4218), nothing re-derived it to audit for drift (#4229), and the bulk-vs-fold equivalence oracle did not compare it at all (#4217). All three are closed here, with the rule they share stated once and implemented twice — deliberately.

## The rule, and where it now lives

A source **owes** a target when the source is live, its `content` names the target as a `[[ULID]]` / `((ULID))` token, and no `block_links` row carries that edge. That is `sync_unresolved_links`' rule — it too subtracts the post-INSERT `block_links` rows from the parsed token set rather than predicting which offered targets landed.

Deriving against the **stored** edges rather than against a from-content rebuild of `block_links` is what keeps every consumer of the rule inside #4210's approved lifecycle: it records what is owed, and never creates an edge. The rejected vault-wide `rebuild_block_links` stays rejected.

## #4218 — the restore now rebuilds the index in its own transaction

`truncate_block_links` deletes from **both** link tables, and the wipe is correct: the previous vault's pending repairs describe the previous vault's content. Nothing refilled it. The snapshot format carries no rows for the table, `CACHE_TABLES` does not list it (it is wiped by the owner-crate helper instead), and `enqueue_post_snapshot_rebuilds` had no rebuild for it — so a restored vault came up holding the sender's `block_links` and no record of what that edge set was missing. #4118's permanent loss, on every restore.

`agaric_store::cache::rebuild_block_links_unresolved_conn` is the reconstruction, called from `apply_snapshot`'s transaction after the row inserts. Two reasons it is not a post-commit `MaterializeTask` like its sibling caches:

* the enqueue half is **best-effort by design** — every post-snapshot enqueue failure is logged and swallowed so a shutdown-in-progress cannot fault an already-durable restore — so a task would leave the index empty exactly where nothing would notice;
* the paired-edit hazard `restore.rs`'s own doc warns about ("a new cache table still requires paired edits, now in two files instead of one") is precisely what went wrong here. The wipe and the refill now sit in one crate, one transaction, three lines apart.

It also means the restored index is **better** than a reindex-driven one: a token whose target is linkable but whose edge the snapshot did not carry (the sender's own pre-#4118 loss) comes back as an obligation, and the existing push half discharges it the next time that target is reindexed.

## #4229 — the obligation index has an auditor

`reconcile_block_links_unresolved`, artefact 7, in the scheduled/directed lane like its sibling and for the same three reasons. A separate entry point from `block_links_reconciliation_failure`, not another arm inside it: the two artefacts answer different questions and can legitimately disagree with the world in opposite directions at once — a vault mid-repair has a MISSING edge **and** a correct obligation — so merging the reports would make each one's fixtures noise for the other.

One MISSING window is this artefact's alone and is enumerated on it rather than left to be discovered in a triage: a `PurgeBlock` of a linked target cascades the `block_links` edge away while the referrer's content still names the token, and no purge arm reindexes the referrer — so the debt becomes real with nothing recording it, on a vault where every writer behaved correctly. `reconcile_block_links` does not share it (its expected side requires the target to exist), and this one cannot borrow that escape: an obligation whose target is absent IS #4118 case 1. Verified against the sibling — the sibling reports nothing, this one reports one row.

Both arms are scoped to what production actually implements. MISSING is live-scoped on the source; EXTRA is deliberately **not**, because no delete arm enqueues `ReindexBlockLinks`, so a tombstoned source's rows survive by design and an arm that reported them would redden on every ordinary block deletion and be muted within a week. EXTRA covers both of `sync_unresolved_links`' DELETE clauses — the content no longer names the target, and `block_links` now carries the edge — with distinct reasons, because covering one would leave the other's divergence invisible.

## #4217 — the equivalence oracle compares it

A seventh `read_table` in `DbSnapshot`. The issue flagged a real hazard first: the set is recomputed per source on every reindex rather than accumulated, so two arms reindexing in different orders could hold the same set with different row identities, and an identity-keyed comparison would report a divergence that is not one.

**It does not apply, for a reason specific to this table rather than to the reader.** `diff_tables` compares a `BTreeMap` keyed on the KEY COLUMNS, not two ordered `Vec`s — the `ORDER BY` is for readable failure output and shuffling it cannot change the comparison — and the key columns here are the whole row (`PRIMARY KEY (source_id, target_id)`, no other column, no exposed rowid). "Row identity" and "set membership" are the same thing, so normalising to a set is what the differ already does. What can legitimately differ is the SET, and only when the arms did different work, which is the divergence class the oracle exists to catch.

## What was unified and what was kept apart

**Unified:** one production routine, `rebuild_block_links_unresolved{,_conn}`, in the table's owner crate. The snapshot RESET calls the connection-scoped form; the oracle's `settle_block_links_unresolved` calls the pool-scoped one.

**Kept apart, deliberately:** the oracle's expected side is an independent Rust transcription (`fold_block_links_unresolved`), not a call to that routine. This module's whole doctrine is that an artefact derived by calling production audits nothing — it would go green on its own bug. The two derivations meet in exactly one place, and it is an assertion: the central #4229 test erases an obligation, watches the artefact report it, settles with **production's** vault-wide rebuild, and asserts the artefact goes clean. That pins the two against each other without collapsing them.

## Falsification

Each central test was shown RED against a reverted production change before being trusted:

* #4218 — deleting the `rebuild_block_links_unresolved_conn` call from `apply_snapshot` leaves the restored vault owing nothing (`left: []`);
* #4229 — neutering the MISSING arm reddens the central test at "oracle must report the unrecorded obligations"; neutering the EXTRA arm reddens the second at "oracle must report the un-named debt";
* #4217 — restoring the six-table `DbSnapshot` reports zero divergences for two arms that genuinely differ.

## Notes

* No schema change, and no new op type, task kind or queue. #4210's approval covers the table as shipped and explicitly does not pre-approve widening its **lifecycle** — and a vault-wide recompute is, on its face, exactly that, so it needs its own authority rather than an appeal to "nothing changed". It has one: #4218's own text rules the vault-wide derivation back IN for a restore trigger (*"Rejecting it as the trigger for 'a target became linkable' does not rule it out as a restore-time reconstruction… Option 1 looks right"*), and #4229 asks for that derivation to be shared rather than written twice. The stated growth bound survives: this function's output is the union of what `sync_unresolved_links` would produce per source over the same content and the same edges, so it cannot write a row a reindex of that source would not. `_conn` has exactly one production caller (the RESET); the pool form has none — it is the #4229 oracle's settle.
* Two new `sqlx::query!` sites in `agaric-store`, so all four `.sqlx` caches were regenerated with `just gen-sqlx` — not a bare `cargo sqlx prepare`, which is the #4210 review's finding.
* `check-table-ownership.py`, `check-dynamic-sql.py`, `check-raw-tx.py`, `check-bulk-equivalence.mjs`, `check-metric-provable.mjs` and the citation guards all clean; no baseline was re-anchored.
