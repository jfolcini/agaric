//! `parity_report` — PEND-09 Phase 2 day-7 read-only diagnostic.
//!
//! Closes Phase-2 Gate 7 ([Phase-2 cutover plan
//! `pending/PEND-09-PHASE-2-CUTOVER-PLAN.md` §2 Gate 7 + §3 day 7]) and
//! the §7 item 2 follow-up that flagged the 7-day shadow-mode soak as
//! "tedious to observe without a diagnostic command". The maintainer
//! runs this against `notes.db` between Gate-1 daily samples and reads
//! the bucket histogram + recent-divergent-ops tail without typing raw
//! SQL.
//!
//! ## Behaviour
//!
//! - Opens the database **read-only**
//!   (`SqliteConnectOptions::read_only(true)`) so the binary can never
//!   accidentally write to the user's data — safe to run on a live DB.
//! - Detects whether `merge_parity_log` exists via a `sqlite_master`
//!   lookup. If the table is absent the binary explains why ("was
//!   this DB built with shadow mode?") and exits with code `2` rather
//!   than auto-running migrations.
//! - Runs five queries, each with deterministic ordering (every query
//!   has an `ORDER BY` on a tiebreaking key so the output is stable):
//!     1. `SELECT COUNT(*) FROM merge_parity_log` — total events.
//!     2. `SELECT bucket, COUNT(*) FROM merge_parity_log GROUP BY
//!        bucket ORDER BY bucket` — per-bucket counts. NULL bucket is
//!        rendered as `unclassified`.
//!     3. `SELECT op_type, COUNT(*) FROM merge_parity_log GROUP BY
//!        op_type ORDER BY count DESC, op_type ASC` — per-op-type
//!        breakdown.
//!     4. `SELECT MIN(created_at), MAX(created_at) FROM
//!        merge_parity_log` — date range.
//!     5. `SELECT id, op_id, op_type, diffy_result, loro_result,
//!        bucket, created_at FROM merge_parity_log WHERE bucket IN
//!        ('C','D') ORDER BY created_at DESC, id DESC LIMIT 20` —
//!        recent divergent ops (the headline data the user actually
//!        cares about).
//! - Emits a verdict line at the end:
//!     - `D = 0` → "OK: kill-criterion #2 holds".
//!     - `D > 0` → "ALERT: D-bucket sightings present — investigate
//!       before cutover".
//!
//! ## Exit codes
//!
//! - `0` — report printed (regardless of D-bucket presence; the verdict
//!   conveys the alert).
//! - `2` — error (DB not found, `merge_parity_log` table absent, schema
//!   mismatch, IO failure).
//!
//! ## Why a separate bin (not `agaric debug parity-report` IPC)
//!
//! The Phase-2 plan §3 day 7 lists "CLI subcommand or IPC command"; we
//! pick CLI for the same reasons `op_log_histogram` is CLI:
//!
//! - The maintainer runs it from a terminal between Gate-1 samples;
//!   typing into a TipTap editor to invoke an IPC command is friction.
//! - Read-only at the SQLite level means there is no risk of running
//!   the diagnostic against a live DB while the app is open.
//! - No Loro / `loro-shadow` feature flag dependency — the bin compiles
//!   on default builds. A maintainer who has rolled back to a build
//!   without shadow mode can still inspect rows accumulated when shadow
//!   mode was on.

use std::path::PathBuf;
use std::process::ExitCode;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use agaric_lib::error::AppError;

// ---------------------------------------------------------------------------
// CLI argument parsing — mirrors op_log_histogram.rs
// ---------------------------------------------------------------------------

#[derive(Debug)]
enum ParsedArgs {
    Run { db_path: Option<PathBuf> },
    Help,
    Version,
    BadArg(String),
}

fn parse_args(args: &[String]) -> ParsedArgs {
    let mut db_path: Option<PathBuf> = None;
    let mut iter = args.iter().skip(1);
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--help" | "-h" => return ParsedArgs::Help,
            "--version" | "-V" => return ParsedArgs::Version,
            "--db-path" => match iter.next() {
                Some(p) => db_path = Some(PathBuf::from(p)),
                None => return ParsedArgs::BadArg("--db-path requires a path argument".into()),
            },
            other if other.starts_with("--db-path=") => {
                let value = other.trim_start_matches("--db-path=");
                if value.is_empty() {
                    return ParsedArgs::BadArg("--db-path requires a path argument".into());
                }
                db_path = Some(PathBuf::from(value));
            }
            // Accept a single positional path arg for ergonomic
            // `parity_report /path/to/notes.db` invocation.
            other if !other.starts_with('-') && db_path.is_none() => {
                db_path = Some(PathBuf::from(other));
            }
            other => return ParsedArgs::BadArg(format!("unknown argument: {other}")),
        }
    }
    ParsedArgs::Run { db_path }
}

fn print_help() {
    println!(
        "parity_report — PEND-09 Phase 2 day-7 read-only diagnostic\n\
         \n\
         USAGE:\n    \
             parity_report <NOTES_DB>\n    \
             parity_report --db-path <NOTES_DB>\n\
         \n\
         OPTIONS:\n    \
             --db-path <PATH>  Path to notes.db (read-only). Required (no default).\n    \
             -V, --version     Print version and exit.\n    \
             -h, --help        Print this help and exit.\n\
         \n\
         EXIT CODES:\n    \
             0   Report printed (verdict line conveys D-bucket alert).\n    \
             2   Real error (DB missing, merge_parity_log table absent,\n        \
                 schema mismatch, IO failure)."
    );
}

// ---------------------------------------------------------------------------
// Report data model
// ---------------------------------------------------------------------------

/// One row of the bucket histogram. `bucket` is `None` for the
/// `unclassified` (NULL) row that the day-6 classifier hasn't reached
/// yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BucketRow {
    pub bucket: Option<String>,
    pub count: u64,
}

/// One row of the per-op-type breakdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OpTypeRow {
    pub op_type: String,
    pub count: u64,
}

/// One recent divergent op (bucket C or D). `bucket` is always
/// `Some(...)` here because the SELECT filters on `bucket IN ('C','D')`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DivergentOp {
    pub id: i64,
    pub op_id: String,
    pub op_type: String,
    pub diffy_result: String,
    pub loro_result: String,
    pub bucket: String,
    pub created_at: i64,
}

/// Aggregated data for the report. Built by [`load_report`] from the
/// five SQL queries; consumed by [`format_report`].
#[derive(Debug, Clone)]
pub(crate) struct ParityReport {
    pub total: u64,
    pub buckets: Vec<BucketRow>,
    pub op_types: Vec<OpTypeRow>,
    /// MIN / MAX `created_at` across the table. `None` when the table
    /// is empty (SQLite's MIN/MAX return NULL on an empty set).
    pub date_range: Option<(i64, i64)>,
    pub recent_divergent: Vec<DivergentOp>,
}

impl ParityReport {
    pub fn is_empty(&self) -> bool {
        self.total == 0
    }

    /// Count of bucket-D rows in the report. The verdict line keys off
    /// this — `0` is the kill-criterion #2 floor.
    pub fn d_count(&self) -> u64 {
        self.buckets
            .iter()
            .find(|b| b.bucket.as_deref() == Some("D"))
            .map(|b| b.count)
            .unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// SQL — load the report from a notes.db merge_parity_log
// ---------------------------------------------------------------------------

/// Maximum number of recent divergent ops to surface. The user is
/// browsing this on a terminal so a hard cap keeps the output readable;
/// the full tail is one SQL query away if they need more.
const RECENT_DIVERGENT_LIMIT: i64 = 20;

/// Check whether the `merge_parity_log` table exists in the open DB. A
/// missing table indicates the DB was built without shadow-mode (the
/// migration `0051_pend_09_merge_parity_log.sql` ran during a feature-on
/// build); the diagnostic refuses to silently auto-run migrations on
/// the maintainer's data.
pub(crate) async fn merge_parity_log_exists(pool: &SqlitePool) -> Result<bool, AppError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'merge_parity_log'",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Run all five report queries against an open SQLite pool. Each query
/// has deterministic ordering so the output is reproducible across
/// runs.
pub(crate) async fn load_report(pool: &SqlitePool) -> Result<ParityReport, AppError> {
    // --- 1. Total event count.
    let (total_i64,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM merge_parity_log")
        .fetch_one(pool)
        .await?;
    let total = u64::try_from(total_i64).map_err(|_| {
        AppError::InvalidOperation(format!(
            "merge_parity_log COUNT(*) is negative ({total_i64}); refusing to proceed",
        ))
    })?;

    // --- 2. Per-bucket counts.  ORDER BY bucket — SQLite sorts NULL
    // first, which is what we want: unclassified rows appear at the top
    // of the bucket table where they're most visible.
    let bucket_rows: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT bucket, COUNT(*) AS count \
         FROM merge_parity_log \
         GROUP BY bucket \
         ORDER BY bucket",
    )
    .fetch_all(pool)
    .await?;

    let mut buckets: Vec<BucketRow> = Vec::with_capacity(bucket_rows.len());
    for (bucket, count) in bucket_rows {
        let count = u64::try_from(count).map_err(|_| {
            AppError::InvalidOperation(format!(
                "merge_parity_log bucket count is negative ({count}); refusing to proceed",
            ))
        })?;
        buckets.push(BucketRow { bucket, count });
    }

    // --- 3. Per-op-type breakdown.  Tiebreak on op_type ASC for stable
    // output across runs.
    let op_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT op_type, COUNT(*) AS count \
         FROM merge_parity_log \
         GROUP BY op_type \
         ORDER BY count DESC, op_type ASC",
    )
    .fetch_all(pool)
    .await?;
    let mut op_types: Vec<OpTypeRow> = Vec::with_capacity(op_rows.len());
    for (op_type, count) in op_rows {
        let count = u64::try_from(count).map_err(|_| {
            AppError::InvalidOperation(format!(
                "merge_parity_log op_type count for '{op_type}' is negative ({count}); refusing to proceed",
            ))
        })?;
        op_types.push(OpTypeRow { op_type, count });
    }

    // --- 4. Date range.  MIN / MAX over an empty table return NULL;
    // we map the `(None, None)` case to a single `None`.
    let date_row: (Option<i64>, Option<i64>) =
        sqlx::query_as("SELECT MIN(created_at), MAX(created_at) FROM merge_parity_log")
            .fetch_one(pool)
            .await?;
    let date_range = match date_row {
        (Some(min), Some(max)) => Some((min, max)),
        _ => None,
    };

    // --- 5. Recent divergent ops.  Tiebreak on `id DESC` so two events
    // sharing the same millisecond timestamp still produce stable
    // output — recent insert id wins.
    let recent: Vec<(i64, String, String, String, String, String, i64)> = sqlx::query_as(
        "SELECT id, op_id, op_type, diffy_result, loro_result, bucket, created_at \
         FROM merge_parity_log \
         WHERE bucket IN ('C', 'D') \
         ORDER BY created_at DESC, id DESC \
         LIMIT ?",
    )
    .bind(RECENT_DIVERGENT_LIMIT)
    .fetch_all(pool)
    .await?;
    let recent_divergent: Vec<DivergentOp> = recent
        .into_iter()
        .map(
            |(id, op_id, op_type, diffy_result, loro_result, bucket, created_at)| DivergentOp {
                id,
                op_id,
                op_type,
                diffy_result,
                loro_result,
                bucket,
                created_at,
            },
        )
        .collect();

    Ok(ParityReport {
        total,
        buckets,
        op_types,
        date_range,
        recent_divergent,
    })
}

// ---------------------------------------------------------------------------
// Pretty-printer
// ---------------------------------------------------------------------------

/// Formats a count with thousands separators, ASCII only.
fn fmt_count(n: u64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len() + s.len() / 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

/// Render a millisecond Unix timestamp as `YYYY-MM-DDTHH:MM:SSZ`. Uses
/// the `time` crate (already a transitive dep via `sqlx`) for parsing
/// — but to avoid pulling a new dep into the binary's compile graph we
/// hand-roll the conversion here. ISO-like; not strictly RFC 3339 (no
/// fractional seconds) but close enough for a diagnostic tail.
fn fmt_timestamp_ms(ms: i64) -> String {
    // Days from 1970-01-01 to the date of `ms`.
    let secs = ms.div_euclid(1_000);
    let secs_in_day = secs.rem_euclid(86_400);
    let days = secs.div_euclid(86_400);
    let h = secs_in_day / 3_600;
    let m = (secs_in_day % 3_600) / 60;
    let s = secs_in_day % 60;

    // Howard Hinnant's days-from-civil algorithm, in reverse. Works
    // for any i64 day count without leap-second adjustments — adequate
    // for the diagnostic.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097); // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

/// Truncate a long summary string for table display. Keeps the binary
/// safely under one terminal line at most realistic widths. The full
/// strings are still in the DB if the maintainer wants them.
fn truncate_for_table(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

const SUMMARY_TRUNCATE: usize = 36;

/// Render the full report as one ASCII string. No color codes — the
/// user might pipe the output to a file. Rule lines use ASCII `-`
/// rather than U+2500 box-drawing so the output is grep-friendly.
pub(crate) fn format_report(report: &ParityReport, db_path: &std::path::Path) -> String {
    let mut out = String::new();

    // --- Header ------------------------------------------------------
    out.push_str("PEND-09 Phase 2 day-7 — merge_parity_log report\n");
    out.push_str(&format!("DB path: {}\n", db_path.display()));

    if let Some((min_ms, max_ms)) = report.date_range {
        out.push_str(&format!(
            "Date range: {} .. {}\n",
            fmt_timestamp_ms(min_ms),
            fmt_timestamp_ms(max_ms),
        ));
    } else {
        out.push_str("Date range: (no events)\n");
    }
    out.push_str(&format!("Total events: {}\n", fmt_count(report.total)));
    out.push('\n');

    if report.is_empty() {
        out.push_str("merge_parity_log is empty (0 events).\n");
        out.push_str(&verdict_line(report));
        return out;
    }

    // --- Bucket counts ----------------------------------------------
    out.push_str("Bucket counts:\n");
    out.push_str(&format_bucket_table(report));

    // --- Op-type breakdown ------------------------------------------
    out.push('\n');
    out.push_str("Op-type breakdown:\n");
    out.push_str(&format_op_type_table(report));

    // --- Recent divergent ops ---------------------------------------
    out.push('\n');
    out.push_str(&format!(
        "Recent divergent ops (bucket C / D, most recent first, max {} rows):\n",
        RECENT_DIVERGENT_LIMIT,
    ));
    if report.recent_divergent.is_empty() {
        out.push_str("  (none — no bucket-C or bucket-D rows in this DB)\n");
    } else {
        out.push_str(&format_divergent_table(&report.recent_divergent));
    }

    // --- Verdict ----------------------------------------------------
    out.push('\n');
    out.push_str(&verdict_line(report));
    out
}

fn format_bucket_table(report: &ParityReport) -> String {
    let header_bucket = "bucket";
    let header_count = "count";
    let header_pct = "%";

    let bucket_label = |b: &Option<String>| match b.as_deref() {
        None => "unclassified".to_string(),
        Some(s) => s.to_string(),
    };

    let bucket_width = report
        .buckets
        .iter()
        .map(|b| bucket_label(&b.bucket).len())
        .max()
        .unwrap_or(0)
        .max(header_bucket.len());
    let count_width = report
        .buckets
        .iter()
        .map(|b| fmt_count(b.count).len())
        .max()
        .unwrap_or(0)
        .max(header_count.len())
        .max(8);
    let pct_width = 6;

    let row_width = bucket_width + 4 + count_width + 4 + pct_width;
    let rule: String = "-".repeat(row_width);

    let mut out = String::new();
    out.push_str(&format!(
        "  {:<bucket_width$}    {:>count_width$}    {:>pct_width$}\n",
        header_bucket,
        header_count,
        header_pct,
        bucket_width = bucket_width,
        count_width = count_width,
        pct_width = pct_width,
    ));
    out.push_str("  ");
    out.push_str(&rule);
    out.push('\n');

    let total_f = report.total as f64;
    for row in &report.buckets {
        let pct = (row.count as f64) / total_f * 100.0;
        out.push_str(&format!(
            "  {:<bucket_width$}    {:>count_width$}    {:>pct_width$}\n",
            bucket_label(&row.bucket),
            fmt_count(row.count),
            format!("{pct:.1}%"),
            bucket_width = bucket_width,
            count_width = count_width,
            pct_width = pct_width,
        ));
    }
    out.push_str("  ");
    out.push_str(&rule);
    out.push('\n');
    out.push_str(&format!(
        "  {:<bucket_width$}    {:>count_width$}    {:>pct_width$}\n",
        "TOTAL",
        fmt_count(report.total),
        "100.0%",
        bucket_width = bucket_width,
        count_width = count_width,
        pct_width = pct_width,
    ));
    out
}

fn format_op_type_table(report: &ParityReport) -> String {
    let header_op = "op_type";
    let header_count = "count";
    let header_pct = "%";

    let op_width = report
        .op_types
        .iter()
        .map(|r| r.op_type.len())
        .max()
        .unwrap_or(0)
        .max(header_op.len());
    let count_width = report
        .op_types
        .iter()
        .map(|r| fmt_count(r.count).len())
        .max()
        .unwrap_or(0)
        .max(header_count.len())
        .max(8);
    let pct_width = 6;

    let row_width = op_width + 4 + count_width + 4 + pct_width;
    let rule: String = "-".repeat(row_width);

    let mut out = String::new();
    out.push_str(&format!(
        "  {:<op_width$}    {:>count_width$}    {:>pct_width$}\n",
        header_op,
        header_count,
        header_pct,
        op_width = op_width,
        count_width = count_width,
        pct_width = pct_width,
    ));
    out.push_str("  ");
    out.push_str(&rule);
    out.push('\n');

    let total_f = report.total as f64;
    for row in &report.op_types {
        let pct = (row.count as f64) / total_f * 100.0;
        out.push_str(&format!(
            "  {:<op_width$}    {:>count_width$}    {:>pct_width$}\n",
            row.op_type,
            fmt_count(row.count),
            format!("{pct:.1}%"),
            op_width = op_width,
            count_width = count_width,
            pct_width = pct_width,
        ));
    }
    out
}

fn format_divergent_table(rows: &[DivergentOp]) -> String {
    // Five columns: id, timestamp, op_type, diffy summary, loro summary,
    // bucket. Truncate the two summary columns at SUMMARY_TRUNCATE so
    // the row stays under 132 cols at sane bucket / op_type lengths.
    let header_id = "id";
    let header_ts = "timestamp";
    let header_op = "op_type";
    let header_diffy = "diffy";
    let header_loro = "loro";
    let header_bucket = "bk";

    let id_width = rows
        .iter()
        .map(|r| fmt_count(r.id.unsigned_abs()).len())
        .max()
        .unwrap_or(0)
        .max(header_id.len());
    let ts_width = "2026-05-09T00:00:00Z".len().max(header_ts.len());
    let op_width = rows
        .iter()
        .map(|r| r.op_type.len())
        .max()
        .unwrap_or(0)
        .max(header_op.len());
    let diffy_width = rows
        .iter()
        .map(|r| {
            truncate_for_table(&r.diffy_result, SUMMARY_TRUNCATE)
                .chars()
                .count()
        })
        .max()
        .unwrap_or(0)
        .max(header_diffy.len());
    let loro_width = rows
        .iter()
        .map(|r| {
            truncate_for_table(&r.loro_result, SUMMARY_TRUNCATE)
                .chars()
                .count()
        })
        .max()
        .unwrap_or(0)
        .max(header_loro.len());
    let bucket_width = header_bucket.len(); // single character so 2 (header) is the floor

    let row_width = id_width
        + 2
        + ts_width
        + 2
        + op_width
        + 2
        + diffy_width
        + 2
        + loro_width
        + 2
        + bucket_width;
    let rule: String = "-".repeat(row_width);

    let mut out = String::new();
    out.push_str(&format!(
        "  {:>id_width$}  {:<ts_width$}  {:<op_width$}  {:<diffy_width$}  {:<loro_width$}  {:<bucket_width$}\n",
        header_id,
        header_ts,
        header_op,
        header_diffy,
        header_loro,
        header_bucket,
        id_width = id_width,
        ts_width = ts_width,
        op_width = op_width,
        diffy_width = diffy_width,
        loro_width = loro_width,
        bucket_width = bucket_width,
    ));
    out.push_str("  ");
    out.push_str(&rule);
    out.push('\n');

    for r in rows {
        let diffy = truncate_for_table(&r.diffy_result, SUMMARY_TRUNCATE);
        let loro = truncate_for_table(&r.loro_result, SUMMARY_TRUNCATE);
        // We pad by character count, not byte length, so the truncated
        // ellipsis (one char, three bytes) still aligns. Use a manual
        // pad-right because Rust's `{:<width$}` pads by byte length.
        let diffy_padded = pad_right_chars(&diffy, diffy_width);
        let loro_padded = pad_right_chars(&loro, loro_width);
        out.push_str(&format!(
            "  {:>id_width$}  {:<ts_width$}  {:<op_width$}  {}  {}  {:<bucket_width$}\n",
            r.id,
            fmt_timestamp_ms(r.created_at),
            r.op_type,
            diffy_padded,
            loro_padded,
            r.bucket,
            id_width = id_width,
            ts_width = ts_width,
            op_width = op_width,
            bucket_width = bucket_width,
        ));
    }
    out
}

/// Right-pad `s` with ASCII spaces until its character count reaches
/// `width`. Unlike Rust's `{:<width$}` formatter (which counts bytes),
/// this counts grapheme-approximating `chars()` so the truncation
/// ellipsis (`…`, three bytes, one char) doesn't visually misalign the
/// column.
fn pad_right_chars(s: &str, width: usize) -> String {
    let chars = s.chars().count();
    if chars >= width {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + (width - chars));
    out.push_str(s);
    for _ in 0..(width - chars) {
        out.push(' ');
    }
    out
}

fn verdict_line(report: &ParityReport) -> String {
    let d = report.d_count();
    if d == 0 {
        "Verdict: OK — kill-criterion #2 holds (D = 0 in this DB).\n".to_string()
    } else {
        format!(
            "Verdict: ALERT — D-bucket sightings present ({} row{}); investigate before cutover.\n",
            fmt_count(d),
            if d == 1 { "" } else { "s" },
        )
    }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match parse_args(&args) {
        ParsedArgs::Help => {
            print_help();
            ExitCode::SUCCESS
        }
        ParsedArgs::Version => {
            println!("parity_report {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ParsedArgs::BadArg(msg) => {
            eprintln!("parity_report: {msg}");
            eprintln!("Try `parity_report --help` for usage.");
            ExitCode::from(2)
        }
        ParsedArgs::Run { db_path: None } => {
            eprintln!("parity_report: a path to notes.db is required.");
            eprintln!("Try `parity_report --help` for usage.");
            ExitCode::from(2)
        }
        ParsedArgs::Run {
            db_path: Some(path),
        } => run_main(&path).await,
    }
}

async fn run_main(db_path: &std::path::Path) -> ExitCode {
    if !db_path.exists() {
        eprintln!(
            "parity_report: database file not found: {}",
            db_path.display()
        );
        return ExitCode::from(2);
    }

    // Read-only: SQLite refuses any writes (including incidental writes
    // like vacuum / WAL checkpoint) at the engine level. Safe to run on
    // a live DB while the main app is running.
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true);

    let pool = match SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
    {
        Ok(pool) => pool,
        Err(e) => {
            eprintln!("parity_report: failed to open DB: {e}");
            return ExitCode::from(2);
        }
    };

    match merge_parity_log_exists(&pool).await {
        Ok(true) => {}
        Ok(false) => {
            eprintln!(
                "parity_report: merge_parity_log table not found; was this DB built with shadow mode?"
            );
            eprintln!("  (the table is created by migration 0051_pend_09_merge_parity_log.sql,");
            eprintln!("  which only runs on builds that ran the migrations after it landed.)");
            return ExitCode::from(2);
        }
        Err(e) => {
            eprintln!("parity_report: sqlite_master probe failed: {e}");
            return ExitCode::from(2);
        }
    }

    let report = match load_report(&pool).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("parity_report: query failed: {e}");
            return ExitCode::from(2);
        }
    };

    print!("{}", format_report(&report, db_path));
    ExitCode::SUCCESS
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use agaric_lib::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    /// Build an empty, fully-migrated `notes.db` for tests. Mirrors the
    /// pattern in `op_log_histogram::tests::make_pool` and
    /// `audit_cross_space_refs::tests::make_pool`.
    async fn make_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("parity_report.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Insert a single `merge_parity_log` row. Test helper — the
    /// production write paths live in `parity_sink.rs` (chunked
    /// multi-row INSERT) but the diagnostic only reads, so the test
    /// fixture writes one row at a time.
    async fn insert_event(
        pool: &SqlitePool,
        op_id: &str,
        op_type: &str,
        diffy_result: &str,
        loro_result: &str,
        matched: bool,
        bucket: Option<&str>,
        created_at_ms: i64,
    ) {
        sqlx::query(
            "INSERT INTO merge_parity_log \
             (op_id, space_id, op_type, diffy_result, loro_result, matched, bucket, created_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(op_id)
        .bind("01ARZ3NDEKTSV4RRFFQ69G5FAV")
        .bind(op_type)
        .bind(diffy_result)
        .bind(loro_result)
        .bind(if matched { 1i64 } else { 0i64 })
        .bind(bucket)
        .bind(created_at_ms)
        .execute(pool)
        .await
        .expect("insert merge_parity_log row");
    }

    // -----------------------------------------------------------------------
    // 1. CLI parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_args_positional_path() {
        match parse_args(&["parity_report".into(), "/tmp/notes.db".into()]) {
            ParsedArgs::Run { db_path } => {
                assert_eq!(db_path.expect("path"), PathBuf::from("/tmp/notes.db"));
            }
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn parse_args_help_and_version() {
        assert!(matches!(
            parse_args(&["parity_report".into(), "--help".into()]),
            ParsedArgs::Help
        ));
        assert!(matches!(
            parse_args(&["parity_report".into(), "-V".into()]),
            ParsedArgs::Version
        ));
    }

    #[test]
    fn parse_args_unknown_flag_is_bad_arg() {
        assert!(matches!(
            parse_args(&["parity_report".into(), "--unknown".into()]),
            ParsedArgs::BadArg(_)
        ));
    }

    // -----------------------------------------------------------------------
    // 2. Required by the spec
    // -----------------------------------------------------------------------

    /// `parity_report_groups_by_bucket`: insert a mix of A/B/C/D/null
    /// events and assert the bucket counts come out right.
    #[tokio::test]
    async fn parity_report_groups_by_bucket() {
        let (pool, _dir) = make_pool().await;

        // 5x A
        for i in 0..5 {
            insert_event(
                &pool,
                &format!("dev/A{i}"),
                "edit_block",
                "edit:BLK1:hi",
                "edit:BLK1:hi",
                true,
                Some("A"),
                1_000 + i,
            )
            .await;
        }
        // 1x B
        insert_event(
            &pool,
            "dev/B0",
            "edit_block",
            "conflict:BLK2",
            "edit:BLK2:bye",
            false,
            Some("B"),
            2_000,
        )
        .await;
        // 2x C
        for i in 0..2 {
            insert_event(
                &pool,
                &format!("dev/C{i}"),
                "set_property",
                "set_property:BLK3.k=v1",
                "set_property:BLK3.k=v2",
                false,
                Some("C"),
                3_000 + i,
            )
            .await;
        }
        // 1x D
        insert_event(
            &pool,
            "dev/D0",
            "edit_block",
            "edit:BLK4:hi",
            "error:Validation(boom)",
            false,
            Some("D"),
            4_000,
        )
        .await;
        // 1x unclassified
        insert_event(
            &pool,
            "dev/N0",
            "create_block",
            "create:BLK5",
            "create:BLK5",
            true,
            None,
            5_000,
        )
        .await;

        let report = load_report(&pool).await.expect("load_report");
        assert_eq!(report.total, 10);

        // Buckets: NULL sorts first, then A, B, C, D (ORDER BY bucket).
        let counts: Vec<(Option<&str>, u64)> = report
            .buckets
            .iter()
            .map(|b| (b.bucket.as_deref(), b.count))
            .collect();
        assert_eq!(
            counts,
            vec![
                (None, 1),
                (Some("A"), 5),
                (Some("B"), 1),
                (Some("C"), 2),
                (Some("D"), 1),
            ]
        );

        // d_count helper.
        assert_eq!(report.d_count(), 1);
    }

    /// `parity_report_handles_empty_log`: empty merge_parity_log → the
    /// formatter says "0 events" and the verdict is OK (D = 0).
    #[tokio::test]
    async fn parity_report_handles_empty_log() {
        let (pool, dir) = make_pool().await;

        // Confirm the table exists (migrations ran).
        assert!(merge_parity_log_exists(&pool)
            .await
            .expect("sqlite_master probe"));

        let report = load_report(&pool).await.expect("load_report");
        assert!(report.is_empty(), "fresh DB should have no parity rows");
        assert_eq!(report.total, 0);
        assert!(report.buckets.is_empty());
        assert!(report.op_types.is_empty());
        assert!(report.date_range.is_none());
        assert!(report.recent_divergent.is_empty());
        assert_eq!(report.d_count(), 0);

        // The formatted output mentions "0 events" and the "(no events)"
        // date-range fallback so the user sees the empty-state plainly.
        let out = format_report(&report, &dir.path().join("parity_report.db"));
        assert!(out.contains("0 events"));
        assert!(out.contains("(no events)"));
        assert!(out.contains("OK"));
    }

    /// `parity_report_lists_recent_divergent`: 25 D events + 25 A
    /// events; assert the recent-divergent slice has exactly the LIMIT
    /// 20 cap, only D rows, and is ordered by created_at DESC.
    #[tokio::test]
    async fn parity_report_lists_recent_divergent() {
        let (pool, _dir) = make_pool().await;

        for i in 0..25i64 {
            insert_event(
                &pool,
                &format!("dev/D{i}"),
                "edit_block",
                &format!("edit:BLK{i}:hi"),
                "error:Validation(boom)",
                false,
                Some("D"),
                10_000 + i, // strictly increasing timestamps
            )
            .await;
            // Plus an A row that should NOT appear in the recent-divergent
            // slice.
            insert_event(
                &pool,
                &format!("dev/A{i}"),
                "create_block",
                &format!("create:BLK{i}"),
                &format!("create:BLK{i}"),
                true,
                Some("A"),
                10_000 + i,
            )
            .await;
        }

        let report = load_report(&pool).await.expect("load_report");
        assert_eq!(report.total, 50);

        // Cap honoured.
        let recent = &report.recent_divergent;
        assert_eq!(
            recent.len() as i64,
            RECENT_DIVERGENT_LIMIT,
            "recent-divergent slice must be capped at {} rows",
            RECENT_DIVERGENT_LIMIT,
        );

        // All bucket-D, no bucket-A.
        for r in recent {
            assert_eq!(r.bucket, "D");
        }

        // Ordered created_at DESC. With our seed (10_000 + i for i in
        // 0..25), the most recent D event has created_at = 10_024, then
        // 10_023, ...
        for (idx, r) in recent.iter().enumerate() {
            let expected_ts = 10_024 - idx as i64;
            assert_eq!(
                r.created_at, expected_ts,
                "row {idx} expected ts {expected_ts}, got {}",
                r.created_at,
            );
        }
    }

    /// `parity_report_verdict_on_zero_d`: only A/B/C events → verdict
    /// is OK.
    #[tokio::test]
    async fn parity_report_verdict_on_zero_d() {
        let (pool, dir) = make_pool().await;

        insert_event(
            &pool,
            "dev/A0",
            "create_block",
            "create:BLK1",
            "create:BLK1",
            true,
            Some("A"),
            1_000,
        )
        .await;
        insert_event(
            &pool,
            "dev/B0",
            "edit_block",
            "conflict:BLK2",
            "edit:BLK2:bye",
            false,
            Some("B"),
            2_000,
        )
        .await;
        insert_event(
            &pool,
            "dev/C0",
            "set_property",
            "set_property:BLK3.k=v1",
            "set_property:BLK3.k=v2",
            false,
            Some("C"),
            3_000,
        )
        .await;

        let report = load_report(&pool).await.expect("load_report");
        assert_eq!(report.d_count(), 0);

        let out = format_report(&report, &dir.path().join("parity_report.db"));
        assert!(
            out.contains("Verdict: OK"),
            "verdict line should say OK; got: {out}",
        );
        assert!(out.contains("kill-criterion #2 holds"));
        assert!(
            !out.contains("Verdict: ALERT"),
            "must not emit ALERT verdict when D = 0",
        );
    }

    /// `parity_report_verdict_on_d_present`: at least one D event →
    /// verdict is ALERT.
    #[tokio::test]
    async fn parity_report_verdict_on_d_present() {
        let (pool, dir) = make_pool().await;

        // One A row (so the table isn't empty) plus one D row.
        insert_event(
            &pool,
            "dev/A0",
            "create_block",
            "create:BLK1",
            "create:BLK1",
            true,
            Some("A"),
            1_000,
        )
        .await;
        insert_event(
            &pool,
            "dev/D0",
            "edit_block",
            "edit:BLK1:hi",
            "error:Validation(boom)",
            false,
            Some("D"),
            2_000,
        )
        .await;

        let report = load_report(&pool).await.expect("load_report");
        assert_eq!(report.d_count(), 1);

        let out = format_report(&report, &dir.path().join("parity_report.db"));
        assert!(
            out.contains("Verdict: ALERT"),
            "verdict line should say ALERT when D > 0; got: {out}",
        );
        assert!(out.contains("D-bucket sightings present"));
        assert!(out.contains("investigate before cutover"));
    }

    // -----------------------------------------------------------------------
    // 3. Schema-detection contract
    // -----------------------------------------------------------------------

    /// `merge_parity_log_exists` returns true on a fully-migrated DB.
    #[tokio::test]
    async fn merge_parity_log_exists_on_migrated_db() {
        let (pool, _dir) = make_pool().await;
        assert!(merge_parity_log_exists(&pool).await.expect("probe"));
    }

    /// `merge_parity_log_exists` returns false when the table has been
    /// dropped (simulating a DB that was built before the migration
    /// landed).
    #[tokio::test]
    async fn merge_parity_log_exists_returns_false_when_table_absent() {
        let (pool, _dir) = make_pool().await;
        sqlx::query("DROP TABLE merge_parity_log")
            .execute(&pool)
            .await
            .expect("drop merge_parity_log");
        assert!(!merge_parity_log_exists(&pool)
            .await
            .expect("probe after drop"));
    }

    // -----------------------------------------------------------------------
    // 4. Pretty-printer smoke tests
    // -----------------------------------------------------------------------

    #[test]
    fn fmt_count_inserts_thousands_separators() {
        assert_eq!(fmt_count(0), "0");
        assert_eq!(fmt_count(42), "42");
        assert_eq!(fmt_count(1_000), "1,000");
        assert_eq!(fmt_count(1_234_567), "1,234,567");
    }

    #[test]
    fn fmt_timestamp_ms_round_trips_known_dates() {
        // Epoch.
        assert_eq!(fmt_timestamp_ms(0), "1970-01-01T00:00:00Z");
        // 2026-05-09 00:00:00 UTC — sanity-check the days-from-civil
        // arithmetic on a recent date. Re-derivable via
        // `date -u --date='2026-05-09 00:00:00 UTC' +%s` → 1778284800.
        assert_eq!(fmt_timestamp_ms(1_778_284_800_000), "2026-05-09T00:00:00Z");
        // A non-UTC-midnight time too, to exercise the H/M/S branches.
        // 2026-05-09 12:34:56 UTC = 1778284800 + 12*3600 + 34*60 + 56 = 1778330096.
        assert_eq!(fmt_timestamp_ms(1_778_330_096_000), "2026-05-09T12:34:56Z");
    }

    #[test]
    fn truncate_for_table_keeps_short_strings() {
        assert_eq!(truncate_for_table("abc", 10), "abc");
        assert_eq!(truncate_for_table("", 10), "");
    }

    #[test]
    fn truncate_for_table_truncates_long_strings_with_ellipsis() {
        let out = truncate_for_table("0123456789ABCDEFGHIJ", 10);
        assert_eq!(out.chars().count(), 10);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn pad_right_chars_pads_by_character_count() {
        // The ellipsis `…` is one char but three bytes; the padder
        // counts chars so the column visually aligns.
        let s = "abc…";
        let padded = pad_right_chars(s, 6);
        assert_eq!(padded.chars().count(), 6);
        assert!(padded.starts_with("abc…"));
        assert!(padded.ends_with("  "));
    }

    #[test]
    fn format_report_shows_table_with_rule_lines_and_no_color() {
        // Build a synthetic report bypassing the DB so the test stays
        // pure (no migrations, no async).
        let report = ParityReport {
            total: 3,
            buckets: vec![
                BucketRow {
                    bucket: Some("A".into()),
                    count: 2,
                },
                BucketRow {
                    bucket: Some("D".into()),
                    count: 1,
                },
            ],
            op_types: vec![
                OpTypeRow {
                    op_type: "edit_block".into(),
                    count: 2,
                },
                OpTypeRow {
                    op_type: "create_block".into(),
                    count: 1,
                },
            ],
            date_range: Some((1_778_284_800_000, 1_778_284_805_000)),
            recent_divergent: vec![DivergentOp {
                id: 42,
                op_id: "dev/x/1".into(),
                op_type: "edit_block".into(),
                diffy_result: "edit:BLK1:hi".into(),
                loro_result: "error:Validation(boom)".into(),
                bucket: "D".into(),
                created_at: 1_778_284_805_000,
            }],
        };

        let out = format_report(&report, std::path::Path::new("/tmp/notes.db"));

        // Header
        assert!(out.contains("merge_parity_log report"));
        assert!(out.contains("Date range: 2026-05-09T00:00:00Z .. 2026-05-09T00:00:05Z"));
        assert!(out.contains("Total events: 3"));
        // Bucket table
        assert!(out.contains("bucket"));
        assert!(out.contains("count"));
        // Op-type table
        assert!(out.contains("op_type"));
        assert!(out.contains("edit_block"));
        // Divergent table
        assert!(out.contains("Recent divergent ops"));
        assert!(out.contains("error:Validation(boom)"));
        // Verdict
        assert!(out.contains("Verdict: ALERT"));
        // ASCII-only rule line
        assert!(out.contains("-----"));
        assert!(
            !out.contains("─"),
            "rule should be ASCII so the output is grep / pipe friendly"
        );
        // No color codes
        assert!(
            !out.contains("\x1b["),
            "must not contain ANSI escape codes — output may be piped"
        );
    }

    #[test]
    fn format_report_empty_db_shows_zero_events_and_ok_verdict() {
        let report = ParityReport {
            total: 0,
            buckets: Vec::new(),
            op_types: Vec::new(),
            date_range: None,
            recent_divergent: Vec::new(),
        };
        let out = format_report(&report, std::path::Path::new("/tmp/notes.db"));
        assert!(out.contains("merge_parity_log is empty (0 events)."));
        assert!(out.contains("Verdict: OK"));
    }

    /// Op-type table ordering: count DESC, op_type ASC tiebreak.
    #[tokio::test]
    async fn op_types_break_ties_alphabetically() {
        let (pool, _dir) = make_pool().await;
        // Two op_types with the same count — alphabetical ASC tiebreak.
        for i in 0..3 {
            insert_event(
                &pool,
                &format!("dev/E{i}"),
                "edit_block",
                "edit:BLK1:hi",
                "edit:BLK1:hi",
                true,
                Some("A"),
                1_000 + i,
            )
            .await;
        }
        for i in 0..3 {
            insert_event(
                &pool,
                &format!("dev/C{i}"),
                "create_block",
                "create:BLK2",
                "create:BLK2",
                true,
                Some("A"),
                2_000 + i,
            )
            .await;
        }
        let report = load_report(&pool).await.expect("load_report");
        let names: Vec<&str> = report.op_types.iter().map(|r| r.op_type.as_str()).collect();
        assert_eq!(names, vec!["create_block", "edit_block"]);
    }

    /// Divergent-table tiebreak on `id DESC`: when two C/D events share
    /// the exact same `created_at`, the higher id wins so the slice is
    /// fully deterministic.
    #[tokio::test]
    async fn divergent_table_breaks_timestamp_ties_by_id_desc() {
        let (pool, _dir) = make_pool().await;
        // Three D rows at the same timestamp — order should be id DESC,
        // i.e. the last inserted comes out first.
        for i in 0..3 {
            insert_event(
                &pool,
                &format!("dev/D{i}"),
                "edit_block",
                &format!("edit:BLK{i}:hi"),
                "error:Validation(boom)",
                false,
                Some("D"),
                5_000, // identical
            )
            .await;
        }
        let report = load_report(&pool).await.expect("load_report");
        let ids: Vec<i64> = report.recent_divergent.iter().map(|r| r.id).collect();
        // AUTOINCREMENT primary key → ids are 1, 2, 3 in insert order;
        // ORDER BY id DESC → 3, 2, 1.
        assert_eq!(ids, vec![3, 2, 1]);
    }
}
