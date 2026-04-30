//! Bug-report command handlers (FEAT-5).
//!
//! Provides two read-only commands consumed by the in-app bug-report dialog:
//!
//! - `collect_bug_report_metadata` — gathers app version, OS, arch, device ID,
//!   and the last [`RECENT_ERRORS_CAP`] error/warn lines from today's log file.
//! - `read_logs_for_report` — enumerates rolled log files, capping per-file
//!   size, skipping anything older than [`MAX_ROLLED_AGE_DAYS`] days, and
//!   optionally redacting home paths + device IDs.
//!
//! The frontend composes these with the user-entered title/description,
//! optionally writes a ZIP to disk via `downloadBlob`, and opens a prefilled
//! GitHub issue URL. Logs NEVER leave the device as part of the URL itself
//! — the feature's privacy story rests on the explicit user-visible preview
//! + confirmation checkbox + ZIP-on-disk flow. See REVIEW-LATER FEAT-5.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;
use tauri::Manager;

use crate::error::AppError;
use crate::log_dir_for_app_data;

// =====================================================================
// REDACTION POLICY (H-9b)
// =====================================================================
//
// Bug-report redaction is **deny-by-default at the field-value level**.
// Anything that does not match a member of [`SAFE_TOKEN_PATTERNS`] is
// replaced with `[REDACTED]`. This is the inverse of H-9a, which scrubbed
// SPECIFIC values (`$HOME`, `device_id`, GCal email, peer IDs) and let
// everything else through.
//
// **Pipeline** (per [`redact_line`]):
//   1. If the line parses as JSON (i.e. structured `tracing` JSON output),
//      walk the parsed tree and replace every leaf string VALUE that
//      doesn't match a safe-token pattern with `[REDACTED]`. Field KEYS
//      are preserved verbatim — the schema of a log line is not PII.
//   2. The `message` field gets one extra exception: if it appears in
//      [`STABLE_MESSAGES`] it is kept verbatim. Free-text messages that
//      don't match a stable string OR a safe-token shape collapse to
//      `[REDACTED]`. (Per-word tokenization makes log bundles
//      unreadable without bringing privacy benefit.)
//   3. If the line does NOT parse as JSON (older rolled
//      `agaric.log.YYYY-MM-DD` files written before tracing switched to
//      structured output, or any non-JSON tail handed to redact_log),
//      fall back to the legacy H-9a allow-list ([`apply_allow_list`]):
//      replace `$HOME`, `device_id`, GCal email, peer-device IDs, and
//      any email-shaped substring. This branch is documented as a
//      defense-in-depth fallback rather than the primary path.
//
// **Drift watch:** the on-disk format produced by `tracing-subscriber`
// in `lib.rs::run` is currently the human-readable text format
// (`fmt::layer().with_writer(non_blocking).with_ansi(false)`), NOT JSON.
// That means today every line takes the H-9a fallback branch. The
// deny-list architecture is fully implemented and tested; it activates
// automatically once the file appender is switched to `.json()` (a
// follow-up bookkeeping change tracked in REVIEW-LATER under H-9b).
//
// **Tuning:** to widen what survives the pipeline, add a regex to
// [`SAFE_TOKEN_PATTERNS`] or a string to [`STABLE_MESSAGES`]. **Never**
// loosen the patterns to accommodate noisy log sites — the deny-list is
// the safety contract; tracing call sites should use stable, scrub-able
// shapes (e.g. `error = %e`, `id = %ulid`) whose values fit a safe-token
// class.
// =====================================================================

/// Safe-token regex set: a value is preserved verbatim if-and-only-if it
/// matches AT LEAST ONE pattern below — OR appears in [`SAFE_LITERALS`].
/// Anything else is `[REDACTED]`.
///
/// Edit this list — and only this list — when tuning what survives the
/// deny-list. Each entry is anchored with `^…$` so a longer string that
/// merely CONTAINS a safe shape still gets redacted (defense against
/// "ULID embedded in a sentence" leaks).
///
/// Patterns deliberately exclude bare lowercase identifiers
/// (`^[a-z]+$`) so first-name-shaped strings like `alice` or `bob` do
/// not slip through as safe tokens. Multi-segment Rust paths, hex
/// digests, ULIDs, and integers are all distinguishable from prose by
/// the presence of digits / `::` / fixed length, so each pattern below
/// has at least one such discriminator.
const SAFE_TOKEN_PATTERNS: &[&str] = &[
    // Empty string — common (optional fields default to "").
    r"^$",
    // ULID: 26-char Crockford base32 (no I/L/O/U), uppercase. The on-the-
    // wire id format used throughout the op log.
    r"^[0-9A-HJKMNP-TV-Z]{26}$",
    // op_log seq / line number / byte count / any small unsigned integer.
    // 19 digits caps the value at u64::MAX so a 20-digit phone-number-
    // shaped string is NOT a safe token.
    r"^-?[0-9]{1,19}$",
    // AppError variant name (e.g. `AppError::NotFound`). The codebase
    // logs these as `error = %e` where `Display` for `AppError` resolves
    // to the variant's debug-ish form.
    r"^AppError::[A-Z][a-zA-Z0-9_]*$",
    // Rust path / module / type name with AT LEAST ONE `::` separator.
    // Covers `target` / `module` field values like
    // `agaric::commands::bug_report` and fully-qualified type names like
    // `crate::error::AppError`. The mandatory `::` blocks bare lowercase
    // words (e.g. `alice`) from masquerading as module paths.
    r"^[a-z_][a-z0-9_]*(::[a-zA-Z_][a-zA-Z0-9_]*)+$",
    // file:line[:col] ref. Covers Rust + TS + SQL source paths anchored
    // to `src/` or `src-tauri/`. Line/col are bounded at 7 digits so
    // a numeric blob doesn't sneak through as a fake location. Underscore
    // is included in the path char class so `bug_report.rs` and migration
    // names like `0001_initial.sql` round-trip.
    r"^src(?:-tauri)?/[A-Za-z0-9_./-]+\.(rs|ts|tsx|sql|toml|json|yaml|md)(:\d{1,7}(:\d{1,7})?)?$",
    // ISO-8601-Z timestamp produced by `tracing` JSON layer.
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$",
    // ISO-8601 date (no time component).
    r"^\d{4}-\d{2}-\d{2}$",
    // Well-known boolean / null literals (JSON values serialised as
    // strings — rare but not impossible).
    r"^(true|false|null)$",
    // Log-level literals, both upper-case (tracing JSON layer) and
    // lower-case (some upstream libs).
    r"^(INFO|WARN|ERROR|DEBUG|TRACE|info|warn|error|debug|trace)$",
    // Hex digest at common cryptographic sizes — short-hash (8/16),
    // md5 (32), sha1 (40), and sha256 / blake3 (64). Restricting to
    // these exact lengths avoids false positives from medium-length
    // numeric blobs (e.g. a 20-digit phone-shaped string would have
    // matched a `{8,64}` range). Pure-digit strings of these specific
    // lengths are extremely unlikely to be PII (no real-world
    // identifier has exactly 8/16/32/40/64 digits without separators).
    r"^[0-9a-fA-F]{8}$",
    r"^[0-9a-fA-F]{16}$",
    r"^[0-9a-fA-F]{32}$",
    r"^[0-9a-fA-F]{40}$",
    r"^[0-9a-fA-F]{64}$",
    // Snake_case identifier with at least one `_` or digit (covers
    // tracing targets like `bug_report` and field-key identifiers like
    // `tls13`). Pure alphabetic words (`alice`, `bob`) are NOT matched
    // because the `[_0-9]` requirement forces at least one separator
    // or digit.
    r"^[a-z][a-z0-9_]*[_0-9][a-z0-9_]*$",
];

/// Specific literal strings that are always safe (not user data, not
/// PII). Checked before the regex set; cheaper than a regex for the
/// hot-path of well-known short tokens.
///
/// Add only short, stable, repo-controlled values here — never user
/// input. OS / arch tokens come from `tauri-plugin-os::platform()` /
/// `arch()` and are a closed set; tracing targets come from the
/// codebase's own `target: "…"` literals.
const SAFE_LITERALS: &[&str] = &[
    // Tracing targets used in `tracing::*!(target: "…", …)` sites that
    // are single-segment (don't match the Rust path regex).
    "agaric",
    "frontend",
    "bug_report",
    "gcal",
    "mcp",
    "sync",
    "test",
    // OS values (`tauri_plugin_os::platform()`).
    "linux",
    "macos",
    "windows",
    "android",
    "ios",
    "freebsd",
    "openbsd",
    "netbsd",
    "dragonfly",
    "solaris",
    // Arch values (`tauri_plugin_os::arch()`).
    "x86",
    "x86_64",
    "i686",
    "arm",
    "armv7",
    "armv8",
    "aarch64",
    "arm64",
    "wasm32",
    "riscv64",
    "powerpc64",
    "mips",
    "mips64",
    "s390x",
];

/// Compiled forms of [`SAFE_TOKEN_PATTERNS`]. Built once on first use.
static SAFE_TOKEN_REGEXES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    SAFE_TOKEN_PATTERNS
        .iter()
        .map(|p| {
            Regex::new(p).unwrap_or_else(|e| panic!("SAFE_TOKEN_PATTERNS[{p}] must compile: {e}"))
        })
        .collect()
});

/// Diagnostic strings used at `tracing::warn!` / `tracing::error!` /
/// `tracing::info!` sites that are stable across releases and carry no
/// PII. When a JSON log line's `message` field matches one of these
/// verbatim, it is preserved through the deny-list.
///
/// Add new entries here when an existing static `tracing::*!("…")` site
/// would otherwise lose critical diagnostic context to `[REDACTED]`. Do
/// NOT add formatted / interpolated messages — only stable string
/// literals from `tracing::*!` macros (the `"…"` final argument).
const STABLE_MESSAGES: &[&str] = &[
    // lib.rs — boot lifecycle.
    "log directory initialized",
    "running database migrations",
    "database migrations complete",
    "TLS cert loaded",
    "boot count query failed; treating as 0",
    "PANIC",
    "failed to run Tauri application",
    "failed to bootstrap spaces — aborting boot",
    "failed to clean up stale link metadata",
    "cleaned up stale link metadata entries",
    "FTS index empty — scheduling rebuild",
    "failed to enqueue FTS rebuild at boot",
    "failed to enqueue block_tag_refs rebuild at boot",
    "failed to enqueue projected agenda cache rebuild at boot",
    "failed to enqueue page_id rebuild at boot",
    // sync_daemon — protocol lifecycle.
    "incoming sync connection received, starting responder session",
    "SyncDaemon started successfully",
    "SyncDaemon started, mDNS announced",
    "SyncDaemon shut down cleanly",
    "Failed to start SyncDaemon",
    "Sync will work via manual IP entry only",
    "rejecting sync with self (remote_id matches local device_id)",
    "rejecting sync from unpaired device",
    "responder locked peer for sync",
    "responder sync ended in non-complete state",
    "responder file transfer failed (non-fatal)",
    "responder sync session failed",
    "could not determine app_data_dir, skipping file transfer",
    "discovered new peer via mDNS",
    "debounced-change peer task panicked",
    "mDNS announce failed (peer discovery disabled)",
    "mDNS browse failed (peer discovery disabled)",
    "mDNS shutdown error",
    "mDNS initialization failed (peer discovery disabled)",
    "peer has no addresses, skipping sync",
    "failed to save peer address",
    "sync session failed",
    "initiator file transfer failed (non-fatal)",
    // materializer — queue lifecycle.
    "Materializer::set_app_data_dir called twice — ignoring later set",
    "background queue full, dropping task",
    "boot-time retry queue sweep failed",
    "periodic retry queue sweep failed",
    "materializer retry queue sweep",
    "rebuild failed for fts_blocks cache",
    "error processing materializer task",
    // merge — conflict resolution.
    "merge completed — clean merge applied",
    "merge completed — conflict copy created",
    "creating conflict copy",
    "property conflict resolved via LWW",
    "text merge completed",
    // snapshot / compaction.
    "compaction starting",
    "compaction: no eligible ops, nothing to do",
    // commands / surface.
    "internal error suppressed during sanitization",
    // mcp.
    "connector task exited",
    "MCP connection ended with error",
    "already bound",
    // bug_report itself (so its own warn lines round-trip).
    "L-52: skipping log file with invalid UTF-8 in name",
    "L-52: skipping log entry — not a regular file (symlink/dir/socket?)",
    "L-52: skipping log file — read_capped_file failed (permission denied or io error?)",
    "failed to fetch oauth_account_email for redaction; skipping GCal email scrub",
    "failed to fetch peer_refs for redaction; skipping peer-device-id scrub",
];

/// `true` iff `s` is a safe token: either a literal in [`SAFE_LITERALS`]
/// or a match for one of the [`SAFE_TOKEN_PATTERNS`] regexes.
///
/// Used by the JSON deny-list pipeline ([`redact_json_value`]) to decide
/// per leaf string value whether to keep the literal or replace it with
/// `[REDACTED]`.
fn is_safe_token(s: &str) -> bool {
    if SAFE_LITERALS.contains(&s) {
        return true;
    }
    SAFE_TOKEN_REGEXES.iter().any(|re| re.is_match(s))
}

/// H-9a — generic email regex applied AFTER the specific GCal-email scrub
/// so a known account still carries the precise `[REDACTED:GCAL_EMAIL]`
/// marker while stray emails in error messages, tracing fields, or third-
/// party log lines all collapse to the generic `[EMAIL]` placeholder.
///
/// The pattern is the well-known "good-enough" email shape used in most
/// log scrubbers; deliberately conservative so common cases (Gmail, work
/// addresses, mailing lists) are caught without trying to be RFC 5322
/// compliant. Compiled once via [`LazyLock`] — the regex is hot-path.
///
/// H-9b: still consulted on the unstructured-fallback branch as defense-
/// in-depth. JSON-format lines route through the deny-list pipeline,
/// which subsumes this check (free-text values are redacted wholesale).
static EMAIL_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
        .expect("EMAIL_REGEX is a compile-time constant; regex must parse")
});

/// Metadata returned by [`collect_bug_report_metadata`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BugReport {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub device_id: String,
    /// Last [`RECENT_ERRORS_CAP`] error/warn lines from today's
    /// `agaric.log`, newest last.
    pub recent_errors: Vec<String>,
}

/// One log file's name + contents returned by [`read_logs_for_report`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct LogFileEntry {
    pub name: String,
    pub contents: String,
}

/// Maximum bytes read from any single log file. Larger files are truncated
/// to the last `MAX_FILE_BYTES` bytes with a leading `…[truncated N bytes]`
/// marker. The current value (2 MiB) is generous enough for dozens of
/// sessions without exploding the resulting ZIP.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Maximum age (in days) of a rolled log file to include in the export.
/// Files older than this are silently skipped. Today's live `agaric.log`
/// (no date suffix) is always included.
const MAX_ROLLED_AGE_DAYS: i64 = 7;

/// Per-line byte ceiling applied during redaction. Lines longer than this
/// are truncated to a `…[truncated N chars]` marker. The current value
/// (8 KiB) is well above any reasonable log line and catches pathological
/// cases (massive stack traces, serialised snapshots) without silently
/// dropping content.
const MAX_LINE_BYTES: usize = 8 * 1024;

/// L-54: cap on the total bug-report bundle size (sum of all redacted
/// file outputs returned from [`read_logs_for_report_inner`]). 10 MiB
/// matches GitHub's default issue-attachment limit and bounds the worst
/// case `MAX_FILE_BYTES * (1 + MAX_ROLLED_AGE_DAYS)` (= 16 MiB if every
/// daily log packs the per-file cap) to a value the user can actually
/// upload. Files exceeding the cap are dropped oldest-first; a synthetic
/// `[skipped … older logs — bundle exceeded N MB cap]` entry tells the
/// user something was omitted instead of silently truncating.
const MAX_BUNDLE_BYTES: usize = 10 * 1024 * 1024;

/// Cap on the number of recent error/warn lines surfaced in
/// [`collect_bug_report_metadata`]. Short enough to render cleanly in the
/// dialog preview; long enough to capture a crash + a few surrounding hints.
const RECENT_ERRORS_CAP: usize = 20;

/// L-40: pin level detection to the tracing-subscriber default format
/// configured in `lib.rs::run` (`fmt::layer().with_writer(non_blocking)
/// .with_ansi(false)`). The disk format is:
///
/// ```text
/// 2026-04-28T10:23:45.123456Z  ERROR agaric::module: failed to apply op
/// 2026-04-28T10:23:46.234567Z  WARN  agaric::sync_files: ...
/// ```
///
/// Or, in JSON format (active on disk after H-9b-activation):
///
/// ```text
/// {"timestamp":"2026-04-28T10:23:45.123456Z","level":"ERROR","fields":{"message":"..."},"target":"agaric::module"}
/// ```
///
/// The level always appears within the first ~80 bytes (27-byte ISO-Z
/// timestamp + JSON framing + the 4–5-char level value). Bounding the
/// substring search to the first 80 bytes prevents body content of the
/// form `... contains ERROR somewhere in the message ...` from being
/// misclassified. The previous unbounded `line.contains(" ERROR ") ||
/// line.contains(" WARN ")` produced false positives any time an
/// INFO/DEBUG line's payload mentioned those words.
///
/// We accept three lexically-distinct level shapes within the prefix:
/// (a) text-format ` ERROR ` / ` WARN ` (legacy stderr/non-JSON file
///     fixtures + in-file unit tests; still reachable for any line that
///     does not parse as JSON);
/// (b) JSON-format `"level":"ERROR"` / `"level":"WARN"` (production
///     `agaric.log` post-activation);
/// (c) JSON-format with whitespace `"level": "ERROR"` (defensive — we do
///     not control the JSON formatter's whitespace policy across versions).
///
/// `regex` is a workspace dep (used by [`EMAIL_REGEX`] above), so a fully
/// anchored ISO-Z regex would also work — but the prefix-bound check is
/// cheaper and has no per-call regex overhead in this hot path (the helper
/// is invoked per-line on the live `agaric.log` tail).
fn is_error_or_warn_line(line: &str) -> bool {
    // Text format (stderr / non-JSON fixtures): the level always sits
    // within the first 40 bytes (27-byte ISO-Z + separator + 4–5-char
    // level). A body whose payload mentions the word " ERROR " is past
    // byte 40 and therefore excluded — preserves the L-40 false-positive
    // guard pinned by `is_error_or_warn_line_rejects_body_match`.
    let text_prefix = line.get(..40.min(line.len())).unwrap_or("");
    if text_prefix.contains(" ERROR ") || text_prefix.contains(" WARN ") {
        return true;
    }
    // JSON format (post-H-9b-activation `agaric.log`). The `level` key
    // appears around byte 44–58 of a typical line — outside the 40-byte
    // window above. Use a slightly larger window. The `"level":"X"`
    // substring is specific enough that body false-positives are
    // negligible (a body would need to contain the exact 15-byte literal
    // `"level":"ERROR"` early in the message). Both no-whitespace and
    // single-space JSON shapes accepted defensively.
    let json_prefix = line.get(..80.min(line.len())).unwrap_or("");
    json_prefix.contains(r#""level":"ERROR""#)
        || json_prefix.contains(r#""level":"WARN""#)
        || json_prefix.contains(r#""level": "ERROR""#)
        || json_prefix.contains(r#""level": "WARN""#)
}

/// Pure helper: extract up to [`RECENT_ERRORS_CAP`] most-recent `ERROR` or
/// `WARN` lines from an iterator of log lines. Preserves order.
fn extract_recent_errors<'a, I: Iterator<Item = &'a str>>(lines: I) -> Vec<String> {
    let mut matches: Vec<String> = Vec::new();
    for line in lines {
        if is_error_or_warn_line(line) {
            matches.push(line.to_string());
        }
    }
    if matches.len() > RECENT_ERRORS_CAP {
        let start = matches.len() - RECENT_ERRORS_CAP;
        matches.drain(..start);
    }
    matches
}

/// Read the tail of today's log file as a list of `ERROR`/`WARN` lines.
///
/// Silently returns an empty vec if the file does not exist or cannot be
/// read — a bug report without recent errors is still useful, and boot-time
/// failures (no log dir, permission denied) should not also break the
/// report surface.
///
/// M-31: reuses [`read_capped_file`] (cap = [`MAX_FILE_BYTES`]) so
/// a chatty session that grows `agaric.log` to tens of MB does not stall
/// the bug-report dialog's IPC thread on a multi-MB
/// `fs::read_to_string` followed by a full-buffer line scan. The cap is
/// shared with `read_logs_for_report_inner`, so the preview window
/// matches the bundle-export window byte-for-byte.
fn recent_errors_from_log_dir(log_dir: &Path) -> Vec<String> {
    let today = chrono::Utc::now()
        .date_naive()
        .format("%Y-%m-%d")
        .to_string();

    // `tracing-appender::rolling::daily` writes to `agaric.log` and rolls
    // the previous day's file to `agaric.log.YYYY-MM-DD`. The "today" file
    // is the plain `agaric.log`.
    let today_path = log_dir.join("agaric.log");
    if !today_path.is_file() {
        // Fall back to the dated filename in case the rotation convention
        // ever changes.
        let dated = log_dir.join(format!("agaric.log.{today}"));
        if !dated.is_file() {
            return Vec::new();
        }
        return read_errors_from_path(&dated);
    }
    read_errors_from_path(&today_path)
}

fn read_errors_from_path(path: &Path) -> Vec<String> {
    // M-31: cap the read at [`MAX_FILE_BYTES`] using the same helper
    // as `read_logs_for_report_inner`. On oversized files the helper
    // prepends a `…[truncated …]` marker line; that marker contains
    // neither " ERROR " nor " WARN " so it is naturally filtered out by
    // `extract_recent_errors` below.
    match read_capped_file(path) {
        Ok(contents) => extract_recent_errors(contents.lines()),
        Err(_) => Vec::new(),
    }
}

/// Gather metadata about the running app + the tail of today's log file.
///
/// MAINT-109: `os` / `arch` are sourced from `tauri-plugin-os` rather than
/// `std::env::consts::*` directly so per-platform branches are centralised
/// behind the plugin's documented cross-platform API. The plugin's
/// `platform()` / `arch()` helpers currently return `std::env::consts::OS`
/// / `std::env::consts::ARCH` verbatim, so the returned values are
/// byte-for-byte unchanged from the previous implementation — but routing
/// through the plugin means future expansions (locale, hostname, OS
/// version) can lean on the same surface without adding more `std::env`
/// branches here. `app_version` stays sourced from `CARGO_PKG_VERSION`:
/// that is the *application* version, not the OS version, and the plugin
/// has no equivalent for it.
pub fn collect_bug_report_metadata_inner(
    app_data_dir: &Path,
    device_id: String,
) -> Result<BugReport, AppError> {
    let log_dir = log_dir_for_app_data(app_data_dir);
    let recent_errors = recent_errors_from_log_dir(&log_dir);

    Ok(BugReport {
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: tauri_plugin_os::platform().to_string(),
        arch: tauri_plugin_os::arch().to_string(),
        device_id,
        recent_errors,
    })
}

/// Tauri command: gather bug-report metadata (app version, OS, arch,
/// device id, recent ERROR/WARN log lines). Delegates to
/// [`collect_bug_report_metadata_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn collect_bug_report_metadata(
    app: tauri::AppHandle,
    device_id: tauri::State<'_, crate::device::DeviceId>,
) -> Result<BugReport, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    collect_bug_report_metadata_inner(&data_dir, device_id.as_str().to_string())
        .map_err(super::sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Log bundle assembly
// ---------------------------------------------------------------------------

/// Decide whether a log filename should be included in the report bundle.
///
/// Accepts `agaric.log` (today) and `agaric.log.YYYY-MM-DD` files no older
/// than [`MAX_ROLLED_AGE_DAYS`] days. Rejects anything else.
fn should_include_log_file(name: &str, today: chrono::NaiveDate) -> bool {
    if name == "agaric.log" {
        return true;
    }
    let Some(rest) = name.strip_prefix("agaric.log.") else {
        return false;
    };
    let Ok(file_date) = chrono::NaiveDate::parse_from_str(rest, "%Y-%m-%d") else {
        return false;
    };
    let age = today.signed_duration_since(file_date).num_days();
    (0..=MAX_ROLLED_AGE_DAYS).contains(&age)
}

/// Read a file, capping the byte count at [`MAX_FILE_BYTES`]. If the file
/// exceeds the cap, the tail is returned with a leading truncation marker so
/// the last (most-recent) lines are preserved.
fn read_capped_file(path: &Path) -> std::io::Result<String> {
    let metadata = fs::metadata(path)?;
    let total = metadata.len();
    if total <= MAX_FILE_BYTES {
        return fs::read_to_string(path);
    }

    let mut file = fs::File::open(path)?;
    use std::io::Seek;
    let skip = total - MAX_FILE_BYTES;
    file.seek(std::io::SeekFrom::Start(skip))?;
    let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
    let mut buf = Vec::with_capacity(cap);
    file.take(MAX_FILE_BYTES).read_to_end(&mut buf)?;
    // Drop bytes up to the first newline so we don't start mid-line.
    let newline_idx = buf.iter().position(|&b| b == b'\n').unwrap_or(0);
    let tail = String::from_utf8_lossy(&buf[newline_idx..]).into_owned();
    Ok(format!(
        "…[truncated {skip} bytes of older content]\n{tail}"
    ))
}

/// MAINT-147 (i): bundle of optional redaction inputs threaded through
/// [`redact_line`] and [`redact_log`]. Grew organically as H-9a added
/// GCal-email and peer-device scrubs; gluing the four parameters into a
/// single context kept the call sites from sprouting another argument
/// every time the redaction allow-list expanded.
///
/// Every field is "absent → noop" by construction:
/// `home`/`device_id`/`gcal_email = None` skip the corresponding
/// `String::replace`, and an empty `peer_device_ids` slice yields zero
/// loop iterations. Callers that don't yet know one of the inputs (e.g.
/// early boot before the SQLite pool is online) can pass
/// [`RedactionContext::default()`] and rely on the catch-all email
/// regex and the line-length cap as a final safety net.
#[derive(Debug, Default, Clone, Copy)]
struct RedactionContext<'a> {
    home: Option<&'a str>,
    device_id: Option<&'a str>,
    gcal_email: Option<&'a str>,
    peer_device_ids: &'a [String],
}

/// H-9b — JSON deny-list pipeline. Returns `Some(redacted_line)` if
/// `line` parses as a JSON object; returns `None` to signal the caller
/// should take the H-9a allow-list fallback (text-format / older rolled
/// files).
///
/// Bytes-of-`{` test runs first so the cost of routing every text-format
/// line through `serde_json::from_str` is bounded — the parser short-
/// circuits on the very first byte.
fn redact_json_line(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    // `tracing-subscriber`'s JSON layer emits one `{ … }` object per line.
    // Anything else (text format, rolled YYYY-MM-DD logs, blank lines,
    // truncation markers) takes the fallback branch.
    if !trimmed.starts_with('{') {
        return None;
    }
    let mut value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    redact_json_value(&mut value, /*depth=*/ 0, /*key=*/ None);
    serde_json::to_string(&value).ok()
}

/// Recursively walk a JSON value and replace every leaf string VALUE
/// that is not a safe token with `[REDACTED]`. Numbers, booleans, and
/// `null` are inherently safe (never PII shapes) and pass through
/// untouched. Object keys are NEVER redacted — the schema of a log
/// line is part of the structural skeleton the user reads to follow
/// the flow of events.
///
/// `key` carries the parent object key when descending into a value so
/// the `message` exception ([`STABLE_MESSAGES`]) can fire on the right
/// field.
fn redact_json_value(value: &mut serde_json::Value, depth: usize, key: Option<&str>) {
    // Bound recursion — pathological deeply-nested JSON would otherwise
    // stack-overflow. 32 levels is well above any realistic tracing
    // payload (timestamp + level + target + fields + spans rarely
    // exceeds 4 levels).
    if depth > 32 {
        *value = serde_json::Value::String("[REDACTED]".into());
        return;
    }
    match value {
        serde_json::Value::String(s) => {
            // The `message` field gets the stable-message whitelist
            // exception in addition to the safe-token check.
            let is_message = key == Some("message");
            if is_safe_token(s) || (is_message && STABLE_MESSAGES.contains(&s.as_str())) {
                // keep verbatim
            } else {
                *s = "[REDACTED]".into();
            }
        }
        serde_json::Value::Number(_) | serde_json::Value::Bool(_) | serde_json::Value::Null => {
            // Inherently safe shapes — never PII patterns.
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                // Arrays do not propagate a key — each element's
                // redaction is independent of the parent.
                redact_json_value(v, depth + 1, None);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                redact_json_value(v, depth + 1, Some(k.as_str()));
            }
        }
    }
}

/// H-9a fallback: legacy allow-list scrubs for non-JSON lines.
///
/// Replaces specific known-bad values (`$HOME`, `device_id`, GCal email,
/// peer device IDs) and falls back to a generic email regex. This branch
/// runs for:
///
/// * Older rolled `agaric.log.YYYY-MM-DD` files written before the
///   `tracing-subscriber` file appender switches to `.json()` output.
/// * Truncation marker lines (`…[truncated N bytes of older content]`).
/// * Any non-JSON tail accidentally appended to a log file.
///
/// **NOT** the primary path. The deny-list pipeline (`redact_json_line`)
/// is the safety contract going forward; this function is preserved as
/// defense-in-depth so the H-9a guarantees are not lost on legacy input.
fn apply_allow_list(line: &str, ctx: &RedactionContext<'_>) -> String {
    let mut out = line.to_string();
    if let Some(home) = ctx.home {
        if !home.is_empty() {
            out = out.replace(home, "~");
        }
    }
    if let Some(id) = ctx.device_id {
        if !id.is_empty() {
            out = out.replace(id, "[REDACTED_DEVICE_ID]");
        }
    }
    // H-9a (1): specific GCal account email replaced BEFORE the generic
    // email regex so the known account keeps its precise tag.
    if let Some(email) = ctx.gcal_email {
        if !email.is_empty() {
            out = out.replace(email, "[REDACTED:GCAL_EMAIL]");
        }
    }
    // H-9a (2): every known peer device ID — the local `device_id` is
    // already covered above, but cross-device sync logs reference peer IDs
    // verbatim and must be scrubbed independently.
    for peer in ctx.peer_device_ids {
        if !peer.is_empty() {
            out = out.replace(peer.as_str(), "[REDACTED:PEER_DEVICE_ID]");
        }
    }
    // H-9a (3): generic email catch-all. Runs LAST so the GCal-specific
    // marker above is preserved verbatim (the specific tag itself does not
    // match the email shape, so it is not re-rewritten by this pass).
    if EMAIL_REGEX.is_match(&out) {
        out = EMAIL_REGEX.replace_all(&out, "[EMAIL]").into_owned();
    }
    out
}

/// Apply the per-line length cap from [`MAX_LINE_BYTES`] with UTF-8
/// safety. Returns the input unchanged when its byte length is at or
/// below the cap — no allocation in the common case.
fn cap_line_length(out: String) -> String {
    if out.len() <= MAX_LINE_BYTES {
        return out;
    }
    let extra = out.len() - MAX_LINE_BYTES;
    let mut out = out;
    // Keep the first MAX_LINE_BYTES bytes — split on a char boundary to
    // avoid producing invalid UTF-8 when the cut lands inside a codepoint.
    let mut cut = MAX_LINE_BYTES;
    while !out.is_char_boundary(cut) && cut > 0 {
        cut -= 1;
    }
    out.truncate(cut);
    out.push_str(&format!("…[truncated {extra} chars]"));
    out
}

/// Redact a single log line via the H-9b deny-list pipeline.
///
/// 1. **JSON path:** if `line` parses as a JSON object (the structured
///    `tracing` JSON layer's per-line emission), every leaf string VALUE
///    that doesn't match a [`SAFE_TOKEN_PATTERNS`] regex (or appear in
///    [`SAFE_LITERALS`]) is replaced with `[REDACTED]`. The `message`
///    field gets the [`STABLE_MESSAGES`] whitelist exception. Field keys
///    are preserved verbatim.
/// 2. **Fallback path:** if `line` is not JSON (older rolled files, the
///    truncation marker line, non-JSON test fixtures), apply the legacy
///    H-9a allow-list ([`apply_allow_list`]) as defense-in-depth so the
///    H-9a guarantees are not lost on legacy input.
/// 3. **Length cap:** the result is truncated to [`MAX_LINE_BYTES`] with
///    a `…[truncated N chars]` marker on overflow.
///
/// Public signature unchanged from H-9a: callers (`redact_log`, the
/// in-file unit tests) keep working without edit.
fn redact_line(line: &str, ctx: &RedactionContext<'_>) -> String {
    if let Some(redacted) = redact_json_line(line) {
        return cap_line_length(redacted);
    }
    cap_line_length(apply_allow_list(line, ctx))
}

/// Apply line-by-line redaction to an entire log file's contents.
///
/// H-9b: each line is dispatched independently — a bundle can mix JSON
/// (today's log, after the format switch) and text (older rolled files)
/// without confusing the pipeline.
fn redact_log(contents: &str, ctx: &RedactionContext<'_>) -> String {
    let mut out = String::with_capacity(contents.len());
    for line in contents.split_inclusive('\n') {
        // `split_inclusive` preserves the trailing `\n`; strip it before
        // redacting so our length cap is measured on content, not the newline.
        let (body, newline) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        out.push_str(&redact_line(body, ctx));
        out.push_str(newline);
    }
    out
}

/// Resolve the user's home directory as a string, if known. Used for path
/// redaction. Returns `None` when no home directory can be determined —
/// callers must treat the absence as "no home replacement" rather than
/// fabricating a path.
///
/// L-41 — Uses `dirs::home_dir()` so that the platform-canonical source is
/// consulted on every OS:
/// - **Unix:** `$HOME` (with `/etc/passwd` fallback)
/// - **Windows:** `USERPROFILE` (and the `SHGetKnownFolderPath` API as a
///   fallback). The previous `$HOME`-only implementation silently returned
///   `None` on Windows, leaking `C:\Users\<name>\…` paths into bug-report
///   ZIP exports destined for public GitHub issues.
fn home_dir_string() -> Option<String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
}

/// Core implementation shared between the Tauri command and its tests.
///
/// Enumerates matching files under `log_dir`, reads each one with a byte
/// cap, optionally applies redaction, and returns them sorted by filename
/// (which — thanks to the `YYYY-MM-DD` suffix — sorts chronologically).
///
/// H-9a — `gcal_email` and `peer_device_ids` extend the redaction allow-list
/// with PII vectors that cross the trust boundary when a bug-report ZIP is
/// uploaded to a public GitHub issue. They are only consulted when
/// `redact == true`; pass `None` / `&[]` if the values are unknown (e.g.
/// the user has never connected GCal, or has no paired peers) and the
/// scrubs gracefully degrade to a noop.
pub fn read_logs_for_report_inner(
    log_dir: &Path,
    redact: bool,
    home: Option<&str>,
    device_id: Option<&str>,
    gcal_email: Option<&str>,
    peer_device_ids: &[String],
) -> Result<Vec<LogFileEntry>, AppError> {
    if !log_dir.is_dir() {
        return Ok(Vec::new());
    }

    let today = chrono::Utc::now().date_naive();
    let mut entries: Vec<(PathBuf, String)> = Vec::new();

    // L-52: per-file silent-drop sites are now traced at warn level so a
    // bug report missing log files for unexpected reasons (permission
    // denied, invalid UTF-8 in name, non-file entry under a corrupted
    // log dir) leaves a breadcrumb in the daily log itself rather than
    // failing silently. The function still returns `Ok(_)` with whatever
    // survived — partial coverage beats no coverage when the user is
    // already submitting a bug report.
    for entry in fs::read_dir(log_dir)? {
        let entry = entry?;
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            // Anonymise the lossy form to avoid leaking PII on
            // pathologically named files; truncate at 80 chars.
            let lossy = name_os.to_string_lossy().into_owned();
            let truncated: String = lossy.chars().take(80).collect();
            tracing::warn!(
                path = %truncated,
                "L-52: skipping log file with invalid UTF-8 in name",
            );
            continue;
        };
        if !should_include_log_file(name, today) {
            // Out-of-window or unrecognised filename — common, not noteworthy.
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            tracing::warn!(
                name = %name,
                "L-52: skipping log entry — not a regular file (symlink/dir/socket?)",
            );
            continue;
        }
        let contents = match read_capped_file(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    name = %name,
                    error = %e,
                    "L-52: skipping log file — read_capped_file failed (permission denied or io error?)",
                );
                continue;
            }
        };
        entries.push((path, contents));
    }

    // L-54: sort newest-first so the bundle-size cap walk in
    // [`apply_bundle_cap`] drops the OLDEST files when the running total
    // exceeds [`MAX_BUNDLE_BYTES`]. `agaric.log` (today, no date suffix)
    // is unconditionally newest; rolled `agaric.log.YYYY-MM-DD` files
    // sort by descending date (newer date before older). This also
    // matches the existing comment's "today first, then reverse-chrono"
    // intent — the previous plain alphabetic sort accidentally produced
    // chronological-ascending order on the dated suffixes (oldest dated
    // first).
    entries.sort_by(|a, b| {
        let an = a.0.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let bn = b.0.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let a_today = an == "agaric.log";
        let b_today = bn == "agaric.log";
        match (a_today, b_today) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            // Reverse-alphabetic on dated suffixes ≡ newer date first
            // because the `YYYY-MM-DD` shape sorts naturally.
            (false, false) => bn.cmp(an),
        }
    });

    let mut out = Vec::with_capacity(entries.len());
    for (path, contents) in entries {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("agaric.log")
            .to_string();
        let final_contents = if redact {
            // MAINT-147 (i): bundle the four optional inputs into a
            // single RedactionContext so future allow-list extensions
            // don't grow the parameter list of every redaction helper.
            let ctx = RedactionContext {
                home,
                device_id,
                gcal_email,
                peer_device_ids,
            };
            redact_log(&contents, &ctx)
        } else {
            contents
        };
        out.push(LogFileEntry {
            name,
            contents: final_contents,
        });
    }

    Ok(apply_bundle_cap(out))
}

/// L-54: enforce the cumulative [`MAX_BUNDLE_BYTES`] cap on a list of
/// already-built log entries. `entries` MUST be passed in newest-first
/// order so that skipping when the running byte total would exceed the
/// cap drops the OLDEST files first (preserving the most recent —
/// usually most diagnostically valuable — content).
///
/// Returns the kept entries in the same order they were given, with a
/// synthetic
/// `[skipped N older logs — bundle exceeded M MB cap]` entry appended
/// at the end when one or more files were dropped. The synthetic entry
/// has empty `contents` so it occupies a single line in the bundle ZIP
/// listing without contributing to its byte total.
fn apply_bundle_cap(entries: Vec<LogFileEntry>) -> Vec<LogFileEntry> {
    let mut kept: Vec<LogFileEntry> = Vec::with_capacity(entries.len());
    let mut total_bytes: usize = 0;
    let mut skipped_count: usize = 0;
    for entry in entries {
        let len = entry.contents.len();
        if total_bytes.saturating_add(len) > MAX_BUNDLE_BYTES {
            // We're newest-first, so this entry is older than every kept
            // entry above; dropping it preserves the "newest stays" rule.
            skipped_count += 1;
            continue;
        }
        total_bytes += len;
        kept.push(entry);
    }
    if skipped_count > 0 {
        let cap_mb = MAX_BUNDLE_BYTES / (1024 * 1024);
        kept.push(LogFileEntry {
            name: format!("[skipped {skipped_count} older logs — bundle exceeded {cap_mb} MB cap]"),
            contents: String::new(),
        });
    }
    kept
}

/// H-9a — fetch the redaction allow-list inputs that live in SQLite.
///
/// Returns `(gcal_email, peer_device_ids)`. Both are best-effort:
///
/// * **GCal email:** the value of `gcal_settings.oauth_account_email`. The
///   user-prompt suggested reading this from the keyring, but `Token` (the
///   keyring payload) does not carry the email — the email is persisted in
///   `gcal_settings` alongside the rest of the per-device GCal config (see
///   `commands/gcal.rs::get_gcal_status_inner` which reads it from the
///   exact same row). On any DB error we drop to `None`; a redaction miss
///   beats a failed bug-report dialog.
/// * **Peer device IDs:** every `peer_id` from `peer_refs`. The user-prompt
///   referred to the column as `device_id`; the actual schema (see
///   `migrations/0001_initial.sql`) names it `peer_id` (the comment notes
///   "device UUID of remote peer"). The semantics — "every paired peer's
///   stable identifier" — are unchanged. On DB error we fall back to an
///   empty slice for the same fail-soft reason.
async fn fetch_redaction_extras(pool: &SqlitePool) -> (Option<String>, Vec<String>) {
    let gcal_email = match crate::gcal_push::models::get_setting(
        pool,
        crate::gcal_push::models::GcalSettingKey::OauthAccountEmail,
    )
    .await
    {
        Ok(Some(s)) if !s.is_empty() => Some(s),
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(
                target: "bug_report",
                error = %e,
                "failed to fetch oauth_account_email for redaction; skipping GCal email scrub",
            );
            None
        }
    };

    let peer_device_ids: Vec<String> = match sqlx::query_scalar!("SELECT peer_id FROM peer_refs")
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows.into_iter().filter(|s| !s.is_empty()).collect(),
        Err(e) => {
            tracing::warn!(
                target: "bug_report",
                error = %e,
                "failed to fetch peer_refs for redaction; skipping peer-device-id scrub",
            );
            Vec::new()
        }
    };

    (gcal_email, peer_device_ids)
}

/// Tauri command: enumerate the log files eligible for inclusion in a
/// bug-report ZIP, applying per-file size caps and optional PII
/// redaction (home path, device id, GCal email, peer device ids).
/// Delegates to [`read_logs_for_report_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn read_logs_for_report(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::db::ReadPool>,
    device_id: tauri::State<'_, crate::device::DeviceId>,
    redact: bool,
) -> Result<Vec<LogFileEntry>, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let log_dir = log_dir_for_app_data(&data_dir);
    let home = home_dir_string();
    let (gcal_email, peer_device_ids) = if redact {
        fetch_redaction_extras(&pool.inner().0).await
    } else {
        (None, Vec::new())
    };
    read_logs_for_report_inner(
        &log_dir,
        redact,
        home.as_deref(),
        Some(device_id.as_str()),
        gcal_email.as_deref(),
        &peer_device_ids,
    )
    .map_err(super::sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const DEV: &str = "device-abc-123";
    const HOME: &str = "/home/alice";

    // -- extract_recent_errors -------------------------------------------

    #[test]
    fn extract_recent_errors_empty_input_returns_empty() {
        let out = extract_recent_errors(std::iter::empty());
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn extract_recent_errors_picks_only_error_and_warn_lines() {
        let input = vec![
            "2025-01-01 INFO [agaric] booted",
            "2025-01-01 ERROR [agaric] kaboom",
            "2025-01-01 DEBUG [agaric] chatter",
            "2025-01-01 WARN [agaric] sluggish",
        ];
        let out = extract_recent_errors(input.into_iter());
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("ERROR"));
        assert!(out[1].contains("WARN"));
    }

    #[test]
    fn extract_recent_errors_caps_at_twenty_keeping_newest() {
        let mut input = Vec::new();
        for i in 0..30 {
            input.push(format!("2025-01-01 ERROR [agaric] error #{i}"));
        }
        let borrowed: Vec<&str> = input.iter().map(String::as_str).collect();
        let out = extract_recent_errors(borrowed.into_iter());
        assert_eq!(out.len(), 20);
        // Newest (#29) must be last.
        assert!(out[19].contains("error #29"));
        // Oldest kept is #10 (dropped the first 10).
        assert!(out[0].contains("error #10"));
    }

    // -- is_error_or_warn_line (L-40) ------------------------------------

    /// L-40 — the helper must accept the on-disk format produced by
    /// `tracing_subscriber::fmt::layer().with_writer(...).with_ansi(false)`
    /// (the production sink configured in `lib.rs::run`). The format puts
    /// an ISO-8601-Z timestamp followed by whitespace, then the level
    /// (right-padded to 5 chars), then whitespace + target.
    #[test]
    fn is_error_or_warn_line_matches_actual_tracing_format() {
        // ERROR: 5 chars, single separator space after.
        assert!(is_error_or_warn_line(
            "2026-04-28T10:23:45.123456Z  ERROR agaric::commands::blocks::crud: failed to apply op"
        ));
        // WARN: 4 chars, padded to 5 (one leading + one trailing space).
        assert!(is_error_or_warn_line(
            "2026-04-28T10:23:46.234567Z  WARN  agaric::sync_files: stale snapshot, retrying"
        ));
    }

    /// L-40 — the previous unbounded `line.contains(" ERROR ")` produced
    /// false positives whenever an INFO/DEBUG payload happened to mention
    /// the word " ERROR " in the message body. Bounding the substring
    /// search to the first 40 bytes (where the level always lives) means
    /// such body matches no longer trigger.
    #[test]
    fn is_error_or_warn_line_rejects_body_match() {
        let info_with_error_in_body =
            "2026-04-28T10:23:45.123456Z  INFO  agaric::module: this contains ERROR somewhere in the message body but level is INFO";
        assert!(
            !is_error_or_warn_line(info_with_error_in_body),
            "INFO line whose body mentions ERROR must NOT be classified as an error/warn line"
        );

        // Also guard against " WARN " appearing in a DEBUG body.
        let debug_with_warn_in_body =
            "2026-04-28T10:23:45.123456Z  DEBUG agaric::module: emitting WARN about future deprecation";
        assert!(
            !is_error_or_warn_line(debug_with_warn_in_body),
            "DEBUG line whose body mentions WARN must NOT be classified as an error/warn line"
        );
    }

    /// L-40 — defensive: the helper must not panic on an empty input and
    /// must classify it as not-an-error.
    #[test]
    fn is_error_or_warn_line_handles_empty_input() {
        assert!(!is_error_or_warn_line(""));
    }

    /// H-9b-activation: the helper must also detect the JSON-format level
    /// produced by `tracing_subscriber::fmt::layer().json()` (the production
    /// file appender post-activation). Both no-whitespace and single-space
    /// JSON shapes are accepted defensively.
    #[test]
    fn is_error_or_warn_line_matches_json_levels_h9b_activation() {
        // No-whitespace JSON (the default tracing-subscriber JSON shape).
        assert!(is_error_or_warn_line(
            r#"{"timestamp":"2026-04-28T10:23:45.123456Z","level":"ERROR","fields":{"message":"failed to apply op"},"target":"agaric::commands"}"#
        ));
        assert!(is_error_or_warn_line(
            r#"{"timestamp":"2026-04-28T10:23:46.234567Z","level":"WARN","fields":{"message":"stale snapshot, retrying"},"target":"agaric::sync_files"}"#
        ));
        // Single-space JSON shape (defensive — some formatter configs emit this).
        assert!(is_error_or_warn_line(
            r#"{"timestamp":"2026-04-28T10:23:45.123456Z","level": "ERROR","fields":{"message":"x"}}"#
        ));
        assert!(is_error_or_warn_line(
            r#"{"timestamp":"2026-04-28T10:23:46.234567Z","level": "WARN","fields":{"message":"y"}}"#
        ));
    }

    /// H-9b-activation: a JSON line whose level is INFO/DEBUG/TRACE must
    /// NOT be classified as an error/warn line, even if the body
    /// (`fields.message` or nested data) happens to contain the
    /// substring `ERROR` or `WARN`.
    #[test]
    fn is_error_or_warn_line_rejects_json_body_match_h9b_activation() {
        // INFO line whose `message` contains the word "ERROR" — must NOT match.
        let info_with_error_in_message = r#"{"timestamp":"2026-04-28T10:23:45.123456Z","level":"INFO","fields":{"message":"completed without ERROR"},"target":"agaric::module"}"#;
        assert!(
            !is_error_or_warn_line(info_with_error_in_message),
            "INFO line whose body mentions ERROR must NOT be classified as error/warn, got: {info_with_error_in_message}"
        );
        // DEBUG line whose `data` field mentions "WARN" — must NOT match.
        let debug_with_warn_in_data = r#"{"timestamp":"2026-04-28T10:23:46.234567Z","level":"DEBUG","fields":{"message":"emitting WARN deprecation"},"target":"agaric::other"}"#;
        assert!(
            !is_error_or_warn_line(debug_with_warn_in_data),
            "DEBUG line whose body mentions WARN must NOT be classified as error/warn, got: {debug_with_warn_in_data}"
        );
    }

    // -- collect_bug_report_metadata_inner --------------------------------

    #[test]
    fn collect_metadata_happy_path_surfaces_recent_errors() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("agaric.log"),
            "2025-01-01 INFO [agaric] boot\n\
             2025-01-01 ERROR [agaric] first error\n\
             2025-01-01 WARN [agaric] first warn\n",
        )
        .unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into()).unwrap();

        assert_eq!(md.device_id, DEV);
        assert_eq!(md.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(md.os, std::env::consts::OS);
        assert_eq!(md.arch, std::env::consts::ARCH);
        assert_eq!(md.recent_errors.len(), 2);
    }

    #[test]
    fn collect_metadata_empty_log_dir_returns_empty_recent_errors() {
        let dir = TempDir::new().unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into()).unwrap();

        assert_eq!(md.recent_errors.len(), 0);
        assert_eq!(md.device_id, DEV);
    }

    #[test]
    fn collect_metadata_missing_log_file_but_existing_dir_is_safe() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(log_dir_for_app_data(dir.path())).unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into()).unwrap();

        assert_eq!(md.recent_errors.len(), 0);
    }

    /// M-31: a chatty session can grow `agaric.log` to tens of MB; the
    /// bug-report dialog must not stall the IPC thread on an unbounded
    /// `fs::read_to_string` of the live log. With the cap applied, a
    /// 2+ MB file completes well under 200 ms even with an ERROR line
    /// at the very tail. The threshold is set with CI variability in
    /// mind — local dev machines see ~5 ms, but shared GitHub-Actions
    /// runners regularly land in the 50–95 ms band; without the cap
    /// the same file took over 1 s. 200 ms keeps the regression-detection
    /// signal (ratio over 5×) without flaking the public CI.
    #[test]
    fn collect_metadata_completes_quickly_for_oversized_log_file() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();

        // Write > MAX_FILE_BYTES of filler followed by a clearly
        // identifiable ERROR line at the tail.
        let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
        let mut contents = String::with_capacity(cap + 4_096);
        while contents.len() < cap + 1_024 {
            contents.push_str("2025-01-01 INFO [agaric] filler line abcdefghijklmnopqrstuvwxyz\n");
        }
        contents.push_str("2025-01-01 ERROR [agaric] M31_TAIL_MARKER\n");
        fs::write(log_dir.join("agaric.log"), &contents).unwrap();

        let start = std::time::Instant::now();
        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into()).unwrap();
        let elapsed = start.elapsed();

        assert!(
            elapsed < std::time::Duration::from_millis(200),
            "collect_bug_report_metadata_inner took {elapsed:?}; expected < 200ms with the read cap in place"
        );
        // Tail marker survives the cap-truncate-from-head path.
        assert!(
            md.recent_errors
                .iter()
                .any(|l| l.contains("M31_TAIL_MARKER")),
            "tail ERROR marker must survive the cap, got recent_errors: {:?}",
            md.recent_errors
        );
    }

    // -- should_include_log_file -----------------------------------------

    #[test]
    fn includes_plain_agaric_log() {
        let today = chrono::NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        assert!(should_include_log_file("agaric.log", today));
    }

    #[test]
    fn includes_rolled_file_within_seven_days() {
        let today = chrono::NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        // 3 days old.
        assert!(should_include_log_file("agaric.log.2025-01-12", today));
        // Exactly 7 days old.
        assert!(should_include_log_file("agaric.log.2025-01-08", today));
    }

    #[test]
    fn excludes_rolled_file_older_than_seven_days() {
        let today = chrono::NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        // 8 days old.
        assert!(!should_include_log_file("agaric.log.2025-01-07", today));
    }

    #[test]
    fn excludes_unrelated_filenames() {
        let today = chrono::NaiveDate::from_ymd_opt(2025, 1, 15).unwrap();
        assert!(!should_include_log_file("other.log", today));
        assert!(!should_include_log_file("agaric.log.bogus", today));
        assert!(!should_include_log_file("agaric.txt", today));
    }

    // -- read_logs_for_report_inner --------------------------------------

    #[test]
    fn read_logs_empty_dir_returns_empty() {
        let dir = TempDir::new().unwrap();
        let out = read_logs_for_report_inner(dir.path(), false, None, None, None, &[]).unwrap();
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn read_logs_nonexistent_dir_returns_empty() {
        let bogus = PathBuf::from("/tmp/agaric-nonexistent-bug-report-dir");
        let out = read_logs_for_report_inner(&bogus, false, None, None, None, &[]).unwrap();
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn read_logs_happy_path_returns_all_recent_files_sorted() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        fs::write(log_dir.join("agaric.log"), "today content\n").unwrap();
        // Yesterday — within the 7-day window.
        let yesterday = (chrono::Utc::now().date_naive() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        fs::write(
            log_dir.join(format!("agaric.log.{yesterday}")),
            "yesterday content\n",
        )
        .unwrap();

        let out = read_logs_for_report_inner(log_dir, false, None, None, None, &[]).unwrap();

        assert_eq!(out.len(), 2, "should include today + yesterday");
        // Files sort alphabetically: "agaric.log" < "agaric.log.YYYY-..."
        assert_eq!(out[0].name, "agaric.log");
        assert!(out[0].contents.contains("today content"));
        assert!(out[1].contents.contains("yesterday content"));
    }

    #[test]
    fn read_logs_oversized_file_is_truncated_to_tail() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        let path = log_dir.join("agaric.log");

        // Write > MAX_FILE_BYTES of content with a clearly-identifiable
        // tail line.
        let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
        let mut contents = String::with_capacity(cap + 2_048);
        while contents.len() < cap + 1_024 {
            contents.push_str("2025-01-01 INFO [agaric] filler line abcdefghijklmnopqrstuvwxyz\n");
        }
        contents.push_str("2025-01-01 ERROR [agaric] TAIL_MARKER\n");
        fs::write(&path, &contents).unwrap();

        let out = read_logs_for_report_inner(log_dir, false, None, None, None, &[]).unwrap();

        assert_eq!(out.len(), 1);
        let got = &out[0].contents;
        assert!(
            got.starts_with("…[truncated"),
            "truncated output must start with marker, got prefix: {:?}",
            &got[..got.len().min(80)]
        );
        assert!(
            got.contains("TAIL_MARKER"),
            "tail of oversized file must be preserved"
        );
        // Must fit within cap + marker overhead.
        assert!(
            got.len() <= cap + 1_024,
            "truncated content ({}) exceeds cap",
            got.len()
        );
    }

    #[test]
    fn read_logs_excludes_files_older_than_seven_days() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        fs::write(log_dir.join("agaric.log"), "today\n").unwrap();
        // 10 days ago — outside the 7-day window.
        let old = (chrono::Utc::now().date_naive() - chrono::Duration::days(10))
            .format("%Y-%m-%d")
            .to_string();
        fs::write(log_dir.join(format!("agaric.log.{old}")), "should skip\n").unwrap();

        let out = read_logs_for_report_inner(log_dir, false, None, None, None, &[]).unwrap();
        assert_eq!(out.len(), 1, "only today's file should be included");
        assert_eq!(out[0].name, "agaric.log");
    }

    #[test]
    fn read_logs_redaction_replaces_home_and_blanks_device_id() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        let contents = format!(
            "2025-01-01 INFO [agaric] path={HOME}/code/agaric/notes.db\n\
             2025-01-01 ERROR [agaric] device={DEV} failed\n"
        );
        fs::write(log_dir.join("agaric.log"), &contents).unwrap();

        let out =
            read_logs_for_report_inner(log_dir, true, Some(HOME), Some(DEV), None, &[]).unwrap();

        assert_eq!(out.len(), 1);
        let body = &out[0].contents;
        assert!(
            !body.contains(HOME),
            "home path must be redacted, got: {body}"
        );
        assert!(body.contains("~/code/agaric"), "home must become ~");
        assert!(!body.contains(DEV), "device id must be redacted");
        assert!(
            body.contains("[REDACTED_DEVICE_ID]"),
            "redaction marker present"
        );
    }

    #[test]
    fn read_logs_redaction_truncates_long_lines() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();

        // Build a line longer than MAX_LINE_BYTES.
        let mut long_line = String::with_capacity(MAX_LINE_BYTES + 100);
        long_line.push_str("2025-01-01 INFO [agaric] ");
        while long_line.len() < MAX_LINE_BYTES + 50 {
            long_line.push('x');
        }
        long_line.push('\n');
        fs::write(log_dir.join("agaric.log"), &long_line).unwrap();

        let out = read_logs_for_report_inner(log_dir, true, None, None, None, &[]).unwrap();

        assert_eq!(out.len(), 1);
        let lines: Vec<&str> = out[0].contents.split_inclusive('\n').collect();
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("…[truncated"),
            "long line must carry truncation marker"
        );
        // Cap + marker overhead is bounded.
        assert!(
            lines[0].len() < MAX_LINE_BYTES + 64,
            "truncated line length {} must be close to cap",
            lines[0].len()
        );
    }

    #[test]
    fn read_logs_no_redaction_leaves_content_intact() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        let contents = format!("device={DEV} home={HOME}/foo\n");
        fs::write(log_dir.join("agaric.log"), &contents).unwrap();

        let out =
            read_logs_for_report_inner(log_dir, false, Some(HOME), Some(DEV), None, &[]).unwrap();

        assert_eq!(out.len(), 1);
        assert!(out[0].contents.contains(DEV));
        assert!(out[0].contents.contains(HOME));
    }

    // -- L-52: silent-drop sites now warn -------------------------------

    /// L-52 — a non-file entry under the log dir (e.g., a directory)
    /// must NOT be silently dropped: the function continues to skip it
    /// (file-only contract preserved), but a `tracing::warn!` is now
    /// emitted naming the entry. The test verifies the function still
    /// returns `Ok(_)` with the directory excluded; the warn line is
    /// load-bearing for operator triage but cumbersome to capture
    /// inline, so we only assert the structural behaviour here.
    #[test]
    fn read_logs_warns_on_non_file_entry_and_excludes_it() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        // Today's log file (real, included).
        fs::write(log_dir.join("agaric.log"), "ok\n").unwrap();
        // A subdirectory with a name that matches the include filter
        // but is not a regular file. Use today's date to ensure it
        // passes `should_include_log_file`.
        let today = chrono::Utc::now().date_naive();
        let dated = format!("agaric.log.{}", today.format("%Y-%m-%d"));
        fs::create_dir(log_dir.join(&dated)).unwrap();

        let out = read_logs_for_report_inner(log_dir, false, None, None, None, &[]).unwrap();

        assert_eq!(
            out.len(),
            1,
            "directory entry must be excluded; only agaric.log survives",
        );
        assert_eq!(out[0].name, "agaric.log");
    }

    /// L-52 — a file whose `read_capped_file` fails (e.g., permission
    /// denied) is excluded from the result and a warn is emitted. We
    /// simulate "fails to read" by creating a file with `0o000` mode
    /// on Unix; on Windows the file-permission model differs and the
    /// test is skipped. The function must still return `Ok(_)` with
    /// the unreadable file excluded.
    #[cfg(unix)]
    #[test]
    fn read_logs_warns_on_unreadable_file_and_excludes_it() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        // Today's log file (real, readable, included).
        fs::write(log_dir.join("agaric.log"), "ok\n").unwrap();
        // Older dated file that we make unreadable. Use a day in the
        // window so `should_include_log_file` doesn't pre-filter it.
        let yesterday = chrono::Utc::now().date_naive() - chrono::Duration::days(1);
        let dated = format!("agaric.log.{}", yesterday.format("%Y-%m-%d"));
        let unreadable = log_dir.join(&dated);
        fs::write(&unreadable, "should be unreadable\n").unwrap();
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();

        // If running as root the chmod 0o000 doesn't actually deny —
        // skip the assertion in that case (the test is informational
        // only when the kernel honours the mode).
        let read_check = fs::read_to_string(&unreadable);
        let running_as_root = read_check.is_ok();

        let out = read_logs_for_report_inner(log_dir, false, None, None, None, &[]).unwrap();

        if running_as_root {
            // Restore so TempDir cleanup works.
            fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).ok();
            assert!(
                out.iter().any(|e| e.name == "agaric.log"),
                "running as root: kernel ignores 0o000 mode, can't trigger the L-52 warn path",
            );
            return;
        }

        assert_eq!(
            out.len(),
            1,
            "unreadable file must be excluded; only agaric.log survives",
        );
        assert_eq!(out[0].name, "agaric.log");

        // Restore permissions so TempDir Drop can clean up.
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).ok();
    }

    // -- apply_bundle_cap (L-54) -----------------------------------------

    /// L-54 — when the running total stays under [`MAX_BUNDLE_BYTES`],
    /// every input entry must be preserved verbatim (same count, same
    /// order) and NO synthetic `[skipped …]` marker is appended.
    #[test]
    fn bundle_within_cap_includes_all_files() {
        // Four 1 KiB entries → 4 KiB total, well under the 10 MiB cap.
        let entries: Vec<LogFileEntry> = (0..4)
            .map(|i| LogFileEntry {
                name: format!("agaric.log.2025-01-{:02}", 14 - i),
                contents: "x".repeat(1024),
            })
            .collect();
        let input_names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();

        let kept = apply_bundle_cap(entries);

        assert_eq!(
            kept.len(),
            input_names.len(),
            "all entries must be kept when total stays under MAX_BUNDLE_BYTES",
        );
        for (got, want) in kept.iter().zip(input_names.iter()) {
            assert_eq!(&got.name, want, "kept entries must preserve input order");
        }
        assert!(
            !kept.iter().any(|e| e.name.starts_with("[skipped")),
            "no synthetic skip marker must be appended when nothing was dropped",
        );
    }

    /// L-54 — when the running total exceeds [`MAX_BUNDLE_BYTES`] the
    /// helper must drop the OLDEST entries (which, given the
    /// newest-first iteration order documented on `apply_bundle_cap`,
    /// means the entries APPENDED at the end of the input list) and
    /// synthesize a `[skipped … older logs — bundle exceeded N MB cap]`
    /// marker so the user knows something was omitted.
    #[test]
    fn bundle_over_cap_drops_oldest_and_synthesizes_marker() {
        // Six 2-MiB entries → 12 MiB total, exceeding the 10 MiB cap.
        // With strict `>` cap-check, exactly five entries (10 MiB)
        // pass; the sixth is dropped.
        let big = "x".repeat(usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX));
        let entries: Vec<LogFileEntry> = (0..6)
            .map(|i| LogFileEntry {
                name: format!("entry-{i}"),
                contents: big.clone(),
            })
            .collect();
        let input_count = entries.len();

        let kept = apply_bundle_cap(entries);

        // At least one REAL entry was dropped — the marker entry does
        // not count as a kept real entry.
        let real_kept = kept
            .iter()
            .filter(|e| !e.name.starts_with("[skipped"))
            .count();
        assert!(
            real_kept < input_count,
            "real-entry count {real_kept} must be < input count {input_count} (some real entries dropped)",
        );
        // The synthetic marker must be present.
        let marker_count = kept
            .iter()
            .filter(|e| e.name.starts_with("[skipped"))
            .count();
        assert_eq!(
            marker_count,
            1,
            "exactly one [skipped …] marker must be appended, got: {:?}",
            kept.iter().map(|e| &e.name).collect::<Vec<_>>(),
        );
        // The marker entry must reference the cap (in MiB units) so the
        // user can interpret what "exceeded" means.
        let marker = kept
            .iter()
            .find(|e| e.name.starts_with("[skipped"))
            .unwrap();
        let cap_mb = MAX_BUNDLE_BYTES / (1024 * 1024);
        assert!(
            marker.name.contains(&format!("{cap_mb} MB")),
            "marker must reference the cap in MB units, got: {}",
            marker.name,
        );
        // The marker contributes nothing to the bundle byte total — its
        // contents are intentionally empty.
        assert!(
            marker.contents.is_empty(),
            "marker contents must be empty; got {} bytes",
            marker.contents.len(),
        );
        // The kept REAL entries must preserve newest-first order: the
        // first entry of the input (newest) is still the first entry of
        // the kept list, the last entry of the kept REAL block is the
        // last entry that fit.
        assert_eq!(
            kept[0].name, "entry-0",
            "newest entry must be preserved as the first kept entry"
        );
    }

    // -- redact_line corner cases ----------------------------------------

    #[test]
    fn redact_line_preserves_utf8_on_truncation() {
        // Build a line whose byte length just exceeds MAX_LINE_BYTES and
        // contains a multi-byte codepoint straddling the cut point. If
        // truncation cuts mid-codepoint, `String::truncate` panics; this
        // test proves the char-boundary guard works.
        let mut s = String::with_capacity(MAX_LINE_BYTES + 8);
        // Fill with ASCII to within 2 bytes of the cap...
        for _ in 0..(MAX_LINE_BYTES - 1) {
            s.push('a');
        }
        // ...then a 4-byte codepoint (😀 = U+1F600) so the byte cut lands
        // inside it.
        s.push('😀');
        let out = redact_line(&s, &RedactionContext::default());
        assert!(out.contains("…[truncated"), "must carry truncation marker");
        // No panic = success. Verify the output is still valid UTF-8 (it
        // inherently is since it's a `String`).
        let _check = out.chars().count();
    }

    #[test]
    fn redact_line_no_home_no_device_is_identity_on_short_lines() {
        let line = "2025-01-01 INFO nothing to redact";
        assert_eq!(redact_line(line, &RedactionContext::default()), line);
    }

    #[test]
    fn redact_line_empty_home_is_noop() {
        let line = "2025-01-01 path=/home/alice/x";
        // Empty home must NOT replace all forward-slashes or similar.
        let out = redact_line(
            line,
            &RedactionContext {
                home: Some(""),
                ..Default::default()
            },
        );
        assert_eq!(out, line);
    }

    #[test]
    fn redact_line_empty_device_id_is_noop() {
        let line = "2025-01-01 device=abc";
        let out = redact_line(
            line,
            &RedactionContext {
                device_id: Some(""),
                ..Default::default()
            },
        );
        assert_eq!(out, line);
    }

    // -- H-9a redaction extensions ---------------------------------------

    /// H-9a (1) — when the GCal account email is known, every occurrence of
    /// it must be replaced with the precise `[REDACTED:GCAL_EMAIL]` marker
    /// and the original literal must not survive in the output.
    #[test]
    fn redact_line_replaces_gcal_email() {
        let line = "2025-01-01 INFO [gcal] account=me@gmail.com synced 12 events";
        let out = redact_line(
            line,
            &RedactionContext {
                gcal_email: Some("me@gmail.com"),
                ..Default::default()
            },
        );
        assert!(
            !out.contains("me@gmail.com"),
            "GCal email must be redacted, got: {out}"
        );
        assert!(
            out.contains("[REDACTED:GCAL_EMAIL]"),
            "specific GCal-email marker must be present, got: {out}"
        );
        // The catch-all `[EMAIL]` marker must not also appear — the
        // specific scrub takes precedence and the marker itself does not
        // match the email regex.
        assert!(
            !out.contains("[EMAIL]"),
            "specific GCal scrub must not be double-tagged with [EMAIL], got: {out}"
        );
    }

    /// H-9a (2) — every known peer device ID from `peer_refs` must be
    /// scrubbed, regardless of how many appear on a line.
    #[test]
    fn redact_line_replaces_peer_device_ids() {
        let peers = vec![
            "01HZQ7-PEER-AAA".to_string(),
            "01HZQ7-PEER-BBB".to_string(),
            "01HZQ7-PEER-CCC".to_string(),
        ];
        let line = format!(
            "2025-01-01 DEBUG [sync] peers={} forwarded to {}, {}",
            peers[0], peers[1], peers[2],
        );
        let out = redact_line(
            &line,
            &RedactionContext {
                peer_device_ids: &peers,
                ..Default::default()
            },
        );
        for peer in &peers {
            assert!(
                !out.contains(peer.as_str()),
                "peer id {peer} must be redacted, got: {out}"
            );
        }
        // All three occurrences should collapse to the marker.
        assert_eq!(
            out.matches("[REDACTED:PEER_DEVICE_ID]").count(),
            3,
            "expected 3 peer-redaction markers, got: {out}"
        );
    }

    /// H-9a (3) — the catch-all email regex must scrub stray emails that
    /// are NOT the GCal account (e.g. an upstream library logging a
    /// support address, an error message echoing a third party's email).
    #[test]
    fn redact_line_email_regex_catches_unknown_emails() {
        let line = "2025-01-01 ERROR upstream=random@example.com timed out";
        // Note: gcal_email is None here — the only email present is NOT
        // the user's GCal account, so it MUST fall to the catch-all regex.
        let out = redact_line(line, &RedactionContext::default());
        assert!(
            !out.contains("random@example.com"),
            "unknown email must be redacted, got: {out}"
        );
        assert!(
            out.contains("[EMAIL]"),
            "catch-all [EMAIL] marker must be present, got: {out}"
        );
    }

    /// H-9a — ordering invariant: the specific GCal-email marker must take
    /// precedence over the generic regex. If the regex were applied first,
    /// the GCal address would be scrubbed to `[EMAIL]` and the more
    /// specific provenance information would be lost.
    #[test]
    fn redact_line_specific_email_takes_precedence_over_regex() {
        let line = "2025-01-01 INFO oauth.account=me@gmail.com refreshed";
        let out = redact_line(
            line,
            &RedactionContext {
                gcal_email: Some("me@gmail.com"),
                ..Default::default()
            },
        );
        assert!(
            out.contains("[REDACTED:GCAL_EMAIL]"),
            "GCal-specific marker must win, got: {out}"
        );
        assert!(
            !out.contains("[EMAIL]"),
            "generic [EMAIL] marker must NOT clobber the specific one, got: {out}"
        );
        assert!(
            !out.contains("me@gmail.com"),
            "the original email must not survive, got: {out}"
        );
    }

    /// H-9a — multiple distinct emails on the same line must all be
    /// scrubbed by the catch-all regex (`replace_all`, not `replace`).
    #[test]
    fn redact_line_email_regex_handles_multiple_emails_in_one_line() {
        let line = "2025-01-01 ERROR cc=alice@example.com,bob@other.org delivery failed";
        let out = redact_line(line, &RedactionContext::default());
        assert!(
            !out.contains("alice@example.com"),
            "first email must be redacted, got: {out}"
        );
        assert!(
            !out.contains("bob@other.org"),
            "second email must be redacted, got: {out}"
        );
        assert_eq!(
            out.matches("[EMAIL]").count(),
            2,
            "both emails must be replaced with [EMAIL], got: {out}"
        );
    }

    /// H-9a — a line with no PII must pass through unchanged. Guards
    /// against false-positive regex matches (e.g. tracing fields with `@`
    /// signs that are not emails — `attr@key=value` style).
    #[test]
    fn redact_line_no_pii_input_unchanged() {
        let line = "2025-01-01 INFO [agaric] db.pool=2W+4R writer=available";
        let out = redact_line(
            line,
            &RedactionContext {
                home: Some("/home/alice"),
                device_id: Some("dev-id"),
                ..Default::default()
            },
        );
        assert_eq!(
            out, line,
            "line with no PII must pass through unchanged, got: {out}"
        );
    }

    // -- H-9b deny-list pipeline -----------------------------------------
    //
    // The tests below exercise the JSON deny-list path. They feed
    // structured `tracing` JSON-shape lines and assert per-token
    // behaviour (safe tokens preserved, everything else redacted, the
    // `message` whitelist exception). The H-9a allow-list tests above
    // exercise the fallback path on text-format input.

    /// H-9b — `is_safe_token` accepts every documented token class.
    /// One positive sample per [`SAFE_TOKEN_PATTERNS`] entry.
    #[test]
    fn h9b_is_safe_token_accepts_each_class() {
        // ULID
        assert!(is_safe_token("01HZQK7M5N6PQRSTVWXYZABCDE"));
        // Op_log seq / integer
        assert!(is_safe_token("0"));
        assert!(is_safe_token("1234567890"));
        assert!(is_safe_token("-42"));
        // AppError variant
        assert!(is_safe_token("AppError::NotFound"));
        assert!(is_safe_token("AppError::Database"));
        // Rust path
        assert!(is_safe_token("agaric::commands::bug_report"));
        assert!(is_safe_token("crate::error::AppError"));
        // file:line:col
        assert!(is_safe_token("src-tauri/src/lib.rs:42:7"));
        assert!(is_safe_token("src/components/Foo.tsx:10"));
        assert!(is_safe_token("src-tauri/migrations/0001_initial.sql"));
        // ISO-Z timestamp
        assert!(is_safe_token("2026-04-28T10:23:45.123456Z"));
        // ISO date
        assert!(is_safe_token("2025-01-15"));
        // Bool / null
        assert!(is_safe_token("true"));
        assert!(is_safe_token("false"));
        assert!(is_safe_token("null"));
        // Levels
        assert!(is_safe_token("INFO"));
        assert!(is_safe_token("ERROR"));
        // Hex digest at common crypto sizes (8/16/32/40/64).
        assert!(is_safe_token("deadbeef")); // 8 — short hash
        assert!(is_safe_token("0123456789abcdef")); // 16
        assert!(is_safe_token("0123456789abcdef0123456789abcdef")); // 32 — md5
        assert!(is_safe_token("0123456789abcdef0123456789abcdef01234567")); // 40 — sha1
        assert!(is_safe_token(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )); // 64 — sha256/blake3
            // Snake_case identifier with digit/underscore
        assert!(is_safe_token("bug_report"));
        assert!(is_safe_token("tls13"));
        // Empty
        assert!(is_safe_token(""));
        // SAFE_LITERALS
        assert!(is_safe_token("agaric"));
        assert!(is_safe_token("linux"));
        assert!(is_safe_token("x86_64"));
    }

    /// H-9b — `is_safe_token` rejects PII-shaped strings, free text,
    /// and any value that doesn't match a documented token class.
    #[test]
    fn h9b_is_safe_token_rejects_pii_shapes() {
        // Bare lowercase first names (ALICE/BOB/etc. as single words).
        assert!(!is_safe_token("alice"));
        assert!(!is_safe_token("bob"));
        assert!(!is_safe_token("charlie"));
        // Email — handled by EMAIL_REGEX in fallback, but in the JSON
        // deny-list path the whole string fails the safe-token test.
        assert!(!is_safe_token("alice@example.com"));
        // URL.
        assert!(!is_safe_token("https://example.com/private/path"));
        // Phone-shaped (12+ digits with formatting OR pure digits over
        // 19 characters — both should fail).
        assert!(!is_safe_token("555-123-4567"));
        assert!(!is_safe_token("(555) 123-4567"));
        assert!(!is_safe_token("12345678901234567890")); // 20 digits — over u64
                                                         // Sentence / free text.
        assert!(!is_safe_token("the quick brown fox"));
        assert!(!is_safe_token("an error occurred"));
        // Path with $HOME shape.
        assert!(!is_safe_token("/home/alice/notes.db"));
        // Base32-shaped but wrong length (not a ULID).
        assert!(!is_safe_token("01HZQK7M5N")); // too short
        assert!(!is_safe_token("01HZQK7M5N6PQRSTVWXYZABCDEFG")); // too long
                                                                 // ULID with disallowed Crockford char (I/L/O/U).
        assert!(!is_safe_token("01HZQK7M5N6PQRSTVWXYZABCDI")); // ends in I
                                                               // CamelCase only — not a Rust path.
        assert!(!is_safe_token("FooBar"));
        // file ref outside src/.
        assert!(!is_safe_token("/etc/passwd:42"));
        assert!(!is_safe_token("foo.rs:42"));
    }

    /// H-9b — happy path: a JSON line whose values are ALL safe tokens
    /// must round-trip through `redact_line` with every value preserved.
    #[test]
    fn h9b_redact_line_json_preserves_safe_tokens() {
        let line = r#"{"timestamp":"2026-04-28T10:23:45.123456Z","level":"INFO","fields":{"message":"compaction starting","seq":42},"target":"agaric::snapshot::create"}"#;
        let out = redact_line(line, &RedactionContext::default());
        assert!(
            out.contains(r#""timestamp":"2026-04-28T10:23:45.123456Z""#),
            "ISO timestamp must survive, got: {out}"
        );
        assert!(
            out.contains(r#""level":"INFO""#),
            "level must survive: {out}"
        );
        assert!(
            out.contains(r#""target":"agaric::snapshot::create""#),
            "Rust path target must survive: {out}"
        );
        assert!(
            out.contains(r#""message":"compaction starting""#),
            "stable message must survive verbatim: {out}"
        );
        assert!(
            out.contains(r#""seq":42"#),
            "JSON number must survive: {out}"
        );
        assert!(
            !out.contains("[REDACTED]"),
            "no value should be redacted, got: {out}"
        );
    }

    /// H-9b — non-safe values are redacted at the field-VALUE level.
    /// The structural skeleton (keys, levels, target) is preserved.
    #[test]
    fn h9b_redact_line_json_redacts_unsafe_values() {
        let line = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"WARN","fields":{"message":"the user typed something private","note":"alice's secret notes"},"target":"agaric::frontend"}"#;
        let out = redact_line(line, &RedactionContext::default());
        // Skeleton preserved.
        assert!(out.contains(r#""level":"WARN""#));
        assert!(out.contains(r#""target":"agaric::frontend""#));
        // Free-text message redacted (not in STABLE_MESSAGES).
        assert!(
            !out.contains("the user typed"),
            "free-text message must NOT survive: {out}"
        );
        assert!(
            !out.contains("alice's secret"),
            "free-text field value must NOT survive: {out}"
        );
        assert!(
            out.contains(r#""message":"[REDACTED]""#),
            "message redaction marker must be present: {out}"
        );
        assert!(
            out.contains(r#""note":"[REDACTED]""#),
            "note redaction marker must be present: {out}"
        );
    }

    /// H-9b — the `message` field gets the `STABLE_MESSAGES` whitelist
    /// exception. A literal stable diagnostic survives; a non-stable
    /// message in the same field DOES NOT.
    #[test]
    fn h9b_redact_line_json_message_whitelist_exception() {
        // Whitelisted message survives.
        let stable = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"WARN","fields":{"message":"failed to bootstrap spaces — aborting boot"},"target":"agaric::lib"}"#;
        let out = redact_line(stable, &RedactionContext::default());
        assert!(
            out.contains("failed to bootstrap spaces"),
            "STABLE_MESSAGES entry must survive: {out}"
        );
        assert!(
            !out.contains("[REDACTED]"),
            "no redaction for whitelisted message: {out}"
        );

        // Non-whitelisted message redacted.
        let custom = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"WARN","fields":{"message":"unique never-before-seen diagnostic from 2099"},"target":"agaric::lib"}"#;
        let out = redact_line(custom, &RedactionContext::default());
        assert!(
            !out.contains("never-before-seen"),
            "non-whitelisted message must be redacted: {out}"
        );
        assert!(
            out.contains(r#""message":"[REDACTED]""#),
            "message replaced by [REDACTED]: {out}"
        );
    }

    /// H-9b — JSON numbers, booleans, and null are inherently safe and
    /// pass through unchanged. They are not user-typed strings and
    /// therefore not PII-shape vectors.
    #[test]
    fn h9b_redact_line_json_primitives_preserved() {
        let line = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"INFO","fields":{"message":"compaction starting","count":1234567890,"ok":true,"hint":null,"ratio":-3}}"#;
        let out = redact_line(line, &RedactionContext::default());
        assert!(out.contains(r#""count":1234567890"#));
        assert!(out.contains(r#""ok":true"#));
        assert!(out.contains(r#""hint":null"#));
        assert!(out.contains(r#""ratio":-3"#));
    }

    /// H-9b — nested objects + arrays are walked recursively. A safe
    /// token deep in the tree survives; a non-safe sibling is redacted
    /// independently.
    #[test]
    fn h9b_redact_line_json_recursive() {
        let line = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"INFO","fields":{"message":"compaction starting"},"target":"agaric::lib","spans":[{"name":"agaric::sync","peer":"01HZQK7M5N6PQRSTVWXYZABCDE","note":"some private text"}]}"#;
        let out = redact_line(line, &RedactionContext::default());
        // ULID inside spans[].peer must survive.
        assert!(
            out.contains("01HZQK7M5N6PQRSTVWXYZABCDE"),
            "ULID in nested array must survive: {out}"
        );
        // Multi-segment Rust path inside spans[].name must survive.
        assert!(
            out.contains(r#""name":"agaric::sync""#),
            "Rust path in nested array must survive: {out}"
        );
        // Free-text sibling must be redacted.
        assert!(
            !out.contains("some private text"),
            "free-text in nested array must be redacted: {out}"
        );
        assert!(
            out.contains(r#""note":"[REDACTED]""#),
            "redaction marker in nested array: {out}"
        );
    }

    /// H-9b — the JSON `fields` object's keys are ALWAYS preserved
    /// verbatim. Field key NAMES are part of the structural skeleton
    /// the user reads to follow the flow of events; they are not PII.
    #[test]
    fn h9b_redact_line_json_keys_never_redacted() {
        let line = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"INFO","fields":{"message":"compaction starting","weird_field_name_users_dont_typically_use":"alice"},"target":"agaric::lib"}"#;
        let out = redact_line(line, &RedactionContext::default());
        // The unusual KEY is preserved.
        assert!(
            out.contains("weird_field_name_users_dont_typically_use"),
            "field keys are never redacted: {out}"
        );
        // The bare-word VALUE `alice` IS redacted (fails safe-token).
        assert!(
            !out.contains(r#""alice""#),
            "bare first-name value must be redacted: {out}"
        );
    }

    /// H-9b — non-JSON input (text format, blank lines, truncation
    /// markers) takes the H-9a allow-list fallback. This matches the
    /// pre-H-9b behaviour exactly so older rolled `agaric.log.YYYY-MM-DD`
    /// files do not regress.
    #[test]
    fn h9b_redact_line_non_json_takes_allowlist_fallback() {
        // Truncation marker line — must pass through the cap helper
        // unchanged (no JSON parse, no allow-list match).
        let marker = "…[truncated 1024 bytes of older content]";
        let out = redact_line(marker, &RedactionContext::default());
        assert_eq!(out, marker, "truncation marker must round-trip: {out}");

        // Text-format line with $HOME — H-9a fallback scrubs to `~`.
        let line = "2025-01-01 INFO path=/home/alice/code/agaric/notes.db";
        let out = redact_line(
            line,
            &RedactionContext {
                home: Some("/home/alice"),
                ..Default::default()
            },
        );
        assert!(
            !out.contains("/home/alice"),
            "H-9a `$HOME` scrub must run on text fallback: {out}"
        );
        assert!(out.contains("~"), "tilde replacement: {out}");
    }

    /// H-9b — property test: random alphanumeric / PII-shaped strings
    /// fed into a JSON log line's free-text fields collapse to
    /// `[REDACTED]`. Verifies the safety contract: no value outside the
    /// safe-token set survives.
    ///
    /// `proptest` is a workspace dev-dep (per `src-tauri/Cargo.toml`)
    /// so this is a true property test, not just a hardcoded sweep.
    #[test]
    fn h9b_property_pii_shapes_are_redacted() {
        use proptest::prelude::*;
        let mut runner = proptest::test_runner::TestRunner::default();

        // PII-shaped string strategy. Each shape carries at least one
        // character class that no [`SAFE_TOKEN_PATTERNS`] entry allows
        // (`@`, embedded hyphen between digits, `://`, internal space),
        // so collisions with the safe-token set are impossible by
        // construction. Bare-letter shapes (e.g. `alice`) are
        // deliberately omitted because some short literals like `linux`
        // / `arm64` are in SAFE_LITERALS — narrow letter strategies
        // would generate false-positive PII collisions.
        let pii = prop_oneof![
            // Email shape (contains `@`).
            r"[a-z]{3,8}@[a-z]{3,8}\.(com|org|net)",
            // Phone shape with separators (hyphen between digit groups
            // — never matches integer safe-token).
            r"\d{3}-\d{3}-\d{4}",
            // URL shape (contains `://`).
            r"https://[a-z]{3,10}\.com/[a-z]{3,15}",
            // Sentence shape (contains spaces — no safe-token allows
            // internal whitespace).
            r"[a-z]{3,8} [a-z]{3,8} [a-z]{3,8}",
            // Free-form note shape (mixed letters + spaces + apostrophe).
            r"my [a-z]{3,8} note about [a-z]{3,8}",
        ];

        runner
            .run(&pii, |sample| {
                // Embed the sample as a free-text VALUE in a JSON line.
                // The `secret` key is never in STABLE_MESSAGES; the
                // value must redact.
                let escaped = sample.replace('\\', "\\\\").replace('"', "\\\"");
                let line = format!(
                    r#"{{"timestamp":"2026-04-28T10:23:45Z","level":"WARN","fields":{{"message":"compaction starting","secret":"{escaped}"}},"target":"agaric::test"}}"#
                );
                let out = redact_line(&line, &RedactionContext::default());
                prop_assert!(
                    !out.contains(&sample),
                    "PII-shaped sample {sample:?} must NOT survive in {out:?}"
                );
                prop_assert!(
                    out.contains(r#""secret":"[REDACTED]""#),
                    "redaction marker missing for sample {sample:?}: got {out:?}"
                );
                Ok(())
            })
            .expect("property must hold for every PII-shape input");
    }

    /// H-9b — property test: known-safe tokens fed as field values are
    /// preserved verbatim by the deny-list pipeline.
    #[test]
    fn h9b_property_safe_tokens_preserved() {
        use proptest::prelude::*;
        let mut runner = proptest::test_runner::TestRunner::default();

        // Safe-token strategy: random samples from each documented
        // token class.
        let safe = prop_oneof![
            // ULID (Crockford base32, 26 chars).
            r"[0-9A-HJKMNP-TV-Z]{26}",
            // Integer ≤ u64 (1–19 digits).
            r"[1-9][0-9]{0,18}",
            // AppError variant.
            r"AppError::[A-Z][a-zA-Z]{2,12}",
            // file:line ref. `[a-z_]{3,10}` covers basenames with
            // underscores (e.g. `bug_report.rs`).
            r"src-tauri/src/[a-z_]{3,10}\.rs:[1-9][0-9]{0,4}",
            // Hex digest at standard crypto sizes (8 = short-hash,
            // 16 = u64-hex, 32 = md5, 40 = sha1, 64 = sha256/blake3).
            r"[0-9a-f]{8}",
            r"[0-9a-f]{16}",
            r"[0-9a-f]{32}",
            r"[0-9a-f]{40}",
            r"[0-9a-f]{64}",
        ];

        runner
            .run(&safe, |sample| {
                let escaped = sample.replace('\\', "\\\\").replace('"', "\\\"");
                let line = format!(
                    r#"{{"timestamp":"2026-04-28T10:23:45Z","level":"INFO","fields":{{"message":"compaction starting","token":"{escaped}"}},"target":"agaric::test"}}"#
                );
                let out = redact_line(&line, &RedactionContext::default());
                prop_assert!(
                    out.contains(&sample),
                    "safe sample {sample:?} must survive in {out:?}"
                );
                prop_assert!(
                    !out.contains(r#""token":"[REDACTED]""#),
                    "safe token wrongly redacted: sample {sample:?}, got {out:?}"
                );
                Ok(())
            })
            .expect("property must hold for every safe-token input");
    }

    /// H-9b — `redact_log` mixes JSON and text-format lines in one
    /// bundle without confusing the dispatcher. Today's `agaric.log`
    /// (post-format-switch JSON) and yesterday's rolled file (text
    /// format) appear in the same bundle for a 7-day-window export.
    #[test]
    fn h9b_redact_log_mixed_format_dispatch() {
        let contents = concat!(
            r#"{"timestamp":"2026-04-28T10:23:45Z","level":"INFO","fields":{"message":"compaction starting"},"target":"agaric::lib"}"#,
            "\n",
            "2025-01-01 INFO [agaric] path=/home/alice/notes.db\n",
        );
        let ctx = RedactionContext {
            home: Some("/home/alice"),
            ..Default::default()
        };
        let out = redact_log(contents, &ctx);
        // First line: JSON deny-list path, stable message preserved.
        assert!(
            out.contains("compaction starting"),
            "JSON deny-list message preserved: {out}"
        );
        // Second line: text fallback with $HOME scrubbed.
        assert!(
            !out.contains("/home/alice"),
            "$HOME scrub on text fallback line: {out}"
        );
        assert!(out.contains("~"), "tilde marker present: {out}");
    }

    /// H-9b — field VALUES that LOOK structured but contain a non-safe
    /// substring (e.g. an email embedded in a 'note' string) are
    /// redacted as a single unit. The deny-list does NOT do partial
    /// substring substitution — it's a whole-value check.
    #[test]
    fn h9b_redact_line_json_no_partial_substring_substitution() {
        let line = r#"{"timestamp":"2026-04-28T10:23:45Z","level":"INFO","fields":{"message":"compaction starting","note":"contact: alice@example.com please"}}"#;
        let out = redact_line(line, &RedactionContext::default());
        // The whole `note` value is replaced (not just the email
        // substring). This is the SAFER posture: any embedded PII
        // inside a free-text wrapper still vanishes.
        assert!(
            !out.contains("alice@example.com"),
            "embedded email must not survive: {out}"
        );
        assert!(
            out.contains(r#""note":"[REDACTED]""#),
            "whole-value redaction (not substring): {out}"
        );
    }

    // -- home_dir_string (L-41) ------------------------------------------

    /// L-41 — On Linux/macOS the standard CI environments set `$HOME`, so
    /// `dirs::home_dir()` resolves and `home_dir_string()` returns Some.
    /// Headless container CIs that strip `$HOME` would force `dirs` to
    /// fall back to `/etc/passwd`; if even that fails we treat absence as
    /// "no home replacement" rather than failing the test (matching the
    /// production "no home replacement" semantics the function documents).
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn home_dir_string_returns_some_when_dirs_resolves() {
        if let Some(expected) = dirs::home_dir() {
            let got = home_dir_string();
            assert_eq!(
                got.as_deref(),
                Some(expected.to_string_lossy().as_ref()),
                "home_dir_string must mirror dirs::home_dir() when it resolves"
            );
            assert!(
                got.as_deref().is_some_and(|s| !s.is_empty()),
                "home_dir_string must filter out empty strings"
            );
        } else {
            // Container CI without HOME and no /etc/passwd entry — accept
            // None as the documented "no home replacement" outcome.
            assert!(
                home_dir_string().is_none(),
                "home_dir_string must return None when dirs::home_dir() fails"
            );
        }
    }

    /// L-41 — On Windows, `dirs::home_dir()` resolves through `USERPROFILE`
    /// (and the `SHGetKnownFolderPath` API as a fallback), not `$HOME`.
    /// The previous `std::env::var("HOME")` implementation would silently
    /// return `None` here, leaking `C:\Users\<name>\…` into bug-report ZIPs.
    #[cfg(windows)]
    #[test]
    fn home_dir_string_resolves_on_windows_via_userprofile() {
        let expected = dirs::home_dir().expect(
            "Windows: dirs::home_dir() must resolve via USERPROFILE on developer/CI machines",
        );
        let got = home_dir_string()
            .expect("home_dir_string must return Some on Windows when USERPROFILE is set");
        assert_eq!(
            got,
            expected.to_string_lossy().into_owned(),
            "home_dir_string must mirror dirs::home_dir() on Windows"
        );
        assert!(!got.is_empty(), "home_dir_string must filter empty strings");
    }
}
