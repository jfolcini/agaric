//! `tags_cache` — materialized `(tag_id, space_id, name, usage_count)` per
//! live tag block, a DELETE+INSERT recompute of the GROUP BY in
//! [`DESIRED_TAGS_SQL`] (a `COUNT(DISTINCT block_id)` over
//! `block_tags ∪ block_tag_refs`). `space_id` mirrors `blocks.space_id`:
//! the name slot is `UNIQUE (space_id, name)` (migration 0121, #5237), so
//! the same name in two spaces is two cached tags.
//!
//! **Measurement justification (#2508).** The pre-cache read shape is the
//! [`DESIRED_TAGS_SQL`] projection run live. The `interactive_slo` bench
//! probe `bench_tags_cache_direct_query` (gated behind `SLO_INCLUDE_PROBLEM`,
//! `src-tauri/benches/interactive_slo.rs`) measured it at **~183 ms @ 100K**
//! (500 tags, 100K usages spread across both source tables; nightly
//! `bench-slo` runner). That is ~92% of the entire 200 ms interactive SLO
//! budget — serving tag reads live would consume the budget on its own, so
//! the incremental-maintenance machinery here is earning its complexity:
//! **KEEP.** Any retirement of this cache is deferred to #709 Phase 2 (its
//! name-keyed re-key makes the UNIQUE(name) invariant live at the source, per
//! #626); this measured number is the empirical input to that decision.

use futures_util::TryStreamExt;
use sqlx::SqlitePool;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use crate::db::MAX_SQL_PARAMS;
use agaric_core::error::AppError;
use agaric_core::tag_norm::normalize_tag_name;

// `tags_cache` has 5 columns per row (tag_id, space_id, name, usage_count,
// updated_at) → `MAX_SQL_PARAMS / 5 = 199` rows per chunk for INSERT.
// DELETE binds 1 column (tag_id) → `MAX_SQL_PARAMS / 1 = 999` rows per
// chunk.
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 5; // 199
const DELETE_CHUNK: usize = MAX_SQL_PARAMS; // 999

/// One desired or current cache row: `(tag_id, name, usage_count, space_id)`.
type TagRow = (String, String, i64, Option<String>);

// ---------------------------------------------------------------------------
// Desired-state SQL
// ---------------------------------------------------------------------------

/// Projection that computes the desired state of `tags_cache` from the
/// live database. The whole-vault read ([`DESIRED_TAGS_SQL`]) and the
/// re-derivation of the stale tags ([`DESIRED_TAGS_OF_SQL`]) are this one
/// text, so the two cannot silently diverge.
///
/// Semantics (preserved verbatim from the pre-M-2 full rebuild):
///   - `usage_count` counts DISTINCT `block_id`s from the UNION of
///     `block_tags` (explicit) ∪ `block_tag_refs` (inline `#[ULID]`).
///   - Both joins enforce `deleted_at IS NULL` on the referenced block and
///     keep only blocks in the tag's own space (`blk.space_id IS
///     tag.space_id`, #5275): a `block_tags` / `block_tag_refs` row
///     survives the block's move to another space, and the Tags view is
///     space-scoped.
///   - Tags with zero usage are included via the LEFT JOIN + COALESCE.
///
/// Output is sorted by `b.id ASC` so the sort-merge diff in
/// [`merge_tag_streams`] can walk this stream alongside
/// `tags_cache` (also `ORDER BY tag_id ASC`) in lockstep.
///
/// **Duplicate-name de-duplication (#626).** `tags_cache` is
/// `UNIQUE (space_id, name)` (migration 0121) but `blocks.content` has no
/// uniqueness for `block_type='tag'`: two live tags in one space can
/// legitimately share a name (a rename collision, or two devices
/// independently creating `#project` then syncing). If both were emitted
/// into the desired state, the rebuild's INSERT would have to resolve the
/// UNIQUE collision on *every* run, and `INSERT OR REPLACE` made the two
/// rows flip-flop forever (each rebuild evicted whichever one the previous
/// rebuild had inserted → `changed >= 1` perpetually, one tag permanently
/// invisible).
///
/// We instead de-duplicate by name *deterministically*: among all live
/// tags sharing a name within one space, only the one with the smallest
/// `id` (ULID → earliest-created) survives. The same name in another
/// space is a different tag and keeps its own row (#5237); `space_id` is
/// the tag block's own `blocks.space_id`, NULL for an unscoped tag.
///
/// **#1990 — normalize-consistent identity.** Tag identity is defined by
/// [`agaric_core::tag_norm::normalize_tag_name`] (NFC → full-Unicode lowercase
/// → NFC) — the SAME key the Loro sync engine stores its tag map under
/// (`loro/engine/apply.rs::tag_map_key_for`). The previous dedup used
/// `PARTITION BY content COLLATE NOCASE`, but SQLite's NOCASE folds only
/// ASCII A–Z, so non-ASCII case-variants (`#Σ`/`#σ`) were merged by the
/// engine yet SPLIT into two cache rows — a latent multi-device hazard.
/// SQLite cannot compute `normalize_tag_name`, so this SQL no longer
/// de-duplicates at all: it emits EVERY live tag (id, content, cnt,
/// space_id) ordered by `id ASC`, and [`next_desired_winner`] picks the
/// smallest-id winner per `(space_id, normalized name)` in Rust. Because
/// the stream is `id`-ordered, the first row for a key IS the winner and
/// later same-key rows are dropped. The winner is a pure function of the
/// source rows, so the desired stream is stable across rebuilds → the
/// cache converges (a settled rebuild reports `changed == 0`) and the
/// same tag wins every time. The loser is omitted from the cache (it has
/// no UNIQUE slot to occupy); it remains fully live in `blocks` and is
/// recoverable by a rename. The ASCII case behaviour is unchanged — it is
/// a strict subset of the Unicode fold (pinned by
/// `tag_norm::ascii_fold_matches_sqlite_nocase`).
macro_rules! desired_tags_sql {
    ($usage_space:literal, $of_block_tags:literal, $of_tag_refs:literal, $of_tag:literal) => {
        concat!(
            "SELECT b.id, b.content, COALESCE(t.cnt, 0) AS cnt, b.space_id
             FROM blocks b
             LEFT JOIN (
                 SELECT tag_id, COUNT(*) AS cnt FROM (
                     SELECT bt.tag_id, bt.block_id
                     FROM block_tags bt
                     JOIN blocks blk ON blk.id = bt.block_id
                     JOIN blocks tag ON tag.id = bt.tag_id
                     WHERE blk.deleted_at IS NULL AND ",
            $usage_space,
            " IS tag.space_id",
            $of_block_tags,
            "
                     UNION
                     SELECT btr.tag_id, btr.source_id AS block_id
                     FROM block_tag_refs btr
                     JOIN blocks blk ON blk.id = btr.source_id
                     JOIN blocks tag ON tag.id = btr.tag_id
                     WHERE blk.deleted_at IS NULL AND ",
            $usage_space,
            " IS tag.space_id",
            $of_tag_refs,
            "
                 )
                 GROUP BY tag_id
             ) t ON t.tag_id = b.id
             WHERE b.block_type = 'tag' AND b.deleted_at IS NULL AND b.content IS NOT NULL",
            $of_tag,
            "
             ORDER BY b.id ASC"
        )
    };
}

const DESIRED_TAGS_SQL: &str = desired_tags_sql!("blk.space_id", "", "", "");

/// [`DESIRED_TAGS_SQL`] for the tags in the JSON id array `?1` alone, before
/// the name de-duplication: the same text with the usage rows and the tag
/// rows each narrowed to those ids, so a tag's row here is its row there.
///
/// `+blk.space_id` keeps the planner on those tags' usage rows, as in
/// [`DESIRED_TAG_USAGE_SQL`]; the unary `+` changes no value.
const DESIRED_TAGS_OF_SQL: &str = desired_tags_sql!(
    "+blk.space_id",
    " AND bt.tag_id IN (SELECT value FROM json_each(?1))",
    " AND btr.tag_id IN (SELECT value FROM json_each(?1))",
    " AND b.id IN (SELECT value FROM json_each(?1))"
);

const CURRENT_TAGS_SQL: &str =
    "SELECT tag_id, name, usage_count, space_id FROM tags_cache ORDER BY tag_id ASC";

/// [`CURRENT_TAGS_SQL`] for the tags in the JSON id array `?1` alone.
const CURRENT_TAGS_OF_SQL: &str = "SELECT tag_id, name, usage_count, space_id FROM tags_cache \
     WHERE tag_id IN (SELECT value FROM json_each(?1)) ORDER BY tag_id ASC";

/// Scoped desired-state SQL for a SINGLE tag (#676).
///
/// Computes the `(name, usage_count)` a full [`DESIRED_TAGS_SQL`] rebuild
/// would emit for exactly one `tag_id`, reusing the **identical** usage
/// subquery (`block_tags` ∪ `block_tag_refs`, both filtered to live source
/// blocks) and the **identical** name de-duplication rule. The single bind
/// parameter `?` is the candidate tag's id.
///
/// The de-dup guard is the load-bearing difference from a naive
/// `WHERE b.id = ?`: in a full rebuild, among all live tags in one space
/// sharing a normalized name (#1990 — [`normalize_tag_name`], the engine's
/// tag identity key) only the smallest-id tag occupies the cache slot; the
/// rest are omitted. So this query emits a row **only if** the candidate
/// is that smallest-id winner — i.e. no live tag in its space with the
/// same normalized name has a smaller id.
///
/// **SQLite cannot compute `normalize_tag_name`.** Earlier this guard was
/// an SQL `NOT EXISTS … o.content = b.content COLLATE NOCASE`, but NOCASE
/// folds only ASCII, so a non-ASCII case-variant loser would wrongly be
/// treated as a winner. Instead this query returns the candidate's own
/// `(content, cnt)` plus the smallest live-tag `id` sharing its content
/// under NOCASE (a cheap superset prefilter); the Rust caller
/// ([`refresh_tag_usage_count_impl`]) confirms the true smallest-id winner
/// among the full-Unicode-normalized siblings. If the candidate is a name
/// *loser*, was deleted, or isn't a tag block, the caller leaves the cache
/// untouched (exactly what a full rebuild does for that tag).
///
/// Because `add_tag`/`remove_tag` mutate only `block_tags` (never
/// `blocks.content`, never which tag blocks exist), the *winner* for any
/// name and the *set* of cached tag rows are invariant under these ops — only
/// the winner's `usage_count` can move. Recomputing just this one row is
/// therefore provably identical to the full rebuild's effect for the op.
///
/// `+blk.space_id` keeps the planner on this tag's rows: an indexable space
/// predicate drives a scan of every block in the space instead.
const DESIRED_TAG_USAGE_SQL: &str =
    "SELECT b.content AS name, COALESCE(t.cnt, 0) AS cnt, b.space_id
         FROM blocks b
         LEFT JOIN (
             SELECT COUNT(*) AS cnt FROM (
                 SELECT bt.block_id
                 FROM block_tags bt
                 JOIN blocks blk ON blk.id = bt.block_id
                 JOIN blocks tag ON tag.id = bt.tag_id
                 WHERE blk.deleted_at IS NULL AND +blk.space_id IS tag.space_id
                   AND bt.tag_id = ?1
                 UNION
                 SELECT btr.source_id AS block_id
                 FROM block_tag_refs btr
                 JOIN blocks blk ON blk.id = btr.source_id
                 JOIN blocks tag ON tag.id = btr.tag_id
                 WHERE blk.deleted_at IS NULL AND +blk.space_id IS tag.space_id
                   AND btr.tag_id = ?1
             )
         ) t
         WHERE b.id = ?1
           AND b.block_type = 'tag'
           AND b.deleted_at IS NULL
           AND b.content IS NOT NULL";

/// All live tag blocks (id, content) in one space (`?1`, `IS` so a NULL
/// space matches NULL), ordered by `id ASC`, used by the scoped refresh to
/// confirm the smallest-id winner for a candidate's normalized name in Rust
/// (#1990). SQLite's NOCASE folds only ASCII, so a SQL prefilter on
/// `content = ? COLLATE NOCASE` would MISS a non-ASCII case-variant sibling
/// (`#Σ` for a `#σ` candidate) — the exact relationship the winner check
/// must detect. So we scan every live tag of the space and confirm the
/// full-Unicode `normalize_tag_name` equality in Rust. Tag count is bounded
/// by the user's vocabulary (cf. the no-clamp `list_all_tags_in_space`), so
/// the scan is cheap. The first `id`-ordered tag whose normalized name
/// matches the candidate's is the winner.
const LIVE_TAGS_IN_SPACE_SQL: &str = "SELECT id, content
         FROM blocks
         WHERE block_type = 'tag'
           AND deleted_at IS NULL
           AND content IS NOT NULL
           AND space_id IS ?1
         ORDER BY id ASC";

/// Incremental, single-tag refresh of `tags_cache.usage_count` (#676).
///
/// `add_tag` / `remove_tag` mutate exactly one `(block_id, tag_id)` edge in
/// `block_tags`. The only `tags_cache` column that can change as a result is
/// the affected tag's `usage_count`; neither the tag's `name` nor the *set*
/// of cached tags can move (see `DESIRED_TAG_USAGE_SQL`). So instead of the
/// former full O(vault) [`rebuild_tags_cache`] (which streams every tag block
/// and the whole `block_tags`/`block_tag_refs` union to sort-merge-diff the
/// entire cache), this recomputes the desired row for just `tag_id` and:
///   - if the tag is the name-winner → `INSERT OR REPLACE` its row with the
///     freshly computed `usage_count` (UPSERT — robust if the row hasn't been
///     materialized yet under eventual consistency);
///   - if the tag is a name-loser / deleted / not a tag → the desired query
///     returns no row, so the cache is left untouched (identical to a full
///     rebuild's treatment of that tag).
///
/// `INSERT OR REPLACE` is safe here for the same reason as in the full
/// rebuild (`apply_tags_diff`): the candidate is, by the de-dup guard, the
/// sole owner of its `UNIQUE(space_id, name)` slot among live tags, so no
/// unchanged tag can collide on the name.
pub async fn refresh_tag_usage_count(pool: &SqlitePool, tag_id: &str) -> Result<(), AppError> {
    super::rebuild_with_timing("tags", || refresh_tag_usage_count_impl(pool, tag_id)).await
}

async fn refresh_tag_usage_count_impl(pool: &SqlitePool, tag_id: &str) -> Result<u64, AppError> {
    let now = agaric_core::time::now_rfc3339();
    // dynamic-sql: a named text, documented beside the rebuild's it mirrors
    let desired: Option<(String, i64, Option<String>)> =
        sqlx::query_as::<_, (String, i64, Option<String>)>(DESIRED_TAG_USAGE_SQL)
            .bind(tag_id)
            .fetch_optional(pool)
            .await?;

    let Some((name, cnt, space_id)) = desired else {
        // Deleted / non-tag / NULL content: a full rebuild would not place this
        // id in the cache, so leave it untouched.
        return Ok(0);
    };

    // #1990 — confirm the candidate is the smallest-id winner among the live
    // tags of ITS SPACE sharing its NORMALIZED name (the engine's tag
    // identity). SQLite cannot compute `normalize_tag_name`, so we resolve the
    // winner in Rust (same fold the full rebuild's `next_desired_winner`
    // uses). If the candidate is a name *loser*, it has no UNIQUE cache slot —
    // identical to a full rebuild, which omits it — so leave the cache
    // untouched.
    let candidate_norm = normalize_tag_name(&name);
    // dynamic-sql: a named text, shared with the rebuild's write half
    let siblings = sqlx::query_as::<_, (String, Option<String>)>(LIVE_TAGS_IN_SPACE_SQL)
        .bind(&space_id)
        .fetch_all(pool)
        .await?;
    let winner_id = siblings.iter().find_map(|(id, content)| {
        let c = content.as_deref()?;
        (normalize_tag_name(c) == candidate_norm).then_some(id.as_str())
    });
    if winner_id != Some(tag_id) {
        return Ok(0);
    }

    let mut tx = crate::db::begin_immediate_logged(pool, "cache_tags_refresh_one").await?;
    let res = sqlx::query!(
        "INSERT OR REPLACE INTO tags_cache (tag_id, space_id, name, usage_count, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        tag_id,
        space_id,
        name,
        cnt,
        now,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(res.rows_affected())
}

// ---------------------------------------------------------------------------
// Apply diff
// ---------------------------------------------------------------------------

/// Apply a tags diff inside an open transaction in chunks bounded by
/// [`MAX_SQL_PARAMS`].
///
/// **Ordering invariant.** All DELETEs execute before any INSERTs. This
/// matters because `tags_cache` carries a `UNIQUE (space_id, name)`
/// constraint: if a tag is renamed (e.g. TAG_A renamed to "X" while TAG_B
/// still owns the row whose name was "X"), the new "X" insert would
/// collide on UNIQUE unless TAG_B's row is deleted first. The pre-M-2 full
/// rebuild dodged this trivially by truncating the table; here we mirror
/// that guarantee by sequencing all deletes before all inserts within a
/// single apply pass — see [`rederive_tags_of`] which calls this
/// exactly once at end-of-stream.
async fn apply_tags_diff(
    conn: &mut sqlx::SqliteConnection,
    delete_ids: &[String],
    insert_rows: &[TagRow],
    now: &str,
) -> Result<(), AppError> {
    for chunk in delete_ids.chunks(DELETE_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "?").collect();
        let sql = format!(
            "DELETE FROM tags_cache WHERE tag_id IN ({})",
            placeholders.join(", ")
        );
        // dynamic-sql: the placeholder list is as long as the chunk
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for id in chunk {
            q = q.bind(id);
        }
        q.execute(&mut *conn).await?;
    }

    for chunk in insert_rows.chunks(INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?, ?, ?)").collect();
        let sql = format!(
            // INSERT OR REPLACE (not INSERT OR IGNORE): if a tag is renamed to
            // a name still held by an UNCHANGED tag (not in the delete set), the
            // UNIQUE constraint would cause INSERT OR IGNORE to silently drop
            // the renamed tag's new row.  INSERT OR REPLACE instead evicts the
            // stale row and preserves the incoming (correct) row.
            //
            // The desired projection de-duplicates names deterministically per
            // space (DESIRED_TAGS_SQL, #626), so each rebuild's insert set holds
            // at most one row per (space_id, name) and OR REPLACE no longer
            // flip-flops between two same-name tags: the same winner (smallest
            // id) is inserted every rebuild and the cache converges (changed ==
            // 0 once settled).
            "INSERT OR REPLACE INTO tags_cache (tag_id, space_id, name, usage_count, updated_at) \
             VALUES {}",
            placeholders.join(", ")
        );
        // dynamic-sql: the placeholder list is as long as the chunk
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (tag_id, name, usage_count, space_id) in chunk {
            q = q
                .bind(tag_id)
                .bind(space_id)
                .bind(name)
                .bind(usage_count)
                .bind(now);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Sort-merge rebuild core
// ---------------------------------------------------------------------------

/// Advance an `id`-ordered desired-tag stream to the next **name-winner**,
/// de-duplicating by `(space_id, `[`normalize_tag_name`]`)` in Rust (#1990,
/// #5237).
///
/// [`DESIRED_TAGS_SQL`] emits EVERY live tag ordered by `id ASC` (SQLite
/// cannot compute the full-Unicode `normalize_tag_name`, so the dedup can no
/// longer live in SQL). For each candidate this folds its `content` to the
/// engine's identity key, pairs it with the tag's space, and keeps it only if
/// that key is unseen — i.e. it is the smallest-id tag for that normalized
/// name in that space. Later same-key rows (losers) are skipped, mirroring
/// the old `ROW_NUMBER() … rn = 1` projection but with the Unicode-correct
/// fold. `seen` accumulates the winning keys across the whole stream; because
/// the stream is `id`-ordered the first occurrence of a key is always its
/// smallest-id winner, so the result is a pure, stable function of the source
/// rows (the cache still converges to `changed == 0`).
async fn next_desired_winner(
    stream: &mut (impl futures_util::Stream<Item = Result<TagRow, sqlx::Error>> + Unpin),
    seen: &mut HashSet<(Option<String>, String)>,
) -> Result<Option<TagRow>, AppError> {
    while let Some(row) = stream.try_next().await? {
        // Load-bearing for unscoped tags: SQLite treats NULLs as distinct, so
        // `UNIQUE (space_id, name)` never rejects two `space_id IS NULL` rows
        // with one name; only this dedup keeps them to one row per name.
        if seen.insert((row.3.clone(), normalize_tag_name(&row.1))) {
            return Ok(Some(row));
        }
        // Name-loser (a smaller-id tag in the same space already owns this
        // normalized name) — skip it; it has no UNIQUE cache slot, exactly as
        // the old SQL `rn = 1` filter dropped it.
    }
    Ok(None)
}

/// Walk the desired name-winners and the cached rows in id order and hand
/// every tag they disagree on to `on_stale`, as `(desired, cached)`:
///   - PK in NEW not in OLD → `(Some, None)`.
///   - PK in OLD not in NEW → `(None, Some)`.
///   - PK in both, `(name, usage_count, space_id)` differs → `(Some, Some)`.
///
/// `desired_stream` is the [`DESIRED_TAGS_SQL`] rows before the name
/// de-duplication, which [`next_desired_winner`] applies here. Returns how
/// many tags disagreed.
async fn merge_tag_streams(
    mut desired_stream: impl futures_util::Stream<Item = Result<TagRow, sqlx::Error>> + Unpin,
    mut current_stream: impl futures_util::Stream<Item = Result<TagRow, sqlx::Error>> + Unpin,
    mut on_stale: impl FnMut(Option<&TagRow>, Option<&TagRow>),
) -> Result<u64, AppError> {
    let mut changed: u64 = 0;
    // #1990 — winning `(space_id, normalized name)` keys seen so far. The
    // desired stream is de-duplicated by that key in Rust (the smallest-id tag
    // wins each key); `seen` tracks those winners as the stream advances. The
    // desired stream stays `id`-ordered after the filter (we drop rows, never
    // reorder), so the sort-merge below still walks both streams in lockstep
    // on `id`.
    let mut seen: HashSet<(Option<String>, String)> = HashSet::new();

    let mut next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
    let mut next_current = current_stream.try_next().await?;

    loop {
        // Which side the smaller id is on: `Less` is a tag only the desired
        // rows have, `Greater` one only the cache has.
        let side = match (&next_desired, &next_current) {
            (None, None) => break,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some(desired), Some(current)) => desired.0.cmp(&current.0),
        };
        let desired = next_desired.as_ref().filter(|_| side != Ordering::Greater);
        let current = next_current.as_ref().filter(|_| side != Ordering::Less);
        // Same id with the same name, usage_count and space is the one case
        // that is not stale, and keeps its row's `updated_at`.
        if desired != current {
            on_stale(desired, current);
            changed += 1;
        }
        if side != Ordering::Greater {
            next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
        }
        if side != Ordering::Less {
            next_current = current_stream.try_next().await?;
        }
    }

    Ok(changed)
}

/// The read half of [`rebuild_tags_cache_split`]: the tags on which the whole
/// desired state and the whole cache disagree, in id order.
///
/// Two connections, because the two streams are walked together; each has
/// its own snapshot. A write that lands between the two is seen by one
/// stream only and at worst names a tag that is not stale, which the write
/// half then finds nothing to change for.
async fn tags_with_stale_rows(read_pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let mut desired_conn = read_pool.acquire().await?;
    let mut current_conn = read_pool.acquire().await?;
    let mut stale = Vec::new();
    // dynamic-sql: the projection is a named text, which the write half
    // narrows; the cache is read beside it
    merge_tag_streams(
        sqlx::query_as::<_, TagRow>(DESIRED_TAGS_SQL).fetch(&mut *desired_conn),
        sqlx::query_as::<_, TagRow>(CURRENT_TAGS_SQL).fetch(&mut *current_conn),
        |desired, current| {
            if let Some((tag_id, ..)) = desired.or(current) {
                stale.push(tag_id.clone());
            }
        },
    )
    .await?;
    Ok(stale)
}

/// The write half of [`rebuild_tags_cache_split`]: bring the `tags_cache`
/// rows of the tags in `tag_ids` to what [`DESIRED_TAGS_SQL`] and its name
/// de-duplication give for them now. It reads the tags, their usage, their
/// spaces' names and the cached rows again under the writer lock instead of
/// applying what the read phase saw, so a write that landed in between is
/// never undone. Returns the tags changed.
///
/// A tag keeps a row only if it is the smallest-id live tag of its space with
/// its normalized name, so the winners are read per space of the tags named:
/// an index range over the space's tags, not a scan of `blocks`.
async fn rederive_tags_of(
    conn: &mut sqlx::SqliteConnection,
    tag_ids: &[String],
    now: &str,
) -> Result<u64, AppError> {
    let ids_json = serde_json::to_string(tag_ids)?;
    // dynamic-sql: `DESIRED_TAGS_SQL`'s text narrowed to an id list
    let live: Vec<TagRow> = sqlx::query_as(DESIRED_TAGS_OF_SQL)
        .bind(&ids_json)
        .fetch_all(&mut *conn)
        .await?;

    // Per space: normalized name → the id that owns it.
    let mut winners: HashMap<Option<String>, HashMap<String, String>> = HashMap::new();
    for (_, _, _, space_id) in &live {
        if winners.contains_key(space_id) {
            continue;
        }
        let mut names = HashMap::new();
        // dynamic-sql: a named text, shared with the scoped refresh
        let tags = sqlx::query_as::<_, (String, Option<String>)>(LIVE_TAGS_IN_SPACE_SQL)
            .bind(space_id)
            .fetch_all(&mut *conn)
            .await?;
        for (id, content) in tags {
            // `id`-ordered, so the first tag with a name is its winner.
            names
                .entry(normalize_tag_name(content.as_deref().unwrap_or_default()))
                .or_insert(id);
        }
        winners.insert(space_id.clone(), names);
    }
    let desired = live.into_iter().filter(|(tag_id, name, _, space_id)| {
        winners
            .get(space_id)
            .and_then(|names| names.get(&normalize_tag_name(name)))
            == Some(tag_id)
    });

    // dynamic-sql: a named text, which the plan test reads
    let current: Vec<TagRow> = sqlx::query_as(CURRENT_TAGS_OF_SQL)
        .bind(&ids_json)
        .fetch_all(&mut *conn)
        .await?;

    // A changed row is a DELETE + INSERT under its PK.
    let mut deletes: Vec<String> = Vec::new();
    let mut inserts: Vec<TagRow> = Vec::new();
    let changed = merge_tag_streams(
        futures_util::stream::iter(desired.map(Ok)),
        futures_util::stream::iter(current.into_iter().map(Ok)),
        |desired, current| {
            deletes.extend(current.map(|row| row.0.clone()));
            inserts.extend(desired.cloned());
        },
    )
    .await?;
    apply_tags_diff(conn, &deletes, &inserts, now).await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Rebuild_tags_cache (p1-t18)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `tags_cache`: [`rebuild_tags_cache_split`] with one
/// pool for both halves.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_tags_cache(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_tags_cache_split(pool, pool).await
}

/// Rebuild `tags_cache` with the whole-vault comparison on `read_pool`.
///
/// 1. Streams the desired state from `blocks` (filtered by
///    `block_type = 'tag' AND deleted_at IS NULL AND content IS NOT NULL`)
///    LEFT-joined with a UNION'd usage subquery over `block_tags` ∪
///    `block_tag_refs`, and the cache, both sorted by tag id, and walks them
///    in lockstep, keeping the ids of the tags they disagree on.
/// 2. Takes the writer lock only when there are any, and under it re-derives
///    those tags' rows (`rederive_tags_of`).
///
/// Unchanged rows are not touched — their `updated_at` is preserved. Tags
/// with zero usage are included via the LEFT JOIN + COALESCE.
///
/// A tag that goes stale after step 1 read it is left to the refresh or
/// rebuild its own write enqueues, which runs after this one.
pub async fn rebuild_tags_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("tags", || rebuild_tags_cache_impl(write_pool, read_pool)).await
}

async fn rebuild_tags_cache_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let stale = tags_with_stale_rows(read_pool).await?;
    if stale.is_empty() {
        return Ok(0);
    }
    let now = agaric_core::time::now_rfc3339();
    let mut tx = crate::db::begin_immediate_logged(write_pool, "cache_tags_rebuild_write").await?;
    let changed = rederive_tags_of(&mut tx, &stale, &now).await?;
    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// Sort-merge tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests scoped to this file. Helpers are local copies of the
    //! patterns in `cache/tests.rs`.
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        crate::test_support::test_pool().await
    }

    async fn insert_tag(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, 'tag', ?)",
            id,
            name,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_content(pool: &SqlitePool, id: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, 'content', ?)",
            id,
            content,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn add_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query!(
            "INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            block_id,
            tag_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn rename_tag(pool: &SqlitePool, id: &str, new_name: &str) {
        sqlx::query!("UPDATE blocks SET content = ? WHERE id = ?", new_name, id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn soft_delete(pool: &SqlitePool, id: &str) {
        sqlx::query!(
            "UPDATE blocks SET deleted_at = 1767139200000 WHERE id = ?",
            id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn snapshot(pool: &SqlitePool) -> Vec<(String, String, i64)> {
        sqlx::query_as::<_, (String, String, i64)>(
            "SELECT tag_id, name, usage_count FROM tags_cache ORDER BY tag_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// 100 tags → rebuild → mutate (add, remove, rename, usage_count
    /// change) → rebuild → assert cache reflects the new source state.
    #[tokio::test]
    async fn rebuild_tags_cache_incremental_parity_m2() {
        let (pool, _dir) = test_pool().await;

        // Seed: 100 tags (50 with 1 usage each, 50 with 0 usage).
        for i in 0..100 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let name = format!("tag-{i:04}");
            insert_tag(&pool, &id, &name).await;
            if i < 50 {
                let bid = format!("BLKM2{i:04}AAAAAAAAAAAAAAAAA");
                insert_content(&pool, &bid, "note").await;
                add_tag(&pool, &bid, &id).await;
            }
        }

        let first = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(first, 100, "baseline inserts 100 rows");

        // Mutate:
        //   A) 10 tags renamed (TAGM2 0000..0009).
        //   B) 5 tags removed (TAGM2 0090..0094).
        //   C) 5 new tags added (TAGM2 0100..0104).
        //   D) 10 tags get a usage_count bump (TAGM2 0050..0059, all currently 0).
        for i in 0..10 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let new_name = format!("renamed-{i:04}");
            rename_tag(&pool, &id, &new_name).await;
        }
        for i in 90..95 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            soft_delete(&pool, &id).await;
        }
        for i in 100..105 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let name = format!("new-tag-{i:04}");
            insert_tag(&pool, &id, &name).await;
        }
        for i in 50..60 {
            let tag_id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let bid = format!("BUMP{i:04}AAAAAAAAAAAAAAAAAAA");
            insert_content(&pool, &bid, "bump").await;
            add_tag(&pool, &bid, &tag_id).await;
        }

        let touched = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        // 10 renames + 5 deletes + 5 inserts + 10 usage bumps = 30.
        assert_eq!(
            touched, 30,
            "diff = 10 renames + 5 deletes + 5 inserts + 10 usage bumps"
        );

        // Build the expected set from the source data.
        let mut expected: Vec<(String, String, i64)> = Vec::new();
        for i in 0..100 {
            if (90..95).contains(&i) {
                continue;
            }
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            let name = if i < 10 {
                format!("renamed-{i:04}")
            } else {
                format!("tag-{i:04}")
            };
            let usage_count: i64 = i64::from(i < 50 || (50..60).contains(&i));
            expected.push((id, name, usage_count));
        }
        for i in 100..105 {
            let id = format!("TAGM2{i:04}AAAAAAAAAAAAAAAAA");
            expected.push((id, format!("new-tag-{i:04}"), 0));
        }
        expected.sort();

        let actual = snapshot(&pool).await;
        assert_eq!(actual, expected, "cache must reflect mutated source");
    }

    /// Rename-collision: tag A renamed to the name still held by unchanged tag B.
    ///
    /// With `INSERT OR IGNORE` the new row for A was silently dropped because B
    /// still occupied the UNIQUE(name) slot (B was not in the delete set). With
    /// the deterministic de-dup projection (#626), the smaller-id tag wins the
    /// shared name and the cache stays correct.
    #[tokio::test]
    async fn tags_cache_rename_collision_does_not_silently_drop_tag() {
        let (pool, _dir) = test_pool().await;

        // Tag A: id=TAG_AA, initial name "alpha"
        // Tag B: id=TAG_BB, name "beta" — will NOT be renamed
        insert_tag(&pool, "TAG_AAAAAAAAAAAAAAAAAAAAAAA", "alpha").await;
        insert_tag(&pool, "TAG_BBBBBBBBBBBBBBBBBBBBBBB", "beta").await;

        // Baseline rebuild — both tags in cache
        let first = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(first, 2, "baseline must insert 2 rows");

        // Rename tag A to "beta" — now A and B both want the name "beta".
        // A has the smaller id (TAG_AA... < TAG_BB...), so A deterministically
        // wins the "beta" slot.
        rename_tag(&pool, "TAG_AAAAAAAAAAAAAAAAAAAAAAA", "beta").await;

        // Incremental rebuild must not silently drop the winning tag A
        let _changed = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();

        let cache = snapshot(&pool).await;
        let tag_a_row = cache
            .iter()
            .find(|(id, _, _)| id == "TAG_AAAAAAAAAAAAAAAAAAAAAAA");
        assert!(
            tag_a_row.is_some(),
            "tag A must still appear in the cache after rename collision; cache = {cache:?}"
        );
        assert_eq!(
            tag_a_row.unwrap().1,
            "beta",
            "tag A must carry its new name 'beta'"
        );
    }

    /// #626 — two LIVE tags sharing a name must NOT flip-flop forever.
    ///
    /// `tags_cache.name` is UNIQUE but two live tags can legitimately share a
    /// name (rename collision / two devices each create `#project` then sync).
    /// The old `INSERT OR REPLACE` rebuild evicted one and re-inserted the
    /// other on *every* rebuild → perpetual flip-flop (`changed >= 1` forever,
    /// one tag permanently invisible). With the deterministic de-dup projection
    /// the smaller-id tag wins the name on *every* rebuild, so the cache
    /// converges: the same winner each time, and the third rebuild is a no-op.
    #[tokio::test]
    async fn tags_cache_duplicate_name_converges_no_flip_flop() {
        let (pool, _dir) = test_pool().await;

        // Two live tags that share the name "project". A has the smaller id.
        insert_tag(&pool, "TAGDUPA0000000000000000000", "project").await;
        insert_tag(&pool, "TAGDUPB0000000000000000000", "project").await;
        // Give the LOSER (B) the higher usage so we can prove the winner is
        // chosen by id, not by usage_count.
        insert_content(&pool, "BLKDUP00000000000000000000", "note").await;
        add_tag(
            &pool,
            "BLKDUP00000000000000000000",
            "TAGDUPB0000000000000000000",
        )
        .await;

        // Rebuild three times. Capture the winner each time.
        let mut winners: Vec<(String, String, i64)> = Vec::new();
        let mut changes: Vec<u64> = Vec::new();
        for _ in 0..3 {
            let changed = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
            changes.push(changed);
            let cache = snapshot(&pool).await;
            // Exactly one row may occupy the UNIQUE(name) slot for "project".
            let project_rows: Vec<_> = cache
                .iter()
                .filter(|(_, name, _)| name == "project")
                .cloned()
                .collect();
            assert_eq!(
                project_rows.len(),
                1,
                "exactly one tag may hold the UNIQUE name 'project'; cache = {cache:?}"
            );
            winners.push(project_rows.into_iter().next().unwrap());
        }

        // (1) STABLE: the SAME tag (smaller id, A) wins all three rebuilds.
        assert!(
            winners
                .iter()
                .all(|(id, _, _)| id == "TAGDUPA0000000000000000000"),
            "the smaller-id tag must win every rebuild (deterministic); winners = {winners:?}"
        );

        // (2) CONVERGED: the third rebuild reports zero diff ops — no flip-flop.
        assert_eq!(
            changes[2], 0,
            "third rebuild must converge to changed == 0 (no perpetual flip-flop); changes = {changes:?}"
        );
    }

    /// #1990 — two live tags that are NON-ASCII case-variants (`#Σ` / `#σ`)
    /// share one normalized identity (`normalize_tag_name`, the engine's tag
    /// key) and must converge to ONE cache row deterministically — the
    /// smallest-id winner — WITHOUT a UNIQUE-violation crash or flip-flop. The
    /// old `PARTITION BY content COLLATE NOCASE` dedup folded only ASCII, so it
    /// SPLIT these into two rows. This guards the Unicode-correct dedup.
    #[tokio::test]
    async fn tags_cache_unicode_case_variants_converge_1990() {
        let (pool, _dir) = test_pool().await;

        // Two live tags: capital sigma `Σ` (smaller id A) and lowercase
        // sigma `σ` (larger id B). normalize_tag_name folds both to `σ`.
        insert_tag(&pool, "TAGSIGA0000000000000000000", "Σ").await;
        insert_tag(&pool, "TAGSIGB0000000000000000000", "σ").await;
        // Give the LOSER (B) the higher usage to prove the winner is chosen by
        // id, not usage_count.
        insert_content(&pool, "BLKSIG00000000000000000000", "note").await;
        add_tag(
            &pool,
            "BLKSIG00000000000000000000",
            "TAGSIGB0000000000000000000",
        )
        .await;

        let mut winners: Vec<(String, String, i64)> = Vec::new();
        let mut changes: Vec<u64> = Vec::new();
        for _ in 0..3 {
            // No UNIQUE(name) crash: the dedup keeps exactly one of the
            // case-variants out of the insert set.
            let changed = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
            changes.push(changed);
            let cache = snapshot(&pool).await;
            // Exactly ONE cache row exists across both case-variants (they share
            // a normalized identity). The other is omitted, not duplicated.
            assert_eq!(
                cache.len(),
                1,
                "Unicode case-variants `Σ`/`σ` must converge to one cache row; cache = {cache:?}"
            );
            winners.push(cache.into_iter().next().unwrap());
        }

        // STABLE: the SAME smaller-id tag (A, `Σ`) wins every rebuild.
        assert!(
            winners
                .iter()
                .all(|(id, name, _)| id == "TAGSIGA0000000000000000000" && name == "Σ"),
            "the smaller-id tag (Σ) must win every rebuild; winners = {winners:?}"
        );
        // CONVERGED: third rebuild is a no-op (no flip-flop).
        assert_eq!(
            changes[2], 0,
            "third rebuild must converge to changed == 0; changes = {changes:?}"
        );
    }

    /// #1990 — the existing ASCII behaviour (a strict subset of the Unicode
    /// fold) must still hold: `#Foo`/`#foo` converge to one row, smaller-id
    /// winner. Belt-and-braces alongside the NOCASE convergence tests, pinning
    /// that the dedup-mechanism swap did not regress ASCII case-folding.
    #[tokio::test]
    async fn tags_cache_ascii_case_variants_still_converge_1990() {
        let (pool, _dir) = test_pool().await;
        insert_tag(&pool, "TAGFOOA0000000000000000000", "Foo").await;
        insert_tag(&pool, "TAGFOOB0000000000000000000", "foo").await;

        let changed = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(changed, 1, "ASCII case-variants insert exactly one row");
        let cache = snapshot(&pool).await;
        assert_eq!(
            cache.len(),
            1,
            "Foo/foo converge to one row; cache = {cache:?}"
        );
        assert_eq!(
            cache[0].0, "TAGFOOA0000000000000000000",
            "smaller-id Foo wins"
        );
        // Idempotent second rebuild.
        assert_eq!(rebuild_tags_cache_impl(&pool, &pool).await.unwrap(), 0);
    }

    async fn remove_tag_edge(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query!(
            "DELETE FROM block_tags WHERE block_id = ? AND tag_id = ?",
            block_id,
            tag_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Build a FRESH cache from scratch via the full rebuild, into a
    /// throwaway clone of the live state, so we can compare the scoped
    /// refresh's result against the authoritative full rebuild. Here we
    /// simply run the full rebuild on the same pool AFTER capturing the
    /// scoped-refresh snapshot, since the full rebuild is idempotent and
    /// converges to the canonical desired state.
    async fn full_rebuild_snapshot(pool: &SqlitePool) -> Vec<(String, String, i64)> {
        rebuild_tags_cache_impl(pool, pool).await.unwrap();
        snapshot(pool).await
    }

    /// #676 — the scoped single-tag refresh must produce the SAME
    /// `tags_cache` as a full rebuild for add / remove / re-add (dedupe) /
    /// remove-missing, AND must not touch unrelated tags' rows.
    #[tokio::test]
    async fn refresh_tag_usage_count_matches_full_rebuild_all_cases() {
        let (pool, _dir) = test_pool().await;

        // Three tags; two content blocks.
        insert_tag(&pool, "TAGA0000000000000000000000", "alpha").await;
        insert_tag(&pool, "TAGB0000000000000000000000", "beta").await;
        insert_tag(&pool, "TAGC0000000000000000000000", "gamma").await;
        insert_content(&pool, "BLK10000000000000000000000", "n1").await;
        insert_content(&pool, "BLK20000000000000000000000", "n2").await;

        // Baseline: full rebuild seeds all three tags at usage 0.
        assert_eq!(rebuild_tags_cache_impl(&pool, &pool).await.unwrap(), 3);
        // Give beta a stable usage of 1 (unrelated to the tag we refresh)
        // and capture its row so we can prove it is never disturbed.
        add_tag(
            &pool,
            "BLK10000000000000000000000",
            "TAGB0000000000000000000000",
        )
        .await;
        rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        let beta_before = snapshot(&pool)
            .await
            .into_iter()
            .find(|(id, _, _)| id == "TAGB0000000000000000000000")
            .unwrap();
        assert_eq!(beta_before.2, 1);

        // ── ADD: add alpha to BLK1, refresh just alpha ───────────────────
        add_tag(
            &pool,
            "BLK10000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        let after_add = snapshot(&pool).await;
        // Unrelated tag beta untouched.
        let beta_after = after_add
            .iter()
            .find(|(id, _, _)| id == "TAGB0000000000000000000000")
            .unwrap()
            .clone();
        assert_eq!(beta_after, beta_before, "ADD must not touch unrelated beta");
        // Identical to a full rebuild.
        assert_eq!(
            after_add,
            full_rebuild_snapshot(&pool).await,
            "ADD: scoped refresh must equal full rebuild"
        );

        // ── RE-ADD (dedupe): adding alpha to BLK2 → usage 2; re-adding the
        //    SAME (BLK2, alpha) edge is a PK-dup no-op at the op layer, so
        //    the count stays 2. Prove the scoped refresh agrees with a full
        //    rebuild after the second (deduped) add. ─────────────────────
        add_tag(
            &pool,
            "BLK20000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        // Second add of the identical edge is suppressed by the (block_id,
        // tag_id) PK — simulate the op layer's idempotence by attempting it
        // and ignoring the unique violation.
        let _ = sqlx::query!(
            "INSERT OR IGNORE INTO block_tags (block_id, tag_id) VALUES (?, ?)",
            "BLK20000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .execute(&pool)
        .await
        .unwrap();
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        let after_readd = snapshot(&pool).await;
        let alpha_readd = after_readd
            .iter()
            .find(|(id, _, _)| id == "TAGA0000000000000000000000")
            .unwrap();
        assert_eq!(alpha_readd.2, 2, "RE-ADD must dedupe to usage 2, not 3");
        assert_eq!(
            after_readd,
            full_rebuild_snapshot(&pool).await,
            "RE-ADD: scoped refresh must equal full rebuild"
        );

        // ── REMOVE: drop alpha from BLK1 → usage back to 1 ──────────────
        remove_tag_edge(
            &pool,
            "BLK10000000000000000000000",
            "TAGA0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGA0000000000000000000000")
            .await
            .unwrap();
        let after_remove = snapshot(&pool).await;
        let alpha_remove = after_remove
            .iter()
            .find(|(id, _, _)| id == "TAGA0000000000000000000000")
            .unwrap();
        assert_eq!(alpha_remove.2, 1, "REMOVE must drop alpha usage to 1");
        assert_eq!(
            after_remove
                .iter()
                .find(|(id, _, _)| id == "TAGB0000000000000000000000")
                .unwrap()
                .clone(),
            beta_before,
            "REMOVE must not touch unrelated beta"
        );
        assert_eq!(
            after_remove,
            full_rebuild_snapshot(&pool).await,
            "REMOVE: scoped refresh must equal full rebuild"
        );

        // ── REMOVE-MISSING: remove a (block, tag) edge that does not exist
        //    (gamma was never added). The refresh must be a no-op that
        //    still equals a full rebuild (gamma stays at usage 0). ────────
        remove_tag_edge(
            &pool,
            "BLK10000000000000000000000",
            "TAGC0000000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGC0000000000000000000000")
            .await
            .unwrap();
        let after_missing = snapshot(&pool).await;
        let gamma = after_missing
            .iter()
            .find(|(id, _, _)| id == "TAGC0000000000000000000000")
            .unwrap();
        assert_eq!(gamma.2, 0, "REMOVE-MISSING: gamma stays at usage 0");
        assert_eq!(
            after_missing,
            full_rebuild_snapshot(&pool).await,
            "REMOVE-MISSING: scoped refresh must equal full rebuild"
        );
    }

    /// #676 — the scoped refresh must respect the same name-deduplication
    /// rule as the full rebuild: a name *loser* (a larger-id tag sharing a
    /// name with a smaller-id tag) has NO cache slot, so refreshing it must
    /// be a no-op that does not resurrect a row a full rebuild would omit.
    #[tokio::test]
    async fn refresh_tag_usage_count_respects_name_dedup_loser() {
        let (pool, _dir) = test_pool().await;
        // A (smaller id) and B (larger id) share the name "project".
        insert_tag(&pool, "TAGDUPA0000000000000000000", "project").await;
        insert_tag(&pool, "TAGDUPB0000000000000000000", "project").await;
        insert_content(&pool, "BLKZ0000000000000000000000", "note").await;

        // Full rebuild: only the winner A holds the "project" slot.
        rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        let cache = snapshot(&pool).await;
        assert!(
            cache
                .iter()
                .any(|(id, _, _)| id == "TAGDUPA0000000000000000000")
        );
        assert!(
            !cache
                .iter()
                .any(|(id, _, _)| id == "TAGDUPB0000000000000000000"),
            "loser B must not be in the cache"
        );

        // Add an edge to the LOSER B and refresh it. The scoped refresh must
        // NOT insert B (it has no UNIQUE(name) slot) — identical to a full
        // rebuild, which still omits B.
        add_tag(
            &pool,
            "BLKZ0000000000000000000000",
            "TAGDUPB0000000000000000000",
        )
        .await;
        let touched = refresh_tag_usage_count_impl(&pool, "TAGDUPB0000000000000000000")
            .await
            .unwrap();
        assert_eq!(touched, 0, "refreshing a name-loser must be a no-op");
        assert!(
            !snapshot(&pool)
                .await
                .iter()
                .any(|(id, _, _)| id == "TAGDUPB0000000000000000000"),
            "loser B must still be absent after a scoped refresh"
        );
        assert_eq!(
            snapshot(&pool).await,
            full_rebuild_snapshot(&pool).await,
            "loser refresh must equal full rebuild"
        );
    }

    /// #1990 — the scoped refresh's name-dedup must use the full-Unicode
    /// `normalize_tag_name`, not ASCII NOCASE. A NON-ASCII case-variant loser
    /// (`#σ`, larger id, sharing the normalized identity of the smaller-id
    /// `#Σ` winner) has NO cache slot, so refreshing it must be a no-op — and
    /// refreshing the WINNER must (re)materialize exactly one row. The old SQL
    /// `NOT EXISTS … COLLATE NOCASE` guard would wrongly treat `#σ` as a
    /// winner and resurrect a second row.
    #[tokio::test]
    async fn refresh_tag_usage_count_respects_unicode_name_dedup_1990() {
        let (pool, _dir) = test_pool().await;
        // A (smaller id, `Σ`) and B (larger id, `σ`) share the normalized
        // identity `σ`.
        insert_tag(&pool, "TAGSIGA0000000000000000000", "Σ").await;
        insert_tag(&pool, "TAGSIGB0000000000000000000", "σ").await;
        insert_content(&pool, "BLKSIG00000000000000000000", "note").await;

        // Full rebuild: only winner A holds the slot.
        rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        let cache = snapshot(&pool).await;
        assert_eq!(cache.len(), 1, "exactly one row; cache = {cache:?}");
        assert_eq!(cache[0].0, "TAGSIGA0000000000000000000");

        // Add an edge to the LOSER B and refresh it → must be a no-op (B has no
        // UNIQUE(name) slot under the Unicode fold).
        add_tag(
            &pool,
            "BLKSIG00000000000000000000",
            "TAGSIGB0000000000000000000",
        )
        .await;
        let touched = refresh_tag_usage_count_impl(&pool, "TAGSIGB0000000000000000000")
            .await
            .unwrap();
        assert_eq!(
            touched, 0,
            "refreshing the Unicode case-variant loser is a no-op"
        );
        let after = snapshot(&pool).await;
        assert_eq!(
            after.len(),
            1,
            "loser must not resurrect a second row; cache = {after:?}"
        );
        assert_eq!(
            after[0].0, "TAGSIGA0000000000000000000",
            "winner A still owns the slot"
        );

        // Refreshing the WINNER A is the live path.
        add_tag(
            &pool,
            "BLKSIG00000000000000000000",
            "TAGSIGA0000000000000000000",
        )
        .await;
        refresh_tag_usage_count_impl(&pool, "TAGSIGA0000000000000000000")
            .await
            .unwrap();
        assert_eq!(
            snapshot(&pool).await,
            full_rebuild_snapshot(&pool).await,
            "winner refresh must equal full rebuild"
        );
    }

    /// #676 — the scoped refresh counts inline `#[ULID]` tag refs
    /// (`block_tag_refs`) in `usage_count`, exactly as the full rebuild's
    /// UNION does. Proves the two usage subqueries stay in lockstep.
    #[tokio::test]
    async fn refresh_tag_usage_count_includes_inline_refs_like_full_rebuild() {
        let (pool, _dir) = test_pool().await;
        insert_tag(&pool, "TAGREF00000000000000000000", "ref").await;
        insert_content(&pool, "SRC10000000000000000000000", "a").await;
        insert_content(&pool, "SRC20000000000000000000000", "b").await;
        rebuild_tags_cache_impl(&pool, &pool).await.unwrap();

        // One explicit edge + one inline ref → usage 2.
        add_tag(
            &pool,
            "SRC10000000000000000000000",
            "TAGREF00000000000000000000",
        )
        .await;
        sqlx::query!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            "SRC20000000000000000000000",
            "TAGREF00000000000000000000",
        )
        .execute(&pool)
        .await
        .unwrap();
        refresh_tag_usage_count_impl(&pool, "TAGREF00000000000000000000")
            .await
            .unwrap();
        let scoped = snapshot(&pool).await;
        assert_eq!(
            scoped
                .iter()
                .find(|(id, _, _)| id == "TAGREF00000000000000000000")
                .unwrap()
                .2,
            2,
            "usage must count explicit edge + inline ref"
        );
        assert_eq!(
            scoped,
            full_rebuild_snapshot(&pool).await,
            "inline-ref usage must equal full rebuild"
        );
    }

    /// Rebuild on unchanged source produces zero diff ops.
    #[tokio::test]
    async fn rebuild_tags_cache_idempotent_m2() {
        let (pool, _dir) = test_pool().await;
        for i in 0..50 {
            insert_tag(
                &pool,
                &format!("IDEMT{i:04}AAAAAAAAAAAAAAAAA"),
                &format!("idem-t-{i}"),
            )
            .await;
        }
        let first = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(first, 50);
        let second = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");
        assert_eq!(snapshot(&pool).await.len(), 50);
    }

    /// A registered space: a page block plus its `spaces` row, so
    /// `blocks.space_id` (FK → `spaces`) can point at it.
    async fn insert_space(pool: &SqlitePool, id: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, page_id) VALUES (?, 'page', 'space', ?)",
            id,
            id,
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query!("INSERT INTO spaces (id) VALUES (?)", id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_tag_in_space(pool: &SqlitePool, id: &str, name: &str, space_id: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content, space_id) VALUES (?, 'tag', ?, ?)",
            id,
            name,
            space_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// `(tag_id, name, usage_count, space_id)` in `tag_id` order.
    async fn snapshot_with_space(pool: &SqlitePool) -> Vec<TagRow> {
        sqlx::query_as::<_, TagRow>(
            "SELECT tag_id, name, usage_count, space_id FROM tags_cache ORDER BY tag_id",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    const SPACE_WORK: &str = "SPACEWORK00000000000000000";
    const SPACE_HOME: &str = "SPACEHOME00000000000000000";
    const TODO_WORK: &str = "TAG5237A000000000000000000";
    const TODO_HOME: &str = "TAG5237B000000000000000000";
    const TODO_HOME_DUP: &str = "TAG5237C000000000000000000";

    /// `todo` in Work (smallest id), `todo` in Home, and a same-space
    /// case-variant loser `Todo` in Home (largest id).
    async fn seed_todo_in_two_spaces(pool: &SqlitePool) {
        insert_space(pool, SPACE_WORK).await;
        insert_space(pool, SPACE_HOME).await;
        insert_tag_in_space(pool, TODO_WORK, "todo", SPACE_WORK).await;
        insert_tag_in_space(pool, TODO_HOME, "todo", SPACE_HOME).await;
        insert_tag_in_space(pool, TODO_HOME_DUP, "Todo", SPACE_HOME).await;
    }

    /// #5237 — the same name in two spaces is two tags: the full rebuild
    /// caches one row PER SPACE, the winner rule within a space is unchanged
    /// (smallest id, normalized name), and the cache converges.
    #[tokio::test]
    async fn tags_cache_same_name_in_two_spaces_keeps_one_row_per_space_5237() {
        let (pool, _dir) = test_pool().await;
        seed_todo_in_two_spaces(&pool).await;
        // Usage on the Home winner, from a Home block, proves the count rides
        // with its own row.
        insert_content(&pool, "BLK5237000000000000000000A", "note").await;
        sqlx::query!(
            "UPDATE blocks SET space_id = ? WHERE id = ?",
            SPACE_HOME,
            "BLK5237000000000000000000A",
        )
        .execute(&pool)
        .await
        .unwrap();
        add_tag(&pool, "BLK5237000000000000000000A", TODO_HOME).await;

        let mut changes = Vec::new();
        for _ in 0..3 {
            changes.push(rebuild_tags_cache_impl(&pool, &pool).await.unwrap());
            assert_eq!(
                snapshot_with_space(&pool).await,
                vec![
                    (
                        TODO_WORK.to_owned(),
                        "todo".to_owned(),
                        0,
                        Some(SPACE_WORK.to_owned())
                    ),
                    (
                        TODO_HOME.to_owned(),
                        "todo".to_owned(),
                        1,
                        Some(SPACE_HOME.to_owned())
                    ),
                ],
                "one `todo` row per space; the Home case-variant loser stays out"
            );
        }
        assert_eq!(changes, vec![2, 0, 0], "converges after the first rebuild");
    }

    /// #5237 — the incremental path from a cold cache: refreshing the Home
    /// `todo` while Work's `todo` already holds the name lands Home's own
    /// row (the old vault-wide UNIQUE evicted it), and the same-space loser
    /// is still a no-op. Scoped refresh equals a full rebuild throughout.
    #[tokio::test]
    async fn refresh_tag_usage_count_lands_same_name_in_second_space_5237() {
        let (pool, _dir) = test_pool().await;
        seed_todo_in_two_spaces(&pool).await;

        refresh_tag_usage_count_impl(&pool, TODO_WORK)
            .await
            .unwrap();
        let touched = refresh_tag_usage_count_impl(&pool, TODO_HOME)
            .await
            .unwrap();
        assert_eq!(touched, 1, "Home's `todo` is the winner of its own space");
        assert_eq!(
            refresh_tag_usage_count_impl(&pool, TODO_HOME_DUP)
                .await
                .unwrap(),
            0,
            "the same-space case-variant loser has no slot"
        );
        assert_eq!(
            snapshot_with_space(&pool).await,
            vec![
                (
                    TODO_WORK.to_owned(),
                    "todo".to_owned(),
                    0,
                    Some(SPACE_WORK.to_owned())
                ),
                (
                    TODO_HOME.to_owned(),
                    "todo".to_owned(),
                    0,
                    Some(SPACE_HOME.to_owned())
                ),
            ],
            "both spaces' `todo` rows are cached"
        );
        assert_eq!(
            snapshot(&pool).await,
            full_rebuild_snapshot(&pool).await,
            "scoped refresh must equal full rebuild"
        );
    }

    /// #5275 — a block that left the tag's space (its `block_tags` /
    /// `block_tag_refs` rows survive a move) no longer counts, on both the
    /// scoped refresh and the full rebuild.
    #[tokio::test]
    async fn tag_usage_count_excludes_blocks_in_another_space_5275() {
        let (pool, _dir) = test_pool().await;
        insert_space(&pool, SPACE_WORK).await;
        insert_space(&pool, SPACE_HOME).await;
        insert_tag_in_space(&pool, TODO_WORK, "todo", SPACE_WORK).await;
        // Two holders in Work; the one that will move holds the tag both
        // explicitly and inline, so each UNION arm's space predicate is what
        // drops it.
        insert_content(&pool, "BLK5275A00000000000000000A", "stays").await;
        insert_content(&pool, "BLK5275B00000000000000000B", "moves").await;
        for id in ["BLK5275A00000000000000000A", "BLK5275B00000000000000000B"] {
            sqlx::query!(
                "UPDATE blocks SET space_id = ? WHERE id = ?",
                SPACE_WORK,
                id
            )
            .execute(&pool)
            .await
            .unwrap();
        }
        add_tag(&pool, "BLK5275A00000000000000000A", TODO_WORK).await;
        add_tag(&pool, "BLK5275B00000000000000000B", TODO_WORK).await;
        sqlx::query!(
            "INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)",
            "BLK5275B00000000000000000B",
            TODO_WORK,
        )
        .execute(&pool)
        .await
        .unwrap();
        refresh_tag_usage_count_impl(&pool, TODO_WORK)
            .await
            .unwrap();
        assert_eq!(
            snapshot(&pool).await,
            vec![(TODO_WORK.to_owned(), "todo".to_owned(), 2)],
            "both same-space holders count"
        );

        // The double holder moves to Home; its `block_tags` and
        // `block_tag_refs` rows stay.
        sqlx::query!(
            "UPDATE blocks SET space_id = ? WHERE id = ?",
            SPACE_HOME,
            "BLK5275B00000000000000000B",
        )
        .execute(&pool)
        .await
        .unwrap();
        refresh_tag_usage_count_impl(&pool, TODO_WORK)
            .await
            .unwrap();
        assert_eq!(
            snapshot(&pool).await,
            vec![(TODO_WORK.to_owned(), "todo".to_owned(), 1)],
            "the scoped refresh drops the holder that left the space"
        );
        assert_eq!(
            full_rebuild_snapshot(&pool).await,
            vec![(TODO_WORK.to_owned(), "todo".to_owned(), 1)],
            "the full rebuild drops it too"
        );
    }

    /// The rebuild [`rebuild_tags_cache_split`] replaced, as it was: it took
    /// the writer lock, then compared the whole desired state with the whole
    /// cache and wrote the difference. The oracle the split is tested
    /// against (#6522).
    mod replaced {
        use super::super::*;

        async fn apply_sort_merge_rebuild(
            desired_conn: &mut sqlx::SqliteConnection,
            current_conn: &mut sqlx::SqliteConnection,
            write_conn: &mut sqlx::SqliteConnection,
            now: &str,
        ) -> Result<u64, AppError> {
            let mut desired_stream =
                sqlx::query_as::<_, TagRow>(DESIRED_TAGS_SQL).fetch(desired_conn);
            let mut current_stream =
                sqlx::query_as::<_, TagRow>(CURRENT_TAGS_SQL).fetch(current_conn);

            let mut deletes: Vec<String> = Vec::new();
            let mut inserts: Vec<TagRow> = Vec::new();
            let mut changed: u64 = 0;
            // #1990 — winning `(space_id, normalized name)` keys seen so far. The
            // desired stream is de-duplicated by that key in Rust (the smallest-id tag
            // wins each key); `seen` tracks those winners as the stream advances. The
            // desired stream stays `id`-ordered after the filter (we drop rows, never
            // reorder), so the sort-merge below still walks both streams in lockstep
            // on `id`.
            let mut seen: HashSet<(Option<String>, String)> = HashSet::new();

            let mut next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
            let mut next_current = current_stream.try_next().await?;

            loop {
                match (&next_desired, &next_current) {
                    (None, None) => break,
                    (Some(desired), None) => {
                        inserts.push(desired.clone());
                        changed += 1;
                        next_desired = next_desired_winner(&mut desired_stream, &mut seen).await?;
                    }
                    (None, Some((c_id, _, _, _))) => {
                        deletes.push(c_id.clone());
                        changed += 1;
                        next_current = current_stream.try_next().await?;
                    }
                    (Some(desired), Some(current)) => {
                        match desired.0.as_str().cmp(current.0.as_str()) {
                            Ordering::Less => {
                                inserts.push(desired.clone());
                                changed += 1;
                                next_desired =
                                    next_desired_winner(&mut desired_stream, &mut seen).await?;
                            }
                            Ordering::Greater => {
                                deletes.push(current.0.clone());
                                changed += 1;
                                next_current = current_stream.try_next().await?;
                            }
                            Ordering::Equal => {
                                if desired != current {
                                    // Name, usage_count and/or space changed — DELETE +
                                    // INSERT under PK. Counts as one logical change.
                                    deletes.push(current.0.clone());
                                    inserts.push(desired.clone());
                                    changed += 1;
                                }
                                next_desired =
                                    next_desired_winner(&mut desired_stream, &mut seen).await?;
                                next_current = current_stream.try_next().await?;
                            }
                        }
                    }
                }
            }

            drop(desired_stream);
            drop(current_stream);

            if !deletes.is_empty() || !inserts.is_empty() {
                apply_tags_diff(write_conn, &deletes, &inserts, now).await?;
            }

            Ok(changed)
        }

        pub(super) async fn rebuild_tags_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
            let now = agaric_core::time::now_rfc3339();
            // Three independent connections — two readers (desired + current
            // state streams) plus one writer for the diff transaction. Distinct
            // connections are required so the streams' mutable borrows don't
            // conflict. Snapshot consistency across the three connections is not
            // required: same stale-while-revalidate semantics as
            // `rebuild_agenda_cache_impl` (M-19b).
            let mut desired_conn = pool.acquire().await?;
            let mut current_conn = pool.acquire().await?;
            let mut tx = crate::db::begin_immediate_logged(pool, "cache_tags_rebuild").await?;

            let changed =
                apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx, &now)
                    .await?;

            if changed == 0 {
                return Ok(0);
            }

            tx.commit().await?;
            Ok(changed)
        }
    }

    /// Five tags — ALPHA and its name-loser ALPHB, BETA, the deleted GAMMA,
    /// DELTA — with usage from live and deleted blocks, and cache rows that
    /// are stale in their count (ALPHA's), held by a loser (ALPHB's) and by a
    /// deleted tag (GAMMA's), missing (BETA's) and right (DELTA's).
    async fn seed_tag_drift(pool: &SqlitePool) {
        for (id, name) in [
            ("ALPHA", "alpha"),
            ("ALPHB", "Alpha"),
            ("BETA", "beta"),
            ("GAMMA", "gamma"),
            ("DELTA", "delta"),
        ] {
            insert_tag(pool, id, name).await;
        }
        soft_delete(pool, "GAMMA").await;
        for id in ["B1", "B2", "B3"] {
            insert_content(pool, id, "note").await;
        }
        add_tag(pool, "B1", "ALPHA").await;
        add_tag(pool, "B2", "ALPHA").await;
        add_tag(pool, "B2", "BETA").await;
        add_tag(pool, "B3", "BETA").await;
        soft_delete(pool, "B3").await;
        sqlx::query(
            "INSERT INTO tags_cache (tag_id, space_id, name, usage_count, updated_at) VALUES \
             ('ALPHA', NULL, 'alpha', 0, ''), ('ALPHB', NULL, 'Alpha', 0, ''), \
             ('GAMMA', NULL, 'gamma', 0, ''), ('DELTA', NULL, 'delta', 0, '')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    fn cached(tag_id: &str, name: &str, usage_count: i64) -> (String, String, i64) {
        (tag_id.to_owned(), name.to_owned(), usage_count)
    }

    /// #6522: the split rebuild leaves `tags_cache` where the rebuild it
    /// replaced does, and changes the same tags.
    #[tokio::test]
    async fn rebuild_tags_cache_split_matches_the_rebuild_it_replaced_6522() {
        let (oracle_pool, _oracle_dir) = test_pool().await;
        let (pool, _dir) = test_pool().await;
        seed_tag_drift(&oracle_pool).await;
        seed_tag_drift(&pool).await;

        let oracle_changed = replaced::rebuild_tags_cache_impl(&oracle_pool)
            .await
            .unwrap();
        let changed = rebuild_tags_cache_impl(&pool, &pool).await.unwrap();

        assert_eq!(oracle_changed, 4, "ALPHA, ALPHB, BETA and GAMMA drifted");
        assert_eq!(changed, oracle_changed);
        assert_eq!(snapshot(&pool).await, snapshot(&oracle_pool).await);
        assert_eq!(
            snapshot(&pool).await,
            vec![
                cached("ALPHA", "alpha", 2),
                cached("BETA", "beta", 1),
                cached("DELTA", "delta", 0),
            ],
        );
        assert_eq!(
            rebuild_tags_cache_impl(&pool, &pool).await.unwrap(),
            0,
            "a second run finds nothing stale"
        );
    }

    /// #6522: the same, after every round of random writes to the tables the
    /// rebuild reads and to the cache itself.
    #[tokio::test]
    async fn rebuild_tags_cache_split_matches_the_rebuild_it_replaced_on_random_vaults_6522() {
        crate::cache::random_vault_tests::assert_rebuild_matches_oracle(
            "tags_cache",
            "tag_id, space_id, name, usage_count",
            async |pool| replaced::rebuild_tags_cache_impl(pool).await.unwrap(),
            async |pool| rebuild_tags_cache_impl(pool, pool).await.unwrap(),
        )
        .await;
    }

    /// #6522: the write half re-derives only the tags it is handed, from
    /// what the tables hold when it runs.
    #[tokio::test]
    async fn rederive_tags_of_touches_only_the_tags_named_6522() {
        let (pool, _dir) = test_pool().await;
        seed_tag_drift(&pool).await;
        assert_eq!(
            tags_with_stale_rows(&pool).await.unwrap(),
            ["ALPHA", "ALPHB", "BETA", "GAMMA"]
        );
        // A write lands after the read half: B1 loses its tag.
        sqlx::query("DELETE FROM block_tags WHERE block_id = 'B1'")
            .execute(&pool)
            .await
            .unwrap();

        let mut tx = pool.begin().await.unwrap();
        let changed = rederive_tags_of(&mut tx, &["ALPHA".to_owned(), "DELTA".to_owned()], "")
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(changed, 1, "ALPHA's count; DELTA was not stale");
        assert_eq!(
            snapshot(&pool).await,
            vec![
                cached("ALPHA", "alpha", 1),
                cached("ALPHB", "Alpha", 0),
                cached("DELTA", "delta", 0),
                cached("GAMMA", "gamma", 0),
            ],
            "ALPHA takes the count it has now, and the tags not named keep their planted rows"
        );
    }

    /// #6522: a tag named stale that has since lost its name to a smaller id
    /// loses its row, as the whole-vault de-duplication would have it.
    #[tokio::test]
    async fn rederive_tags_of_drops_a_tag_that_is_no_longer_its_names_winner_6522() {
        let (pool, _dir) = test_pool().await;
        insert_tag(&pool, "TAGB", "école").await;
        rebuild_tags_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(snapshot(&pool).await, vec![cached("TAGB", "école", 0)]);
        insert_tag(&pool, "TAGA", "ÉCOLE").await;

        let mut tx = pool.begin().await.unwrap();
        let changed = rederive_tags_of(&mut tx, &["TAGB".to_owned()], "")
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(changed, 1);
        assert_eq!(snapshot(&pool).await, vec![]);
    }

    /// #6522: with nothing stale the rebuild never asks for the writer lock,
    /// so it finishes while another connection holds it.
    #[tokio::test]
    async fn rebuild_tags_cache_takes_no_writer_lock_when_nothing_is_stale_6522() {
        let (pool, _dir) = test_pool().await;
        seed_tag_drift(&pool).await;
        rebuild_tags_cache(&pool).await.unwrap();

        let _writer = crate::db::begin_immediate_logged(&pool, "test_holds_the_lock")
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), rebuild_tags_cache(&pool))
            .await
            .expect("the rebuild must not wait for the writer lock")
            .unwrap();
    }

    /// #6522: what runs under the writer lock seeks the stale tags and their
    /// usage by id, and a space's tags by index; it never scans a table.
    #[tokio::test]
    async fn rederive_tags_of_never_scans_a_table_6522() {
        let (pool, _dir) = test_pool().await;
        for sql in [
            DESIRED_TAGS_OF_SQL,
            CURRENT_TAGS_OF_SQL,
            LIVE_TAGS_IN_SPACE_SQL,
        ] {
            let plan: Vec<(i64, i64, i64, String)> =
                sqlx::query_as(sqlx::AssertSqlSafe(format!("EXPLAIN QUERY PLAN {sql}")))
                    .bind("[]")
                    .fetch_all(&pool)
                    .await
                    .unwrap();
            let scans: Vec<&str> = plan
                .iter()
                .map(|row| row.3.as_str())
                .filter(|detail| {
                    detail.starts_with("SCAN")
                        && !detail.starts_with("SCAN (subquery")
                        && !detail.contains("json_each")
                })
                .collect();
            assert!(
                scans.is_empty(),
                "scans under the writer lock in `{sql}`: {scans:?}"
            );
        }
    }
}
