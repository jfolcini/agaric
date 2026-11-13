use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use sqlx::SqlitePool;
use std::cmp::Ordering;
use std::collections::BTreeSet;

use crate::db::MAX_SQL_PARAMS;
use agaric_core::error::AppError;

// `agenda_cache` PK is `(date, block_id)`. The chunked DELETE binds 2
// params per row → `MAX_SQL_PARAMS / 2 = 499` rows per chunk. The
// chunked `INSERT OR IGNORE` writes 3 columns per row
// (date, block_id, source) → `MAX_SQL_PARAMS / 3 = 333` rows per chunk.
// Mirrors the constant in `cache/block_tag_refs.rs`.
const DELETE_CHUNK: usize = MAX_SQL_PARAMS / 2; // 499
const INSERT_CHUNK: usize = MAX_SQL_PARAMS / 3; // 333

/// Apply an agenda diff inside an open transaction in chunks bounded by
/// [`MAX_SQL_PARAMS`].
///
/// Plan (a) from the fix: UPDATEs are folded into the merged
/// DELETE + INSERT lists. The PK is `(date, block_id)` so DELETE+INSERT
/// is equivalent to UPDATE on `source` — and avoids a specialised
/// chunked UPDATE statement.
///
/// `delete_rows` and `insert_rows` are caller-owned and may be empty;
/// each chunk emits a single multi-row statement so a 1000-row diff
/// produces 2 DELETEs + 3 INSERTs instead of 1000 individual statements.
async fn apply_agenda_diff(
    conn: &mut sqlx::SqliteConnection,
    delete_rows: &[(&str, &str)],
    insert_rows: &[((&str, &str), &str)],
) -> Result<(), AppError> {
    for chunk in delete_rows.chunks(DELETE_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?)").collect();
        let sql = format!(
            "DELETE FROM agenda_cache WHERE (date, block_id) IN ({})",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for (date, block_id) in chunk {
            q = q.bind(date).bind(block_id);
        }
        q.execute(&mut *conn).await?;
    }

    for chunk in insert_rows.chunks(INSERT_CHUNK) {
        let placeholders: Vec<&str> = chunk.iter().map(|_| "(?, ?, ?)").collect();
        let sql = format!(
            "INSERT OR IGNORE INTO agenda_cache (date, block_id, source) VALUES {}",
            placeholders.join(", ")
        );
        let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.as_str()));
        for ((date, block_id), source) in chunk {
            q = q.bind(date).bind(block_id).bind(source);
        }
        q.execute(&mut *conn).await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Desired-state SQL
// ---------------------------------------------------------------------------

/// 4-source UNION ALL projection that computes the desired state of
/// `agenda_cache` from the live database. The whole-vault read
/// ([`DESIRED_AGENDA_SQL`]) and the re-derivation of the stale blocks
/// ([`DESIRED_AGENDA_OF_SQL`]) are this one text, so any change to the
/// template-page filter, source semantics, or new column source is made
/// in exactly one place.
///
/// Sources, in order (first-wins on PK `(date, block_id)` after
/// the sort-merge dedup pass — M-19b):
/// 1. `block_properties` rows with a non-null `value_date` →
///    `source = 'property:<key>'`, `prio = 0`. The lifecycle timestamps
///    `created_at` / `completed_at` / `repeat-until` are excluded (#5074):
///    they record when a task changed state, not when it is due, and
///    projecting them pinned every task to its creation and completion
///    days. The set is the LIFECYCLE keys only, spelled as a literal because
///    the SQL is a `&str` constant. It is not "the date-valued builtins":
///    `due_date` and `scheduled_date` are date-valued builtins too, and they
///    are the agenda's two real sources — adding them here empties it.
/// 2. `block_tags` referencing tag blocks whose name matches
///    `date/YYYY-MM-DD` (exactly 15 chars) →
///    `source = 'tag:<tag_id>'`, `prio = 1`.
/// 3. `blocks.due_date` column → `source = 'column:due_date'`, `prio = 2`.
/// 4. `blocks.scheduled_date` column →
///    `source = 'column:scheduled_date'`, `prio = 3`.
///
/// Output is sorted by `(date, block_id, prio)` so:
///   - the sort-merge diff in [`merge_agenda_streams`] can walk this
///     stream alongside `agenda_cache` (also `ORDER BY date, block_id`)
///     in lockstep, and
///   - duplicate `(date, block_id)` rows produced by multiple sources
///     are adjacent with the lowest-priority (= highest-precedence)
///     row first; the merge loop drops the rest. This preserves the
///     pre-M-19b first-source-wins property without requiring a
///     `HashMap` materialisation.
///
/// The `prio` column is exposed in the outer `SELECT` because SQLite's
/// `ORDER BY` resolves against the result-column list. Callers ignore
/// the value beyond ordering.
///
/// Template-page filter: every source excludes blocks whose
/// owning page (`b.page_id`, denormalised by migration 0027) carries a
/// `template` property, so the agenda surface — and the Google Calendar
/// push layer that consumes it — never sees template scaffolding.
/// Top-level tags have `page_id IS NULL` and pass the `NOT EXISTS`
/// check vacuously.
///
/// Liveness: `deleted_at IS NULL` on every block reference is the sole
/// liveness guard. (The former `is_conflict` column / conflict-copy
/// exclusion was dropped in migration 0058; soft-delete is now the only
/// way a block is hidden.)
///
/// SQL/C9(c) (#345): the `date/YYYY-MM-DD` tag projection (the second
/// UNION arm) validates only the *digit shape* via `GLOB`
/// (`[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]`), not calendar
/// validity — a tag like `date/2025-13-99` passes the shape check and
/// is projected verbatim. This is intentional and left as-is: every
/// consumer self-guards (the FE date parser and the Google Calendar
/// push layer both reject malformed dates downstream), so an invalid
/// date string in the cache is inert. Enforcing month/day bounds (let
/// alone leap-year correctness) in portable SQLite would add a brittle
/// nested CASE for marginal benefit — see the issue's \"do not
/// over-engineer\" note.
macro_rules! desired_agenda_sql {
    ($of_property:literal, $of_tag:literal, $of_block:literal) => {
        concat!(
            "SELECT date, block_id, source, prio FROM (
            SELECT bp.value_date AS date, bp.block_id, 'property:' || bp.key AS source, 0 AS prio
            FROM block_properties bp
            JOIN blocks b ON b.id = bp.block_id
            WHERE bp.value_date IS NOT NULL AND b.deleted_at IS NULL
              AND bp.key NOT IN ('created_at', 'completed_at', 'repeat-until')
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )",
            $of_property,
            "
            UNION ALL
            SELECT SUBSTR(t.content, 6) AS date, bt.block_id, 'tag:' || bt.tag_id AS source, 1 AS prio
            FROM block_tags bt
            JOIN blocks t ON t.id = bt.tag_id
            JOIN blocks b ON b.id = bt.block_id
            WHERE t.block_type = 'tag'
              AND t.content LIKE 'date/%'
              AND LENGTH(t.content) = 15
              AND SUBSTR(t.content, 6, 4) GLOB '[0-9][0-9][0-9][0-9]'
              AND SUBSTR(t.content, 10, 1) = '-'
              AND SUBSTR(t.content, 11, 2) GLOB '[0-9][0-9]'
              AND SUBSTR(t.content, 13, 1) = '-'
              AND SUBSTR(t.content, 14, 2) GLOB '[0-9][0-9]'
              AND b.deleted_at IS NULL
              AND t.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )",
            $of_tag,
            "
            UNION ALL
            SELECT b.due_date AS date, b.id AS block_id, 'column:due_date' AS source, 2 AS prio
            FROM blocks b
            WHERE b.due_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )",
            $of_block,
            "
            UNION ALL
            SELECT b.scheduled_date AS date, b.id AS block_id, 'column:scheduled_date' AS source, 3 AS prio
            FROM blocks b
            WHERE b.scheduled_date IS NOT NULL
              AND b.deleted_at IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM block_properties tp
                WHERE tp.block_id = b.page_id AND tp.key = 'template'
              )",
            $of_block,
            "
        )
        ORDER BY date ASC, block_id ASC, prio ASC"
        )
    };
}

pub(crate) const DESIRED_AGENDA_SQL: &str = desired_agenda_sql!("", "", "");

/// [`DESIRED_AGENDA_SQL`] for the blocks in the JSON id array `?1` alone: the
/// same text with each source narrowed by the column that becomes its row's
/// `block_id`, so a block's rows here are its rows there.
const DESIRED_AGENDA_OF_SQL: &str = desired_agenda_sql!(
    "
              AND bp.block_id IN (SELECT value FROM json_each(?1))",
    "
              AND bt.block_id IN (SELECT value FROM json_each(?1))",
    "
              AND b.id IN (SELECT value FROM json_each(?1))"
);

const CURRENT_AGENDA_SQL: &str =
    "SELECT date, block_id, source FROM agenda_cache ORDER BY date ASC, block_id ASC";

/// [`CURRENT_AGENDA_SQL`] for the blocks in the JSON id array `?1` alone.
const CURRENT_AGENDA_OF_SQL: &str = "SELECT date, block_id, source FROM agenda_cache \
     WHERE block_id IN (SELECT value FROM json_each(?1)) ORDER BY date ASC, block_id ASC";

// ---------------------------------------------------------------------------
// Sort-merge rebuild core (M-19b)
// ---------------------------------------------------------------------------

/// A desired-agenda row stream — `(date, block_id, source, prio)` as
/// [`DESIRED_AGENDA_SQL`] yields it.
type DesiredAgendaStream<'a> = BoxStream<'a, Result<(String, String, String, i64), sqlx::Error>>;

/// A cached `agenda_cache` row stream — `(date, block_id, source)` as
/// [`CURRENT_AGENDA_SQL`] yields it.
type CurrentAgendaStream<'a> = BoxStream<'a, Result<(String, String, String), sqlx::Error>>;

/// One `(date, block_id)` key on which the desired rows and `agenda_cache`
/// disagree.
struct StaleAgendaRow<'a> {
    date: &'a str,
    block_id: &'a str,
    /// The source the key should carry; `None` when it should have no row.
    desired_source: Option<&'a str>,
    /// Whether `agenda_cache` holds a row for the key now.
    cached: bool,
}

/// Walk the desired and cached agenda rows in lockstep and hand every key
/// they disagree on to `on_stale`. Returns how many keys that was.
///
/// Both inputs share the sort key `(date, block_id)` (with the desired
/// stream additionally tie-breaking on source priority — see
/// [`DESIRED_AGENDA_SQL`]) so the merge runs in `O(n)` time and holds one
/// row of each stream.
async fn merge_agenda_streams(
    mut desired_stream: DesiredAgendaStream<'_>,
    mut current_stream: CurrentAgendaStream<'_>,
    mut on_stale: impl FnMut(StaleAgendaRow<'_>),
) -> Result<u64, AppError> {
    let mut changed: u64 = 0;

    // Pull the next *distinct* desired row, skipping any adjacent
    // duplicate `(date, block_id)` keys (lower-precedence sources from
    // the UNION ALL). Dedup must be bound to the desired-advance step —
    // if we did the skip in the merge loop body using the previously
    // emitted key, the `Ordering::Greater` arm (which only advances
    // current) would falsely classify the legitimate next desired row
    // as a duplicate of the one we just emitted.
    let mut prev_desired_key: Option<(String, String)> = None;
    macro_rules! pull_desired {
        () => {{
            let mut out: Option<(String, String, String)> = None;
            while let Some((d_date, d_block, d_source, _prio)) = desired_stream.try_next().await? {
                let key = (d_date.clone(), d_block.clone());
                if prev_desired_key.as_ref() == Some(&key) {
                    continue;
                }
                prev_desired_key = Some(key);
                out = Some((d_date, d_block, d_source));
                break;
            }
            out
        }};
    }

    let mut next_desired = pull_desired!();
    let mut next_current = current_stream.try_next().await?;

    loop {
        // Which side the smaller key is on: `Less` is a key only the desired
        // rows have, `Greater` one only the cache has.
        let side = match (&next_desired, &next_current) {
            (None, None) => break,
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (Some((d_date, d_block, _)), Some((c_date, c_block, _))) => {
                (d_date.as_str(), d_block.as_str()).cmp(&(c_date.as_str(), c_block.as_str()))
            }
        };
        if let (Ordering::Less | Ordering::Equal, Some((date, block_id, source))) =
            (side, &next_desired)
        {
            // Same key on both sides with the same source is the one case
            // that is not stale. A different source is a row whose upstream
            // moved (e.g. property → column): one logical change.
            let cached_source = match (side, &next_current) {
                (Ordering::Equal, Some((_, _, c_source))) => Some(c_source),
                _ => None,
            };
            if cached_source != Some(source) {
                on_stale(StaleAgendaRow {
                    date,
                    block_id,
                    desired_source: Some(source.as_str()),
                    cached: cached_source.is_some(),
                });
                changed += 1;
            }
        } else if let Some((date, block_id, _)) = &next_current {
            on_stale(StaleAgendaRow {
                date,
                block_id,
                desired_source: None,
                cached: true,
            });
            changed += 1;
        }
        if side != Ordering::Greater {
            next_desired = pull_desired!();
        }
        if side != Ordering::Less {
            next_current = current_stream.try_next().await?;
        }
    }

    Ok(changed)
}

/// The read half of [`rebuild_agenda_cache_split`]: the blocks with a key on
/// which the whole desired state and the whole cache disagree, in id order.
///
/// Two connections, because the two streams are walked together; each has
/// its own snapshot. A write that lands between the two is seen by one
/// stream only and at worst names a block that is not stale, which the write
/// half then finds nothing to change for.
async fn blocks_with_stale_agenda(read_pool: &SqlitePool) -> Result<Vec<String>, AppError> {
    let mut desired_conn = read_pool.acquire().await?;
    let mut current_conn = read_pool.acquire().await?;
    let mut stale = BTreeSet::new();
    merge_agenda_streams(
        sqlx::query_as(DESIRED_AGENDA_SQL).fetch(&mut *desired_conn),
        sqlx::query_as(CURRENT_AGENDA_SQL).fetch(&mut *current_conn),
        |row| {
            if !stale.contains(row.block_id) {
                stale.insert(row.block_id.to_owned());
            }
        },
    )
    .await?;
    Ok(stale.into_iter().collect())
}

/// Blocks re-derived per statement by [`rederive_agenda_of`], which bounds
/// the rows it holds at once when the whole cache is stale.
const REDERIVE_CHUNK: usize = 500;

/// The write half of [`rebuild_agenda_cache_split`]: bring the `agenda_cache`
/// rows of the blocks in `block_ids` to what [`DESIRED_AGENDA_SQL`] gives for
/// them now. It reads both sides again under the writer lock instead of
/// applying what the read phase saw, so a write that landed in between is
/// never undone. Returns the keys changed.
async fn rederive_agenda_of(
    conn: &mut sqlx::SqliteConnection,
    block_ids: &[String],
) -> Result<u64, AppError> {
    let mut changed = 0;
    for chunk in block_ids.chunks(REDERIVE_CHUNK) {
        let ids_json = serde_json::to_string(chunk)?;
        let desired: Vec<(String, String, String, i64)> = sqlx::query_as(DESIRED_AGENDA_OF_SQL)
            .bind(&ids_json)
            .fetch_all(&mut *conn)
            .await?;
        let current: Vec<(String, String, String)> = sqlx::query_as(CURRENT_AGENDA_OF_SQL)
            .bind(&ids_json)
            .fetch_all(&mut *conn)
            .await?;

        // A changed source is a DELETE + INSERT: the PK is `(date, block_id)`.
        let mut deletes: Vec<(String, String)> = Vec::new();
        let mut inserts: Vec<((String, String), String)> = Vec::new();
        changed += merge_agenda_streams(
            futures_util::stream::iter(desired.into_iter().map(Ok)).boxed(),
            futures_util::stream::iter(current.into_iter().map(Ok)).boxed(),
            |row| {
                let key = (row.date.to_owned(), row.block_id.to_owned());
                if row.cached {
                    deletes.push(key.clone());
                }
                if let Some(source) = row.desired_source {
                    inserts.push((key, source.to_owned()));
                }
            },
        )
        .await?;
        flush_pending_agenda_diff(conn, &deletes, &inserts).await?;
    }
    Ok(changed)
}

/// Hand one accumulated slice of the sort-merge diff to
/// [`apply_agenda_diff`], borrowing the owned keys as `&str` rows.
async fn flush_pending_agenda_diff(
    write_conn: &mut sqlx::SqliteConnection,
    deletes: &[(String, String)],
    inserts: &[((String, String), String)],
) -> Result<(), AppError> {
    let dels: Vec<(&str, &str)> = deletes
        .iter()
        .map(|(d, b)| (d.as_str(), b.as_str()))
        .collect();
    let ins: Vec<((&str, &str), &str)> = inserts
        .iter()
        .map(|((d, b), s)| ((d.as_str(), b.as_str()), s.as_str()))
        .collect();
    apply_agenda_diff(write_conn, &dels, &ins).await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// rebuild_agenda_cache (p1-t20)
// ---------------------------------------------------------------------------

/// Incremental rebuild of `agenda_cache`: [`rebuild_agenda_cache_split`] with
/// one pool for both halves.
///
/// The four sources are `DESIRED_AGENDA_SQL`'s, which is the single place
/// they are defined — including the #5074 exclusion of the lifecycle
/// timestamps (`created_at` / `completed_at` / `repeat-until`) from source 1.
#[tracing::instrument(skip(pool), err)]
pub async fn rebuild_agenda_cache(pool: &SqlitePool) -> Result<(), AppError> {
    rebuild_agenda_cache_split(pool, pool).await
}

/// Rebuild `agenda_cache` with the whole-vault comparison on `read_pool`.
///
/// 1. Streams the desired state from the 4 UNION ALL sources (sorted by
///    `(date, block_id, prio)` — see `DESIRED_AGENDA_SQL`) and the cache
///    (sorted by `(date, block_id)`) and walks them in lockstep, keeping the
///    ids of the blocks they disagree on.
/// 2. Takes the writer lock only when there are any, and under it re-derives
///    those blocks' rows ([`rederive_agenda_of`]).
///
/// A block that goes stale after step 1 read it is left to the rebuild its
/// own write enqueues, which runs after this one.
pub async fn rebuild_agenda_cache_split(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<(), AppError> {
    super::rebuild_with_timing("agenda", || {
        rebuild_agenda_cache_impl(write_pool, read_pool)
    })
    .await?;
    crate::derivations::record_split(
        write_pool,
        read_pool,
        crate::derivations::Derivation::Agenda,
    )
    .await
}

async fn rebuild_agenda_cache_impl(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<u64, AppError> {
    let stale = blocks_with_stale_agenda(read_pool).await?;
    if stale.is_empty() {
        return Ok(0);
    }
    let mut tx =
        crate::db::begin_immediate_logged(write_pool, "cache_agenda_rebuild_write").await?;
    let changed = rederive_agenda_of(&mut tx, &stale).await?;
    tx.commit().await?;
    Ok(changed)
}

// ---------------------------------------------------------------------------
// rewrite_agenda_cache_once — the one-shot #5074 rewrite
// ---------------------------------------------------------------------------

/// `app_settings` key recording that [`rewrite_agenda_cache_once`] has run.
const AGENDA_CACHE_REWRITE_MARKER: &str = "repair.agenda_cache_rewrite.v1";

/// One-shot rewrite of `agenda_cache` for #5074, which dropped `created_at` /
/// `completed_at` / `repeat-until` from `DESIRED_AGENDA_SQL`: only a rebuild
/// rewrites the rows the old projection left, and every write path since
/// maintains the new shape, so once per vault is enough.
///
/// The marker is written only after the rewrite commits, so a pass that fails
/// leaves it unset and the next boot retries; the rewrite is idempotent, so a
/// crash between the two only reruns it.
/// Returns whether this pass ran — false when the marker had already retired
/// it.
///
/// # Errors
/// Returns [`AppError`] if any statement fails.
pub async fn rewrite_agenda_cache_once(
    write_pool: &SqlitePool,
    read_pool: &SqlitePool,
) -> Result<bool, AppError> {
    let done: Option<String> = sqlx::query_scalar!(
        "SELECT value FROM app_settings WHERE key = ?",
        AGENDA_CACHE_REWRITE_MARKER,
    )
    .fetch_optional(write_pool)
    .await?;
    if done.is_some() {
        return Ok(false);
    }

    let changed = rebuild_agenda_cache_impl(write_pool, read_pool)
        .await?
        .to_string();
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)",
        AGENDA_CACHE_REWRITE_MARKER,
        changed,
        now,
    )
    .execute(write_pool)
    .await?;
    Ok(true)
}

// ---------------------------------------------------------------------------
// M-19b sort-merge tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests are scoped to this file (M-19b) so the parent
    //! `cache::tests` module — which sibling subagents may be appending
    //! to in parallel for `block_tag_refs.rs` and
    //! `projected_agenda.rs` — is not touched. Helpers below are
    //! local copies of the patterns in `cache/tests.rs`.
    use super::*;
    use tempfile::TempDir;

    async fn test_pool() -> (SqlitePool, TempDir) {
        crate::test_support::test_pool().await
    }

    async fn insert_block(pool: &SqlitePool, id: &str, block_type: &str, content: &str) {
        sqlx::query!(
            "INSERT INTO blocks (id, block_type, content) VALUES (?, ?, ?)",
            id,
            block_type,
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

    async fn set_property(pool: &SqlitePool, block_id: &str, key: &str, value_date: &str) {
        sqlx::query!(
            "INSERT OR REPLACE INTO block_properties (block_id, key, value_date) VALUES (?, ?, ?)",
            block_id,
            key,
            value_date,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_due_date(pool: &SqlitePool, block_id: &str, date: &str) {
        sqlx::query!(
            "UPDATE blocks SET due_date = ? WHERE id = ?",
            date,
            block_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn set_scheduled_date(pool: &SqlitePool, block_id: &str, date: &str) {
        sqlx::query!(
            "UPDATE blocks SET scheduled_date = ? WHERE id = ?",
            date,
            block_id,
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// Fetches every `(date, block_id, source)` row in `agenda_cache`,
    /// sorted for deterministic comparison.
    async fn snapshot(pool: &SqlitePool) -> Vec<(String, String, String)> {
        sqlx::query_as::<_, (String, String, String)>(
            "SELECT date, block_id, source FROM agenda_cache ORDER BY date, block_id, source",
        )
        .fetch_all(pool)
        .await
        .unwrap()
    }

    /// Generate a fixture spanning all four sources. Returns the
    /// expected canonical `(date, block_id, source)` triples sorted to
    /// match [`snapshot`].
    ///
    /// Layout (50 rows per source × 4 = 200):
    ///   - rows 000-049 → property `due` (date = 2025-01-DD)
    ///   - rows 050-099 → date-tag (date = 2025-02-DD via tag content)
    ///   - rows 100-149 → `blocks.due_date` column (date = 2025-03-DD)
    ///   - rows 150-199 → `blocks.scheduled_date` column (date = 2025-04-DD)
    async fn seed_mixed_fixture(pool: &SqlitePool) -> Vec<(String, String, String)> {
        let mut expected: Vec<(String, String, String)> = Vec::with_capacity(200);

        // Property source: 50 blocks with `due` value_date.
        for i in 0..50 {
            let id = format!("BLKP{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-01-{day:02}");
            insert_block(pool, &id, "content", "prop").await;
            set_property(pool, &id, "due", &date).await;
            expected.push((date, id, "property:due".to_string()));
        }

        // Tag source: 50 distinct date-tags + 50 blocks tagged once each.
        for i in 0..50 {
            let day = (i % 28) + 1;
            let tag_id = format!("DTAG{i:03}");
            let block_id = format!("BLKT{i:03}");
            let tag_content = format!("date/2025-02-{day:02}");
            insert_block(pool, &tag_id, "tag", &tag_content).await;
            insert_block(pool, &block_id, "content", "tag").await;
            add_tag(pool, &block_id, &tag_id).await;
            let date = format!("2025-02-{day:02}");
            expected.push((date, block_id, format!("tag:{tag_id}")));
        }

        // due_date column source: 50 blocks.
        for i in 0..50 {
            let id = format!("BLKD{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-03-{day:02}");
            insert_block(pool, &id, "content", "due").await;
            set_due_date(pool, &id, &date).await;
            expected.push((date, id, "column:due_date".to_string()));
        }

        // scheduled_date column source: 50 blocks.
        for i in 0..50 {
            let id = format!("BLKS{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-04-{day:02}");
            insert_block(pool, &id, "content", "sched").await;
            set_scheduled_date(pool, &id, &date).await;
            expected.push((date, id, "column:scheduled_date".to_string()));
        }

        expected.sort();
        expected
    }

    /// Mixed-source fixture (~200 rows across all four sources) — the
    /// sort-merge stream rebuild must produce the identical output set
    /// to the pre-M-19b HashMap path.
    #[tokio::test]
    async fn rebuild_streams_without_full_hashmap_materialization_m19b() {
        let (pool, _dir) = test_pool().await;
        let mut expected = seed_mixed_fixture(&pool).await;
        expected.sort();

        rebuild_agenda_cache(&pool).await.unwrap();

        let actual = snapshot(&pool).await;
        assert_eq!(actual.len(), 200, "exactly 200 agenda rows expected");
        assert_eq!(
            actual, expected,
            "sort-merge output must match the canonical desired set"
        );
    }

    /// #5074: a task's lifecycle timestamps are not agenda dates. One block
    /// carrying every date-valued lifecycle key plus a real `due` property
    /// projects exactly the `due` row; only that key reaches the cache.
    #[tokio::test]
    async fn lifecycle_timestamps_are_not_agenda_sources_5074() {
        let (pool, _dir) = test_pool().await;
        insert_block(&pool, "LIFE01", "content", "task").await;
        set_property(&pool, "LIFE01", "created_at", "2026-04-15").await;
        set_property(&pool, "LIFE01", "completed_at", "2026-04-20").await;
        set_property(&pool, "LIFE01", "repeat-until", "2026-12-31").await;
        set_property(&pool, "LIFE01", "due", "2026-05-01").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        assert_eq!(
            snapshot(&pool).await,
            vec![(
                "2026-05-01".to_owned(),
                "LIFE01".to_owned(),
                "property:due".to_owned()
            )],
            "created_at / completed_at / repeat-until must not project"
        );
    }

    /// Rebuild over an unchanged source set must report zero logical
    /// changes on the second pass. Exercises the `Ordering::Equal` arm
    /// of the merge with no source drift.
    #[tokio::test]
    async fn rebuild_with_no_changes_is_idempotent_m19b() {
        let (pool, _dir) = test_pool().await;
        seed_mixed_fixture(&pool).await;

        let first = rebuild_agenda_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(first, 200, "first pass inserts every row");

        let second = rebuild_agenda_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(second, 0, "idempotent rebuild must produce zero diff ops");

        assert_eq!(
            snapshot(&pool).await.len(),
            200,
            "row count must be preserved on idempotent rebuild"
        );
    }

    /// Modify 10 rows (source change), insert 5 new rows, and remove 5
    /// existing rows from the source data. The merge must touch
    /// **exactly** those 20 rows — 10 source updates + 5 inserts + 5
    /// deletes — and nothing else.
    #[tokio::test]
    async fn rebuild_diffs_correctly_when_subset_of_rows_changed_m19b() {
        let (pool, _dir) = test_pool().await;

        // Seed: 100 blocks via `property:due` for distinct dates.
        for i in 0..100 {
            let id = format!("DIFF{i:03}");
            let day = (i % 28) + 1;
            let month = (i / 28) + 1; // 1..=4
            let date = format!("2025-{month:02}-{day:02}");
            insert_block(&pool, &id, "content", "diff").await;
            set_property(&pool, &id, "due", &date).await;
        }

        let baseline = rebuild_agenda_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(baseline, 100, "baseline inserts 100 rows");
        assert_eq!(
            snapshot(&pool).await.len(),
            100,
            "baseline cache has 100 rows"
        );

        // Mutation A: 10 rows shift from `property:due` → `column:due_date`.
        // Drop the property and write the same date to the blocks column,
        // so the row's PK `(date, block_id)` is unchanged but `source`
        // moves from `property:due` to `column:due_date`.
        for i in 0..10 {
            let id = format!("DIFF{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-01-{day:02}");
            sqlx::query!(
                "DELETE FROM block_properties WHERE block_id = ? AND key = 'due'",
                id,
            )
            .execute(&pool)
            .await
            .unwrap();
            set_due_date(&pool, &id, &date).await;
        }

        // Mutation B: 5 new rows added (block + property).
        for i in 0..5 {
            let id = format!("NEWB{i:03}");
            insert_block(&pool, &id, "content", "new").await;
            let date = format!("2026-01-{:02}", i + 1);
            set_property(&pool, &id, "due", &date).await;
        }

        // Mutation C: 5 rows removed by deleting the block_properties
        // entry (no other source remains for these blocks → drop from
        // agenda).
        for i in 90..95 {
            let id = format!("DIFF{i:03}");
            sqlx::query!(
                "DELETE FROM block_properties WHERE block_id = ? AND key = 'due'",
                id,
            )
            .execute(&pool)
            .await
            .unwrap();
        }

        let touched = rebuild_agenda_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(
            touched, 20,
            "diff must touch exactly 10 source-changes + 5 inserts + 5 deletes = 20"
        );

        // Final shape: 100 - 5 (deleted) + 5 (added) = 100 rows.
        let after = snapshot(&pool).await;
        assert_eq!(after.len(), 100, "row count = 100 - 5 + 5");

        // Verify the 10 source-changed rows now report `column:due_date`.
        for i in 0..10 {
            let id = format!("DIFF{i:03}");
            let day = (i % 28) + 1;
            let date = format!("2025-01-{day:02}");
            let row = after
                .iter()
                .find(|(d, b, _)| d == &date && b == &id)
                .unwrap_or_else(|| panic!("DIFF{i:03} should still be present"));
            assert_eq!(
                row.2, "column:due_date",
                "DIFF{i:03} source must have moved to column:due_date"
            );
        }

        // Verify the 5 inserted rows are present with `property:due`.
        for i in 0..5 {
            let id = format!("NEWB{i:03}");
            assert!(
                after
                    .iter()
                    .any(|(_, b, s)| b == &id && s == "property:due"),
                "NEWB{i:03} must be present with property:due"
            );
        }

        // Verify the 5 deleted rows are gone.
        for i in 90..95 {
            let id = format!("DIFF{i:03}");
            assert!(
                !after.iter().any(|(_, b, _)| b == &id),
                "DIFF{i:03} must have been deleted from cache"
            );
        }
    }

    /// The same `(date, block_id)` PK appearing from two distinct
    /// sources must collapse to a single row. The desired stream's
    /// `ORDER BY date, block_id, prio` puts the higher-precedence row
    /// (lower `prio`) first; the merge loop drops the rest.
    #[tokio::test]
    async fn rebuild_handles_duplicate_date_block_keys_via_dedup_m19b() {
        let (pool, _dir) = test_pool().await;

        // Same block: property AND scheduled_date column on the same date.
        // property has prio = 0, column:scheduled_date has prio = 3 →
        // property wins.
        insert_block(&pool, "DUPB", "content", "dup-prop-col").await;
        set_property(&pool, "DUPB", "scheduled", "2025-05-01").await;
        set_scheduled_date(&pool, "DUPB", "2025-05-01").await;

        // Second block: tag AND due_date column on the same date.
        // tag has prio = 1, column:due_date has prio = 2 → tag wins.
        insert_block(&pool, "DTAGZ", "tag", "date/2025-05-02").await;
        insert_block(&pool, "DUPC", "content", "dup-tag-col").await;
        add_tag(&pool, "DUPC", "DTAGZ").await;
        set_due_date(&pool, "DUPC", "2025-05-02").await;

        rebuild_agenda_cache(&pool).await.unwrap();

        let rows = snapshot(&pool).await;
        assert_eq!(
            rows.len(),
            2,
            "two distinct (date, block_id) pairs expected"
        );
        assert_eq!(
            rows[0],
            (
                "2025-05-01".to_string(),
                "DUPB".to_string(),
                "property:scheduled".to_string()
            ),
            "property source wins over column:scheduled_date for DUPB"
        );
        assert_eq!(
            rows[1],
            (
                "2025-05-02".to_string(),
                "DUPC".to_string(),
                "tag:DTAGZ".to_string()
            ),
            "tag source wins over column:due_date for DUPC"
        );
    }

    /// Seed a non-empty cache, drop every source-data row, then rebuild
    /// — the cache must be completely cleared. Exercises the
    /// "desired exhausted, drain current" path of the merge.
    #[tokio::test]
    async fn rebuild_with_empty_source_data_clears_cache_m19b() {
        let (pool, _dir) = test_pool().await;
        seed_mixed_fixture(&pool).await;
        rebuild_agenda_cache(&pool).await.unwrap();
        assert_eq!(
            snapshot(&pool).await.len(),
            200,
            "fixture produces 200 cache rows"
        );

        // Drop every source-data row that contributes to agenda_cache.
        // Soft-delete is sufficient — the SQL filters on `deleted_at IS
        // NULL`. We use a fixed timestamp to avoid clock noise.
        sqlx::query("UPDATE blocks SET deleted_at = 1767139200000")
            .execute(&pool)
            .await
            .unwrap();

        let cleared = rebuild_agenda_cache_impl(&pool, &pool).await.unwrap();
        assert_eq!(cleared, 200, "every cache row must be deleted");
        assert_eq!(
            snapshot(&pool).await.len(),
            0,
            "agenda_cache must be empty after source data is removed"
        );
    }

    /// The rebuild [`rebuild_agenda_cache_split`] replaced, as it was: it
    /// took the writer lock, then compared the whole desired state with the
    /// whole cache and wrote the difference. The oracle the split is tested
    /// against (#6522).
    mod replaced {
        use super::super::*;

        const STREAM_BATCH: usize = INSERT_CHUNK;

        async fn apply_sort_merge_rebuild(
            desired_conn: &mut sqlx::SqliteConnection,
            current_conn: &mut sqlx::SqliteConnection,
            write_conn: &mut sqlx::SqliteConnection,
        ) -> Result<u64, AppError> {
            let mut desired_stream =
                sqlx::query_as::<_, (String, String, String, i64)>(DESIRED_AGENDA_SQL).fetch(desired_conn);
            let mut current_stream =
                sqlx::query_as::<_, (String, String, String)>(CURRENT_AGENDA_SQL).fetch(current_conn);

            let mut deletes: Vec<(String, String)> = Vec::with_capacity(STREAM_BATCH);
            let mut inserts: Vec<((String, String), String)> = Vec::with_capacity(STREAM_BATCH);

            let changed = merge_agenda_streams(
                &mut desired_stream,
                &mut current_stream,
                write_conn,
                &mut deletes,
                &mut inserts,
            )
            .await?;

            // Drop both readers before the final flush — defensive, since
            // `write_conn` is independent of either stream's borrow but
            // dropping early releases the two read connections sooner.
            drop(desired_stream);
            drop(current_stream);

            if !deletes.is_empty() || !inserts.is_empty() {
                flush_pending_agenda_diff(write_conn, &deletes, &inserts).await?;
            }

            Ok(changed)
        }

        async fn merge_agenda_streams(
            desired_stream: &mut DesiredAgendaStream<'_>,
            current_stream: &mut CurrentAgendaStream<'_>,
            write_conn: &mut sqlx::SqliteConnection,
            deletes: &mut Vec<(String, String)>,
            inserts: &mut Vec<((String, String), String)>,
        ) -> Result<u64, AppError> {
            let mut changed: u64 = 0;

            // Pull the next *distinct* desired row, skipping any adjacent
            // duplicate `(date, block_id)` keys (lower-precedence sources from
            // the UNION ALL). Dedup must be bound to the desired-advance step —
            // if we did the skip in the merge loop body using the previously
            // emitted key, the `Ordering::Greater` arm (which only advances
            // current) would falsely classify the legitimate next desired row
            // as a duplicate of the one we just emitted.
            let mut prev_desired_key: Option<(String, String)> = None;
            macro_rules! pull_desired {
                () => {{
                    let mut out: Option<(String, String, String)> = None;
                    while let Some((d_date, d_block, d_source, _prio)) = desired_stream.try_next().await? {
                        let key = (d_date.clone(), d_block.clone());
                        if prev_desired_key.as_ref() == Some(&key) {
                            continue;
                        }
                        prev_desired_key = Some(key);
                        out = Some((d_date, d_block, d_source));
                        break;
                    }
                    out
                }};
            }

            let mut next_desired = pull_desired!();
            let mut next_current = current_stream.try_next().await?;

            loop {
                match (&next_desired, &next_current) {
                    (None, None) => break,
                    (Some((d_date, d_block, d_source)), None) => {
                        // Current exhausted — every remaining desired row is a
                        // pure INSERT.
                        inserts.push(((d_date.clone(), d_block.clone()), d_source.clone()));
                        changed += 1;
                        next_desired = pull_desired!();
                    }
                    (None, Some((c_date, c_block, _))) => {
                        // Desired exhausted — every remaining current row is a
                        // pure DELETE.
                        deletes.push((c_date.clone(), c_block.clone()));
                        changed += 1;
                        next_current = current_stream.try_next().await?;
                    }
                    (Some((d_date, d_block, d_source)), Some((c_date, c_block, c_source))) => {
                        let d_key = (d_date.as_str(), d_block.as_str());
                        let c_key = (c_date.as_str(), c_block.as_str());
                        match d_key.cmp(&c_key) {
                            Ordering::Less => {
                                // Desired ahead in the lockstep walk → INSERT.
                                inserts.push(((d_date.clone(), d_block.clone()), d_source.clone()));
                                changed += 1;
                                next_desired = pull_desired!();
                            }
                            Ordering::Greater => {
                                // Current ahead → row no longer in desired set
                                // → DELETE.
                                deletes.push((c_date.clone(), c_block.clone()));
                                changed += 1;
                                next_current = current_stream.try_next().await?;
                            }
                            Ordering::Equal => {
                                // Same PK — compare source. If different, the
                                // row's source moved to a different upstream
                                // (e.g. property → column). Emit DELETE +
                                // INSERT, equivalent to UPDATE source under a
                                // PK of `(date, block_id)`. Counts as a single
                                // logical change to match pre-M-19b
                                // `to_update.len()` semantics.
                                if d_source != c_source {
                                    deletes.push((c_date.clone(), c_block.clone()));
                                    inserts.push(((d_date.clone(), d_block.clone()), d_source.clone()));
                                    changed += 1;
                                }
                                next_desired = pull_desired!();
                                next_current = current_stream.try_next().await?;
                            }
                        }
                    }
                }

                // Flush whenever either buffer hits the threshold so peak
                // Rust-heap stays bounded at `O(STREAM_BATCH)`.
                if deletes.len() >= STREAM_BATCH || inserts.len() >= STREAM_BATCH {
                    flush_pending_agenda_diff(write_conn, deletes, inserts).await?;
                    deletes.clear();
                    inserts.clear();
                }
            }

            Ok(changed)
        }

        pub(super) async fn rebuild_agenda_cache_impl(pool: &SqlitePool) -> Result<u64, AppError> {
            // M-19b: three independent connections — two readers (desired +
            // current state streams) plus one writer for the diff transaction.
            // Distinct connections are required so the streams' mutable borrows
            // don't conflict and the writer can flush mid-stream. The original
            // single-tx snapshot guarantee is relaxed in exchange for
            // `O(STREAM_BATCH)` peak heap; any sub-millisecond drift between
            // snapshots is corrected by the next rebuild — identical
            // stale-while-revalidate semantics to the split-pool variant.
            let mut desired_conn = pool.acquire().await?;
            let mut current_conn = pool.acquire().await?;
            let mut tx = crate::db::begin_immediate_logged(pool, "cache_agenda_rebuild").await?;

            let changed = apply_sort_merge_rebuild(&mut desired_conn, &mut current_conn, &mut tx).await?;

            if changed == 0 {
                // No changes — transaction is rolled back on drop.
                return Ok(0);
            }

            tx.commit().await?;
            Ok(changed)
        }
    }

    /// Two blocks on dates, one of them on a templated page, a date tag, and
    /// cache rows that are missing (DUE's), stale in their source (SCHED's),
    /// and left behind for a block with no date (GONE's).
    async fn seed_agenda_drift(pool: &SqlitePool) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, page_id) VALUES \
             ('PG', 'page', 'p', NULL, 'PG'), ('TPL', 'page', 't', NULL, 'TPL'), \
             ('DUE', 'content', 'c', 'PG', 'PG'), ('SCHED', 'content', 'c', 'PG', 'PG'), \
             ('GONE', 'content', 'c', 'PG', 'PG'), ('RIGHT', 'content', 'c', 'PG', 'PG'), \
             ('INTPL', 'content', 'c', 'TPL', 'TPL'), ('DTAG', 'tag', 'date/2025-06-01', NULL, NULL)",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_text) VALUES ('TPL', 'template', 'true')",
        )
        .execute(pool)
        .await
        .unwrap();
        set_due_date(pool, "DUE", "2025-06-02").await;
        add_tag(pool, "DUE", "DTAG").await;
        set_scheduled_date(pool, "SCHED", "2025-06-03").await;
        set_due_date(pool, "RIGHT", "2025-06-04").await;
        set_due_date(pool, "INTPL", "2025-06-05").await;
        sqlx::query(
            "INSERT INTO agenda_cache (date, block_id, source) VALUES \
             ('2025-06-03', 'SCHED', 'property:scheduled'), ('2025-06-09', 'GONE', 'property:due'), \
             ('2025-06-04', 'RIGHT', 'column:due_date'), ('2025-06-05', 'INTPL', 'column:due_date')",
        )
        .execute(pool)
        .await
        .unwrap();
    }

    /// #6522: the split rebuild leaves `agenda_cache` where the rebuild it
    /// replaced does, and changes the same keys.
    #[tokio::test]
    async fn rebuild_agenda_cache_split_matches_the_rebuild_it_replaced_6522() {
        let (oracle_pool, _oracle_dir) = test_pool().await;
        let (pool, _dir) = test_pool().await;
        seed_agenda_drift(&oracle_pool).await;
        seed_agenda_drift(&pool).await;

        let oracle_changed = replaced::rebuild_agenda_cache_impl(&oracle_pool)
            .await
            .unwrap();
        let changed = rebuild_agenda_cache_impl(&pool, &pool).await.unwrap();

        assert_eq!(
            oracle_changed, 5,
            "DUE's two rows, SCHED's source, GONE's row and INTPL's"
        );
        assert_eq!(changed, oracle_changed);
        assert_eq!(snapshot(&pool).await, snapshot(&oracle_pool).await);
        let row = |date: &str, block: &str, source: &str| {
            (date.to_owned(), block.to_owned(), source.to_owned())
        };
        assert_eq!(
            snapshot(&pool).await,
            vec![
                row("2025-06-01", "DUE", "tag:DTAG"),
                row("2025-06-02", "DUE", "column:due_date"),
                row("2025-06-03", "SCHED", "column:scheduled_date"),
                row("2025-06-04", "RIGHT", "column:due_date"),
            ],
        );
        assert_eq!(
            rebuild_agenda_cache_impl(&pool, &pool).await.unwrap(),
            0,
            "a second run finds nothing stale"
        );
    }

    /// #6522: the same, after every round of random writes to the tables the
    /// rebuild reads and to the cache itself.
    #[tokio::test]
    async fn rebuild_agenda_cache_split_matches_the_rebuild_it_replaced_on_random_vaults_6522() {
        crate::cache::random_vault::assert_rebuild_matches_oracle(
            "agenda_cache",
            "date, block_id, source",
            async |pool| replaced::rebuild_agenda_cache_impl(pool).await.unwrap(),
            async |pool| rebuild_agenda_cache_impl(pool, pool).await.unwrap(),
        )
        .await;
    }

    /// #6522: the write half re-derives only the blocks it is handed, from
    /// what the tables hold when it runs.
    #[tokio::test]
    async fn rederive_agenda_of_touches_only_the_blocks_named_6522() {
        let (pool, _dir) = test_pool().await;
        seed_agenda_drift(&pool).await;
        let stale = blocks_with_stale_agenda(&pool).await.unwrap();
        assert_eq!(stale, ["DUE", "GONE", "INTPL", "SCHED"]);
        // A write lands after the read half: DUE's date moves.
        set_due_date(&pool, "DUE", "2025-07-07").await;

        let mut tx = pool.begin().await.unwrap();
        let changed = rederive_agenda_of(&mut tx, &["DUE".to_owned(), "RIGHT".to_owned()])
            .await
            .unwrap();
        tx.commit().await.unwrap();

        assert_eq!(changed, 2, "DUE's two rows; RIGHT was not stale");
        let rows = snapshot(&pool).await;
        assert!(
            rows.contains(&(
                "2025-07-07".to_owned(),
                "DUE".to_owned(),
                "column:due_date".to_owned()
            )),
            "DUE takes the date it has now, not the one the read half saw: {rows:?}"
        );
        assert!(
            rows.contains(&(
                "2025-06-09".to_owned(),
                "GONE".to_owned(),
                "property:due".to_owned()
            )),
            "GONE was not named, so its planted row stays: {rows:?}"
        );
    }

    /// #6522: with nothing stale the rebuild never asks for the writer lock,
    /// so it finishes while another connection holds it.
    #[tokio::test]
    async fn rebuild_agenda_cache_takes_no_writer_lock_when_nothing_is_stale_6522() {
        let (pool, _dir) = test_pool().await;
        seed_agenda_drift(&pool).await;
        rebuild_agenda_cache(&pool).await.unwrap();

        let _writer = crate::db::begin_immediate_logged(&pool, "test_holds_the_lock")
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            rebuild_agenda_cache(&pool),
        )
        .await
        .expect("the rebuild must not wait for the writer lock")
        .unwrap();
    }

    /// #6522: what runs under the writer lock seeks the stale blocks by id;
    /// it never scans a base table.
    #[tokio::test]
    async fn rederive_agenda_of_never_scans_a_base_table_6522() {
        let (pool, _dir) = test_pool().await;
        for sql in [DESIRED_AGENDA_OF_SQL, CURRENT_AGENDA_OF_SQL] {
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
            assert!(scans.is_empty(), "scans under the writer lock: {scans:?}");
        }
    }
}
