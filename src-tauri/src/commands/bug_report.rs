//! Bug-report command handlers (FEAT-5).
//!
//! Provides two read-only commands consumed by the in-app bug-report dialog:
//!
//! - `collect_bug_report_metadata` — gathers app version, OS, arch, device ID,
//!   and the last ~20 error/warn lines from today's log file.
//! - `read_logs_for_report` — enumerates rolled log files, capping per-file
//!   size, skipping anything older than 7 days, and optionally redacting
//!   home paths + device IDs.
//!
//! The frontend composes these with the user-entered title/description,
//! optionally writes a ZIP to disk via `downloadBlob`, and opens a prefilled
//! GitHub issue URL. Logs NEVER leave the device as part of the URL itself
//! — the feature's privacy story rests on the explicit user-visible preview
//! + confirmation checkbox + ZIP-on-disk flow. See REVIEW-LATER FEAT-5.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::Manager;

use crate::error::AppError;
use crate::log_dir_for_app_data;

/// Metadata returned by [`collect_bug_report_metadata`].
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct BugReport {
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub device_id: String,
    /// Last ~20 error/warn lines from today's `agaric.log`, newest last.
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
/// marker. 2 MB is generous enough for dozens of sessions without exploding
/// the resulting ZIP.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Maximum age (in days) of a rolled log file to include in the export.
/// Files older than this are silently skipped. Today's live `agaric.log`
/// (no date suffix) is always included.
const MAX_ROLLED_AGE_DAYS: i64 = 7;

/// Per-line byte ceiling applied during redaction. Lines longer than this
/// are truncated to a `…[truncated N chars]` marker. 8 KB is well above any
/// reasonable log line and catches pathological cases (massive stack traces,
/// serialised snapshots) without silently dropping content.
const MAX_LINE_BYTES: usize = 8 * 1024;

/// Cap on the number of recent error/warn lines surfaced in
/// [`collect_bug_report_metadata`]. Short enough to render cleanly in the
/// dialog preview; long enough to capture a crash + a few surrounding hints.
const RECENT_ERRORS_CAP: usize = 20;

/// Pure helper: extract up to [`RECENT_ERRORS_CAP`] most-recent `ERROR` or
/// `WARN` lines from an iterator of log lines. Preserves order.
fn extract_recent_errors<'a, I: Iterator<Item = &'a str>>(lines: I) -> Vec<String> {
    let mut matches: Vec<String> = Vec::new();
    for line in lines {
        if line.contains(" ERROR ") || line.contains(" WARN ") {
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
    match fs::read_to_string(path) {
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

/// Redact a single line by:
///  1. Replacing `$HOME` prefixes (and any absolute path beginning with `/`
///     except bracketed log-fmt tokens) with `~` when `home` is given.
///  2. Blanking any occurrence of `device_id` with `[REDACTED_DEVICE_ID]`.
///  3. Truncating the result to [`MAX_LINE_BYTES`] chars.
fn redact_line(line: &str, home: Option<&str>, device_id: Option<&str>) -> String {
    let mut out = line.to_string();
    if let Some(home) = home {
        if !home.is_empty() {
            out = out.replace(home, "~");
        }
    }
    if let Some(id) = device_id {
        if !id.is_empty() {
            out = out.replace(id, "[REDACTED_DEVICE_ID]");
        }
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
fn redact_log(contents: &str, home: Option<&str>, device_id: Option<&str>) -> String {
    let mut out = String::with_capacity(contents.len());
    for line in contents.split_inclusive('\n') {
        // `split_inclusive` preserves the trailing `\n`; strip it before
        // redacting so our length cap is measured on content, not the newline.
        let (body, newline) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        out.push_str(&redact_line(body, home, device_id));
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
pub fn read_logs_for_report_inner(
    log_dir: &Path,
    redact: bool,
    home: Option<&str>,
    device_id: Option<&str>,
) -> Result<Vec<LogFileEntry>, AppError> {
    if !log_dir.is_dir() {
        return Ok(Vec::new());
    }

    let today = chrono::Utc::now().date_naive();
    let mut entries: Vec<(PathBuf, String)> = Vec::new();

    for entry in fs::read_dir(log_dir)? {
        let entry = entry?;
        let name_os = entry.file_name();
        let Some(name) = name_os.to_str() else {
            continue;
        };
        if !should_include_log_file(name, today) {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Ok(contents) = read_capped_file(&path) else {
            continue;
        };
        entries.push((path, contents));
    }

    // Sort so output is deterministic (today first, then reverse-chrono).
    entries.sort_by(|a, b| a.0.file_name().cmp(&b.0.file_name()));

    let mut out = Vec::with_capacity(entries.len());
    for (path, contents) in entries {
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("agaric.log")
            .to_string();
        let final_contents = if redact {
            redact_log(&contents, home, device_id)
        } else {
            contents
        };
        out.push(LogFileEntry {
            name,
            contents: final_contents,
        });
    }

    Ok(out)
}

#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn read_logs_for_report(
    app: tauri::AppHandle,
    device_id: tauri::State<'_, crate::device::DeviceId>,
    redact: bool,
) -> Result<Vec<LogFileEntry>, AppError> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    let log_dir = log_dir_for_app_data(&data_dir);
    let home = home_dir_string();
    read_logs_for_report_inner(&log_dir, redact, home.as_deref(), Some(device_id.as_str()))
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
        let out = read_logs_for_report_inner(dir.path(), false, None, None).unwrap();
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn read_logs_nonexistent_dir_returns_empty() {
        let bogus = PathBuf::from("/tmp/agaric-nonexistent-bug-report-dir");
        let out = read_logs_for_report_inner(&bogus, false, None, None).unwrap();
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

        let out = read_logs_for_report_inner(log_dir, false, None, None).unwrap();

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

        // Write > MAX_FILE_BYTES (2 MB) of content with a clearly-identifiable
        // tail line.
        let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
        let mut contents = String::with_capacity(cap + 2_048);
        while contents.len() < cap + 1_024 {
            contents.push_str("2025-01-01 INFO [agaric] filler line abcdefghijklmnopqrstuvwxyz\n");
        }
        contents.push_str("2025-01-01 ERROR [agaric] TAIL_MARKER\n");
        fs::write(&path, &contents).unwrap();

        let out = read_logs_for_report_inner(log_dir, false, None, None).unwrap();

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

        let out = read_logs_for_report_inner(log_dir, false, None, None).unwrap();
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

        let out = read_logs_for_report_inner(log_dir, true, Some(HOME), Some(DEV)).unwrap();

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

        // Build a line longer than MAX_LINE_BYTES (8 KB).
        let mut long_line = String::with_capacity(MAX_LINE_BYTES + 100);
        long_line.push_str("2025-01-01 INFO [agaric] ");
        while long_line.len() < MAX_LINE_BYTES + 50 {
            long_line.push('x');
        }
        long_line.push('\n');
        fs::write(log_dir.join("agaric.log"), &long_line).unwrap();

        let out = read_logs_for_report_inner(log_dir, true, None, None).unwrap();

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

        let out = read_logs_for_report_inner(log_dir, false, Some(HOME), Some(DEV)).unwrap();

        assert_eq!(out.len(), 1);
        assert!(out[0].contents.contains(DEV));
        assert!(out[0].contents.contains(HOME));
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
        let out = redact_line(&s, None, None);
        assert!(out.contains("…[truncated"), "must carry truncation marker");
        // No panic = success. Verify the output is still valid UTF-8 (it
        // inherently is since it's a `String`).
        let _check = out.chars().count();
    }

    #[test]
    fn redact_line_no_home_no_device_is_identity_on_short_lines() {
        let line = "2025-01-01 INFO nothing to redact";
        assert_eq!(redact_line(line, None, None), line);
    }

    #[test]
    fn redact_line_empty_home_is_noop() {
        let line = "2025-01-01 path=/home/alice/x";
        // Empty home must NOT replace all forward-slashes or similar.
        let out = redact_line(line, Some(""), None);
        assert_eq!(out, line);
    }

    #[test]
    fn redact_line_empty_device_id_is_noop() {
        let line = "2025-01-01 device=abc";
        let out = redact_line(line, None, Some(""));
        assert_eq!(out, line);
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
