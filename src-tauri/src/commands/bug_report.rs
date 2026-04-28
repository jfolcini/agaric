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

/// H-9a — generic email regex applied AFTER the specific GCal-email scrub
/// so a known account still carries the precise `[REDACTED:GCAL_EMAIL]`
/// marker while stray emails in error messages, tracing fields, or third-
/// party log lines all collapse to the generic `[EMAIL]` placeholder.
///
/// The pattern is the well-known "good-enough" email shape used in most
/// log scrubbers; deliberately conservative so common cases (Gmail, work
/// addresses, mailing lists) are caught without trying to be RFC 5322
/// compliant. Compiled once via [`LazyLock`] — the regex is hot-path.
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
/// The level always appears within the first ~35 bytes (27-byte ISO-Z
/// timestamp + a couple of separator spaces + the 4–5-char level).
/// Bounding the substring search to the first 40 bytes prevents body
/// content of the form `... contains ERROR somewhere in the message ...`
/// on an INFO line from being misclassified. The previous unbounded
/// `line.contains(" ERROR ") || line.contains(" WARN ")` produced false
/// positives any time an INFO/DEBUG line's payload mentioned those words.
///
/// `regex` is a workspace dep (used by [`EMAIL_REGEX`] above), so a fully
/// anchored ISO-Z regex would also work — but the prefix-bound check is
/// cheaper, has no per-call regex overhead in this hot path (the helper
/// is invoked per-line on the live `agaric.log` tail), and is permissive
/// enough to also accept the `YYYY-MM-DD LEVEL ...` shape used by the
/// in-file unit-test fixtures, avoiding churn in test data that exists
/// purely to exercise this filter.
fn is_error_or_warn_line(line: &str) -> bool {
    let prefix = line.get(..40.min(line.len())).unwrap_or("");
    prefix.contains(" ERROR ") || prefix.contains(" WARN ")
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

/// Redact a single line by, in order:
///  1. Replacing `$HOME` prefixes (and any absolute path beginning with `/`
///     except bracketed log-fmt tokens) with `~` when `ctx.home` is given.
///  2. Blanking any occurrence of `ctx.device_id` with `[REDACTED_DEVICE_ID]`.
///  3. **H-9a:** Replacing the user's GCal account email (if known) with
///     `[REDACTED:GCAL_EMAIL]`.
///  4. **H-9a:** Replacing every known peer device ID (from `peer_refs`)
///     with `[REDACTED:PEER_DEVICE_ID]`.
///  5. **H-9a:** Catch-all email regex → `[EMAIL]`. Applied AFTER the
///     specific GCal-email scrub so the known account keeps its precise
///     marker; this fold catches stray emails in error messages, tracing
///     fields, and third-party log lines that the specific scrubs miss.
///  6. Truncating the result to [`MAX_LINE_BYTES`] chars.
///
/// All three new scrubs are additive — a default-constructed
/// [`RedactionContext`] is a noop, preserving the previous semantics
/// for callers that have not yet been updated.
fn redact_line(line: &str, ctx: &RedactionContext<'_>) -> String {
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
    if out.len() > MAX_LINE_BYTES {
        let extra = out.len() - MAX_LINE_BYTES;
        // Keep the first MAX_LINE_BYTES bytes — split on a char boundary to
        // avoid producing invalid UTF-8 when the cut lands inside a codepoint.
        let mut cut = MAX_LINE_BYTES;
        while !out.is_char_boundary(cut) && cut > 0 {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str(&format!("…[truncated {extra} chars]"));
    }
    out
}

/// Apply line-by-line redaction to an entire log file's contents.
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
