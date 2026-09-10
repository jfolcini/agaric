use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::collections::HashMap;

use agaric_core::error::AppError;

use crate::db::MAX_SQL_PARAMS;

// ---------------------------------------------------------------------------
// block_links_unresolved (#4118)
// ---------------------------------------------------------------------------

/// The LIVE sources that name `target_id` in their content but have NO
/// `block_links` edge to it — the reverse lookup #4118 exists to provide.
///
/// Soft-deleted sources are excluded (#4286 — see below); the rows they own in
/// `block_links_unresolved` are left in place, only skipped.
///
/// Answered by an index seek on `idx_block_links_unresolved_target`, so it is
/// affordable on the per-block reindex path where every created / edited /
/// page-stamped block asks it once. The overwhelmingly common answer is the
/// empty vec.
///
/// Ordered by `source_id` purely so the repair fan-out is deterministic
/// (test-diffable, and log lines from two runs of the same repair line up).
///
/// # Why LIVE sources only (#4286)
///
/// The rows themselves survive a soft-delete — the FK cascade fires on a row
/// `DELETE`, not on a `deleted_at` stamp — and they are MEANT to (see below).
/// But this function's answer drives a reindex, and reindexing a tombstoned
/// source is actively destructive: `reindex_block_links_conn` reads content as
/// `WHERE id = ? AND deleted_at IS NULL`, sees nothing, treats the block as
/// content-less, and diffs its ENTIRE edge set away — including edges to LIVE,
/// unrelated targets. So restoring or creating ANY block could wipe the link
/// edges of an unrelated block that merely happened to be in the trash while
/// naming it. Nothing about the caller made that reachable; the missing
/// predicate did.
///
/// Filtering here rather than at the call site is deliberate: this is the
/// "who should be re-linked now that `target_id` is linkable?" question, and a
/// tombstoned source is not a candidate for re-linking under the very rule
/// that decides the edge — only a LIVE source owes a target (#4229). A
/// referrer that is later restored gets its own `ReindexBlockLinks` from the
/// restore arm (#4209/#4285), which is where its debt is discharged.
///
/// The rows are NOT deleted, only skipped. `reconciliation_oracle.rs`'s EXTRA
/// arm documents that it is deliberately not liveness-scoped "because no
/// delete arm enqueues `ReindexBlockLinks`, so a tombstoned source's rows
/// survive by design" — it expects exactly these rows to be present, and
/// filtering the *reindex* does not change what it folds.
///
/// # Errors
/// Returns [`AppError`] if the query fails.
pub async fn unresolved_link_sources(
    pool: &SqlitePool,
    target_id: &str,
) -> Result<Vec<String>, AppError> {
    let rows = sqlx::query!(
        "SELECT u.source_id AS \"source_id!\" FROM block_links_unresolved u \
         JOIN blocks b ON b.id = u.source_id \
         WHERE u.target_id = ? AND b.deleted_at IS NULL \
         ORDER BY u.source_id",
        target_id,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|r| r.source_id).collect())
}

/// Bring `source_id`'s rows in `block_links_unresolved` in line with the state
/// the surrounding reindex just committed to `block_links`.
///
/// `new_targets` is every token the source's CURRENT content names;
/// `had_unresolved_rows` is whether the pre-diff read found any row for this
/// source; `all_tokens_already_linked` is `to_insert.is_empty()`.
///
/// # Why `to_insert.is_empty()` is a complete short-circuit
///
/// `to_insert` is every `new_targets` entry absent from `old_targets` or held
/// there under another kind, and `old_targets` is exactly the set of targets
/// that already have a `block_links` row. Empty `to_insert`
/// therefore means every token in the current content is ALREADY linked, so
/// the desired unresolved set is empty and the only work left is dropping
/// stale rows — which is a single source-keyed DELETE, and only when there
/// were rows to drop. A block with no link tokens at all takes this path with
/// `had_unresolved_rows` false and costs zero statements; an edit that leaves
/// an already-fully-linked target set untouched takes it too and costs at
/// most that one DELETE.
///
/// Otherwise — `to_insert` non-empty, i.e. every create or edit that
/// establishes at least one target not already in `block_links` — the
/// recompute is pushed into SQL and reads `block_links` back, rather than
/// being predicted in Rust from `to_insert`: the INSERT is an upsert with an
/// EXISTS guard and a cross-space subquery, so which of the offered targets
/// actually landed is a fact about the database, not something the caller
/// knows. Reading it back is one statement and cannot drift from the filter
/// the way a transcribed prediction would (that drift is what #3903 was). The
/// DELETE and that INSERT both run unconditionally on this path, so it costs
/// two statements even in the all-resolved common case — a target linked for
/// the first time and immediately resolvable — where both are no-ops against
/// `block_links_unresolved`.
async fn sync_unresolved_links(
    conn: &mut sqlx::SqliteConnection,
    source_id: &str,
    new_targets: &HashMap<String, &'static str>,
    had_unresolved_rows: bool,
    all_tokens_already_linked: bool,
) -> Result<(), AppError> {
    if all_tokens_already_linked {
        if had_unresolved_rows {
            sqlx::query!(
                "DELETE FROM block_links_unresolved WHERE source_id = ?",
                source_id,
            )
            .execute(&mut *conn)
            .await?;
        }
        return Ok(());
    }

    let targets: Vec<&String> = new_targets.keys().collect();
    let targets_json = serde_json::to_string(&targets)?;

    // Drop rows the current content no longer names, plus rows whose target
    // the INSERT just linked.
    sqlx::query!(
        "DELETE FROM block_links_unresolved \
         WHERE source_id = ?1 \
           AND (target_id NOT IN (SELECT value FROM json_each(?2)) \
                OR target_id IN (SELECT target_id FROM block_links WHERE source_id = ?1))",
        source_id,
        targets_json,
    )
    .execute(&mut *conn)
    .await?;

    // Record every token the content names that did NOT end up as an edge.
    sqlx::query!(
        "INSERT OR IGNORE INTO block_links_unresolved (source_id, target_id) \
         SELECT ?1, je.value FROM json_each(?2) je \
         WHERE NOT EXISTS ( \
             SELECT 1 FROM block_links WHERE source_id = ?1 AND target_id = je.value)",
        source_id,
        targets_json,
    )
    .execute(&mut *conn)
    .await?;

    Ok(())
}

/// Pairs per chunked INSERT in [`rebuild_block_links_unresolved_conn`].
///
/// The statement binds ONE parameter (a JSON array of `[source, target]`
/// pairs), so `MAX_SQL_PARAMS` does not bind it the way it binds
/// `page_link_cache`'s multi-row VALUES rebuild. What is bounded here is the
/// size of the JSON text handed to `json_each` in a single statement; the
/// divisor mirrors the two-column shape so the constant stays legible next to
/// its sibling rather than being an unexplained round number.
const UNRESOLVED_REBUILD_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499

/// Recompute the WHOLE `block_links_unresolved` table from `blocks.content`
/// and the `block_links` rows that exist right now (#4218).
///
/// Connection-scoped and transaction-less: the caller owns the boundary.
/// That is what let the (#4699-deleted) snapshot RESET call it INSIDE the
/// restore transaction, so
/// the wipe and the reconstruction cannot be separated — see "Why the restore
/// calls this in-transaction" below.
///
/// # The rule, stated once
///
/// A source OWES a target when the source is live, its `content` names the
/// target as a `[[ULID]]` / `((ULID))` token, and no `block_links` row carries
/// that `(source, target)` edge. That is `sync_unresolved_links`'s rule
/// verbatim — it too subtracts the post-INSERT `block_links` rows from the
/// parsed token set — evaluated for every source at once instead of for the
/// one source a reindex just touched.
///
/// Deriving against the STORED edges rather than against a from-content
/// rebuild of `block_links` is deliberate and is what keeps this function
/// inside #4210's approved lifecycle. It records what is owed; it never
/// creates an edge. A vault-wide `rebuild_block_links` was rejected by #4118 /
/// #4210 as the primary mechanism and this is not a re-litigation of that: a
/// token whose target IS linkable but whose edge the snapshot did not carry
/// (the sender's own pre-#4118 loss) comes back as an OBLIGATION, and the
/// existing `ReindexBlockLinks` push half discharges it the next time that
/// target is reindexed. The repair stays where #4210 put it.
///
/// # Where the authority for a vault-wide arm comes from
///
/// Worth stating explicitly, because "no schema change" answers only half of
/// it. #4118's approval comment scopes itself to the table as shipped and adds
/// that it "does not pre-approve widening its schema or its LIFECYCLE; that is
/// a fresh decision" — and a vault-wide recompute is, on its face, a new
/// lifecycle event for a table whose growth bound was stated as "recomputed
/// per source on every reindex".
///
/// The fresh decision exists and is #4218's own text: *"Rejecting it as the
/// trigger for 'a target became linkable' does not rule it out as a
/// restore-time reconstruction, where a lifecycle trigger is exactly the right
/// shape… Option 1 looks right."* #4229 then asks for the re-derivation to be
/// shared rather than written twice. So the widening is the thing that was
/// asked for, not a side effect of answering it.
///
/// The bound survives the widening, which is why the two are compatible: this
/// function's output is the UNION of what `sync_unresolved_links` would
/// produce for each source over the same content and the same edges — same
/// rule, same wipe-then-recompute shape, evaluated for every source instead of
/// one — so it cannot put a row in the table that a reindex of that source
/// would not. What it changes is WHEN, not HOW MUCH.
///
/// No production path calls this since the snapshot RESET went (#4699): the
/// pool form below is the reconciliation oracle's settle (#4229) and the #4218
/// store test's subject. No new task kind, no new queue, no periodic trigger.
///
/// Returns the number of obligation rows written.
///
/// # Errors
/// Returns [`AppError`] if the wipe, the content scan, or any chunked INSERT
/// fails.
pub(crate) async fn rebuild_block_links_unresolved_conn(
    conn: &mut sqlx::SqliteConnection,
) -> Result<u64, AppError> {
    sqlx::query!("DELETE FROM block_links_unresolved")
        .execute(&mut *conn)
        .await?;

    // Live sources only: `reindex_block_links_conn` reads content `WHERE
    // deleted_at IS NULL` and a reindex of a tombstoned source clears its rows,
    // so a tombstone owes nothing. The `LIKE` pre-filter is a strict superset
    // of the grammar — EVERY token `ulid_link_re` can match begins with `[[`
    // or `((` — so it can only skip rows the regex would have found nothing in.
    // (`[` and `(` carry no special meaning in SQLite's LIKE; only `%` and `_`
    // do.)
    // Streamed rather than `fetch_all` (#4242): the decoded `SnapshotData` this
    // is called from restore is still alive for the caller's whole transaction,
    // so buffering every matched row's `content` into a `Vec` up front would
    // roughly double peak content residency at the one moment the vault is
    // largest. Each row is reduced to its `(source, target)` pairs and then
    // dropped, so peak residency here is O(pairs) rather than O(matched
    // content) — measured to matter (#4242): the ABSOLUTE gap grows with block
    // count (below the measurement's noise floor at 20k, ~8 MB at 50k, ~16 MB
    // at 100k) because it is content bytes while the rest of the transaction
    // is closer to fixed per-row overhead.
    //
    // Read the absolute figures, not a percentage. The ~14% quoted in the
    // measurement is a share of the REBUILD's own peak: that arm runs in a
    // transaction of its own, with no decoded `SnapshotData` alive. On the
    // restore path the denominator is larger, so the same megabytes are a
    // smaller fraction — the absolute saving transfers, the ratio does not.
    //
    // Those numbers are not a one-off diagnostic that was thrown away: they
    // come from the `#[ignore]`d `..._residency_at_{20k,50k,100k}_blocks_4242`
    // tests in this crate's `cache::tests`, which re-run the comparison —
    // this streamed fold against a faithful copy of the pre-#4242 buffered
    // one — in the weekly deep-checks lane and print the current figures.
    // They also pin the property this rewrite had to preserve — but only on
    // the path their own fixture walks, which is narrower than the sentence
    // that used to stand here claimed (#4291 corrected the copy in
    // `cache::tests`; #4292 this one). That fixture leaves `block_links`
    // empty, so the `NOT EXISTS` clause below discharges nothing, and gives
    // every seeded source exactly one token, so the dedup below removes
    // nothing. What they pin is that the two folds agree on the PLAIN path.
    // The other two answers are pinned elsewhere:
    // `rebuild_block_links_unresolved_recomputes_the_whole_vault_4218` for
    // discharge against a real edge, and
    // `rebuild_block_links_unresolved_dedups_a_repeated_token_4292` for a
    // source that names one target more than once.
    let mut pairs: Vec<(String, String)> = Vec::new();
    {
        let mut rows = sqlx::query!(
            "SELECT id, content FROM blocks \
             WHERE deleted_at IS NULL AND content IS NOT NULL \
               AND (content LIKE '%[[%' OR content LIKE '%((%')",
        )
        .fetch(&mut *conn);
        while let Some(row) = rows.try_next().await? {
            let content = row.content.unwrap_or_default();
            for cap in super::ulid_link_re().captures_iter(&content) {
                pairs.push((row.id.clone(), cap[1].to_owned()));
            }
        }
    }
    // One block naming the same target twice is one obligation. Deduplicating
    // in Rust keeps the chunk boundaries from being the thing that decides
    // whether `INSERT OR IGNORE` absorbs the duplicate.
    pairs.sort_unstable();
    pairs.dedup();

    let mut inserted: u64 = 0;
    for chunk in pairs.chunks(UNRESOLVED_REBUILD_CHUNK) {
        let pairs_json = serde_json::to_string(&chunk)?;
        let res = sqlx::query!(
            "INSERT OR IGNORE INTO block_links_unresolved (source_id, target_id) \
             SELECT json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]') \
               FROM json_each(?1) je \
              WHERE NOT EXISTS ( \
                  SELECT 1 FROM block_links bl \
                   WHERE bl.source_id = json_extract(je.value, '$[0]') \
                     AND bl.target_id = json_extract(je.value, '$[1]'))",
            pairs_json,
        )
        .execute(&mut *conn)
        .await?;
        inserted += res.rows_affected();
    }

    Ok(inserted)
}

/// Pool-scoped form of the rebuild above: opens its own
/// `BEGIN IMMEDIATE` transaction so the wipe and the refill are one atomic
/// step, and reports through the standard rebuild instrumentation.
///
/// The write lock is held across the content scan deliberately. The set this
/// table holds is a function of `blocks.content` AND `block_links`, so a
/// concurrent reindex landing between a lock-free read and the refill would be
/// overwritten by a snapshot of the world from before it ran.
///
/// # Errors
/// Returns [`AppError`] if the transaction, the rebuild, or the commit fails.
pub async fn rebuild_block_links_unresolved(pool: &SqlitePool) -> Result<(), AppError> {
    super::rebuild_with_timing("block_links_unresolved", || async {
        let mut tx =
            crate::db::begin_immediate_logged(pool, "cache_block_links_unresolved_rebuild").await?;
        let inserted = rebuild_block_links_unresolved_conn(&mut tx).await?;
        tx.commit().await?;
        Ok(inserted)
    })
    .await
}

// ---------------------------------------------------------------------------
// backfill_block_links — the one-shot vault-wide fill
// ---------------------------------------------------------------------------

/// `app_settings` key recording that [`backfill_block_links`] has run.
///
/// Versioned so a future correction can re-arm the pass by bumping the
/// suffix, the way `repair.tag_space_misfiled.v1` does.
const BLOCK_LINKS_BACKFILL_MARKER: &str = "repair.block_links_backfill.v1";

/// One-shot vault-wide backfill of `block_links` (and, through the reindexer,
/// `block_links_unresolved`) from block content.
///
/// # The hole this fills
///
/// `block_links` has only ever been maintained INCREMENTALLY, by
/// [`reindex_block_links`] on the write paths. Nothing has ever derived it
/// vault-wide: migration 0001 creates the table empty, 0061 only rebuilds it
/// to add FK cascades, `db/recovery/` does not touch it, and there is no
/// `rebuild_block_links` behind the per-block reindexer the way
/// [`rebuild_block_links_unresolved`] sits behind `sync_unresolved_links`.
///
/// So every `[[ULID]]` / `((ULID))` token written before its block was last
/// re-saved is absent from the link graph, permanently. The user sees it as
/// missing backlinks: `page_link_cache` and `pages_cache.inbound_link_count`
/// are both rolled up FROM `block_links`, so the hole propagates to every
/// linked-references panel and inbound count in the app.
///
/// This is the same defect #3839 fixed one layer up. Migration 0110
/// backfilled `page_link_cache` "for every vault upgrading past migration
/// 0065 (which created the table with NO backfill)" — but it rebuilt the
/// rollup from `block_links`, which had the identical hole underneath it, so
/// the rollup faithfully reproduced it.
///
/// # Why Rust and not a migration
///
/// 0110 could be SQL because it transcribed SQL. This one cannot: the source
/// of truth is `ULID_LINK_RE`, which deliberately accepts MIXED delimiters
/// (`[[ULID))`), and hand-writing that in a recursive CTE would be a second
/// implementation of the tokenizer — the thing the shared-regex comment in
/// `cache/mod.rs` exists to prevent. Reindexing each candidate through the
/// production path instead means the backfill cannot disagree with the
/// incremental writer about what a link is.
///
/// # Why gated to run once
///
/// The candidate scan is a sequential `LIKE` over `blocks`, and a block whose
/// tokens are all cross-space or self-referential legitimately produces no
/// row — so "has tokens but no edges" cannot distinguish a hole from a
/// converged vault, and there is no cheap precondition to test. The damage is
/// historical: every write path since has maintained the graph correctly.
/// Paying a full scan on every boot forever to find something that can only
/// exist once is the wrong trade, so the marker retires it. A regression that
/// reintroduces holes is caught by `reconciliation_oracle.rs`'s
/// `block_links.row` arm, which is what found this one.
///
/// The marker is written even when nothing needed repair: its point is to
/// retire the SCAN, not to record that work happened.
///
/// # Returns
///
/// Whether this pass scanned — false only when the marker had already retired
/// it. The rollups that read `block_links` are rebuilt on THAT, never on a row
/// count: a pass that drops one stale edge and adds one missing edge leaves
/// every `COUNT(*)` identical while changing which edges exist. Since the scan
/// happens once per vault, rebuilding on it unconditionally is always right.
///
/// # Errors
/// Returns [`AppError`] if any statement fails. The caller treats that as
/// best-effort — the marker is only written on the committed path, so a
/// failed run is retried on the next boot.
pub async fn backfill_block_links(pool: &SqlitePool) -> Result<bool, AppError> {
    let done: Option<String> = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        BLOCK_LINKS_BACKFILL_MARKER,
    )
    .fetch_optional(pool)
    .await?;
    if done.is_some() {
        return Ok(false);
    }

    let mut tx = crate::db::begin_immediate_logged(pool, "block_links_backfill").await?;

    // The `LIKE` pair is a cheap prefilter, not the tokenizer: it only has to
    // be a SUPERSET of what `ULID_LINK_RE` matches, and every token it can
    // match opens with `[[` or `((`. `reindex_block_links_conn` decides what
    // is actually a link.
    let candidates: Vec<String> = sqlx::query_scalar!(
        "SELECT id FROM blocks          WHERE deleted_at IS NULL            AND (content LIKE '%[[%' OR content LIKE '%((%')",
    )
    .fetch_all(&mut *tx)
    .await?;

    for id in &candidates {
        reindex_block_links_conn(&mut tx, id).await?;
    }

    let now = crate::db::now_ms();
    let scanned = candidates.len().to_string();
    sqlx::query!(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        BLOCK_LINKS_BACKFILL_MARKER,
        scanned,
        now,
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    // The rollups are the CALLER's to rebuild, through the materializer:
    // doing it here would run after the marker has committed, so a failed
    // rebuild would leave the pass recorded as done and nothing to retry it.
    Ok(true)
}
// ---------------------------------------------------------------------------
// reindex_block_links (p1-t21)
// ---------------------------------------------------------------------------

/// `block_links.kind` for a `(content, target)` pair (#4551): `block_ref` iff
/// `content` carries the exact `((target))` token. The same rule as migration
/// 0119's `instr()` backfill and the mock's `classifyLinkKind`; a pair whose
/// content carries both forms is a `block_ref`, and a mixed-delimiter token
/// such as `[[X))` is a `page_link`.
pub fn classify_link_kind(content: &str, target: &str) -> &'static str {
    if content.contains(&format!("(({target}))")) {
        "block_ref"
    } else {
        "page_link"
    }
}

/// Incremental reindex of `block_links` for a single block.
///
/// 1. Opens a transaction for a consistent read snapshot.
/// 2. Reads the block's current `content` and its existing outbound links.
/// 3. Parses all `[[ULID]]` and `((ULID))` tokens via regex.
/// 4. Diffs: deletes removed links, inserts added links within the same tx.
pub async fn reindex_block_links(pool: &SqlitePool, block_id: &str) -> Result<(), AppError> {
    let mut tx = crate::db::begin_immediate_logged(pool, "cache_block_links_reindex").await?;
    reindex_block_links_conn(&mut tx, block_id).await?;
    tx.commit().await?;
    Ok(())
}

/// Diff the source's recorded link targets against the ones its current
/// content names. A pair whose kind changed lands in `to_insert` too: the
/// callers' INSERT upserts `kind`, so a second run over unchanged content
/// still writes nothing.
fn diff_link_targets<'a>(
    old_targets: &'a HashMap<String, String>,
    new_targets: &'a HashMap<String, &'static str>,
) -> (Vec<&'a String>, Vec<(&'a String, &'static str)>) {
    let to_delete: Vec<&String> = old_targets
        .keys()
        .filter(|t| !new_targets.contains_key(*t))
        .collect();
    let to_insert: Vec<(&String, &'static str)> = new_targets
        .iter()
        .map(|(t, kind)| (t, *kind))
        .filter(|(t, kind)| {
            old_targets
                .get(t.as_str())
                .is_none_or(|old| old.as_str() != *kind)
        })
        .collect();
    (to_delete, to_insert)
}

/// Connection-scoped core of [`reindex_block_links`]: runs the
/// read → diff → DELETE/INSERT of a single block's outbound `block_links`
/// edges against an already-open connection/transaction, WITHOUT opening or
/// committing its own transaction. The caller controls the transaction
/// boundary.
///
/// This is the diff engine shared between the background
/// `ReindexBlockLinks` task (via [`reindex_block_links`], which wraps this in
/// its own tx) and the foreground per-op `pages_cache` count maintenance
/// hook (`materializer::handlers::pages_cache`), which calls it INSIDE the
/// apply-op transaction so the in-tx `inbound_link_count` recompute observes
/// the just-written edges immediately rather than after the async reindex
/// catches up (#1548).
///
/// Idempotent by construction: it diffs the parsed content tokens against the
/// rows currently in `block_links`, so a second run (e.g. the background
/// `ReindexBlockLinks` after the foreground hook already applied the edges)
/// finds an empty diff and is a no-op — the synchronous update and the
/// backstop rebuild converge on the same edge set with no double-count.
///
/// # #4118 — what it does with the tokens it declines to link
///
/// The INSERT below drops a parsed token whose target is not yet LINKABLE: the
/// target row must exist and be live, and (when the source has a resolved
/// space) the target's resolved space must match. Both conditions are about
/// the TARGET and both can become true LATER — the target can be created after
/// the referrer (routine on an out-of-order remote replay), and its `space_id`
/// is stamped post-commit by `SetBlockPageId`. This function is driven by ONE
/// trigger, a change to the SOURCE's content, so nothing re-ran it when that
/// happened and the edge was lost permanently.
///
/// It therefore no longer discards what it dropped: every declined token is
/// recorded in `block_links_unresolved` (migration 0112) keyed for lookup BY
/// TARGET, which is the reverse index the repair needs and the one
/// `block_links` cannot be (the missing row is the thing being looked up). The
/// push side lives in the materializer's `ReindexBlockLinks` handler, which
/// asks that index "who was waiting for this block?" after reindexing it.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub async fn reindex_block_links_conn(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<(), AppError> {
    // 1. Get current content (combined with step 2 in the same tx to
    //    avoid an extra connection round-trip). Soft-deleted blocks
    // Do not contribute outbound links to `block_links`.
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(&mut *conn)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all links
        None => String::new(),
    };

    // 2. Parse [[ULID]] and ((ULID)) tokens, each classified by kind.
    let new_targets: HashMap<String, &'static str> = super::ulid_link_re()
        .captures_iter(&content)
        .map(|cap| {
            let target = cap[1].to_string();
            let kind = classify_link_kind(&content, &target);
            (target, kind)
        })
        .collect();

    // 3. Get existing outbound links (same tx — consistent snapshot), AND
    //    (#4118) the source's currently-recorded unresolved tokens.
    //
    //    One `UNION ALL` rather than two statements: the unresolved read is
    //    needed on EVERY reindex (that is how a stale row gets dropped), and
    //    the create path this rides on is the one #3843 is measuring. Both
    //    sides are source-keyed index seeks and the second is almost always
    //    empty, so folding them into the existing round-trip keeps the added
    //    cost of the whole #4118 mechanism at zero statements for a block with
    //    no link tokens.
    let existing_rows = sqlx::query!(
        "SELECT target_id, kind, CAST(0 AS INTEGER) AS unresolved \
           FROM block_links WHERE source_id = ?1 \
         UNION ALL \
         SELECT target_id, 'page_link' AS kind, CAST(1 AS INTEGER) AS unresolved \
           FROM block_links_unresolved WHERE source_id = ?1",
        block_id,
    )
    .fetch_all(&mut *conn)
    .await?;

    let mut old_targets: HashMap<String, String> = HashMap::new();
    let mut had_unresolved_rows = false;
    for row in existing_rows {
        if row.unresolved == 0 {
            old_targets.insert(row.target_id, row.kind);
        } else {
            had_unresolved_rows = true;
        }
    }

    // 4. Diff — see [`diff_link_targets`].
    let (to_delete, to_insert) = diff_link_targets(&old_targets, &new_targets);

    // Phase 3 — filter out cross-space targets before inserting.
    // The write-time enforcement gate (Phase 2) rejects new cross-space
    // references, but the materializer rebuild path also processes content
    // that may contain legacy tokens. Filtering here ensures the cache
    // never holds cross-space rows even if a legacy token survives.
    //
    // P6 (#346): the source space is resolved once (one query); the
    // per-target space resolution that used to run in a Rust loop is
    // pushed into the INSERT's correlated subquery below, so the whole
    // cross-space filter costs one set-based statement instead of N+1
    // round-trips.
    //
    // #3903 correction of record (filed separately from the #3842/#3839
    // rollup work this landed alongside, so a future regression here bisects
    // to something whose title is about THIS defect): this comment previously
    // claimed the subquery was "a verbatim copy of `resolve_block_space`'s".
    // It was NOT. `resolve_block_space` (#533 Phase 2, `space.rs`) reads
    // `COALESCE(b.space_id, p.space_id)` over a `LEFT JOIN blocks p ON
    // p.id = b.page_id AND p.deleted_at IS NULL` — the owning-page fallback
    // that covers a block whose own `space_id` column has not been
    // materialised yet (it is stamped post-commit by `SetBlockPageId`'s
    // `set_block_space_id_from_parent`). The target-side subquery read only
    // `blocks.space_id`, so a target inside that window resolved to NULL,
    // `NULL = ?3` was falsy, and a legitimate SAME-space link was silently
    // dropped — asymmetric with the source side, which DOES take the
    // fallback (it calls `resolve_block_space` directly). Reachable via the
    // in-tx edit hook (`agaric-engine`'s `maintain_pages_cache_counts_after_op`,
    // `PreOpState::Edit`), where the source block's `space_id` is long since
    // stamped. The subquery below now mirrors `resolve_block_space` for real,
    // fallback included. It KEEPS both soft-delete guards (invariant #9): the
    // target row itself (`tgt.deleted_at IS NULL`) and the owning-page join
    // (`tp.deleted_at IS NULL`). Strictly widening: a non-NULL
    // `tgt.space_id` gives the old answer, and where it was NULL the old form
    // was already falsy — so no link the old filter KEPT can be dropped.
    let source_space: Option<String> = if to_insert.is_empty() {
        None
    } else {
        let source_block_id = agaric_core::ulid::BlockId::from_trusted(block_id);
        crate::space::resolve_block_space(&mut *conn, &source_block_id)
            .await?
            .map(|s| s.as_str().to_owned())
    };

    // #4118: the former `to_delete.is_empty() && to_insert.is_empty()` early
    // return is gone. Both write blocks below are already self-guarding, so it
    // saved nothing — and it skipped the unresolved-index maintenance for the
    // one case that still owes work: a token that LEFT the content while it
    // was still unresolved contributes to neither `to_delete` (it never had a
    // `block_links` row) nor `to_insert` (it is no longer in the content), so
    // its stale row would have survived every subsequent reindex and kept
    // re-triggering a repair for a reference that no longer exists.
    //
    // Batch DELETE/INSERT via `json_each` — one round-trip per side
    // regardless of the number of changed targets, replacing the previous
    // 2N round-trip per-target loops.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_links \
             WHERE source_id = ? \
               AND target_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *conn)
        .await?;
    }

    if !to_insert.is_empty() {
        // The upsert absorbs PK conflicts but does NOT suppress FK
        // violations — the `WHERE EXISTS` filter on `blocks` keeps dangling
        // targets out of the result set instead of relying on the FK.
        // SQL/C9 (#345): the EXISTS guard also requires `deleted_at IS NULL`
        // so a link to a soft-deleted (tombstoned) target is never created
        // — invariant #9 (tombstones must not participate in derived state).
        //
        // P6 (#346): the `(?3 IS NULL OR target_space = ?3)` clause is the
        // pushed-down cross-space filter. When the source has no resolved
        // space (`?3 IS NULL`) every target passes (mirrors the old
        // `if source_space.is_some()` skip). Otherwise a target is kept
        // only if its own resolved space equals the source's; targets
        // whose space is still NULL after the owning-page fallback
        // (genuinely unresolvable / soft-deleted holder) yield
        // `NULL = ?3` → falsy → dropped, exactly as the prior loop did
        // (it only pushed `Ok(Some(space))` matches).
        // `[target, kind]` pairs; the upsert is what lands a kind change on a
        // pair that already exists (#4551).
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT INTO block_links (source_id, target_id, kind) \
             SELECT ?1, json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]') \
             FROM json_each(?2) je \
             WHERE EXISTS (SELECT 1 FROM blocks WHERE id = json_extract(je.value, '$[0]') AND deleted_at IS NULL) \
               AND (?3 IS NULL OR ?3 = ( \
                   SELECT COALESCE(tgt.space_id, tp.space_id) FROM blocks tgt \
                   LEFT JOIN blocks tp ON tp.id = tgt.page_id AND tp.deleted_at IS NULL \
                   WHERE tgt.id = json_extract(je.value, '$[0]') AND tgt.deleted_at IS NULL \
                   LIMIT 1)) \
             ON CONFLICT(source_id, target_id) DO UPDATE SET kind = excluded.kind",
        )
        .bind(block_id)
        .bind(&insert_json)
        .bind(&source_space)
        .execute(&mut *conn)
        .await?;
    }

    // #4118: record whatever the INSERT above declined to link, so the edge is
    // recoverable when the target becomes linkable. Same connection, so the
    // unresolved index commits or rolls back atomically with the edges it
    // describes — including on the in-tx create/edit hook, where "the edge and
    // the note that it is owed" must not be able to disagree.
    sync_unresolved_links(
        &mut *conn,
        block_id,
        &new_targets,
        had_unresolved_rows,
        to_insert.is_empty(),
    )
    .await?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Read/write split variant (Phase 1A)
// ---------------------------------------------------------------------------

/// Read/write split variant of [`reindex_block_links`].
///
/// Reads block content and existing links from `read_pool`, computes a diff,
/// and applies inserts/deletes on `write_pool`.
/// Used by the materializer when a separate read pool is available.
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub async fn reindex_block_links_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
    block_id: &str,
) -> Result<(), AppError> {
    // Read phase from read_pool

    // 1. Get current content. Soft-deleted blocks do not contribute
    // Outbound links to `block_links`.
    let row = sqlx::query!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(read_pool)
    .await?;

    let content = match row {
        Some(r) => r.content.unwrap_or_default(),
        // Block not found or deleted — remove all links
        None => String::new(),
    };

    // 2. Parse [[ULID]] and ((ULID)) tokens, each classified by kind.
    let new_targets: HashMap<String, &'static str> = super::ulid_link_re()
        .captures_iter(&content)
        .map(|cap| {
            let target = cap[1].to_string();
            let kind = classify_link_kind(&content, &target);
            (target, kind)
        })
        .collect();

    // 3. Get existing outbound links from read pool, and (#4118) the source's
    //    currently-recorded unresolved tokens — one round-trip, exactly as in
    //    the single-pool variant.
    let existing_rows = sqlx::query!(
        "SELECT target_id, kind, CAST(0 AS INTEGER) AS unresolved \
           FROM block_links WHERE source_id = ?1 \
         UNION ALL \
         SELECT target_id, 'page_link' AS kind, CAST(1 AS INTEGER) AS unresolved \
           FROM block_links_unresolved WHERE source_id = ?1",
        block_id,
    )
    .fetch_all(read_pool)
    .await?;

    let mut old_targets: HashMap<String, String> = HashMap::new();
    let mut had_unresolved_rows = false;
    for row in existing_rows {
        if row.unresolved == 0 {
            old_targets.insert(row.target_id, row.kind);
        } else {
            had_unresolved_rows = true;
        }
    }

    // 4. Diff — see [`diff_link_targets`].
    let (to_delete, to_insert) = diff_link_targets(&old_targets, &new_targets);

    // #375: resolve the source space so the INSERT below can exclude
    // cross-space targets, identically to the single-pool `reindex_block_links`
    // (Phase 3 / #345/#346). The split path reads from `read_pool`, so
    // the resolution does too (consistent with the content/target reads above).
    // Without this the production split path silently re-admits exactly the
    // cross-space rows the canonical path is careful to exclude.
    let source_space: Option<String> = if to_insert.is_empty() {
        None
    } else {
        let source_block_id = agaric_core::ulid::BlockId::from_trusted(block_id);
        crate::space::resolve_block_space(read_pool, &source_block_id)
            .await?
            .map(|s| s.as_str().to_owned())
    };

    // #4118: `had_unresolved_rows` joins the "nothing to write" test rather
    // than the early return being dropped outright as in the single-pool
    // variant — this one opens a WRITE transaction on the far side of it, so
    // an unconditional fall-through would put a write tx on the split path's
    // every no-op reindex. A source with no recorded unresolved tokens and an
    // empty diff still writes nothing.
    if to_delete.is_empty() && to_insert.is_empty() && !had_unresolved_rows {
        // No changes — nothing to write.
        return Ok(());
    }

    // Write phase on write pool
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_block_links_reindex_write").await?;

    // Batch DELETE/INSERT via `json_each` — one round-trip per side
    // regardless of the number of changed targets, replacing the previous
    // 2N round-trip per-target loops.
    if !to_delete.is_empty() {
        let delete_json = serde_json::to_string(&to_delete)?;
        sqlx::query(
            "DELETE FROM block_links \
             WHERE source_id = ? \
               AND target_id IN (SELECT value FROM json_each(?))",
        )
        .bind(block_id)
        .bind(&delete_json)
        .execute(&mut *tx)
        .await?;
    }

    if !to_insert.is_empty() {
        // The upsert absorbs PK conflicts but does NOT suppress FK
        // violations — the `WHERE EXISTS` filter on `blocks` keeps dangling
        // targets out of the result set instead of relying on the FK.
        // SQL/C9 (#345): the EXISTS guard also requires `deleted_at IS NULL`
        // so a link to a soft-deleted (tombstoned) target is never created
        // — invariant #9 (tombstones must not participate in derived state).
        //
        // #375: the `(?3 IS NULL OR ?3 = (…))` clause is the pushed-down
        // cross-space filter — a verbatim copy of the single-pool variant's
        // SQL, which (as of #3903) really is `space::resolve_block_space`'s
        // `COALESCE(own space_id, owning page's space_id)` with both
        // soft-delete guards. Source has no space (`?3 IS NULL`) ⇒ every
        // target passes; otherwise a target is kept only if its resolved
        // space equals the source's (a still-NULL target space yields
        // `NULL = ?3` → dropped). See the single-pool variant for why the
        // owning-page fallback is load-bearing rather than cosmetic.
        // `[target, kind]` pairs; the upsert is what lands a kind change on a
        // pair that already exists (#4551).
        let insert_json = serde_json::to_string(&to_insert)?;
        sqlx::query(
            "INSERT INTO block_links (source_id, target_id, kind) \
             SELECT ?1, json_extract(je.value, '$[0]'), json_extract(je.value, '$[1]') \
             FROM json_each(?2) je \
             WHERE EXISTS (SELECT 1 FROM blocks WHERE id = json_extract(je.value, '$[0]') AND deleted_at IS NULL) \
               AND (?3 IS NULL OR ?3 = ( \
                   SELECT COALESCE(tgt.space_id, tp.space_id) FROM blocks tgt \
                   LEFT JOIN blocks tp ON tp.id = tgt.page_id AND tp.deleted_at IS NULL \
                   WHERE tgt.id = json_extract(je.value, '$[0]') AND tgt.deleted_at IS NULL \
                   LIMIT 1)) \
             ON CONFLICT(source_id, target_id) DO UPDATE SET kind = excluded.kind",
        )
        .bind(block_id)
        .bind(&insert_json)
        .bind(&source_space)
        .execute(&mut *tx)
        .await?;
    }

    // #4118: same unresolved-index maintenance as the single-pool variant, on
    // the WRITE transaction — its read-back of `block_links` must observe the
    // INSERT above, which the read pool cannot yet see.
    sync_unresolved_links(
        &mut tx,
        block_id,
        &new_targets,
        had_unresolved_rows,
        to_insert.is_empty(),
    )
    .await?;

    tx.commit().await?;
    Ok(())
}
