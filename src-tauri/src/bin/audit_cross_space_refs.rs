//! `audit_cross_space_refs` — PEND-15 Phase 0 read-only diagnostic.
//!
//! Enumerates cross-space references in a local `notes.db` so the user
//! can decide between Path A (tags space-scoped) and Path B (tags global)
//! before Phase 1 of PEND-15 lands. The four audit categories mirror the
//! plan body (`pending/PEND-15-hard-space-separation.md` §Phase 0):
//!
//! * **A1** — `block_links` rows whose source / target blocks resolve to
//!   different spaces.
//! * **A2** — `block_tags` rows where the tagged block and the tag block
//!   resolve to different spaces.
//! * **A3** — `block_tag_refs` rows (inline `#[ULID]` reference cache)
//!   that cross a space boundary.
//! * **A4** — Inline `[[ULID]]` / `((ULID))` / `#[ULID]` tokens in
//!   `blocks.content` whose target resolves to a different space.
//!
//! The binary opens the database read-only (`SqliteConnectOptions::read_only(true)`)
//! and never emits ops or mutates rows — safe to run on a live DB.
//!
//! Exit codes:
//!
//! * `0` — zero violations across all four categories.
//! * `1` — at least one violation (Path A migration would have non-trivial work).
//! * `2` — a real error (DB not found, schema mismatch, IO failure …).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::LazyLock;

use regex::Regex;
use rustc_hash::FxHashMap;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};

// ---------------------------------------------------------------------------
// Local copies of the canonical ULID-token regexes
// ---------------------------------------------------------------------------
//
// The canonical regexes live in `crate::cache` as `pub(crate)` items
// (see `src-tauri/src/cache/mod.rs`). The audit binary re-declares them
// locally — three lines — instead of widening the `cache` module's API
// surface. If the canonical regexes ever change, this file must be kept
// in sync; the regex strings are intentionally identical so a `grep`
// across the repo will find both copies.

static ULID_LINK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:\[\[|\(\()([0-9A-Z]{26})(?:\]\]|\)\))").expect("invalid ULID link regex")
});

static TAG_REF_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"#\[([0-9A-Z]{26})\]").expect("invalid tag-ref regex"));

// ---------------------------------------------------------------------------
// CLI argument parsing (hand-rolled — mirrors `agaric-mcp`)
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT: usize = 10;

#[derive(Debug)]
enum ParsedArgs {
    Run {
        db_path: Option<PathBuf>,
        limit: usize,
    },
    Help,
    Version,
    BadArg(String),
}

fn parse_args(args: &[String]) -> ParsedArgs {
    let mut db_path: Option<PathBuf> = None;
    let mut limit: usize = DEFAULT_LIMIT;
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
                let (_, value) = other.split_once('=').unwrap();
                if value.is_empty() {
                    return ParsedArgs::BadArg("--db-path requires a path argument".into());
                }
                db_path = Some(PathBuf::from(value));
            }
            "--limit" => match iter.next() {
                Some(v) => match v.parse::<usize>() {
                    Ok(n) => limit = n,
                    Err(_) => {
                        return ParsedArgs::BadArg(format!("--limit expects an integer, got '{v}'"))
                    }
                },
                None => return ParsedArgs::BadArg("--limit requires an integer argument".into()),
            },
            other if other.starts_with("--limit=") => {
                let (_, value) = other.split_once('=').unwrap();
                match value.parse::<usize>() {
                    Ok(n) => limit = n,
                    Err(_) => {
                        return ParsedArgs::BadArg(format!(
                            "--limit expects an integer, got '{value}'"
                        ))
                    }
                }
            }
            other => return ParsedArgs::BadArg(format!("unknown argument: {other}")),
        }
    }
    ParsedArgs::Run { db_path, limit }
}

fn print_help() {
    println!(
        "audit_cross_space_refs — PEND-15 Phase 0 read-only diagnostic\n\
         \n\
         USAGE:\n    \
             audit_cross_space_refs [--db-path <PATH>] [--limit <N>]\n\
         \n\
         OPTIONS:\n    \
             --db-path <PATH>  Path to notes.db. Default: $XDG_DATA_HOME/com.agaric.app/notes.db\n    \
                               (or ~/.local/share/com.agaric.app/notes.db on Linux).\n    \
             --limit <N>       Max example rows printed per category. Default: 10.\n    \
             -V, --version     Print version and exit.\n    \
             -h, --help        Print this help and exit.\n\
         \n\
         EXIT CODES:\n    \
             0   No cross-space references found.\n    \
             1   At least one cross-space reference found (Path A migration is non-trivial).\n    \
             2   Real error (DB missing, schema mismatch, IO failure)."
    );
}

#[cfg(target_os = "linux")]
fn default_db_path() -> PathBuf {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("com.agaric.app").join("notes.db")
}

#[cfg(target_os = "macos")]
fn default_db_path() -> PathBuf {
    let base = std::env::var_os("HOME")
        .map(|h| PathBuf::from(h).join("Library/Application Support"))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("com.agaric.app").join("notes.db")
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn default_db_path() -> PathBuf {
    // Other platforms (Windows, BSD …) — best-effort fallback. The user
    // will normally pass `--db-path` on these targets.
    PathBuf::from("notes.db")
}

// ---------------------------------------------------------------------------
// Audit data model
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Clone)]
pub(crate) struct CategoryReport {
    pub count: usize,
    pub examples: Vec<String>,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct AuditReport {
    pub a1: CategoryReport,
    pub a2: CategoryReport,
    pub a3: CategoryReport,
    pub a4: CategoryReport,
}

impl AuditReport {
    pub fn total(&self) -> usize {
        self.a1.count + self.a2.count + self.a3.count + self.a4.count
    }
}

// ---------------------------------------------------------------------------
// Audit queries
// ---------------------------------------------------------------------------

/// Resolve `space_id → display_name` for every block_type='page' that
/// looks like a space (i.e. has the `is_space` property). Falls back to
/// the ULID itself for spaces missing a `content` row. Used purely for
/// human-readable rendering in the example output.
async fn load_space_names(pool: &SqlitePool) -> Result<FxHashMap<String, String>, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!", b.content AS "content?"
           FROM blocks b
           JOIN block_properties bp
             ON bp.block_id = b.id AND bp.key = 'is_space'
           WHERE b.deleted_at IS NULL"#
    )
    .fetch_all(pool)
    .await?;

    let mut out = FxHashMap::default();
    for row in rows {
        let name = row.content.unwrap_or_else(|| row.id.clone());
        out.insert(row.id, name);
    }
    Ok(out)
}

fn render_space(names: &FxHashMap<String, String>, space: Option<&str>) -> String {
    match space {
        Some(id) => names.get(id).cloned().unwrap_or_else(|| id.to_owned()),
        None => "<no-space>".to_owned(),
    }
}

/// A1 — cross-space `block_links` rows. Mirrors the SQL in the plan body
/// (`pending/PEND-15-hard-space-separation.md` lines 50-59).
async fn audit_a1(
    pool: &SqlitePool,
    limit: usize,
    names: &FxHashMap<String, String>,
) -> Result<CategoryReport, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT bl.source_id AS "source_id!", bl.target_id AS "target_id!",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = COALESCE(bs.page_id, bs.id) AND bp.key = 'space') AS "source_space?",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = COALESCE(bt.page_id, bt.id) AND bp.key = 'space') AS "target_space?"
           FROM block_links bl
           JOIN blocks bs ON bs.id = bl.source_id AND bs.deleted_at IS NULL
           JOIN blocks bt ON bt.id = bl.target_id AND bt.deleted_at IS NULL
           WHERE (SELECT bp.value_ref FROM block_properties bp
                  WHERE bp.block_id = COALESCE(bs.page_id, bs.id) AND bp.key = 'space')
              IS NOT
                 (SELECT bp.value_ref FROM block_properties bp
                  WHERE bp.block_id = COALESCE(bt.page_id, bt.id) AND bp.key = 'space')"#
    )
    .fetch_all(pool)
    .await?;

    let mut report = CategoryReport {
        count: rows.len(),
        examples: Vec::new(),
    };
    for row in rows.into_iter().take(limit) {
        report.examples.push(format!(
            "  source_id={} → target_id={}  source_space={}  target_space={}",
            row.source_id,
            row.target_id,
            render_space(names, row.source_space.as_deref()),
            render_space(names, row.target_space.as_deref()),
        ));
    }
    Ok(report)
}

/// A2 — cross-space `block_tags` rows.
async fn audit_a2(
    pool: &SqlitePool,
    limit: usize,
    names: &FxHashMap<String, String>,
) -> Result<CategoryReport, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT bt.block_id AS "block_id!", bt.tag_id AS "tag_id!",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = COALESCE(bb.page_id, bb.id) AND bp.key = 'space') AS "source_space?",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = COALESCE(tg.page_id, tg.id) AND bp.key = 'space') AS "target_space?"
           FROM block_tags bt
           JOIN blocks bb ON bb.id = bt.block_id AND bb.deleted_at IS NULL
           JOIN blocks tg ON tg.id = bt.tag_id AND tg.deleted_at IS NULL
           WHERE (SELECT bp.value_ref FROM block_properties bp
                  WHERE bp.block_id = COALESCE(bb.page_id, bb.id) AND bp.key = 'space')
              IS NOT
                 (SELECT bp.value_ref FROM block_properties bp
                  WHERE bp.block_id = COALESCE(tg.page_id, tg.id) AND bp.key = 'space')"#
    )
    .fetch_all(pool)
    .await?;

    let mut report = CategoryReport {
        count: rows.len(),
        examples: Vec::new(),
    };
    for row in rows.into_iter().take(limit) {
        report.examples.push(format!(
            "  block_id={} → tag_id={}  source_space={}  target_space={}",
            row.block_id,
            row.tag_id,
            render_space(names, row.source_space.as_deref()),
            render_space(names, row.target_space.as_deref()),
        ));
    }
    Ok(report)
}

/// A3 — cross-space `block_tag_refs` rows (inline `#[ULID]` reference cache).
async fn audit_a3(
    pool: &SqlitePool,
    limit: usize,
    names: &FxHashMap<String, String>,
) -> Result<CategoryReport, sqlx::Error> {
    let rows = sqlx::query!(
        r#"SELECT btr.source_id AS "source_id!", btr.tag_id AS "tag_id!",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = COALESCE(bs.page_id, bs.id) AND bp.key = 'space') AS "source_space?",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = COALESCE(tg.page_id, tg.id) AND bp.key = 'space') AS "target_space?"
           FROM block_tag_refs btr
           JOIN blocks bs ON bs.id = btr.source_id AND bs.deleted_at IS NULL
           JOIN blocks tg ON tg.id = btr.tag_id AND tg.deleted_at IS NULL
           WHERE (SELECT bp.value_ref FROM block_properties bp
                  WHERE bp.block_id = COALESCE(bs.page_id, bs.id) AND bp.key = 'space')
              IS NOT
                 (SELECT bp.value_ref FROM block_properties bp
                  WHERE bp.block_id = COALESCE(tg.page_id, tg.id) AND bp.key = 'space')"#
    )
    .fetch_all(pool)
    .await?;

    let mut report = CategoryReport {
        count: rows.len(),
        examples: Vec::new(),
    };
    for row in rows.into_iter().take(limit) {
        report.examples.push(format!(
            "  source_id={} → tag_id={}  source_space={}  target_space={}",
            row.source_id,
            row.tag_id,
            render_space(names, row.source_space.as_deref()),
            render_space(names, row.target_space.as_deref()),
        ));
    }
    Ok(report)
}

/// A4 — inline `[[ULID]]` / `((ULID))` / `#[ULID]` tokens in `blocks.content`
/// whose target resolves to a different space than the source block.
///
/// Strategy: load every (block_id, space) pair into an in-memory map,
/// then iterate non-deleted blocks scanning each content string with
/// the canonical regexes. For each matched ULID, look up its space in
/// the map; if it differs from the source's space, count it.
async fn audit_a4(
    pool: &SqlitePool,
    limit: usize,
    names: &FxHashMap<String, String>,
) -> Result<CategoryReport, sqlx::Error> {
    // 1. Build block_id → resolved_space map (non-deleted).
    let space_rows = sqlx::query!(
        r#"SELECT b.id AS "id!",
              (SELECT bp.value_ref FROM block_properties bp
               WHERE bp.block_id = b.page_id AND bp.key = 'space') AS "space?"
           FROM blocks b
           WHERE b.deleted_at IS NULL"#
    )
    .fetch_all(pool)
    .await?;

    let mut space_of: FxHashMap<String, Option<String>> = FxHashMap::default();
    space_of.reserve(space_rows.len());
    for r in space_rows {
        space_of.insert(r.id, r.space);
    }

    // 2. Scan content of every non-deleted block.
    let content_rows = sqlx::query!(
        r#"SELECT id AS "id!", content AS "content?"
           FROM blocks
           WHERE deleted_at IS NULL AND content IS NOT NULL"#
    )
    .fetch_all(pool)
    .await?;

    let mut count: usize = 0;
    let mut examples: Vec<String> = Vec::new();

    for row in content_rows {
        let Some(content) = row.content else { continue };
        let source_id = row.id;
        let source_space = match space_of.get(&source_id) {
            Some(s) => s.clone(),
            None => continue, // unknown source — skip
        };

        let mut record = |token: String, target_id: &str, target_space: Option<&str>| {
            count += 1;
            if examples.len() < limit {
                examples.push(format!(
                    "  {token} in block {source_id} ({} → {})",
                    render_space(names, source_space.as_deref()),
                    render_space(names, target_space),
                ));
                let _ = target_id; // not currently surfaced; kept for future formatting
            }
        };

        for cap in ULID_LINK_RE.captures_iter(&content) {
            let target_id = &cap[1];
            let mat = cap.get(0).unwrap().as_str();
            // ULID_LINK_RE matches both `[[ULID]]` and `((ULID))` (and mixed
            // delimiters, harmlessly). The full match preserves the original
            // delimiter style so the audit output reproduces the token shape.
            let target_space = match space_of.get(target_id) {
                Some(s) => s.as_deref(),
                None => continue, // dangling target — not a cross-space ref
            };
            if target_space != source_space.as_deref() {
                record(mat.to_owned(), target_id, target_space);
            }
        }
        for cap in TAG_REF_RE.captures_iter(&content) {
            let target_id = &cap[1];
            let mat = cap.get(0).unwrap().as_str();
            let target_space = match space_of.get(target_id) {
                Some(s) => s.as_deref(),
                None => continue,
            };
            if target_space != source_space.as_deref() {
                record(mat.to_owned(), target_id, target_space);
            }
        }
    }

    Ok(CategoryReport { count, examples })
}

/// Run all four audit categories and assemble the report.
pub(crate) async fn run_audit(pool: &SqlitePool, limit: usize) -> Result<AuditReport, sqlx::Error> {
    let names = load_space_names(pool).await?;
    Ok(AuditReport {
        a1: audit_a1(pool, limit, &names).await?,
        a2: audit_a2(pool, limit, &names).await?,
        a3: audit_a3(pool, limit, &names).await?,
        a4: audit_a4(pool, limit, &names).await?,
    })
}

/// Format the report into the exact stdout layout described in the task spec.
fn format_report(report: &AuditReport, db_path: &std::path::Path) -> String {
    let mut out = String::new();
    out.push_str("PEND-15 Phase 0 audit — cross-space reference report\n");
    out.push_str(&format!("DB path: {}\n\n", db_path.display()));

    let sections: [(&str, &str, &CategoryReport); 4] = [
        ("A1", "cross-space block_links", &report.a1),
        ("A2", "cross-space block_tags", &report.a2),
        ("A3", "cross-space block_tag_refs", &report.a3),
        ("A4", "cross-space inline tokens", &report.a4),
    ];

    for (tag, label, cat) in sections {
        out.push_str(&format!("{tag} ({label}): {} violations\n", cat.count));
        for ex in &cat.examples {
            out.push_str(ex);
            out.push('\n');
        }
        out.push('\n');
    }

    out.push_str(&format!(
        "Total: {} violations across 4 categories\n",
        report.total()
    ));
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
            println!("audit_cross_space_refs {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        ParsedArgs::BadArg(msg) => {
            eprintln!("audit_cross_space_refs: {msg}");
            eprintln!("Try `audit_cross_space_refs --help` for usage.");
            ExitCode::from(2)
        }
        ParsedArgs::Run { db_path, limit } => {
            let resolved = db_path.unwrap_or_else(default_db_path);
            run_main(&resolved, limit).await
        }
    }
}

async fn run_main(db_path: &std::path::Path, limit: usize) -> ExitCode {
    if !db_path.exists() {
        eprintln!(
            "audit_cross_space_refs: database file not found: {}",
            db_path.display()
        );
        return ExitCode::from(2);
    }

    // Read-only: SQLite refuses any writes (including incidental writes
    // like vacuum / WAL checkpoint) at the engine level. Safe to run on
    // a live DB while the main app is running.
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .read_only(true)
        .pragma("foreign_keys", "ON");

    let pool = match SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
    {
        Ok(pool) => pool,
        Err(e) => {
            eprintln!("audit_cross_space_refs: failed to open DB: {e}");
            return ExitCode::from(2);
        }
    };

    let report = match run_audit(&pool, limit).await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("audit_cross_space_refs: query failed: {e}");
            return ExitCode::from(2);
        }
    };

    print!("{}", format_report(&report, db_path));

    if report.total() == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
//
// Tests build their own pool via `agaric_lib::db::init_pool` (which
// runs migrations) and seed via direct SQL. The standard
// `crate::commands::tests::common::test_pool` helper is gated behind
// `#[cfg(test)]` in the library and is therefore not visible from a
// binary's tests, which compile against a non-test build of the lib.
// The seeding here is intentionally minimal so each test asserts one
// audit category in isolation.

#[cfg(test)]
mod tests {
    use super::*;
    use agaric_lib::db::init_pool;
    use sqlx::SqlitePool;
    use tempfile::TempDir;

    const PERSONAL: &str = "00000000000000000AGAR1CPER";
    const WORK: &str = "00000000000000000AGAR1CWRK";

    async fn make_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("audit.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Seed the two reserved space blocks (Personal + Work) with their
    /// `is_space=true` property so `load_space_names` resolves both names.
    async fn seed_spaces(pool: &SqlitePool) {
        for (id, name) in [(PERSONAL, "Personal"), (WORK, "Work")] {
            sqlx::query(
                "INSERT INTO blocks (id, block_type, content, parent_id, position) \
                 VALUES (?, 'page', ?, NULL, 1)",
            )
            .bind(id)
            .bind(name)
            .execute(pool)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_text) VALUES (?, 'is_space', 'true')",
            )
            .bind(id)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    /// Insert a page block belonging to `space_id`. Uses a hand-typed
    /// 26-char ULID so tests can reference it deterministically.
    async fn insert_page(pool: &SqlitePool, page_id: &str, space_id: &str, title: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'page', ?, NULL, 1, ?)",
        )
        .bind(page_id)
        .bind(title)
        .bind(page_id) // page_id of a page is itself
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
        )
        .bind(page_id)
        .bind(space_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a content block under `page_id`. The block inherits its
    /// space transitively via `COALESCE(page_id, id)` → page → space.
    async fn insert_content_block(pool: &SqlitePool, block_id: &str, page_id: &str, content: &str) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', ?, ?, 1, ?)",
        )
        .bind(block_id)
        .bind(content)
        .bind(page_id)
        .bind(page_id)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Insert a tag block (top-level, no parent, no page_id) optionally
    /// pinned to `space_id`. Pre-Path-A code never sets a tag's space, so
    /// `space_id = None` mirrors the production state today.
    async fn insert_tag(pool: &SqlitePool, tag_id: &str, name: &str, space_id: Option<&str>) {
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position) \
             VALUES (?, 'tag', ?, NULL, NULL)",
        )
        .bind(tag_id)
        .bind(name)
        .execute(pool)
        .await
        .unwrap();
        if let Some(sid) = space_id {
            sqlx::query(
                "INSERT INTO block_properties (block_id, key, value_ref) VALUES (?, 'space', ?)",
            )
            .bind(tag_id)
            .bind(sid)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    async fn insert_block_link(pool: &SqlitePool, source_id: &str, target_id: &str) {
        sqlx::query("INSERT INTO block_links (source_id, target_id) VALUES (?, ?)")
            .bind(source_id)
            .bind(target_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_block_tag(pool: &SqlitePool, block_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tags (block_id, tag_id) VALUES (?, ?)")
            .bind(block_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_block_tag_ref(pool: &SqlitePool, source_id: &str, tag_id: &str) {
        sqlx::query("INSERT INTO block_tag_refs (source_id, tag_id) VALUES (?, ?)")
            .bind(source_id)
            .bind(tag_id)
            .execute(pool)
            .await
            .unwrap();
    }

    // -- Test ULIDs (deterministic 26-char Crockford base32) --

    const PAGE_PERSONAL: &str = "01PAGEPERSONAL000000000001";
    const PAGE_WORK: &str = "01PAGEWORK000000000000001Z";
    const BLOCK_PERSONAL: &str = "01BLOCKPERSONAL00000000001";
    const BLOCK_WORK: &str = "01BLOCKWORK0000000000000Z1";
    const TAG_GLOBAL: &str = "01TAGGLOBAL000000000000001";

    // -----------------------------------------------------------------------
    // CLI parsing tests (mirrors the agaric-mcp pattern)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_args_default() {
        match parse_args(&["audit_cross_space_refs".into()]) {
            ParsedArgs::Run { db_path, limit } => {
                assert!(db_path.is_none());
                assert_eq!(limit, DEFAULT_LIMIT);
            }
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn parse_args_db_path_and_limit() {
        let args: Vec<String> = vec![
            "audit_cross_space_refs".into(),
            "--db-path".into(),
            "/tmp/x.db".into(),
            "--limit".into(),
            "5".into(),
        ];
        match parse_args(&args) {
            ParsedArgs::Run { db_path, limit } => {
                assert_eq!(db_path.unwrap(), PathBuf::from("/tmp/x.db"));
                assert_eq!(limit, 5);
            }
            other => panic!("expected Run, got {other:?}"),
        }
    }

    #[test]
    fn parse_args_help_and_version() {
        assert!(matches!(
            parse_args(&["audit_cross_space_refs".into(), "--help".into()]),
            ParsedArgs::Help
        ));
        assert!(matches!(
            parse_args(&["audit_cross_space_refs".into(), "-V".into()]),
            ParsedArgs::Version
        ));
    }

    #[test]
    fn parse_args_bad_limit() {
        assert!(matches!(
            parse_args(&[
                "audit_cross_space_refs".into(),
                "--limit".into(),
                "not-a-number".into()
            ]),
            ParsedArgs::BadArg(_)
        ));
    }

    // -----------------------------------------------------------------------
    // Audit logic tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn audit_empty_db_returns_zero_violations() {
        let (pool, _dir) = make_pool().await;
        let report = run_audit(&pool, 10).await.unwrap();
        assert_eq!(report.a1.count, 0);
        assert_eq!(report.a2.count, 0);
        assert_eq!(report.a3.count, 0);
        assert_eq!(report.a4.count, 0);
        assert_eq!(report.total(), 0);
    }

    #[tokio::test]
    async fn audit_in_space_only_returns_zero_violations() {
        let (pool, _dir) = make_pool().await;
        seed_spaces(&pool).await;
        insert_page(&pool, PAGE_PERSONAL, PERSONAL, "Personal Page").await;
        insert_page(&pool, PAGE_WORK, WORK, "Work Page").await;
        insert_content_block(&pool, BLOCK_PERSONAL, PAGE_PERSONAL, "hello").await;
        insert_content_block(&pool, BLOCK_WORK, PAGE_WORK, "world").await;
        // In-space link: BLOCK_PERSONAL → PAGE_PERSONAL.
        insert_block_link(&pool, BLOCK_PERSONAL, PAGE_PERSONAL).await;

        let report = run_audit(&pool, 10).await.unwrap();
        assert_eq!(report.total(), 0);
    }

    #[tokio::test]
    async fn audit_detects_cross_space_block_link() {
        let (pool, _dir) = make_pool().await;
        seed_spaces(&pool).await;
        insert_page(&pool, PAGE_PERSONAL, PERSONAL, "P").await;
        insert_page(&pool, PAGE_WORK, WORK, "W").await;
        insert_content_block(&pool, BLOCK_PERSONAL, PAGE_PERSONAL, "x").await;
        insert_content_block(&pool, BLOCK_WORK, PAGE_WORK, "y").await;
        // Cross-space: source in Personal, target in Work.
        insert_block_link(&pool, BLOCK_PERSONAL, BLOCK_WORK).await;

        let report = run_audit(&pool, 10).await.unwrap();
        assert_eq!(report.a1.count, 1, "expected 1 cross-space block_links row");
        assert_eq!(report.a2.count, 0);
        assert_eq!(report.a3.count, 0);
        assert_eq!(report.a4.count, 0);
        assert!(report.a1.examples[0].contains(BLOCK_PERSONAL));
        assert!(report.a1.examples[0].contains(BLOCK_WORK));
        assert!(report.a1.examples[0].contains("Personal"));
        assert!(report.a1.examples[0].contains("Work"));
    }

    #[tokio::test]
    async fn audit_detects_cross_space_block_tag_and_tag_ref() {
        let (pool, _dir) = make_pool().await;
        seed_spaces(&pool).await;
        insert_page(&pool, PAGE_PERSONAL, PERSONAL, "P").await;
        insert_content_block(&pool, BLOCK_PERSONAL, PAGE_PERSONAL, "src").await;
        // Tag pinned to Work — block in Personal references it: cross-space.
        insert_tag(&pool, TAG_GLOBAL, "shared", Some(WORK)).await;
        insert_block_tag(&pool, BLOCK_PERSONAL, TAG_GLOBAL).await;
        insert_block_tag_ref(&pool, BLOCK_PERSONAL, TAG_GLOBAL).await;

        let report = run_audit(&pool, 10).await.unwrap();
        assert_eq!(report.a1.count, 0);
        assert_eq!(report.a2.count, 1, "block_tags should flag 1 row");
        assert_eq!(report.a3.count, 1, "block_tag_refs should flag 1 row");
        assert_eq!(report.a4.count, 0);
    }

    #[tokio::test]
    async fn audit_detects_cross_space_inline_tokens() {
        let (pool, _dir) = make_pool().await;
        seed_spaces(&pool).await;
        insert_page(&pool, PAGE_PERSONAL, PERSONAL, "P").await;
        insert_page(&pool, PAGE_WORK, WORK, "W").await;
        insert_content_block(&pool, BLOCK_WORK, PAGE_WORK, "target body").await;
        insert_tag(&pool, TAG_GLOBAL, "shared", Some(WORK)).await;
        // Source in Personal embeds tokens pointing at Work-space targets.
        let content = format!("see [[{BLOCK_WORK}]] and (({BLOCK_WORK})) plus #[{TAG_GLOBAL}]");
        insert_content_block(&pool, BLOCK_PERSONAL, PAGE_PERSONAL, &content).await;

        let report = run_audit(&pool, 10).await.unwrap();
        // 2 ULID-link tokens (`[[…]]` + `((…))`) + 1 tag-ref token.
        assert_eq!(report.a4.count, 3, "expected 3 cross-space inline tokens");
        assert_eq!(report.a1.count, 0);
        assert_eq!(report.a2.count, 0);
        assert_eq!(report.a3.count, 0);

        let joined = report.a4.examples.join("\n");
        assert!(joined.contains(&format!("[[{BLOCK_WORK}]]")));
        assert!(joined.contains(&format!("(({BLOCK_WORK}))")));
        assert!(joined.contains(&format!("#[{TAG_GLOBAL}]")));
    }

    #[tokio::test]
    async fn audit_ignores_deleted_blocks() {
        let (pool, _dir) = make_pool().await;
        seed_spaces(&pool).await;
        insert_page(&pool, PAGE_PERSONAL, PERSONAL, "P").await;
        insert_page(&pool, PAGE_WORK, WORK, "W").await;

        // BLOCK_PERSONAL is soft-deleted.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id, deleted_at) \
             VALUES (?, 'content', 'x', ?, 1, ?, 1735689600000)",
        )
        .bind(BLOCK_PERSONAL)
        .bind(PAGE_PERSONAL)
        .bind(PAGE_PERSONAL)
        .execute(&pool)
        .await
        .unwrap();

        // BLOCK_WORK is a live block in the other space.
        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, page_id) \
             VALUES (?, 'content', 'y', ?, 1, ?)",
        )
        .bind(BLOCK_WORK)
        .bind(PAGE_WORK)
        .bind(PAGE_WORK)
        .execute(&pool)
        .await
        .unwrap();

        // Cross-space link from a deleted source — must not be flagged.
        insert_block_link(&pool, BLOCK_PERSONAL, BLOCK_WORK).await;
        // Inline cross-space token in deleted source — must not be flagged.
        sqlx::query("UPDATE blocks SET content = ? WHERE id = ?")
            .bind(format!("[[{BLOCK_WORK}]]"))
            .bind(BLOCK_PERSONAL)
            .execute(&pool)
            .await
            .unwrap();

        let report = run_audit(&pool, 10).await.unwrap();
        assert_eq!(report.a1.count, 0, "deleted source rows must be skipped");
        assert_eq!(report.a4.count, 0, "deleted source must be skipped");
    }

    // -----------------------------------------------------------------------
    // Output formatting smoke test
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn format_report_empty_pool_clean_output() {
        let (pool, dir) = make_pool().await;
        let report = run_audit(&pool, 10).await.unwrap();
        let out = format_report(&report, &dir.path().join("audit.db"));
        assert!(out.starts_with("PEND-15 Phase 0 audit — cross-space reference report\n"));
        assert!(out.contains("A1 (cross-space block_links): 0 violations"));
        assert!(out.contains("A2 (cross-space block_tags): 0 violations"));
        assert!(out.contains("A3 (cross-space block_tag_refs): 0 violations"));
        assert!(out.contains("A4 (cross-space inline tokens): 0 violations"));
        assert!(out.contains("Total: 0 violations across 4 categories"));
    }
}
