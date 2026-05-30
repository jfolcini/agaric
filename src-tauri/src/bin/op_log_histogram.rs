//! `op_log_histogram` — read-only diagnostic.
//!
//! Runs against a `notes.db` to print the op_log distribution and
//! flag any op type whose share differs more than 2×/0.5× from a
//! reference mix.
//!
//! ## Behaviour
//!
//! - Opens the database **read-only**
//!   (`SqliteConnectOptions::read_only(true)`) so the binary can never
//!   accidentally write to the user's data — safe to run on a live DB.
//! - Runs `SELECT op_type, COUNT(*) FROM op_log GROUP BY op_type ORDER BY
//!   2 DESC, op_type ASC` (deterministic tie-break on op_type to keep
//!   stdout reproducible across runs).
//! - Computes percentages and pretty-prints a table.
//! - Flags op types whose share differs more than 2× over or 0.5×
//!   under the reference mix. Flags are **informational only**.
//!
//! ## Exit codes
//!
//! - `0` — histogram printed; zero or more flags emitted.
//! - `2` — error (DB not found, schema mismatch, IO failure …).

use std::path::PathBuf;
use std::process::ExitCode;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

use agaric_lib::error::AppError;

// ---------------------------------------------------------------------------
// CLI argument parsing (hand-rolled — mirrors agaric-mcp / audit_cross_space_refs)
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
            // `op_log_histogram /path/to/notes.db` invocation.
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
        "op_log_histogram — read-only diagnostic\n\
         \n\
         USAGE:\n    \
             op_log_histogram <NOTES_DB>\n    \
             op_log_histogram --db-path <NOTES_DB>\n\
         \n\
         OPTIONS:\n    \
             --db-path <PATH>  Path to notes.db (read-only). Required (no default).\n    \
             -V, --version     Print version and exit.\n    \
             -h, --help        Print this help and exit.\n\
         \n\
         EXIT CODES:\n    \
             0   Histogram printed.\n    \
             2   Real error (DB missing, schema mismatch, IO failure)."
    );
}

// ---------------------------------------------------------------------------
// Histogram data model
// ---------------------------------------------------------------------------

/// One row of the histogram — an op type string from `op_log.op_type` plus
/// its count in the queried `op_log`. Op types are kept verbatim (no folding
/// into an "_other_" bucket); op types that are not in the spike's
/// `PROXY_MIX` are surfaced as `[not-in-proxy]` rows by
/// [`compare_against_proxy`] when their share is non-trivial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HistogramRow {
    pub op_type: String,
    pub count: u64,
}

#[derive(Debug, Clone)]
pub(crate) struct Histogram {
    pub rows: Vec<HistogramRow>,
    pub total: u64,
}

impl Histogram {
    /// Empty-DB constant for documentation + tests.
    pub fn is_empty(&self) -> bool {
        self.total == 0
    }
}

// ---------------------------------------------------------------------------
// Spike proxy mix — per `SPIKE-REPORT.md` §3 row "Plan 9"
// ---------------------------------------------------------------------------

/// The synthetic 30/50/10/5/5 mix the spike's day-4 replay benchmark used.
/// Anything not in this table is implicitly proxy-share = 0 — for those op
/// types the comparison logic in [`compare_against_proxy`] flags them as
/// "no proxy reference" rather than "over/under".
const PROXY_MIX: &[(&str, f64)] = &[
    ("create_block", 0.30),
    ("edit_block", 0.50),
    ("move_block", 0.10),
    ("delete_block", 0.05),
    ("set_property", 0.05),
];

/// Threshold above which an op type's actual share is "over" its proxy
/// share. 2.0 means actual ≥ 2× proxy.
const OVER_THRESHOLD: f64 = 2.0;

/// Threshold below which an op type's actual share is "under" its proxy
/// share. 0.5 means actual ≤ 0.5× proxy.
const UNDER_THRESHOLD: f64 = 0.5;

/// Convert a [0.0, 1.0]-clamped share to a permyriad (parts per 10 000).
/// Used for `Eq`-friendly storage in [`ProxyComparison`] and the
/// pretty-printer's percentage formatter. Inputs outside the unit interval
/// are clamped before scaling so the cast never overflows or sign-loses;
/// the explicit clamp + round documents the intent so the
/// `cast_possible_truncation` / `cast_sign_loss` lints can be silenced
/// locally without hiding a real bug.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn permyriad_from_share(share: f64) -> u64 {
    let clamped = share.clamp(0.0, 1.0);
    (clamped * 10_000.0).round() as u64
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ProxyFlag {
    /// Actual share is more than `OVER_THRESHOLD` × proxy share.
    Over,
    /// Actual share is less than `UNDER_THRESHOLD` × proxy share.
    Under,
    /// Op type appears in the histogram but not in `PROXY_MIX` — the
    /// spike never measured it. Informational.
    NotInProxy,
    /// Op type is in `PROXY_MIX` but absent from the histogram (count 0)
    /// — the proxy claims this share, the real data has none.
    AbsentInActual,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProxyComparison {
    pub op_type: String,
    pub actual_share: u64, // share encoded as a permyriad (parts per 10 000) for Eq-friendly tests
    pub proxy_share_permyriad: u64,
    pub flag: ProxyFlag,
}

/// Compare the histogram against the spike's `PROXY_MIX`. Returns a list
/// of flags — empty if every op type's share is within
/// `[UNDER_THRESHOLD, OVER_THRESHOLD]` × its proxy share AND every
/// proxy-listed op type is present.
///
/// Edge case: an empty histogram (`total == 0`) returns an empty Vec —
/// the proxy comparison is meaningless on an empty op_log.
pub(crate) fn compare_against_proxy(hist: &Histogram) -> Vec<ProxyComparison> {
    if hist.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let total_f = hist.total as f64;

    // Build a lookup from op_type → count for the absent-in-actual check.
    let actual_count_of = |op: &str| -> u64 {
        hist.rows
            .iter()
            .find(|r| r.op_type == op)
            .map(|r| r.count)
            .unwrap_or(0)
    };

    // 1. Walk the actual histogram rows.
    for row in &hist.rows {
        let actual_share = (row.count as f64) / total_f;
        // Find the row in PROXY_MIX.
        let proxy_share = PROXY_MIX
            .iter()
            .find(|(t, _)| *t == row.op_type)
            .map(|(_, s)| *s);

        match proxy_share {
            None => {
                // Not in proxy — only flag if the share is non-trivial
                // (≥ 1% of the op_log) so the report doesn't drown in
                // tiny-share informational rows for purge_block /
                // restore_block etc.
                if actual_share >= 0.01 {
                    out.push(ProxyComparison {
                        op_type: row.op_type.clone(),
                        actual_share: permyriad_from_share(actual_share),
                        proxy_share_permyriad: 0,
                        flag: ProxyFlag::NotInProxy,
                    });
                }
            }
            Some(p) => {
                // Strict comparison so the spec wording "more than 2x over
                // or less than 0.5x under" reads naturally: ratio == 2.0
                // exactly does not flag. Boundary cases are unlikely in
                // practice (real shares are floating point) but the strict
                // form keeps tests deterministic against synthetic data.
                let ratio = actual_share / p;
                if ratio > OVER_THRESHOLD {
                    out.push(ProxyComparison {
                        op_type: row.op_type.clone(),
                        actual_share: permyriad_from_share(actual_share),
                        proxy_share_permyriad: permyriad_from_share(p),
                        flag: ProxyFlag::Over,
                    });
                } else if ratio < UNDER_THRESHOLD {
                    out.push(ProxyComparison {
                        op_type: row.op_type.clone(),
                        actual_share: permyriad_from_share(actual_share),
                        proxy_share_permyriad: permyriad_from_share(p),
                        flag: ProxyFlag::Under,
                    });
                }
            }
        }
    }

    // 2. Catch proxy-listed op types that are entirely absent from the
    // actual histogram — those would slip through the loop above because
    // we only iterate present rows.
    for (op, p) in PROXY_MIX {
        if actual_count_of(op) == 0 {
            out.push(ProxyComparison {
                op_type: (*op).into(),
                actual_share: 0,
                proxy_share_permyriad: permyriad_from_share(*p),
                flag: ProxyFlag::AbsentInActual,
            });
        }
    }

    out
}

// ---------------------------------------------------------------------------
// SQL — load the histogram from a notes.db op_log
// ---------------------------------------------------------------------------

/// Run the histogram query against an open SQLite pool. Sorts by count
/// descending, then op_type ascending so the output is reproducible.
///
/// Note: this function uses dynamic `sqlx::query_as` rather than the
/// macro-checked `query_as!` so the binary builds without needing a live
/// `sqlx prepare` step. The query references only the canonical `op_log`
/// columns (declared in migration `0001_initial.sql`), so column-name
/// drift is statically obvious from `Cargo.toml`'s migrations directory.
pub(crate) async fn load_histogram(pool: &SqlitePool) -> Result<Histogram, AppError> {
    #[derive(sqlx::FromRow)]
    struct Row {
        op_type: String,
        // SQLite COUNT returns INTEGER which sqlx maps to i64. We cast
        // to u64 below — counts are non-negative by construction.
        count: i64,
    }

    let rows: Vec<Row> = sqlx::query_as::<_, Row>(
        "SELECT op_type, COUNT(*) AS count \
         FROM op_log \
         GROUP BY op_type \
         ORDER BY count DESC, op_type ASC",
    )
    .fetch_all(pool)
    .await?;

    let mut total: u64 = 0;
    let mut out_rows: Vec<HistogramRow> = Vec::with_capacity(rows.len());
    for r in rows {
        let count = u64::try_from(r.count).map_err(|_| {
            AppError::InvalidOperation(format!(
                "op_log count for op_type '{}' is negative ({}); refusing to proceed",
                r.op_type, r.count
            ))
        })?;
        total = total.saturating_add(count);
        out_rows.push(HistogramRow {
            op_type: r.op_type,
            count,
        });
    }

    Ok(Histogram {
        rows: out_rows,
        total,
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

/// Format a permyriad (parts per 10 000) as `NN.N%` for proxy-flag rows.
fn fmt_permyriad(p: u64) -> String {
    let pct = p as f64 / 100.0;
    format!("{pct:.1}%")
}

/// Render the histogram as a table. No color codes — the user might pipe
/// the output to a file. The header / footer rules use ASCII `-` rather
/// than U+2500 box-drawing so the output is grep-friendly.
pub(crate) fn format_histogram(hist: &Histogram, db_path: &std::path::Path) -> String {
    let mut out = String::new();
    out.push_str("op_log histogram\n");
    out.push_str(&format!("DB path: {}\n\n", db_path.display()));

    if hist.is_empty() {
        out.push_str("op_log is empty (0 ops).\n");
        return out;
    }

    let header_op = "op_type";
    let header_count = "count";
    let header_pct = "%";

    // Column widths: op_type column is the wider of the header and the
    // longest op_type string in the histogram. Count column is at least 8
    // wide (long enough for hundreds of millions with thousands seps).
    let op_width = hist
        .rows
        .iter()
        .map(|r| r.op_type.len())
        .max()
        .unwrap_or(0)
        .max(header_op.len());
    let count_width = hist
        .rows
        .iter()
        .map(|r| fmt_count(r.count).len())
        .max()
        .unwrap_or(0)
        .max(header_count.len())
        .max(8);
    let pct_width = 6; // "100.0%" is 6 chars

    let row_width = op_width + 4 + count_width + 4 + pct_width;
    let rule: String = "-".repeat(row_width);

    out.push_str(&format!(
        "{:<op_width$}    {:>count_width$}    {:>pct_width$}\n",
        header_op,
        header_count,
        header_pct,
        op_width = op_width,
        count_width = count_width,
        pct_width = pct_width,
    ));
    out.push_str(&rule);
    out.push('\n');

    let total_f = hist.total as f64;
    for row in &hist.rows {
        let pct = (row.count as f64) / total_f * 100.0;
        out.push_str(&format!(
            "{:<op_width$}    {:>count_width$}    {:>pct_width$}\n",
            row.op_type,
            fmt_count(row.count),
            format!("{pct:.1}%"),
            op_width = op_width,
            count_width = count_width,
            pct_width = pct_width,
        ));
    }
    out.push_str(&rule);
    out.push('\n');
    out.push_str(&format!(
        "{:<op_width$}    {:>count_width$}    {:>pct_width$}\n",
        "TOTAL",
        fmt_count(hist.total),
        "100.0%",
        op_width = op_width,
        count_width = count_width,
        pct_width = pct_width,
    ));
    out
}

/// Render the proxy-comparison block — empty string if every share is
/// within the configured thresholds AND every proxy-listed op is present.
pub(crate) fn format_proxy_comparison(comparisons: &[ProxyComparison]) -> String {
    if comparisons.is_empty() {
        return "\nProxy comparison vs spike's 30/50/10/5/5 mix: within tolerance \
                (no op type is >2x over or <0.5x under the proxy share).\n"
            .to_string();
    }

    let mut out = String::new();
    out.push_str(
        "\nProxy comparison vs spike's 30/50/10/5/5 mix \
                  (kill-criterion #3 informational only):\n",
    );
    for c in comparisons {
        let line = match c.flag {
            ProxyFlag::Over => format!(
                "  [over]              {op_type} actual {actual} > 2x proxy {proxy}\n",
                op_type = c.op_type,
                actual = fmt_permyriad(c.actual_share),
                proxy = fmt_permyriad(c.proxy_share_permyriad),
            ),
            ProxyFlag::Under => format!(
                "  [under]             {op_type} actual {actual} < 0.5x proxy {proxy}\n",
                op_type = c.op_type,
                actual = fmt_permyriad(c.actual_share),
                proxy = fmt_permyriad(c.proxy_share_permyriad),
            ),
            ProxyFlag::NotInProxy => format!(
                "  [not-in-proxy]      {op_type} actual {actual} (spike proxy did not measure this op type)\n",
                op_type = c.op_type,
                actual = fmt_permyriad(c.actual_share),
            ),
            ProxyFlag::AbsentInActual => format!(
                "  [absent-in-actual]  {op_type} proxy {proxy}, actual 0 (proxy claims share, real data has none)\n",
                op_type = c.op_type,
                proxy = fmt_permyriad(c.proxy_share_permyriad),
            ),
        };
        out.push_str(&line);
    }
    out
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
            println!("op_log_histogram {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ParsedArgs::BadArg(msg) => {
            eprintln!("op_log_histogram: {msg}");
            eprintln!("Try `op_log_histogram --help` for usage.");
            ExitCode::from(2)
        }
        ParsedArgs::Run { db_path: None } => {
            eprintln!("op_log_histogram: a path to notes.db is required.");
            eprintln!("Try `op_log_histogram --help` for usage.");
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
            "op_log_histogram: database file not found: {}",
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
            eprintln!("op_log_histogram: failed to open DB: {e}");
            return ExitCode::from(2);
        }
    };

    let hist = match load_histogram(&pool).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!("op_log_histogram: query failed: {e}");
            return ExitCode::from(2);
        }
    };

    print!("{}", format_histogram(&hist, db_path));
    if !hist.is_empty() {
        let comparisons = compare_against_proxy(&hist);
        print!("{}", format_proxy_comparison(&comparisons));
    }

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
    /// pattern in `audit_cross_space_refs::tests::make_pool`.
    async fn make_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("histogram.db");
        let pool = init_pool(&db_path).await.expect("init_pool");
        (pool, dir)
    }

    /// Insert a single op_log row with the given op_type. The other
    /// columns are filled with deterministic placeholders — the
    /// histogram only reads `op_type`, so payload / hash content is
    /// immaterial.
    async fn insert_op(pool: &SqlitePool, device_id: &str, seq: i64, op_type: &str) {
        sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, ?, ?, 1778284800000)",
        )
        .bind(device_id)
        .bind(seq)
        .bind(format!("hash-{device_id}-{seq}"))
        .bind(op_type)
        .bind("{}")
        .execute(pool)
        .await
        .expect("insert op_log row");
    }

    // -----------------------------------------------------------------------
    // 1. CLI parsing
    // -----------------------------------------------------------------------

    #[test]
    fn parse_args_positional_path() {
        match parse_args(&["op_log_histogram".into(), "/tmp/notes.db".into()]) {
            ParsedArgs::Run { db_path } => {
                assert_eq!(db_path.unwrap(), PathBuf::from("/tmp/notes.db"));
            }
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn parse_args_db_path_flag() {
        match parse_args(&[
            "op_log_histogram".into(),
            "--db-path".into(),
            "/tmp/x.db".into(),
        ]) {
            ParsedArgs::Run { db_path } => {
                assert_eq!(db_path.unwrap(), PathBuf::from("/tmp/x.db"));
            }
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn parse_args_help_and_version() {
        assert!(matches!(
            parse_args(&["op_log_histogram".into(), "--help".into()]),
            ParsedArgs::Help
        ));
        assert!(matches!(
            parse_args(&["op_log_histogram".into(), "-V".into()]),
            ParsedArgs::Version
        ));
    }

    #[test]
    fn parse_args_unknown_flag_is_bad_arg() {
        assert!(matches!(
            parse_args(&["op_log_histogram".into(), "--unknown".into()]),
            ParsedArgs::BadArg(_)
        ));
    }

    // -----------------------------------------------------------------------
    // 2. Histogram core — required by the spec
    // -----------------------------------------------------------------------

    /// `histogram_groups_by_op_type`: stand up a temp DB, insert N op_log
    /// rows of mixed types, run the histogram fn, assert the counts.
    #[tokio::test]
    async fn histogram_groups_by_op_type() {
        let (pool, _dir) = make_pool().await;
        // 5x edit_block, 3x create_block, 2x set_property, 1x move_block.
        for i in 0..5 {
            insert_op(&pool, "dev-A", i, "edit_block").await;
        }
        for i in 0..3 {
            insert_op(&pool, "dev-B", i, "create_block").await;
        }
        for i in 0..2 {
            insert_op(&pool, "dev-C", i, "set_property").await;
        }
        insert_op(&pool, "dev-D", 0, "move_block").await;

        let hist = load_histogram(&pool).await.expect("load_histogram");
        assert_eq!(hist.total, 11, "total count should sum across op types");
        // Ordering: count DESC, op_type ASC for ties. With these counts
        // (5, 3, 2, 1) there are no ties so order is just count-DESC.
        assert_eq!(
            hist.rows,
            vec![
                HistogramRow {
                    op_type: "edit_block".into(),
                    count: 5
                },
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 3
                },
                HistogramRow {
                    op_type: "set_property".into(),
                    count: 2
                },
                HistogramRow {
                    op_type: "move_block".into(),
                    count: 1
                },
            ]
        );
    }

    /// `histogram_handles_empty_op_log`: empty DB, histogram returns
    /// "0 ops" — i.e. `Histogram::is_empty()` and the formatter says so.
    #[tokio::test]
    async fn histogram_handles_empty_op_log() {
        let (pool, dir) = make_pool().await;
        let hist = load_histogram(&pool).await.expect("load_histogram");
        assert!(hist.is_empty(), "fresh DB should have empty op_log");
        assert_eq!(hist.total, 0);
        assert!(hist.rows.is_empty());

        // Output format sanity check.
        let out = format_histogram(&hist, &dir.path().join("histogram.db"));
        assert!(out.contains("op_log is empty (0 ops)."));
    }

    /// `histogram_compares_against_proxy`: verify the over/under-flag
    /// logic. Construct three Histograms in-memory: (1) one matching the
    /// proxy mix exactly — zero flags expected; (2) one with set_property
    /// at 80% — the requested example "user bulk-tags a lot" — flags Over;
    /// (3) one with edit_block missing — flags Under for edit_block + the
    /// AbsentInActual entry.
    #[test]
    fn histogram_compares_against_proxy() {
        // (1) Exact proxy mix, total 10 000 to make the math obvious.
        let hist_proxy = Histogram {
            rows: vec![
                HistogramRow {
                    op_type: "edit_block".into(),
                    count: 5_000,
                },
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 3_000,
                },
                HistogramRow {
                    op_type: "move_block".into(),
                    count: 1_000,
                },
                HistogramRow {
                    op_type: "delete_block".into(),
                    count: 500,
                },
                HistogramRow {
                    op_type: "set_property".into(),
                    count: 500,
                },
            ],
            total: 10_000,
        };
        let cmps = compare_against_proxy(&hist_proxy);
        assert!(
            cmps.is_empty(),
            "exact-proxy histogram should produce no flags, got {cmps:?}"
        );

        // (2) set_property dominates at 80% — the bulk-tag scenario.
        // edit_block at 5% (10× under proxy 50%), create_block at 5%, etc.
        let hist_bulk_tag = Histogram {
            rows: vec![
                HistogramRow {
                    op_type: "set_property".into(),
                    count: 8_000,
                },
                HistogramRow {
                    op_type: "edit_block".into(),
                    count: 500,
                },
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 500,
                },
                HistogramRow {
                    op_type: "move_block".into(),
                    count: 500,
                },
                HistogramRow {
                    op_type: "delete_block".into(),
                    count: 500,
                },
            ],
            total: 10_000,
        };
        let cmps = compare_against_proxy(&hist_bulk_tag);
        // Expected flags:
        // - set_property: 80% / 5% = 16x over.
        // - edit_block: 5% / 50% = 0.1x = 10x under.
        // - create_block: 5% / 30% = 0.166x → under.
        let by_op = |op: &str| -> Vec<&ProxyComparison> {
            cmps.iter().filter(|c| c.op_type == op).collect()
        };
        assert_eq!(by_op("set_property").len(), 1);
        assert_eq!(by_op("set_property")[0].flag, ProxyFlag::Over);
        assert_eq!(by_op("edit_block").len(), 1);
        assert_eq!(by_op("edit_block")[0].flag, ProxyFlag::Under);
        assert_eq!(by_op("create_block").len(), 1);
        assert_eq!(by_op("create_block")[0].flag, ProxyFlag::Under);
        // move_block + delete_block are both within tolerance — no flag.
        assert!(
            by_op("move_block").is_empty(),
            "move_block at 5%/10%=0.5x is at the boundary, should not flag (strict <)"
        );
        // delete_block at 5% / 5% = exactly 1x — no flag.
        assert!(by_op("delete_block").is_empty());

        // (3) edit_block missing entirely.
        let hist_no_edits = Histogram {
            rows: vec![
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 6_000,
                },
                HistogramRow {
                    op_type: "move_block".into(),
                    count: 2_000,
                },
                HistogramRow {
                    op_type: "delete_block".into(),
                    count: 1_000,
                },
                HistogramRow {
                    op_type: "set_property".into(),
                    count: 1_000,
                },
            ],
            total: 10_000,
        };
        let cmps = compare_against_proxy(&hist_no_edits);
        let edit_block: Vec<&ProxyComparison> =
            cmps.iter().filter(|c| c.op_type == "edit_block").collect();
        assert_eq!(edit_block.len(), 1, "edit_block should appear once");
        assert_eq!(
            edit_block[0].flag,
            ProxyFlag::AbsentInActual,
            "edit_block missing from histogram should flag AbsentInActual"
        );
    }

    /// Empty-histogram proxy comparison must short-circuit to an empty
    /// Vec — the proxy is meaningless with zero ops to compare against.
    #[test]
    fn proxy_comparison_on_empty_histogram_is_empty() {
        let empty = Histogram {
            rows: Vec::new(),
            total: 0,
        };
        assert!(compare_against_proxy(&empty).is_empty());
    }

    /// Op types not in `PROXY_MIX` (e.g. add_tag, set_property is in
    /// proxy but add_tag is not) should flag NotInProxy when their share
    /// is non-trivial (≥ 1%).
    #[test]
    fn proxy_comparison_flags_unknown_op_types() {
        let hist = Histogram {
            rows: vec![
                HistogramRow {
                    op_type: "add_tag".into(),
                    count: 5_000,
                },
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 3_000,
                },
                HistogramRow {
                    op_type: "edit_block".into(),
                    count: 5_000,
                },
                HistogramRow {
                    op_type: "move_block".into(),
                    count: 1_000,
                },
                HistogramRow {
                    op_type: "delete_block".into(),
                    count: 500,
                },
                HistogramRow {
                    op_type: "set_property".into(),
                    count: 500,
                },
            ],
            total: 15_000,
        };
        let cmps = compare_against_proxy(&hist);
        let add_tag: Vec<&ProxyComparison> =
            cmps.iter().filter(|c| c.op_type == "add_tag").collect();
        assert_eq!(add_tag.len(), 1);
        assert_eq!(add_tag[0].flag, ProxyFlag::NotInProxy);
    }

    // -----------------------------------------------------------------------
    // 3. Pretty-printer smoke tests
    // -----------------------------------------------------------------------

    #[test]
    fn format_count_inserts_thousands_separators() {
        assert_eq!(fmt_count(0), "0");
        assert_eq!(fmt_count(42), "42");
        assert_eq!(fmt_count(1_000), "1,000");
        assert_eq!(fmt_count(12_847), "12,847");
        assert_eq!(fmt_count(1_234_567), "1,234,567");
    }

    #[test]
    fn format_histogram_shows_table_with_rule_lines() {
        let hist = Histogram {
            rows: vec![
                HistogramRow {
                    op_type: "edit_block".into(),
                    count: 12_847,
                },
                HistogramRow {
                    op_type: "set_property".into(),
                    count: 4_221,
                },
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 3_889,
                },
            ],
            total: 20_957,
        };
        let out = format_histogram(&hist, std::path::Path::new("/tmp/notes.db"));
        // Header
        assert!(out.contains("op_type"));
        assert!(out.contains("count"));
        assert!(out.contains("%"));
        // Rows with thousands separators
        assert!(out.contains("12,847"));
        assert!(out.contains("4,221"));
        assert!(out.contains("3,889"));
        // Total row
        assert!(out.contains("TOTAL"));
        assert!(out.contains("20,957"));
        assert!(out.contains("100.0%"));
        // Rule lines (ASCII dashes — no box-drawing chars)
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
    fn format_histogram_empty_db_shows_zero_ops() {
        let hist = Histogram {
            rows: Vec::new(),
            total: 0,
        };
        let out = format_histogram(&hist, std::path::Path::new("/tmp/notes.db"));
        assert!(out.contains("op_log is empty (0 ops)."));
    }

    #[test]
    fn format_proxy_comparison_within_tolerance_message() {
        let out = format_proxy_comparison(&[]);
        assert!(out.contains("within tolerance"));
    }

    #[test]
    fn format_proxy_comparison_lists_flags() {
        let comparisons = vec![
            ProxyComparison {
                op_type: "set_property".into(),
                actual_share: 8000, // 80%
                proxy_share_permyriad: 500,
                flag: ProxyFlag::Over,
            },
            ProxyComparison {
                op_type: "edit_block".into(),
                actual_share: 500,
                proxy_share_permyriad: 5000,
                flag: ProxyFlag::Under,
            },
        ];
        let out = format_proxy_comparison(&comparisons);
        assert!(out.contains("[over]"));
        assert!(out.contains("[under]"));
        assert!(out.contains("set_property"));
        assert!(out.contains("edit_block"));
    }

    // -----------------------------------------------------------------------
    // 4. End-to-end DB round-trip — covers the SQL ordering contract
    // -----------------------------------------------------------------------

    /// Locks the read-only contract on the histogram bin's pool. The
    /// bin opens `notes.db` with
    /// `SqliteConnectOptions::read_only(true)` so it can run safely
    /// against a live DB while the main app is writing; this test
    /// asserts that an INSERT through that pool hard-fails (not just
    /// silently no-ops or warns).
    ///
    /// SQLite's read-only mode rejects writes at the engine level,
    /// not the schema level — so even an INSERT into the canonical
    /// `op_log` table (or any other writable schema) errors out with
    /// `attempt to write a readonly database`.
    #[tokio::test]
    async fn read_only_pool_rejects_writes() {
        // 1. Build a fresh DB in read-write mode and run all migrations
        //    so `op_log` exists with the correct schema.
        let dir = TempDir::new().expect("tempdir");
        let db_path = dir.path().join("readonly_test.db");
        let _rw_pool = init_pool(&db_path).await.expect("init_pool migrations");

        // 2. Open a SECOND pool against the same file with
        //    `read_only(true)` — the same path the bin uses.
        let opts = SqliteConnectOptions::new()
            .filename(&db_path)
            .read_only(true);
        let ro_pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open ro pool");

        // 3. Attempt an INSERT through the read-only pool.  Mirrors
        //    the `insert_op` helper above (same column shape) so the
        //    only difference vs. a successful insert is the pool's
        //    read-only flag.
        let result = sqlx::query(
            "INSERT INTO op_log (device_id, seq, parent_seqs, hash, op_type, payload, created_at) \
             VALUES (?, ?, NULL, ?, ?, ?, 1778284800000)",
        )
        .bind("dev-readonly")
        .bind(1_i64)
        .bind("hash-ro-1")
        .bind("edit_block")
        .bind("{}")
        .execute(&ro_pool)
        .await;

        // 4. The query MUST fail.  Don't pin the exact SQLite error
        //    message string (cross-version drift); assert `Err` and
        //    that the message mentions readonly so a future SQLite
        //    upgrade that changes the wording is the only thing that
        //    can break this test.
        let err = result.expect_err("INSERT must fail on read-only pool");
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("readonly") || msg.contains("read-only") || msg.contains("read only"),
            "expected a read-only-database error, got: {err}",
        );
    }

    /// The histogram must be deterministically ordered: count DESC then
    /// op_type ASC. Insert two op types with the same count and assert
    /// op_type asc breaks the tie.
    #[tokio::test]
    async fn histogram_orders_ties_by_op_type_ascending() {
        let (pool, _dir) = make_pool().await;
        for i in 0..3 {
            insert_op(&pool, "dev-A", i, "edit_block").await;
        }
        for i in 0..3 {
            insert_op(&pool, "dev-B", i, "create_block").await;
        }
        let hist = load_histogram(&pool).await.expect("load_histogram");
        assert_eq!(hist.total, 6);
        // Ties on count=3 → op_type asc ⇒ create_block first.
        assert_eq!(
            hist.rows,
            vec![
                HistogramRow {
                    op_type: "create_block".into(),
                    count: 3,
                },
                HistogramRow {
                    op_type: "edit_block".into(),
                    count: 3,
                },
            ]
        );
    }
}
