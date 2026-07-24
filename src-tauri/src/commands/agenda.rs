//! Agenda command handlers.

use std::collections::{BTreeMap, HashMap};

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::ReadPool;
use agaric_core::error::AppError;
use agaric_store::pagination::{ActiveBlockRow, ActiveProjectedAgendaEntry, Cursor};
use agaric_store::space::SpaceScope;

use super::*;

/// Count agenda items per date for a batch of dates in a single query.
///
/// Returns a `HashMap<date, count>` for dates that have at least one matching
/// agenda entry whose owning block is not soft-deleted.
///
/// `scope` — [`SpaceScope::Active`] restricts the count to
/// blocks whose owning page carries `space = ?space_id`.
/// [`SpaceScope::Global`] is the unscoped (pre-) behaviour
/// preserved for callsites that span every space.
///
/// # Errors
///
/// - [`AppError::Validation`] — `dates.len()` >
///   [`agaric_store::pagination::MAX_BATCH_BLOCK_IDS`]
/// - [`AppError::Validation`] — any date fails `YYYY-MM-DD` validation
#[instrument(skip(pool, dates), err)]
pub async fn count_agenda_batch_inner(
    pool: &SqlitePool,
    dates: Vec<String>,
    scope: &SpaceScope,
) -> Result<HashMap<String, usize>, AppError> {
    if dates.is_empty() {
        return Ok(HashMap::new());
    }
    crate::commands::ensure_batch_within_cap("dates", dates.len())?;
    // Validate all dates
    for d in &dates {
        validate_date_format(d)?;
    }
    // Marshal the date list into a JSON array and unwrap it inside SQL
    // via `json_each(?1)`. This replaces the previous runtime-formatted
    // `?1, ?2, …` placeholder list with a single bind, and lets us drop
    // through `sqlx::query!` for compile-time SQL verification (AGENTS.md
    // invariant #6). Mirrors the sibling `count_agenda_batch_by_source_inner`.
    //
    // ?2 (space filter) drives the shared space-filter clause.
    // The literal mirrors
    // [`agaric_store::space_filter_canonical::SPACE_FILTER_CANONICAL`] — kept
    // inline here because `sqlx::query!` requires a string literal and does
    // not accept `concat!()`. Filters on the first-class `b.space_id`
    // column (#533, migration 0086).
    let dates_json = serde_json::to_string(&dates)?;
    let space_filter = scope.as_filter_param();
    let rows = sqlx::query!(
        r#"SELECT ac.date, COUNT(*) AS "cnt!: i64"
         FROM agenda_cache ac
         JOIN blocks b ON b.id = ac.block_id
         WHERE ac.date IN (SELECT value FROM json_each(?1))
           AND b.deleted_at IS NULL
           AND (?2 IS NULL OR b.space_id = ?2)
         GROUP BY ac.date"#,
        dates_json,
        space_filter,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        // cnt is a non-negative count from SQL; safe to convert (I-CommandsCRUD-11)
        .map(|r| {
            (
                r.date,
                usize::try_from(r.cnt)
                    .expect("COUNT(*) is non-negative and fits in usize on 64-bit targets"),
            )
        })
        .collect())
}

/// Count agenda items per (date, source) for a batch of dates.
///
/// Returns a nested map: `date -> source -> count`. Only includes entries
/// whose owning block is not soft-deleted.
///
/// `scope` — [`SpaceScope::Active`] restricts the count to
/// blocks whose owning page carries `space = ?space_id`.
/// [`SpaceScope::Global`] is the unscoped (pre-) behaviour
/// preserved for callsites that span every space.
///
/// # Errors
///
/// - [`AppError::Validation`] — `dates.len()` >
///   [`agaric_store::pagination::MAX_BATCH_BLOCK_IDS`]
/// - [`AppError::Validation`] — any date fails `YYYY-MM-DD` validation
#[instrument(skip(pool, dates), err)]
pub async fn count_agenda_batch_by_source_inner(
    pool: &SqlitePool,
    dates: Vec<String>,
    scope: &SpaceScope,
) -> Result<HashMap<String, HashMap<String, usize>>, AppError> {
    if dates.is_empty() {
        return Ok(HashMap::new());
    }
    crate::commands::ensure_batch_within_cap("dates", dates.len())?;
    for d in &dates {
        validate_date_format(d)?;
    }
    let dates_json = serde_json::to_string(&dates)?;
    let scope_param = scope.as_filter_param();
    // ?2 (space filter) drives the shared space-filter clause.
    // The literal mirrors
    // [`agaric_store::space_filter_canonical::SPACE_FILTER_CANONICAL`] and filters
    // on the first-class `b.space_id` column (#533, migration 0086). Uses
    // the compile-time-checked `query!` macro — the only difference from
    // `count_agenda_batch_inner` is the extra `ac.source` output column.
    let rows = sqlx::query!(
        "SELECT ac.date, ac.source, COUNT(*) AS \"cnt!: i64\" \
         FROM agenda_cache ac \
         JOIN blocks b ON b.id = ac.block_id \
         WHERE ac.date IN (SELECT value FROM json_each(?1)) \
           AND b.deleted_at IS NULL \
           AND (?2 IS NULL OR b.space_id = ?2) \
         GROUP BY ac.date, ac.source",
        dates_json,
        scope_param,
    )
    .fetch_all(pool)
    .await?;
    let mut result: HashMap<String, HashMap<String, usize>> = HashMap::new();
    for row in rows {
        // cnt is a non-negative count from SQL; safe to convert (I-CommandsCRUD-11)
        result.entry(row.date).or_default().insert(
            row.source,
            usize::try_from(row.cnt)
                .expect("COUNT(*) is non-negative and fits in usize on 64-bit targets"),
        );
    }
    Ok(result)
}

/// Compute projected future agenda entries for repeating tasks.
///
/// First tries the `projected_agenda_cache` table (populated by the background
/// materializer). If the cache is empty AND no `cursor` was supplied (i.e.
/// this is the first page of a fresh request), falls back to the original
/// on-the-fly computation for first-run or pre-cache scenarios.
///
/// Returns a [`PageResponse`] of at most `limit` entries (default 200,
/// max 500). When more pages remain, `next_cursor` is populated and
/// `has_more` is `true` — pass `next_cursor` back as the `cursor` arg to
/// Fetch the next page (AGENTS.md invariant #3).
///
/// **Cursor encoding** (matches `list_agenda_range`'s H-8 convention):
/// the cursor is keyed on `(projected_date, block_id)` — the same
/// composite that the SQL `ORDER BY` uses — packed into
/// `Cursor::deleted_at` (date) + `Cursor::id` (block_id) and
/// base64-encoded JSON.
///
/// The on-the-fly fallback's `dot_plus` (`.+`) / `plus_plus` (`++`)
/// repeat-mode projection is anchored to `today`. We capture `today` once
/// here from `chrono::Local::now()` and thread it through. Tests that need
/// to pin a fixed `today` (so the assertion does not drift with the system
/// clock) call [`list_projected_agenda_on_the_fly`] directly — that also
/// bypasses the cache check, since the cache itself is rebuilt from
/// `chrono::Local::now()` and has the same drift problem.
#[instrument(skip(pool), err)]
pub async fn list_projected_agenda_inner(
    pool: &SqlitePool,
    start_date: String,
    end_date: String,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<PageResponse<ActiveProjectedAgendaEntry>, AppError> {
    // Production anchors recurrence projection to the device's local day; the
    // `_with_today` variant lets tests pin it so the cache rebuild, the #2601
    // horizon guard, and the on-the-fly fallback all share one reference date.
    let today = chrono::Local::now().date_naive();
    list_projected_agenda_inner_with_today(pool, start_date, end_date, cursor, limit, scope, today)
        .await
}

/// Pinned-`today` variant of [`list_projected_agenda_inner`]. Production reads
/// `chrono::Local::now()` via the wrapper above; tests inject a deterministic
/// `today` so fixtures with future-dated (`.+` / `++` today-anchored) repeat
/// rules — and the #2601 horizon fallback, which threads `today` into
/// [`list_projected_agenda_on_the_fly`] — stay stable across the wall clock.
pub(crate) async fn list_projected_agenda_inner_with_today(
    pool: &SqlitePool,
    start_date: String,
    end_date: String,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
    today: chrono::NaiveDate,
) -> Result<PageResponse<ActiveProjectedAgendaEntry>, AppError> {
    validate_date_format(&start_date)?;
    validate_date_format(&end_date)?;

    // Decode the optional cursor. We bypass `pagination::PageRequest::new`
    // because that helper clamps to MAX_PAGE_SIZE=200 and this command
    // historically clamps to 500 (kept as the per-page cap — callers now
    // page past the cap via the cursor instead of being silently
    // Truncated;).
    let after = match cursor.as_deref() {
        Some(s) => Some(Cursor::decode(s)?),
        None => None,
    };

    // Per-page limit must be in `[1, 500]` (limit-clamp-followup Phase 1:
    // silent clamp converted to a loud `AppError::Validation` so a caller
    // asking for >500 fails synchronously instead of silently truncating
    // to 500).  `None` falls through to the historical default of 200.
    let limit_i64 = match limit {
        Some(l) if (1..=500).contains(&l) => l,
        Some(l) => {
            return Err(AppError::validation(format!(
                "list_projected_agenda limit must be in [1, 500]; got {l}. \
                 For larger result sets, use cursor pagination."
            )));
        }
        None => 200,
    };
    // safe: validated above as [1, 500]
    let cap = usize::try_from(limit_i64).unwrap_or(200);

    // Parse date range boundaries
    let range_start = chrono::NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
        .map_err(|_| AppError::validation("invalid start_date".into()))?;
    let range_end = chrono::NaiveDate::parse_from_str(&end_date, "%Y-%m-%d")
        .map_err(|_| AppError::validation("invalid end_date".into()))?;

    if range_start > range_end {
        return Err(AppError::validation(
            "start_date must be <= end_date".into(),
        ));
    }

    // #2601 — bounded materialization horizon guard. `projected_agenda_cache`
    // holds only the next `HORIZON_OCCURRENCES` occurrences per repeating
    // block per source, so it is authoritative only up to the
    // guaranteed-complete `horizon_date` advertised (in the same transaction
    // as the rows) by the last rebuild. A query whose `end_date` reaches past
    // that horizon could be missing far occurrences of a dense (e.g. daily)
    // recurrence, so it is answered by the on-the-fly projector — correct for
    // any range — rather than the cache. An absent horizon row (cache never
    // built, or a device still on the cold-cache path) also routes here,
    // matching the empty-cache fallback below. The on-the-fly path honours
    // the cursor, so mid-pagination is consistent: `end_date` is fixed across
    // a query's pages, so every page of one query takes the same branch.
    //
    // `horizon_date` and `end_date` are both zero-padded `YYYY-MM-DD`, so the
    // lexical string comparison is a valid calendar-date comparison.
    // dynamic-sql: reads projected_agenda_horizon (table added this PR, migration 0102), dynamic so the crate builds without it in the .sqlx cache
    let horizon_date: Option<String> = sqlx::query_scalar::<_, String>(
        "SELECT horizon_date FROM projected_agenda_horizon WHERE id = 0",
    )
    .fetch_optional(pool)
    .await?;
    let cache_covers_range = horizon_date
        .as_deref()
        .is_some_and(|h| end_date.as_str() <= h);
    if !cache_covers_range {
        return list_projected_agenda_on_the_fly(
            pool,
            range_start,
            range_end,
            limit_i64,
            today,
            after.as_ref(),
            scope.as_filter_param(),
        )
        .await;
    }

    // Cursor parts for SQL bind. ?cursor_flag NULL → no cursor filter.
    let (cursor_flag, cursor_date, cursor_id): (Option<i64>, &str, &str) = match after.as_ref() {
        Some(c) => (
            Some(1),
            c.deleted_at.as_deref().unwrap_or(""),
            c.id.as_str(),
        ),
        None => (None, "", ""),
    };

    // Fetch limit + 1 to detect `has_more`.
    let fetch_limit: i64 = limit_i64 + 1;

    // Try cache first — a single query replaces the O(n*m) projection loop.
    #[allow(clippy::type_complexity)]
    let cached: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        // dynamic-sql: 14-column projected-agenda cache join decoded into a positional tuple (no FromRow struct)
    )> = sqlx::query_as(
        // ?7 (space_id) drives the shared space-filter clause.
        // Mirrors `agaric_store::space_filter_canonical::SPACE_FILTER_CANONICAL` — kept inline because this
        // query uses dynamic-typed `query_as`. Filters on the first-class
        // `b.space_id` column (#533, migration 0086).
        "SELECT pac.block_id, pac.projected_date, pac.source,
                b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id
         FROM projected_agenda_cache pac
         JOIN blocks b ON b.id = pac.block_id
         WHERE pac.projected_date >= ?1
           AND pac.projected_date <= ?2
           AND b.deleted_at IS NULL
           AND NOT EXISTS (
               SELECT 1 FROM block_properties tp
               WHERE tp.block_id = b.page_id AND tp.key = 'template'
           )
           AND (?3 IS NULL OR (pac.projected_date > ?4
               OR (pac.projected_date = ?4 AND pac.block_id > ?5)))
           AND (?7 IS NULL OR b.space_id = ?7)
         ORDER BY pac.projected_date ASC, pac.block_id ASC
         LIMIT ?6",
    )
    .bind(&start_date)
    .bind(&end_date)
    .bind(cursor_flag)
    .bind(cursor_date)
    .bind(cursor_id)
    .bind(fetch_limit)
    .bind(scope.as_filter_param())
    .fetch_all(pool)
    .await?;

    // Fall back to on-the-fly only on a fresh first page (no cursor).
    // Once any cursor has been issued, the materializer must be honoured —
    // an empty cache result with a cursor means the caller paged past the
    // last entry, NOT that the cache is unpopulated.
    if cached.is_empty() && after.is_none() {
        return list_projected_agenda_on_the_fly(
            pool,
            range_start,
            range_end,
            limit_i64,
            today,
            after.as_ref(),
            scope.as_filter_param(),
        )
        .await;
    }

    // Boundary cast: the cache query above joins
    // `blocks` filtered to live, non-conflict rows, so every surviving
    // block id is active. `from_trusted_active` records the claim in
    // the type system without re-running the predicate.
    let mut entries: Vec<ActiveProjectedAgendaEntry> = cached
        .into_iter()
        .map(|row| ActiveProjectedAgendaEntry {
            block: ActiveBlockRow {
                id: agaric_core::ulid::ActiveBlockId::from_trusted_active(&row.3),
                block_type: row.4,
                content: row.5,
                parent_id: row.6.map(|s| agaric_core::ulid::BlockId::from_trusted(&s)),
                position: row.7,
                deleted_at: row.8,
                todo_state: row.9,
                priority: row.10,
                due_date: row.11,
                scheduled_date: row.12,
                page_id: row.13.map(|s| agaric_core::ulid::BlockId::from_trusted(&s)),
            },
            projected_date: row.1,
            source: row.2,
        })
        .collect();

    let has_more = entries.len() > cap;
    if has_more {
        entries.truncate(cap);
    }
    let next_cursor = if has_more {
        let last = entries.last().expect("has_more implies non-empty");
        Some(
            Cursor::for_id_and_deleted_at(
                last.block.id.clone().into(),
                Some(last.projected_date.clone()),
            )
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items: entries,
        next_cursor,
        has_more,
        total_count: None,
    })
}

/// On-the-fly projection of repeating tasks (original algorithm).
///
/// Used as a fallback when `projected_agenda_cache` is empty (e.g. first boot
/// before the materializer has populated the cache) OR when the query reaches
/// past the bounded materialization horizon (#2601) — see the horizon guard
/// in [`list_projected_agenda_inner`]. This path applies no occurrence-count
/// cap, so it is exhaustive within `[range_start, range_end]` for any range.
///
/// `today` anchors `dot_plus` (`.+`) and `plus_plus` (`++`) repeat-mode
/// projections; it is threaded in from
/// [`list_projected_agenda_inner`] instead of being
/// read from `chrono::Local::now()` so tests can pin a fixed today.
///
/// `after` is the optional decoded cursor. When supplied, entries
/// whose `(projected_date, block_id)` are `<= cursor` are filtered out
/// before the page is built. The same `(date, id)` keyset that the cache
/// path uses is honoured here so the two branches stay swappable mid-
/// pagination if the materializer populates the cache between calls.
///
/// `pub(crate)` so the regression test in
/// `commands::tests::agenda_cmd_tests` can call this path directly,
/// bypassing the cache-or-fallback branch in
/// [`list_projected_agenda_inner`]. The cache rebuild itself
/// (`cache::projected_agenda::rebuild_projected_agenda_cache_impl`) also
/// reads `chrono::Local::now()`, so any `set_property` op in a test
/// indirectly populates the cache with today-anchored rows that vary as
/// the system clock advances. Calling on-the-fly directly sidesteps that
/// drift; threading `today` through the cache rebuild itself is a larger
/// Follow-up that leaves open.
pub(crate) async fn list_projected_agenda_on_the_fly(
    pool: &SqlitePool,
    range_start: chrono::NaiveDate,
    range_end: chrono::NaiveDate,
    limit: i64,
    today: chrono::NaiveDate,
    after: Option<&Cursor>,
    space_id: Option<&str>,
) -> Result<PageResponse<ActiveProjectedAgendaEntry>, AppError> {
    // The compute below has no in-loop cap (with cursor pagination we need
    // every entry within the date range, regardless of page size). The
    // outer 10_000-step safety per (block × source) still bounds runaway
    // recurrence rules, and the date range itself caps the total work.
    // Find repeating blocks: non-DONE, non-deleted, has repeat property,
    // has at least one date column.
    // LEFT JOINs fetch repeat-until / repeat-count / repeat-seq in the same
    // round-trip, eliminating per-block N+1 queries.
    //
    // Template-page filter (spec line 812): blocks whose owning
    // page has a `template` property are excluded so template scaffolding
    // never surfaces in agenda / Google Calendar results.  `b.page_id`
    // is the denormalised root-page column (migration 0027).
    // ?1 (space_id) drives the shared space-filter clause.
    // Mirrors `agaric_store::space_filter_canonical::SPACE_FILTER_CANONICAL` — kept inline because
    // `sqlx::query_as!` requires a string literal directly. Filters on the
    // first-class `b.space_id` column (#533, migration 0086).
    //
    // #2069: superset date-overlap PREFILTER (`?2 = range_end`). The Rust
    // expansion below is O(blocks × horizon); at 100K repeating blocks the
    // whole-table scan + expand-then-paginate path runs ~620ms, blowing the
    // 200ms SLO. A block can only project an occurrence into
    // `[range_start, range_end]` if its FIRST possible occurrence is
    // `<= range_end`, so we drop blocks that provably cannot — BEFORE the
    // expansion — shrinking the work set without changing results.
    //
    // The first-occurrence rule depends on the repeat mode:
    //   * TODAY-anchored (`.+` dot-plus, `++` plus-plus — the only two
    //     today-anchored prefixes in `recurrence::parser`/`projection`):
    //     projection starts from `today` (dot-plus) or the catch-up date
    //     `> today` (plus-plus), so the base date (`due_date` /
    //     `scheduled_date`) says NOTHING about window membership — these
    //     are ALWAYS kept.
    //   * base-anchored (daily / weekly / monthly / +Nd / +Nw / +Nm / +Ny):
    //     the first occurrence is the base date itself, so a base
    //     `> range_end` can never reach the window (the series only moves
    //     forward) and is safely dropped.
    //
    // We filter ONLY on the upper bound (`<= range_end`); never on the
    // lower bound, because a past base with a forward repeat can still
    // land inside the window. NULL due/scheduled compare as not-`<=`,
    // which is correct (the base-set predicate already requires at least
    // one non-NULL).
    //
    // #2069 review nit (silent-drop fix): the today-anchored arms use a
    // SUBSTRING-CONTAINS test (`LIKE '%.+%'` / `LIKE '%++%'`) rather than a
    // `LOWER(TRIM(...)) LIKE '.+%'` PREFIX test. Rationale:
    //   * `.+` and `++` contain NO alphabetic characters, so case is
    //     irrelevant — no `LOWER()` needed.
    //   * `.` and `+` are not LIKE metacharacters (only `%` and `_` are),
    //     so they match literally; the surrounding `%` are the only
    //     wildcards.
    //   * Any rule that `project_block_dates` would classify as
    //     today-anchored is `repeat_rule.trim().to_lowercase()` then
    //     dispatched on a `.+` / `++` PREFIX, so the literal substring `.+`
    //     or `++` is necessarily PRESENT in the raw `value_text` regardless
    //     of leading whitespace (ASCII space OR any Unicode whitespace such
    //     as a leading TAB/NEWLINE) or case. The old `TRIM()` strips only
    //     ASCII space, whereas Rust's `str::trim()` strips all Unicode
    //     whitespace — so a rule like `"\t.+1w"` with a base AFTER
    //     `range_end` was classified base-anchored by SQL and DROPPED while
    //     the Rust projector trimmed the tab and projected it from today,
    //     silently diverging from the cache path. The contains-test keeps
    //     every today-anchored block, closing that gap — a strict superset.
    //   * Base-anchored forms (daily / weekly / monthly / +Nd / +Nw / +Nm /
    //     +Ny) never contain `.+` or `++` as a substring, so they are not
    //     falsely kept (no perf regression).
    let range_end_str = range_end.format("%Y-%m-%d").to_string();
    let rows = sqlx::query_as!(
        RepeatingBlockRow,
        r#"SELECT b.id, b.block_type, b.content, b.parent_id, b.position,
                b.deleted_at,
                b.todo_state, b.priority, b.due_date, b.scheduled_date,
                b.page_id,
                bp.value_text AS repeat_rule,
                bp_until.value_date AS repeat_until,
                bp_count.value_num AS repeat_count,
                bp_seq.value_num AS repeat_seq
         FROM blocks b
         JOIN block_properties bp ON bp.block_id = b.id AND bp.key = 'repeat'
         LEFT JOIN block_properties bp_until ON bp_until.block_id = b.id AND bp_until.key = 'repeat-until'
         LEFT JOIN block_properties bp_count ON bp_count.block_id = b.id AND bp_count.key = 'repeat-count'
         LEFT JOIN block_properties bp_seq ON bp_seq.block_id = b.id AND bp_seq.key = 'repeat-seq'
         WHERE b.deleted_at IS NULL
           AND (b.todo_state IS NULL OR b.todo_state != 'DONE')
           AND bp.value_text IS NOT NULL
           AND (b.due_date IS NOT NULL OR b.scheduled_date IS NOT NULL)
           AND NOT EXISTS (
               SELECT 1 FROM block_properties tp
               WHERE tp.block_id = b.page_id AND tp.key = 'template'
           )
           AND (?1 IS NULL OR b.space_id = ?1)
           AND (
               bp.value_text LIKE '%.+%'
               OR bp.value_text LIKE '%++%'
               OR b.due_date <= ?2
               OR b.scheduled_date <= ?2
           )"#,
        space_id,      // ?1
        range_end_str, // ?2
    )
    .fetch_all(pool)
    .await?;

    // M1 (Batch 2): build the projected-entry set in a `BTreeMap` keyed by
    // `(projected_date, block_id, source)` so the container itself enforces
    // the `ORDER BY projected_date ASC, block_id ASC` invariant the cache
    // path applies in SQL. Source is included in the key as a deterministic
    // tie-breaker for the (rare) (block × source) collision case — the
    // cache table's primary key `(block_id, projected_date, source)` admits
    // both rows, and the cache path's ORDER BY is sort-stable across them,
    // so threading `source` through the key preserves observable behaviour.
    //
    // The previous post-hoc `entries.sort_by(...)` and `entries.retain(...)`
    // are eliminated: ordering happens at insertion time, and the cursor
    // predicate is checked inline before each insert. This mirrors the
    // SQL `ORDER BY` + keyset-cursor `WHERE` clause the cache path uses
    // (line ~270-275).
    //
    // NOTE on "push LIMIT into SQL": the projected dates here are computed
    // in Rust via `crate::recurrence::shift_date_once`, which parses
    // arbitrary org-mode-style rules (`.+1d`, `++2w`, `+1m`, `monthly`, …)
    // and does calendar-clamp month/year arithmetic. None of that
    // translates to SQLite expressions, so the recurrence expansion itself
    // cannot move into the SQL `query_as!` above. What we *can* do —
    // and what this rewrite does — is enforce the same ordering + cursor
    // + limit invariants at the generation stage instead of as Rust
    // post-processing on a fully-materialised vector.
    let cursor_key: Option<(&str, &str)> = after
        .as_ref()
        .map(|c| (c.deleted_at.as_deref().unwrap_or(""), c.id.as_str()));

    // safe: `limit` is the [1, 500]-clamped per-page cap (i64 → usize on
    // 64-bit). Captured once here so the inline cursor / cap checks below
    // do not repeat the conversion.
    let limit_usize = usize::try_from(limit).unwrap_or(usize::MAX);
    // Generation cap: collect `limit + 1` entries so the caller can detect
    // `has_more`. The previous code generated every entry in the range and
    // truncated afterwards; we now stop adding new keys (or evict the
    // current largest) once the map is saturated, so the BTreeMap is
    // bounded.
    let max_entries = limit_usize.saturating_add(1);

    let mut entries_map: BTreeMap<(String, String, String), ActiveProjectedAgendaEntry> =
        BTreeMap::new();

    // Inline helper: insert an entry into the sorted map, honouring the
    // cursor predicate and the `max_entries` size cap. Returns `true` if
    // the entry was accepted (so the caller can update `projected_count`).
    //
    // #2040: the cursor/cap decision depends ONLY on the cheap key
    // `(projected_date, block_id, source)` — never on the full block row.
    // So the key is taken eagerly while the heavy `ActiveProjectedAgendaEntry`
    // (which clones the block row's content `String`) is produced via the
    // `build` closure ONLY when the entry is actually accepted into the page.
    // The previous shape cloned the block row for every one of up to ~10k
    // projected occurrences before the cap discarded most of them; now the
    // clone happens at most `max_entries` times per page. Behaviour is
    // identical: the same key drives the same accept/reject/evict decisions,
    // and the built entry carries the same `projected_date` / `source` the
    // key was derived from.
    let try_insert =
        |entries_map: &mut BTreeMap<(String, String, String), ActiveProjectedAgendaEntry>,
         projected_date: String,
         block_id: &str,
         source: &str,
         build: &dyn Fn() -> ActiveProjectedAgendaEntry|
         -> bool {
            // Cursor predicate: keep only entries strictly AFTER the
            // cursor's (date, id). Mirrors the cache path's
            // `?cursor_date < projected_date OR (= AND ?cursor_id < block_id)`.
            if let Some((cd, ci)) = cursor_key
                && (projected_date.as_str(), block_id) <= (cd, ci)
            {
                return false;
            }
            let key = (projected_date, block_id.to_string(), source.to_string());
            // Size-cap: if we're at capacity, only accept the new entry
            // when it would land strictly before the current largest
            // (i.e. it's a smaller (date, id, source) tuple). This keeps
            // the map bounded at `max_entries` and matches the
            // sort-then-truncate semantics of the previous code.
            if entries_map.len() >= max_entries {
                let largest_key = entries_map
                    .keys()
                    .next_back()
                    .expect("len >= 1 implies a last key");
                if &key >= largest_key {
                    return false;
                }
                let largest_key = largest_key.clone();
                entries_map.remove(&largest_key);
            }
            // Accepted — only now pay for the block-row clone + entry build.
            entries_map.insert(key, build());
            true
        };

    for block in &rows {
        // Get the repeat rule (pre-fetched via JOIN). Empty / missing
        // rules are skipped here; the shared projector also no-ops on
        // empty rules but we elide the call entirely for clarity.
        let rule = match block.repeat_rule.as_deref() {
            Some(r) if !r.is_empty() => r,
            _ => continue,
        };

        // Surface DB-level corruption: write-time validation
        // (`set_property_in_tx`'s `is_valid_iso_date`) should make this
        // unreachable. A miss means either the DB was hand-edited or a
        // sync-protocol bug let through a bad value; either way we warn
        // before falling through, so the silent skip is observable.
        let until_date = match block.repeat_until.as_deref() {
            Some(d) => {
                if let Ok(parsed) = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") {
                    Some(parsed)
                } else {
                    tracing::warn!(
                        block_id = %block.id,
                        source = "repeat-until",
                        date_str = d,
                        "agenda projection: skipping block with malformed date"
                    );
                    continue;
                }
            }
            None => None,
        };

        // f64 → usize has no `TryFrom` in std; the cast is safe because
        // repeat_count and repeat_seq are non-negative f64 (whole numbers)
        // from SQLite.
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let remaining = match (block.repeat_count, block.repeat_seq) {
            (Some(count), Some(seq)) if count > seq => Some((count - seq) as usize),
            (Some(count), None) => Some(count as usize),
            (Some(_), Some(_)) => Some(0usize), // already exhausted
            _ => None,                          // no limit
        };

        // Recurrence math lives in the shared
        // `recurrence::project_block_dates` helper so the cache rebuild
        // and the on-the-fly path cannot drift. The closure below is
        // the on-the-fly-specific concern: cursor predicate + size-cap
        // + BTreeMap insert via `try_insert`. The helper handles
        // mode/interval parsing, `plus_plus` catch-up + pre-emit,
        // `until_date` / `remaining` end conditions, the 10 000-iter
        // safety bound, and `[range_start, range_end]` clipping.
        //
        // Emit the malformed-date warn at the callsite
        // before handing the validated source strings to the helper.
        // The helper itself silently skips on parse failure; doing the
        // validation here preserves the original ops-log signal
        // (the cache-rebuild path never had this warn — it stays silent
        // There, matching pre-existing behaviour).
        let validate_source = |date: Option<&str>, source: &'static str| -> Option<String> {
            let s = date?;
            if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok() {
                Some(s.to_string())
            } else {
                tracing::warn!(
                    block_id = %block.id,
                    source,
                    date_str = s,
                    "agenda projection: skipping block with malformed date"
                );
                None
            }
        };
        let due_date_valid = validate_source(block.due_date.as_deref(), "due_date");
        let scheduled_date_valid =
            validate_source(block.scheduled_date.as_deref(), "scheduled_date");
        let block_row = block.to_active_block_row();
        crate::recurrence::project_block_dates(
            due_date_valid.as_deref(),
            scheduled_date_valid.as_deref(),
            rule,
            until_date,
            remaining,
            today,
            range_start,
            range_end,
            // On-the-fly clips strictly by the caller's query range — no
            // occurrence-count horizon (that bound belongs to the cache
            // rebuild, #2601). `None` keeps this path exhaustive within
            // `[range_start, range_end]` so cursor pagination sees every
            // occurrence.
            None,
            |projected, source_name| {
                // #2040: format the date (cheap) for the cursor/cap key, but
                // defer the block-row clone (heavy: clones `content`) to the
                // `build` closure, which `try_insert` calls only on acceptance.
                let projected_date = projected.format("%Y-%m-%d").to_string();
                try_insert(
                    &mut entries_map,
                    projected_date.clone(),
                    block_row.id.as_str(),
                    source_name,
                    &|| ActiveProjectedAgendaEntry {
                        block: block_row.clone(),
                        projected_date: projected_date.clone(),
                        source: source_name.to_string(),
                    },
                );
            },
        );
    }

    // BTreeMap iteration order is the (date, id, source) lex order — the
    // same comparator the old `entries.sort_by(...)` enforced post-hoc.
    // The cursor filter is already baked into `try_insert`; the size cap
    // (`max_entries = limit + 1`) means the map holds at most one entry
    // past the page boundary, which we use below for the `has_more`
    // detection.
    let mut entries: Vec<ActiveProjectedAgendaEntry> = entries_map.into_values().collect();

    let has_more = entries.len() > limit_usize;
    if has_more {
        entries.truncate(limit_usize);
    }
    let next_cursor = if has_more {
        let last = entries.last().expect("has_more implies non-empty");
        Some(
            Cursor::for_id_and_deleted_at(
                last.block.id.clone().into(),
                Some(last.projected_date.clone()),
            )
            .encode()?,
        )
    } else {
        None
    };

    Ok(PageResponse {
        items: entries,
        next_cursor,
        has_more,
        total_count: None,
    })
}

/// Tauri command: batch-count agenda items per date. Delegates to [`count_agenda_batch_inner`].
#[tauri::command]
#[specta::specta]
pub async fn count_agenda_batch(
    read_pool: State<'_, ReadPool>,
    dates: Vec<String>,
    scope: SpaceScope,
) -> Result<HashMap<String, usize>, AppError> {
    count_agenda_batch_inner(&read_pool.0, dates, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: batch-count agenda items per (date, source). Delegates to [`count_agenda_batch_by_source_inner`].
#[tauri::command]
#[specta::specta]
pub async fn count_agenda_batch_by_source(
    read_pool: State<'_, ReadPool>,
    dates: Vec<String>,
    scope: SpaceScope,
) -> Result<HashMap<String, HashMap<String, usize>>, AppError> {
    count_agenda_batch_by_source_inner(&read_pool.0, dates, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: list projected future occurrences of repeating tasks.
/// Delegates to [`list_projected_agenda_inner`].
///
/// Cursor-paginated — pass `cursor = next_cursor` from the previous
/// response to fetch the next page.
#[tauri::command]
#[specta::specta]
pub async fn list_projected_agenda(
    pool: State<'_, ReadPool>,
    start_date: String,
    end_date: String,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<PageResponse<ActiveProjectedAgendaEntry>, AppError> {
    list_projected_agenda_inner(&pool.0, start_date, end_date, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

/// List undated tasks: blocks with todo_state but no due_date and no scheduled_date.
/// Cursor-paginated.
///
/// `scope` — [`SpaceScope::Active`] restricts the result set
/// to blocks whose owning page carries `space = ?space_id`.
/// [`SpaceScope::Global`] is the unscoped (pre-) behaviour
/// preserved for callsites that span every space.
#[instrument(skip(pool), err)]
pub async fn list_undated_tasks_inner(
    pool: &SqlitePool,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: &SpaceScope,
) -> Result<PageResponse<BlockRow>, AppError> {
    use agaric_store::pagination;
    let page_req = pagination::PageRequest::new(cursor, limit)?;
    pagination::list_undated_tasks(pool, &page_req, scope.as_filter_param()).await
}

/// Tauri command: list undated tasks. Delegates to [`list_undated_tasks_inner`].
#[tauri::command]
#[specta::specta]
pub async fn list_undated_tasks(
    pool: State<'_, ReadPool>,
    cursor: Option<String>,
    limit: Option<i64>,
    scope: SpaceScope,
) -> Result<PageResponse<BlockRow>, AppError> {
    list_undated_tasks_inner(&pool.0, cursor, limit, &scope)
        .await
        .map_err(sanitize_internal_error)
}

// ======================================================================
// `count_agenda_batch_inner` json_each refactor regression tests
// ======================================================================
//
// Inline coverage for the migration off the runtime `?1, ?2, …` placeholder
// list onto the `IN (SELECT value FROM json_each(?1))` pattern. Mirrors the
// existing coverage for `count_agenda_batch_by_source_inner`.
#[cfg(test)]
mod tests_m24 {
    use super::*;
    use crate::db::init_pool;
    use sqlx::SqlitePool;
    use std::path::PathBuf;
    use tempfile::TempDir;

    /// Build an isolated in-process SQLite pool with all migrations applied.
    /// The returned `TempDir` must be held by the caller — dropping it deletes
    /// the underlying database file (see `tests/AGENTS.md`).
    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("temp dir");
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.expect("init pool");
        (pool, dir)
    }

    /// Insert a minimal live block (no soft-delete) so `agenda_cache` rows
    /// survive the `b.deleted_at IS NULL` filter inside the query.
    async fn insert_live_block(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'content', '', NULL, NULL)",
        )
        .bind(id)
        .execute(pool)
        .await
        .expect("insert block");
    }

    /// Insert one `agenda_cache` row.
    async fn insert_agenda_row(pool: &SqlitePool, date: &str, block_id: &str) {
        sqlx::query("INSERT INTO agenda_cache (date, block_id, source) VALUES (?, ?, ?)")
            .bind(date)
            .bind(block_id)
            .bind("property:due_date")
            .execute(pool)
            .await
            .expect("insert agenda_cache");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_with_empty_input() {
        let (pool, _dir) = test_pool().await;
        let result = count_agenda_batch_inner(&pool, vec![], &SpaceScope::Global)
            .await
            .expect("empty input must succeed");
        assert!(
            result.is_empty(),
            "empty dates input must short-circuit to an empty map (no SQL issued)"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_returns_correct_counts() {
        let (pool, _dir) = test_pool().await;

        // Seed three live blocks.
        insert_live_block(&pool, "M24_BLK_A").await;
        insert_live_block(&pool, "M24_BLK_B").await;
        insert_live_block(&pool, "M24_BLK_C").await;

        // Known counts:
        //   2025-03-01 → 2 entries
        //   2025-03-02 → 1 entry
        //   2025-03-03 → 3 entries (NOT in query input — must NOT appear in result)
        insert_agenda_row(&pool, "2025-03-01", "M24_BLK_A").await;
        insert_agenda_row(&pool, "2025-03-01", "M24_BLK_B").await;
        insert_agenda_row(&pool, "2025-03-02", "M24_BLK_C").await;
        // Three rows on 2025-03-03 to make sure they do NOT bleed into the
        // result for a query that does not include that date — i.e. the
        // `IN (SELECT value FROM json_each(?1))` predicate filters strictly.
        insert_agenda_row(&pool, "2025-03-03", "M24_BLK_A").await;
        insert_agenda_row(&pool, "2025-03-03", "M24_BLK_B").await;
        insert_agenda_row(&pool, "2025-03-03", "M24_BLK_C").await;

        // Query a subset: only the first two dates.
        let result = count_agenda_batch_inner(
            &pool,
            vec!["2025-03-01".into(), "2025-03-02".into()],
            &SpaceScope::Global,
        )
        .await
        .expect("count_agenda_batch_inner must succeed on valid dates");

        assert_eq!(
            result.get("2025-03-01"),
            Some(&2),
            "2025-03-01 must report exactly 2 entries"
        );
        assert_eq!(
            result.get("2025-03-02"),
            Some(&1),
            "2025-03-02 must report exactly 1 entry"
        );
        assert!(
            !result.contains_key("2025-03-03"),
            "dates not in the query input must be absent from the result \
             (json_each filter must not leak rows)"
        );
        assert_eq!(
            result.len(),
            2,
            "result must contain exactly the dates that have matching rows"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn count_agenda_batch_unknown_block_ids() {
        let (pool, _dir) = test_pool().await;

        // Seed one live block + one row for a single date so the table is
        // not entirely empty (defensive: the query path is exercised either
        // way).
        insert_live_block(&pool, "M24_BLK_X").await;
        insert_agenda_row(&pool, "2025-04-01", "M24_BLK_X").await;

        // Query for dates that have NO agenda_cache rows. Per the existing
        // semantics (`GROUP BY ac.date` over the join), dates with no rows
        // are simply absent from the returned map — they do NOT show up
        // with a count of 0.
        let result = count_agenda_batch_inner(
            &pool,
            vec!["2025-05-01".into(), "2025-05-02".into()],
            &SpaceScope::Global,
        )
        .await
        .expect("unknown dates must not error");

        assert!(
            !result.contains_key("2025-05-01"),
            "date with no agenda_cache rows must be absent from the result"
        );
        assert!(
            !result.contains_key("2025-05-02"),
            "date with no agenda_cache rows must be absent from the result"
        );
        assert!(
            result.is_empty(),
            "result must be empty when no queried date has any rows; got {result:?}"
        );

        // Mixed query: one known date (with rows) + one unknown date.
        // Confirms the unknown date is silently omitted while the known
        // one still produces the correct count.
        let mixed = count_agenda_batch_inner(
            &pool,
            vec!["2025-04-01".into(), "2025-05-01".into()],
            &SpaceScope::Global,
        )
        .await
        .expect("mixed known+unknown dates must succeed");
        assert_eq!(
            mixed.get("2025-04-01"),
            Some(&1),
            "known date must still report its real count in a mixed query"
        );
        assert!(
            !mixed.contains_key("2025-05-01"),
            "unknown date must remain absent in a mixed query"
        );
    }
}
