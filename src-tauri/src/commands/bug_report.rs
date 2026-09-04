//! Bug-report command handlers.
//!
//! Provides two read-only commands consumed by the in-app bug-report dialog:
//!
//! - `collect_bug_report_metadata` — gathers app version, OS, arch, device ID,
//!   and the last `RECENT_ERRORS_CAP` error/warn lines from the recent
//!   daily log files (#4216 — the newest days back to
//!   `MAX_ROLLED_AGE_DAYS`, not just the current UTC day's).
//!   #609: the recent-error lines are ALWAYS redacted (same pipeline as the
//!   ZIP path) because the frontend embeds them into the prefilled public
//!   GitHub issue body.
//! - `read_logs_for_report` — enumerates rolled log files, capping per-file
//!   size, skipping anything older than `MAX_ROLLED_AGE_DAYS` days, and
//!   optionally redacting home paths + device IDs.
//!
//! The frontend composes these with the user-entered title/description,
//! optionally writes a ZIP to disk via `downloadBlob`, and opens a prefilled
//! GitHub issue URL. Full log FILES never leave the device as part of the
//! URL itself (only the redacted recent-error tail is embedded in the body)
//! — the feature's privacy story rests on unconditional redaction of that
//! tail plus the explicit user-visible preview + confirmation checkbox +
//! ZIP-on-disk flow.
//!
//! #4283 — and on both paths reading only the log directory's OWN regular
//! files. Every read here goes through `open_confined_log_file`, which opens
//! with symlink resolution of the final component disabled and proves the
//! result is a regular file from the open handle. Redaction is tuned for this
//! application's log format; a file reached through a planted link is not that,
//! and `recent_errors` is pasted into a public issue body. See that function
//! for why the confinement of a log FILE is not a check-then-open race, and
//! for the hard-link residual it deliberately leaves. Two parts are path checks
//! rather than properties of an open, and so are mitigations with a race left
//! in them rather than closed holes: the OTel *directory* guard in
//! `read_logs_for_report_inner` (#4487), and the mtime ranking in
//! `plain_log_outranks_dated`. Neither can exfiltrate — the open re-decides —
//! but both can suppress. Each says so where it stands.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use aho_corasick::{AhoCorasick, MatchKind};
use regex::Regex;
use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use crate::log_dir_for_app_data;
use agaric_core::error::AppError;

// =====================================================================
// REDACTION POLICY (H-9b)
// =====================================================================
//
// Bug-report redaction is **deny-by-default at the field-value level**.
// Anything that does not match a member of [`SAFE_TOKEN_PATTERNS`] is
// replaced with `[REDACTED]`. This is the inverse of H-9a, which scrubbed
// SPECIFIC values (`$HOME`, `device_id`, peer IDs) and let
// everything else through.
//
// **Two formats, declared not sniffed** (#3317). Every file in the bundle
// declares its [`LineFormat`] at the call site that read it: `agaric.log`
// (and its rolled siblings) is `TracingLog`; the OpenTelemetry signal files
// under [`OTEL_SUBDIRS`] are `OtelSignal` — tab-separated `key=value`, one
// record per line. Both branches are deny-by-default at the field-value
// level; they differ only in how a line is split into fields. Dispatching on
// "does this line parse as JSON?" — as this pipeline used to — silently gave
// the OTel files the H-9a allow-list, which passes all text verbatim.
//
// **Pipeline** (per [`redact_line`], the `TracingLog` format):
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
//      replace `$HOME`, `device_id`, peer-device IDs, and
//      any email-shaped substring. This branch is documented as a
//      defense-in-depth fallback rather than the primary path.
//
// **Drift watch:** the on-disk format produced by `tracing-subscriber`
// in `lib.rs::run` is JSON-per-line — the file appender layer calls
// `.json()` (`fmt::layer().json().with_writer(non_blocking).with_ansi(false)`).
// That means today every `agaric.log` line takes the JSON deny-list
// branch (step 1/2 above); the H-9a allow-list is now the
// defense-in-depth fallback for older rolled text files only. The
// stderr layer stays human-readable for live dev debugging and never
// reaches the redaction pipeline.
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
    // `agaric_core::error::AppError`. The mandatory `::` blocks bare lowercase
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
    "sync endpoint identity loaded",
    "boot count query failed; treating as 0",
    "PANIC",
    "failed to build Tauri application",
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
    // #3464 restored the announce that #3488 had to defer: the daemon now owns an iroh
    // endpoint, so it has the `EndpointId` a peer would dial and the record it publishes
    // names the key it is actually accepting on.
    //
    // #3852 split the old single `"SyncDaemon started; announced over mDNS"` line in two,
    // because it was making a claim it could not support: `register()` returns as soon as
    // a command is queued, so that line was logged on a Pixel 8 that answered nothing on
    // the wire. The submit and the actual wire event are now separate messages, and both
    // are here — a bug report about mDNS that redacted either of them would be missing
    // exactly the distinction the report is about.
    "mDNS announce submitted to the daemon's command queue (not yet on the wire)",
    "mDNS announcement sent on the wire",
    "mDNS announce could not be queued; peers must discover this device another way",
    "mDNS daemon reported an error after the announce was accepted; peer discovery is degraded",
    "could not subscribe to the mDNS daemon monitor; announce failures will not be observable",
    // #3852 — Android's per-uid background firewall, as reported by the platform itself.
    // Whether this line is present is the difference between "the LAN was quiet" and "the
    // OS was dropping our packets", which is the question that took three days to answer.
    "the OS is blocking this app's network traffic; sync and pairing cannot reach the network until it is restored",
    "the OS has restored this app's network traffic",
    "SyncDaemon shut down cleanly",
    "Failed to start SyncDaemon",
    "mDNS disabled: no first-ever pair is possible; already-paired peers may still use a cached address",
    "rejecting sync with self",
    "rejecting sync from an unpaired device: no pairing is in progress",
    "responder locked peer for sync",
    "responder sync session finished",
    "responder file transfer failed (non-fatal)",
    "responder sync session failed",
    "could not determine app_data_dir, skipping file transfer",
    "discovered new peer via mDNS",
    "debounced-change peer task panicked",
    "mDNS browse failed (peer discovery disabled)",
    "mDNS shutdown error",
    "mDNS initialization failed (peer discovery disabled)",
    "peer announced no endpoint id, skipping sync (nothing to dial)",
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
    // snapshot / compaction.
    "compaction starting",
    "compaction: no eligible ops, nothing to do",
    // commands / surface.
    "internal error suppressed during sanitization",
    // mcp.
    "MCP connection ended with error",
    "already bound",
    // bug_report itself (so its own warn lines round-trip).
    "skipping log file with invalid UTF-8 in name",
    "skipping log entry — not a regular file (symlink/dir/socket?)",
    "skipping log file — read_capped_file failed (permission denied or io error?)",
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

/// H-9a — generic email regex: stray emails in error messages, tracing
/// fields, or third-party log lines all collapse to the generic
/// `[EMAIL]` placeholder.
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
    /// Last `RECENT_ERRORS_CAP` error/warn lines from the recent
    /// `agaric.log.YYYY-MM-DD` files, newest last.
    ///
    /// #4216: this is a recency window, not a calendar-day one — the walk
    /// crosses UTC day boundaries backwards until the cap is full or the
    /// bundle's own `MAX_ROLLED_AGE_DAYS` retention runs out, so a report
    /// filed minutes after midnight still shows the errors that prompted
    /// it. See `recent_errors_from_log_dir`.
    ///
    /// #609: ALWAYS redacted through the same pipeline as the ZIP export
    /// (`redact_line_with_redactor`) — the frontend embeds these lines
    /// verbatim into the prefilled PUBLIC GitHub issue body
    /// (`src/lib/bug-report.ts::formatReportBody`), and unlike the ZIP
    /// path there is no user-facing redact toggle on the issue-body path.
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

/// Cap on the total bug-report bundle size (sum of all redacted
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

/// OpenTelemetry signal subdirectories (relative to `<log_dir>`) whose live
/// file is folded into the bug-report bundle by
/// [`read_logs_for_report_inner`]. Written by the off-by-default
/// observability stack (M1/M1b/M6): `traces/` holds backend + frontend
/// interaction spans, `otel-logs/` the span-correlated log bridge, and
/// `metrics/` the periodic metrics dump. Each is a daily-rotated
/// [`tracing_appender::rolling`] sink mirroring `agaric.log`'s convention,
/// so the newest file is the live tail (see [`newest_otel_file`]).
///
/// Kept as a `&str` slice rather than importing the `*_SUBDIR` consts from
/// `agaric_observability::exporter` / `::metrics_exporter` so the bundle's
/// view of "which dirs to scoop" stays self-contained here — the subdir
/// names are part of the on-disk layout contract, not a runtime coupling.
/// When tracing was never enabled these dirs simply do not exist and are
/// skipped (no error) by [`newest_otel_file`].
const OTEL_SUBDIRS: &[&str] = &["traces", "otel-logs", "metrics"];

/// Pin level detection to the tracing-subscriber default format
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
    // Byte 40 and therefore excluded — preserves the false-positive
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

/// Read the most recent `ERROR`/`WARN` lines from the app's daily log
/// files, newest last.
///
/// Walks the rolled `agaric.log.YYYY-MM-DD` family from the newest day
/// backwards, stopping as soon as [`RECENT_ERRORS_CAP`] lines have been
/// collected. #4216 — reading only the current UTC day made this field
/// blind by the calendar rather than by recency: a report filed at 00:10
/// UTC saw nothing from the incident twenty minutes earlier, because the
/// appender had already rolled to a near-empty current-day file and the
/// errors sat in `agaric.log.<yesterday>`. Those files are already IN the
/// report bundle (`should_include_log_file` accepts them); they just never
/// reached the summary field a triager reads first.
///
/// The cap is by line count, not by file, so a day boundary is no longer a
/// cliff. Two bounds, both taken from constants this module already
/// enforces rather than invented for this walk:
///
/// * how far back — [`MAX_ROLLED_AGE_DAYS`], the same retention window
///   `should_include_log_file` applies to the bundle (shared by
///   construction: both go through [`parse_rolled_log_date`] +
///   [`is_within_log_retention`]). The shared piece is the *selection
///   predicate*, and only that: after selection the bundle runs
///   [`apply_bundle_cap`], which drops the OLDEST files once the redacted
///   total passes [`MAX_BUNDLE_BYTES`]. So on a log dir whose in-window
///   days are individually huge, the bundle can ship fewer days than this
///   walk read, and a summarised line may name a day whose file was
///   dropped (the bundle says so, via its
///   `[skipped N older logs …]` entry). The invariant this bullet buys is
///   the useful direction — the summary never reaches a day the bundle's
///   own retention would have refused — not set equality with the shipped
///   ZIP.
/// * how much — [`RECENT_ERRORS_CAP`], unchanged, applied to the combined
///   cross-day tail exactly as it was to the single-day one.
///
/// Cost. Each file read is capped at [`MAX_FILE_BYTES`] by
/// [`read_capped_file`] — the same window `read_logs_for_report_inner`
/// uses, so the preview matches the bundle-export window byte-for-byte.
/// The walk stops at the first file that fills the cap, so a chatty
/// current day is still a single read; but "quiet" here means *no
/// ERROR/WARN lines*, not *small*, and a healthy app is quiet by
/// definition — so the reach-back branch is a normal case, not a rare one,
/// and its cost is the one to budget against:
///
/// * cumulative bytes read — at most
///   `MAX_FILE_BYTES * (1 + MAX_ROLLED_AGE_DAYS)` (2 MiB × 8 = 16 MiB),
///   when every in-window day exists at the per-file cap and none of them
///   holds a single ERROR/WARN line. That is strictly less than what the
///   bundle path already reads on the same directory: it reads the same
///   eight dated files plus the OTel signal files. Note this is a READ
///   ceiling, not [`MAX_BUNDLE_BYTES`] — that constant caps what the ZIP
///   *ships*, and exists precisely because 16 MiB is more than a user can
///   upload. It is not a licence for 16 MiB elsewhere; the reason this
///   walk can afford the reads is the next bullet.
/// * peak resident bytes — one capped file (≤ [`MAX_FILE_BYTES`]) plus at
///   most [`RECENT_ERRORS_CAP`] retained lines. `read_errors_from_path`
///   drops each file's `String` before the next is opened, where
///   `read_logs_for_report_inner` holds every file's contents at once. So
///   this path is strictly gentler on memory than the bundle path, and its
///   output is bounded by a line count rather than a byte budget.
///
/// The remaining cost is blocking I/O time, and it grew 8× against the
/// single-file version. [`collect_bug_report_metadata`] is an async
/// command, so this runs on an async-runtime worker rather than on the UI
/// thread — but it is still synchronous `fs` work inside a `Future`, which
/// is why the [`MAX_FILE_BYTES`] cap (rather than a plain
/// `fs::read_to_string`) matters more here than it did when this read one
/// file: the dialog must not stall behind a multi-MB read, times eight.
///
/// Silently returns an empty vec if the dir does not exist or cannot be
/// read — a bug report without recent errors is still useful, and boot-time
/// failures (no log dir, permission denied) should not also break the
/// report surface.
fn recent_errors_from_log_dir(log_dir: &Path) -> Vec<String> {
    recent_errors_from_log_dir_at(log_dir, chrono::Utc::now().date_naive())
}

/// Clock seam for [`recent_errors_from_log_dir`]: the same logic with the
/// "today" boundary injected instead of read from `Utc::now()`.
///
/// Mirrors the seam [`should_include_log_file`] already exposes (it takes
/// `today: NaiveDate` for the same reason). Tests drive this variant with a
/// fixed synthetic date so a fixture's filenames and the code's notion of
/// "today" cannot disagree — neither because the real calendar moved nor
/// because the test straddled a UTC midnight between building the fixture
/// and calling the function.
fn recent_errors_from_log_dir_at(log_dir: &Path, today: chrono::NaiveDate) -> Vec<String> {
    // #4127 — `build_log_file_appender` (`lib.rs`) configures
    // `tracing_appender`'s `RollingFileAppender` with `Rotation::DAILY` and
    // `filename_prefix("agaric.log")` and no suffix. `RollingWriter::join_date`
    // (the crate's own naming logic) then always names the file
    // `{prefix}.{date}` for that combination — there is no rotation event
    // that ever produces a plain, undated `agaric.log`, not even for
    // "today": the current day's live file is `agaric.log.YYYY-MM-DD` from
    // the moment it is created, and a rollover just starts a new dated file
    // under the same scheme. So the dated family IS what production writes,
    // and it is what this must read.
    let mut days: Vec<(chrono::NaiveDate, PathBuf)> = Vec::new();
    if let Ok(read_dir) = fs::read_dir(log_dir) {
        for entry in read_dir.flatten() {
            let name_os = entry.file_name();
            let Some(name) = name_os.to_str() else {
                continue;
            };
            let Some(file_date) = parse_rolled_log_date(name) else {
                continue;
            };
            if !is_within_log_retention(file_date, today) {
                continue;
            }
            // #4283 — `entry.metadata()` is `lstat`, unlike the `Path::is_file`
            // this used to call: a symlink is classified as a symlink here
            // instead of as whatever it points at. Dropping it now, rather than
            // relying on the open in `read_capped_file` to refuse it, keeps a
            // planted link from influencing `plain_log_outranks_dated`'s mtime
            // ranking — which reads `days` and would otherwise be comparing
            // against the mtime of a file outside the log directory.
            if entry.metadata().is_ok_and(|meta| meta.is_file()) {
                days.push((file_date, entry.path()));
            }
        }
    }

    // A plain, undated `agaric.log`. The `Rotation::DAILY` appender above
    // never writes one, but `Rotation::NEVER` DOES (it yields the bare
    // prefix, no date), and hand-written test fixtures use it.
    //
    // #4290 — which family wins is decided by RECENCY, not by the mere
    // ABSENCE of the other. The pre-#4290 rule (read the plain file only
    // when no usable in-window dated file exists) defeated the very
    // scenario the fallback was justified by: on the day the rotation
    // policy is switched to `Rotation::NEVER`, the dated files written
    // BEFORE the switch stay inside [`MAX_ROLLED_AGE_DAYS`] for a whole
    // week, so `days` stays non-empty for that whole week and the live
    // plain file — the only one still being appended to — is ignored. The
    // summary then stops on the day of the switch, which is the "silently
    // going blind" the fallback exists to prevent, and is a regression
    // against the pre-#4216 code (that read `agaric.log` whenever
    // `agaric.log.<today>` was absent).
    //
    // #4127's guarantee survives because it is the SAME comparison read the
    // other way: a stale plain leftover is, by definition, older than the
    // dated files production is still writing, so it loses and can neither
    // be preferred over nor mixed into them. Only the inverse shape — a
    // plain file NEWER than every in-window dated file — changes behaviour.
    // #4283 — `is_regular_file_no_follow`, not `Path::is_file`: this name is
    // as plantable as any dated one, and it wins outright when it outranks the
    // dated family, so a link here would be the whole of `recent_errors`.
    let plain_path = log_dir.join("agaric.log");
    if is_regular_file_no_follow(&plain_path) && plain_log_outranks_dated(&plain_path, &days) {
        // Read it INSTEAD of the dated family rather than merging the two.
        // #4127's rule is that the families are never mixed, and an undated
        // file has no date key to order it by inside the chronological walk
        // below; whichever family is live is the whole answer.
        return read_errors_from_path(&plain_path);
    }

    if days.is_empty() {
        return Vec::new();
    }

    // Newest day first, so the walk below spends its budget on the most
    // recent lines and can stop early.
    days.sort_by_key(|(file_date, _)| std::cmp::Reverse(*file_date));

    // `out` accumulates newest-day-first-collected lines in CHRONOLOGICAL
    // order (newest last, matching `BugReport::recent_errors`): each older
    // day's tail is prepended to what the newer days already contributed.
    let mut out: Vec<String> = Vec::new();
    for (_, path) in days {
        // `room` is > 0 here: the loop breaks as soon as the cap is full.
        let room = RECENT_ERRORS_CAP - out.len();
        let mut older = read_errors_from_path(&path);
        if older.len() > room {
            // Keep this day's NEWEST `room` lines — the same
            // keep-the-tail rule `extract_recent_errors` applies within a
            // single file, extended across the day boundary.
            let start = older.len() - room;
            older.drain(..start);
        }
        older.extend(out);
        out = older;
        if out.len() >= RECENT_ERRORS_CAP {
            break;
        }
    }
    out
}

/// Does a plain, undated `agaric.log` outrank the dated `agaric.log.<date>`
/// family — i.e. is it the file the app is currently writing?
///
/// #4290. The question is answered by RECENCY (mtime) because the two
/// shapes that matter are indistinguishable by CATEGORY:
///
/// - a stale plain leftover sitting next to live dated files (#4127 — the
///   dated family must win), and
/// - a live plain file sitting next to dated files frozen by a
///   `Rotation::NEVER` switch (the plain file must win),
///
/// are both just "a plain file and some in-window dated files". Only the
/// clock separates them.
///
/// `days` being empty is the one case needing no comparison: there is
/// nothing to outrank. That is the pre-#4290 fallback condition, kept
/// exactly — an out-of-window, future-dated, or non-regular-file dated
/// entry still leaves the plain file as the only readable log.
///
/// Everything else resolves toward #4127's conservative default:
///
/// - Ties lose. The plain file must be STRICTLY newer, so on a filesystem
///   whose mtime granularity collapses two nearby writes onto one stamp the
///   dated family still wins.
/// - An unreadable mtime loses, on either side. Without a clock reading
///   there is no evidence against the default, and a dated file whose
///   metadata cannot be read is not evidence *for* the plain file.
///
/// # The ranking `stat` does not follow, and the residual that leaves
///
/// #4283 — both sides are read with `symlink_metadata`, not `fs::metadata`.
/// Every candidate reaching here was classified by an `lstat` back at
/// `read_dir` time (or, for the plain file, by [`is_regular_file_no_follow`]),
/// so it is a proven regular file and the two calls return the same stamp for
/// it: the non-following form costs nothing legitimate. What it buys is the
/// window between those two syscalls. A following `stat` re-resolves the name,
/// so a link swapped in during that window would rank by its TARGET's mtime —
/// any file anywhere on the machine, freshly touched — and that is enough to
/// decide which log family is read.
///
/// Stated plainly, because it is the same TOCTOU class as the OTel-directory
/// residual (#4487) and was previously unmentioned: this narrows the window's
/// value, it does not close the window. An attacker who still wins it gets a
/// candidate stamped with the LINK's own mtime, which they also control (it is
/// the moment they create the link), and the open that follows then refuses
/// the link so that day yields nothing. So the residual is a SUPPRESSION one —
/// steering which family is read, or emptying the entry that was picked, which
/// is the harm `a_planted_symlink_cannot_suppress_the_live_plain_log_4283`
/// pins. It is not an exfiltration one: ranking reads no bytes, and every byte
/// is re-decided at the open by [`open_confined_log_file`] against the handle
/// it actually got. The precondition is the same as the other residuals here —
/// write access to the app's own log directory — and closing it needs
/// `openat`-relative I/O this crate cannot spell (it denies `unsafe_code` and
/// nothing in the dependency set exposes a safe one).
fn plain_log_outranks_dated(plain_path: &Path, days: &[(chrono::NaiveDate, PathBuf)]) -> bool {
    // `path`'s OWN mtime, or `None` if the filesystem will not say. `lstat`,
    // not `stat` — see the residual section above.
    fn mtime(path: &Path) -> Option<std::time::SystemTime> {
        fs::symlink_metadata(path)
            .and_then(|meta| meta.modified())
            .ok()
    }

    if days.is_empty() {
        return true;
    }

    let Some(plain_mtime) = mtime(plain_path) else {
        return false;
    };
    let Some(newest_dated) = days.iter().filter_map(|(_, path)| mtime(path)).max() else {
        return false;
    };

    plain_mtime > newest_dated
}

fn read_errors_from_path(path: &Path) -> Vec<String> {
    // Cap the read at [`MAX_FILE_BYTES`] using the same helper
    // as `read_logs_for_report_inner`. On oversized files the helper
    // prepends a `…[truncated …]` marker line; that marker contains
    // neither " ERROR " nor " WARN " so it is naturally filtered out by
    // `extract_recent_errors` below.
    match read_capped_file(path) {
        Ok(contents) => extract_recent_errors(contents.lines()),
        Err(e) => {
            // Skip, never abort: one unreadable day must not cost the
            // triager the other seven. Traced at warn for the same reason
            // `read_logs_for_report_inner` traces its per-file drops —
            // #4216 made this loop multi-file, so a silent `Vec::new()`
            // here is now indistinguishable from "that day had no
            // errors". Only the file name is logged (the dir is the app's
            // own log dir, but the full path can carry the user's home).
            tracing::warn!(
                name = %path.file_name().map_or_else(
                    || "<no name>".to_string(),
                    |n| n.to_string_lossy().chars().take(80).collect::<String>(),
                ),
                error = %e,
                "skipping log file in recent-errors walk — read failed \
                 (permission denied or io error?)",
            );
            Vec::new()
        }
    }
}

/// Gather metadata about the running app + the recent error/warn tail of
/// its daily log files.
///
/// `os` / `arch` are sourced from `tauri-plugin-os` rather than
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
///
/// #609: `home` / `peer_device_ids` are the same redaction
/// inputs `read_logs_for_report_inner` consumes. The recent-error tail is
/// run through the SAME per-line pipeline as the ZIP export
/// (`redact_line_with_redactor`) — unconditionally, because the frontend
/// embeds these lines into the prefilled PUBLIC GitHub issue body and that
/// path has no redact toggle. All inputs are "absent → noop" per
/// `RedactionContext`; pass `None` / `&[]` when unknown and the deny-list
/// JSON pipeline + generic email scrub still apply.
#[tracing::instrument(skip(app_data_dir, device_id, home, peer_device_ids), err)]
pub fn collect_bug_report_metadata_inner(
    app_data_dir: &Path,
    device_id: String,
    home: Option<&str>,
    peer_device_ids: &[String],
) -> Result<BugReport, AppError> {
    let log_dir = log_dir_for_app_data(app_data_dir);
    let raw_recent_errors = recent_errors_from_log_dir(&log_dir);

    // #609: same redaction pipeline as `read_logs_for_report_inner` —
    // build the Aho-Corasick matcher once, then redact line-by-line
    // exactly like `redact_log` does for the ZIP bundle.
    let ctx = RedactionContext {
        home,
        device_id: Some(device_id.as_str()),
        peer_device_ids,
    };
    let redactor = Redactor::new(&ctx);
    let recent_errors = raw_recent_errors
        .iter()
        // `recent_errors_from_log_dir` reads only `agaric.log`(`.YYYY-MM-DD`),
        // never an OTel signal file, so the format is `TracingLog` by
        // provenance — same as the ZIP bundle's `agaric.log` block.
        .map(|line| redact_line_with_redactor(line, &redactor, LineFormat::TracingLog))
        .collect();

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
///
/// #609: redaction inputs (home dir, peer device ids) are
/// resolved here — same sources as [`read_logs_for_report`] — so the
/// recent-error tail embedded in the prefilled public GitHub issue body
/// goes through the same redaction pipeline as the ZIP export.
#[tauri::command]
#[specta::specta]
pub async fn collect_bug_report_metadata(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::db::ReadPool>,
    device_id: tauri::State<'_, agaric_sync::device::DeviceId>,
) -> Result<BugReport, AppError> {
    // #3334 — the `app_paths` seam, so a bug report describes the vault this
    // process actually opened rather than the one it would have opened by default.
    let data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    let home = home_dir_string();
    let peer_device_ids = fetch_redaction_extras(&pool.inner().0).await;
    collect_bug_report_metadata_inner(
        &data_dir,
        device_id.as_str().to_string(),
        home.as_deref(),
        &peer_device_ids,
    )
    .map_err(super::sanitize_internal_error)
}

// ---------------------------------------------------------------------------
// Log bundle assembly
// ---------------------------------------------------------------------------

/// Decide whether a log filename should be included in the report bundle.
///
/// Accepts `agaric.log` (today) and `agaric.log.YYYY-MM-DD` files no older
/// than [`MAX_ROLLED_AGE_DAYS`] days. Rejects anything else.
///
/// The plain `agaric.log` arm is a defensive/legacy allowance, not a
/// description of what the production appender writes: the live appender
/// never emits an undated `agaric.log` (see the `recent_errors_from_log_dir`
/// comment for the full explanation). This arm only exists to tolerate a
/// future rotation-policy change and the hand-written test fixtures that
/// use the bare name.
fn should_include_log_file(name: &str, today: chrono::NaiveDate) -> bool {
    // Defensive/legacy allowance — see the doc comment above and
    // `recent_errors_from_log_dir` for why the live appender never
    // actually produces this name.
    if name == "agaric.log" {
        return true;
    }
    let Some(file_date) = parse_rolled_log_date(name) else {
        return false;
    };
    is_within_log_retention(file_date, today)
}

/// Parse the date out of a rolled log filename (`agaric.log.YYYY-MM-DD`),
/// or `None` for anything else — including the plain `agaric.log`, which
/// carries no date.
///
/// Shared by [`should_include_log_file`] (bundle selection) and
/// [`recent_errors_from_log_dir_at`] (summary selection) so the two cannot
/// drift apart on which filenames count as a log day.
fn parse_rolled_log_date(name: &str) -> Option<chrono::NaiveDate> {
    let rest = name.strip_prefix("agaric.log.")?;
    chrono::NaiveDate::parse_from_str(rest, "%Y-%m-%d").ok()
}

/// Is a log day inside the [`MAX_ROLLED_AGE_DAYS`] retention window ending
/// at `today`? Future-dated files (negative age — clock skew, a restored
/// backup) are outside it.
///
/// The single definition of the window, so the `recent_errors` summary
/// reaches back exactly as far as the bundle that accompanies it and no
/// further (#4216).
fn is_within_log_retention(file_date: chrono::NaiveDate, today: chrono::NaiveDate) -> bool {
    let age = today.signed_duration_since(file_date).num_days();
    (0..=MAX_ROLLED_AGE_DAYS).contains(&age)
}

// ---------------------------------------------------------------------------
// #4283 — containment: what the report is allowed to read
// ---------------------------------------------------------------------------

/// `true` iff `path` names a **regular file** without resolving a symlink at
/// its final component (#4283).
///
/// `Path::is_file` — what every enumeration site here used to call — follows
/// symlinks, so it answers "is the thing this name eventually resolves to a
/// regular file", which is the wrong question when the name lives in a
/// directory an attacker may be able to write to. `symlink_metadata` is
/// `lstat`: a symlink reports `FileType::is_symlink()`, so `is_file()` is
/// `false` for it whatever it points at.
///
/// This is a **filter**, not the gate. Nothing here is safe against a swap
/// between the check and the open — [`open_confined_log_file`] is what
/// actually confines the read, and it does so on the open handle rather than
/// on the path. This exists so a link is dropped from the candidate set
/// *before* it can influence anything the candidate set feeds (the mtime
/// ranking in [`plain_log_outranks_dated`], the bundle's `skipped N older
/// logs` accounting), not so the later open can trust it.
fn is_regular_file_no_follow(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file())
}

/// Windows' `FILE_FLAG_OPEN_REPARSE_POINT` — open the reparse point itself
/// rather than resolving it. The nearest thing Windows has to `O_NOFOLLOW`.
///
/// Hand-written where the unix flags deliberately are not (see the `libc`
/// entry in `Cargo.toml`), because the two cases are not alike: `O_NOFOLLOW`
/// has a different numeric value on every unix, so a literal is right on one
/// target and silently wrong on the next, while the Win32
/// `FILE_FLAG_*`/`FILE_ATTRIBUTE_*` values are one fixed ABI shared by every
/// Windows target. Both match `windows-sys`' definitions
/// (`FILE_FLAG_OPEN_REPARSE_POINT = 2097152`,
/// `FILE_ATTRIBUTE_REPARSE_POINT = 1024`).
#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;

/// Windows' `FILE_ATTRIBUTE_REPARSE_POINT`. See the constant above for why
/// this one is a literal and the unix flags are not.
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

// The no-follow open below is spelled with per-platform `custom_flags` and has
// no portable fallback. On a target that is neither `unix` nor `windows` BOTH
// `#[cfg]` arms in `open_confined_log_file` vanish, `options` carries nothing
// but `read(true)`, and the function degrades to an ordinary `File::open` that
// FOLLOWS symlinks with only the `fstat` behind it — a silent loss of the
// #4283 property, not a compile failure. Made a build break here instead, which
// is the same fail-loudly rule the rest of this section is built on. Every
// target this app ships is one or the other (Android is `cfg(unix)`), so this
// is latent today; porting to a third one means supplying its no-follow open,
// not deleting this. The predicate is the exact complement of the two arms
// below — keep the three in step if either arm's `cfg` ever changes.
#[cfg(not(any(unix, windows)))]
compile_error!(
    "bug_report's log confinement (#4283) has no no-follow open for this \
     target: `open_confined_log_file` would silently follow symlinks into \
     files the bug report then publishes. Add a `custom_flags` arm for this \
     platform (and widen the `cfg` above) before enabling the target."
);

/// Open `path` for reading with symlink resolution of the final component
/// **disabled**, then prove from the open handle that what was opened is a
/// regular file (#4283).
///
/// # What this confines, and why it is the whole of the confinement
///
/// There are exactly two caller shapes, and what each one gets out of this
/// function is NOT the same guarantee. Spelled out because the sentence a
/// later reader lifts the invariant from is this one:
///
/// 1. `log_dir.join(<single component>)` — the `agaric.log[.YYYY-MM-DD]`
///    readers (`recent_errors_from_log_dir_at`, `read_logs_for_report_inner`).
///    The component is either a name that came out of `read_dir(log_dir)` (a
///    directory entry name can contain neither `/` nor a `..` traversal) or the
///    literal `"agaric.log"`. For these, "the final component does not resolve
///    through a symlink" and "the bytes read came from a regular file sitting
///    directly inside `log_dir`" are the same statement, and no path arithmetic
///    is needed to reach it.
///
/// 2. `log_dir.join(<subdir>).join(<single component>)` — the OTel reader in
///    `read_logs_for_report_inner`, where `<subdir>` is one of the fixed
///    `OTEL_SUBDIRS` literals and the component came out of
///    `read_dir(log_dir/<subdir>)`. For these the guarantee is one directory
///    weaker: the bytes came from a regular file sitting directly inside *the
///    directory that was enumerated*, which is not by itself a statement about
///    `log_dir`. That the enumerated directory IS `log_dir/<subdir>` is a
///    separate guarantee and it is not this function's — it comes from the
///    `lstat` on `<subdir>` at the enumeration site, which is a check-then-read
///    pair rather than a property of the open, and is a mitigated residual
///    rather than a closed hole (#4487).
///
/// So a new caller of shape 2 needs its own directory guard: nothing in here
/// supplies one, and shape 1's "directly inside the log dir" conclusion is
/// available only because that path has a single component.
///
/// That is deliberate. The alternative the issue floats — canonicalise the
/// candidate and require it to be prefixed by the log dir — has a trap:
/// compared against the *un*-canonicalised log dir it rejects every file in a
/// legitimately symlinked log directory (a log dir moved onto another volume),
/// which is exactly the "refusing links loses the logs the report is for"
/// outcome #4283 declines to accept. Confining the final component sidesteps
/// the comparison entirely: a symlinked `log_dir` is resolved on the way in
/// and keeps working, while a symlink *inside* it does not.
///
/// # Why it is not racy
///
/// The check is not "`is_symlink()`, then open" — that is a TOCTOU pair, and
/// the attacker who can plant the link is by construction the attacker who can
/// swap it between the two syscalls. Here:
///
/// * `O_NOFOLLOW` is a property of the `open(2)` call itself. The kernel fails
///   the open with `ELOOP` if the final component is a symlink at the instant
///   it is resolved. There is no window between deciding and acting, because
///   the decision *is* the action.
/// * The regular-file proof is `fstat` on the returned descriptor
///   (`File::metadata`), not `stat` on the path. It describes the exact inode
///   the subsequent reads will come from — a swap after the open cannot
///   retarget an already-open descriptor.
/// * `read_capped_file` then sizes, seeks and reads that same descriptor, so
///   the size the cap is computed from and the bytes returned are the same
///   file too (the old code `stat`ed the path and then re-opened it).
/// * `O_NONBLOCK` is there because opening first and classifying second means
///   a FIFO planted under a log name would otherwise block the open until a
///   writer appeared. With it the open returns immediately and the `fstat`
///   below rejects it.
///
/// The no-follow half of that is per-platform (`O_NOFOLLOW` on unix,
/// `FILE_FLAG_OPEN_REPARSE_POINT` on Windows) and there is no portable
/// fallback, so the `compile_error!` above refuses to build a target that has
/// neither arm rather than letting the open quietly become a following one.
///
/// # Positive classification
///
/// The accepted set is stated, not the refused one: a regular file, opened
/// without traversing a link, directly inside the log directory, under a name
/// the caller already matched against `agaric.log[.YYYY-MM-DD]`. Directories,
/// symlinks, FIFOs, sockets, devices and anything else a filesystem can hold
/// are refused by not being in that set rather than by being enumerated — the
/// enumerated form fails open on whatever nobody thought of, which is how this
/// class of bug survives.
///
/// # Residual, stated plainly
///
/// A **hard link** planted in the log directory under a valid log name still
/// reads its target: a hard link is not a link at the filesystem level, it is
/// a second name for the same inode, so neither `O_NOFOLLOW` nor `fstat` nor
/// canonicalisation can distinguish it from the original file. Refusing
/// `st_nlink > 1` would catch it and is deliberately not done — hard-linking
/// backup tools (rsnapshot and friends) legitimately raise the link count of
/// files they have snapshotted, so that rule would drop real logs on real
/// machines, which is the harm #4283 weighs the fix against. The attacker it
/// would stop must already be able to create a file inside the app's own data
/// directory *and* on the same filesystem as the target.
fn open_confined_log_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;

    // `fstat` on the descriptor, not `stat` on the name.
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing to read a log entry that is not a regular file (#4283)",
        ));
    }
    // Windows resolves the open to the reparse point itself under the flag
    // above, and the `is_file()` test just made is NOT sufficient for it.
    //
    // `std`'s Windows `FileType` calls a reparse point a symlink only when its
    // tag carries the name-surrogate bit (`sys::fs::windows::FileType::new`).
    // Symlinks and junctions do; every other reparse tag — dedup, cloud-files
    // placeholders, WCIFS, `AppExecLink` — does not, so `is_file()` answers
    // `true` for those and the handle would be read as an ordinary log. The
    // attribute bit is the question that has no such gap, and asking it is the
    // same positive classification the rest of this function uses: an
    // ordinary regular file, not "a file that is not one of the reparse kinds
    // we thought of".
    //
    // The cost, since it is a real one: on a volume where a genuine
    // `agaric.log` is itself a reparse point (Data Deduplication, a
    // Files-On-Demand placeholder) this refuses a legitimate log and the
    // report goes blind on that machine. Judged the right way round — the app
    // writes its logs under its own data dir, which is not a synced or
    // deduplicated location on a default install, and the failure is a missing
    // log rather than a published secret.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "refusing to read a log entry that is a reparse point (#4283)",
            ));
        }
    }
    Ok(file)
}

/// Read a log file, capping the byte count at [`MAX_FILE_BYTES`]. If the file
/// exceeds the cap, the tail is returned with a leading truncation marker so
/// the last (most-recent) lines are preserved.
///
/// #4283 — the open goes through [`open_confined_log_file`], so this is also
/// the single choke point at which "may the report read these bytes?" is
/// answered. Every byte that reaches either the ZIP bundle or the
/// `recent_errors` summary published into a public GitHub issue comes through
/// here, and all of the size/seek/read work below is done on that one
/// descriptor.
fn read_capped_file(path: &Path) -> std::io::Result<String> {
    let mut file = open_confined_log_file(path)?;
    let total = file.metadata()?.len();
    if total <= MAX_FILE_BYTES {
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        return Ok(contents);
    }

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

/// Return the most-recently-modified regular file in an OTel signal subdir
/// (`subdir`), or `None` when the dir is absent, empty, unreadable, or holds
/// no regular files.
///
/// The OTel sinks ([`agaric_observability::exporter`] /
/// [`agaric_observability::metrics_exporter`]) use a daily-rotated
/// [`tracing_appender::rolling`] appender exactly like `agaric.log`: the live
/// file carries the bare prefix (`agaric-traces.log`) while rolled-over days
/// gain a `.YYYY-MM-DD` suffix. Newest mtime therefore selects the live tail —
/// the most diagnostically valuable file and the one most likely to overlap
/// the `agaric.log` window the user is reporting against. Rather than re-derive
/// the rotation naming here, we sort by mtime so the helper is agnostic to the
/// per-signal filename prefix.
///
/// **Never errors** — observability is off by default, so a missing subdir is
/// the common case and must read as "nothing to add" rather than a failure
/// that would abort the whole report. Every fallible step (`read_dir`, per-
/// entry `metadata`/`modified`) degrades to "skip this candidate"; an I/O
/// failure reading the dir collapses to `None`. The caller
/// ([`read_logs_for_report_inner`]) then `read_capped_file`s the winner through
/// the SAME cap + redaction pipeline as `agaric.log`.
fn newest_otel_file(subdir: &Path) -> Option<PathBuf> {
    // `read_dir` fails (and we bail to `None`) when the subdir is absent or
    // unreadable — the off-by-default "tracing never enabled" common case.
    let dir = fs::read_dir(subdir).ok()?;
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in dir.flatten() {
        let path = entry.path();
        // `entry.metadata()` does NOT follow symlinks (cf. `Path::is_file`);
        // a symlink/dir/socket is therefore excluded here just as the
        // `agaric.log` enumeration excludes non-regular entries.
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        // A platform without mtime support (or a racing unlink) drops the
        // candidate rather than the whole dir — partial coverage beats none.
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        if newest.as_ref().is_none_or(|(best, _)| modified > *best) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

/// Bundle of optional redaction inputs threaded through
/// [`redact_line`] and [`redact_log`]. Grew organically as H-9a added
/// peer-device scrubs; gluing the parameters into a single context kept
/// the call sites from sprouting another argument every time the
/// redaction allow-list expanded.
///
/// Every field is "absent → noop" by construction:
/// `home`/`device_id = None` skip the corresponding `String::replace`,
/// and an empty `peer_device_ids` slice yields zero loop iterations.
/// Callers that don't yet know one of the inputs (e.g. early boot before
/// the SQLite pool is online) can pass [`RedactionContext::default()`]
/// and rely on the catch-all email regex and the line-length cap as a
/// final safety net.
#[derive(Debug, Default, Clone, Copy)]
struct RedactionContext<'a> {
    home: Option<&'a str>,
    device_id: Option<&'a str>,
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

/// Pre-built single-pass matcher for the static-needle portion of
/// [`apply_allow_list`]. Hoisting the [`AhoCorasick`] construction out of
/// the per-line path turns the legacy O(N × L × K) cascade of
/// `String::replace` calls (one full-buffer scan + allocation per needle
/// per line) into a single linear scan per line, where K = home +
/// device_id + len(peer_device_ids).
///
/// The matcher uses [`MatchKind::LeftmostLongest`] so that when one needle
/// is a substring of another (e.g. overlapping peer IDs) the longest one
/// wins — matching the user-intuitive "scrub the most-specific identifier"
/// semantics. For the typical input shapes (a home path, a device ID, an
/// email, and peer IDs of equal length) no needles overlap and the output
/// is byte-identical to the legacy cascade.
///
/// `replacements[i]` is the marker for `needles[i]`. Both vectors share
/// the same index space and are built from a single pass over the
/// [`RedactionContext`].
struct Redactor {
    matcher: Option<AhoCorasick>,
    replacements: Vec<&'static str>,
}

impl Redactor {
    /// Build a [`Redactor`] from `ctx`. Empty needles (or a context with
    /// no needles at all) yield a `None` matcher — callers must handle
    /// the noop branch so the email-regex pass still runs.
    fn new(ctx: &RedactionContext<'_>) -> Self {
        // Capacity: home + device_id + every peer. Empty strings are
        // filtered out before being added so `unwrap` on the builder
        // result below cannot panic on empty-needle input.
        let mut needles: Vec<&str> = Vec::with_capacity(2 + ctx.peer_device_ids.len());
        let mut replacements: Vec<&'static str> = Vec::with_capacity(2 + ctx.peer_device_ids.len());
        if let Some(home) = ctx.home
            && !home.is_empty()
        {
            needles.push(home);
            replacements.push("~");
        }
        if let Some(id) = ctx.device_id
            && !id.is_empty()
        {
            needles.push(id);
            replacements.push("[REDACTED_DEVICE_ID]");
        }
        // H-9a (2): every known peer device ID — the local `device_id` is
        // already covered above, but cross-device sync logs reference peer IDs
        // verbatim and must be scrubbed independently.
        for peer in ctx.peer_device_ids {
            if !peer.is_empty() {
                needles.push(peer.as_str());
                replacements.push("[REDACTED:PEER_DEVICE_ID]");
            }
        }
        let matcher = if needles.is_empty() {
            None
        } else {
            // `LeftmostLongest` ensures overlapping needles favour the
            // most-specific (longest) match — the secure default.
            // Builder failure is only possible on internal-state limits
            // (NFA size); for our small needle set it cannot fail.
            Some(
                AhoCorasick::builder()
                    .match_kind(MatchKind::LeftmostLongest)
                    .build(&needles)
                    .expect("Redactor needles are small and well-formed"),
            )
        };
        Self {
            matcher,
            replacements,
        }
    }
}

/// H-9a fallback: legacy allow-list scrubs for non-JSON lines.
///
/// Replaces specific known-bad values (`$HOME`, `device_id`,
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
///
/// Takes a pre-built [`Redactor`] so the [`AhoCorasick`] matcher is
/// constructed once per `redact_log` call rather than once per line.
fn apply_allow_list(line: &str, redactor: &Redactor) -> String {
    // H-9a (1)/(2): single-pass static-needle scrub via Aho-Corasick.
    let after_static = if let Some(matcher) = &redactor.matcher {
        let mut dst = String::with_capacity(line.len());
        matcher.replace_all_with(line, &mut dst, |mat, _matched, dst| {
            // `pattern().as_usize()` is the index into our parallel
            // `replacements` vector — same order as construction.
            dst.push_str(redactor.replacements[mat.pattern().as_usize()]);
            true
        });
        dst
    } else {
        line.to_string()
    };
    // H-9a (3): generic email catch-all. Runs LAST so any earlier
    // static-needle markers are preserved verbatim (a marker does not
    // match the email shape, so it is not re-rewritten by this pass).
    if EMAIL_REGEX.is_match(&after_static) {
        EMAIL_REGEX
            .replace_all(&after_static, "[EMAIL]")
            .into_owned()
    } else {
        after_static
    }
}

/// Apply the per-line length cap from [`MAX_LINE_BYTES`] with UTF-8
/// safety. Returns the input unchanged when its byte length is at or
/// below the cap — no allocation in the common case.
///
/// Delegates to [`agaric_core::text_utils::truncate_at_char_boundary`].
/// The marker wording (`…[truncated N chars]`) is owned here and must
/// stay byte-for-byte identical — the bundled bug-report fixtures and
/// the `redact_line_preserves_utf8_on_truncation` test assert on it.
fn cap_line_length(out: String) -> String {
    agaric_core::text_utils::truncate_at_char_boundary(out, MAX_LINE_BYTES, |extra| {
        format!("…[truncated {extra} chars]")
    })
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
/// Public signature unchanged from H-9a: in-file unit tests keep
/// working without edit by going through the convenience wrapper.
///
/// Builds a [`Redactor`] per call. The production hot path
/// ([`redact_log`]) uses [`redact_line_with_redactor`] directly to
/// amortise the matcher-build cost across all lines in a file.
#[cfg(test)]
fn redact_line(line: &str, ctx: &RedactionContext<'_>) -> String {
    let redactor = Redactor::new(ctx);
    redact_line_with_redactor(line, &redactor, LineFormat::TracingLog)
}

/// Which on-disk line format a bundled file is written in — chosen by the
/// file's PROVENANCE at the two [`read_logs_for_report_inner`] call sites,
/// never sniffed from the bytes.
///
/// #3317 — the dispatch used to be a per-line content sniff: "parses as a JSON
/// object" took the deny-by-default [`redact_json_value`] path and EVERYTHING
/// ELSE fell through to [`apply_allow_list`], which passes all text verbatim
/// except four known needles and an email regex. `agaric.log` is JSON, so it
/// took the strong path; the OpenTelemetry signal files are tab-separated
/// `key=value` (see `agaric_observability::exporter`), so they silently took
/// the weak one — a page title that became `[REDACTED]` in `agaric.log` was
/// bundled verbatim from `otel-logs/`. Making the format an explicit input
/// means a file cannot get the wrong (weaker) treatment by looking like
/// something it is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineFormat {
    /// `agaric.log` and its rolled `agaric.log.YYYY-MM-DD` siblings: JSON per
    /// line today, plain `tracing` text in files written before the format
    /// switch. Dispatches JSON → [`redact_json_line`], else the legacy H-9a
    /// [`apply_allow_list`] fallback.
    TracingLog,
    /// The OpenTelemetry signal files under [`OTEL_SUBDIRS`] — `traces/`,
    /// `otel-logs/`, and `metrics/`. One tab-separated `key=value` record per
    /// line; dispatches to the deny-by-default [`redact_kv_line`].
    OtelSignal,
}

/// Per-line redaction against a pre-built [`Redactor`]. Hoisted out
/// of [`redact_line`] so [`redact_log`] can construct the matcher once
/// per log file instead of once per line.
fn redact_line_with_redactor(line: &str, redactor: &Redactor, format: LineFormat) -> String {
    match format {
        LineFormat::TracingLog => {
            if let Some(redacted) = redact_json_line(line) {
                return cap_line_length(redacted);
            }
            cap_line_length(apply_allow_list(line, redactor))
        }
        // The H-9a static-needle + email pass still runs AFTER the deny-list,
        // so the OTel branch keeps every H-9a guarantee on top of its own:
        // a `device_id=<ULID>` value is a "safe token" by shape and would
        // otherwise survive the deny-list, but the needle pass rewrites it.
        // Markers (`[REDACTED]`) match no needle, so this cannot double-rewrite.
        LineFormat::OtelSignal => {
            cap_line_length(apply_allow_list(&redact_kv_line(line), redactor))
        }
    }
}

/// Replacement marker for anything the deny-list does not positively allow.
/// Same spelling as the JSON path so a reader of the bundle sees one marker.
const REDACTED: &str = "[REDACTED]";

/// The exact ORDERED key sequences the OTel line FORMATS themselves write —
/// the fixed leading skeleton of a signal record — rather than a key an
/// instrumentation site chose.
///
/// Sources (all in `agaric-observability`): `exporter::format_span`
/// (`end name trace span parent dur_ms status`), `exporter::format_log_record`
/// (`end level trace span target body`), `ingest::write_frontend_span`
/// (`end service name trace span parent dur_ms status`), and
/// `metrics_exporter`'s sum/histogram writers (`end metric sum` /
/// `end metric count sum min max` — mutually exclusive per data point, so
/// two sequences, not one). Adding a new field to a line format requires a
/// deliberate edit HERE, which is the review point: everything not listed is
/// treated as an instrumentation-site attribute and is deny-by-default.
///
/// A skeleton key gets ONE extra, narrowly-shaped allowance beyond
/// [`is_safe_token`] (see [`skeleton_value_is_allowed`]) because these values
/// are structural — a dotted span name or a fractional `dur_ms` is not a
/// "safe token" by shape, and redacting them would leave a bundle of
/// `[REDACTED]` skeletons with no diagnostic value at all.
///
/// This must be the EXACT ordered sequence per format, not the flattened
/// union of every format's keys: `name` is written by `format_span` and
/// `write_frontend_span` but not by `format_log_record`, so a
/// `format_log_record` line's 7th field happening to be named `name` is an
/// instrumentation-site attribute, not the format's own `name`.
/// [`redact_kv_line`] walks this table position-by-position so that
/// collision cannot borrow the allowance (#3712).
const SKELETON_SEQUENCES: &[&[&str]] = &[
    &["end", "name", "trace", "span", "parent", "dur_ms", "status"],
    &["end", "level", "trace", "span", "target", "body"],
    &[
        "end", "service", "name", "trace", "span", "parent", "dur_ms", "status",
    ],
    &["end", "metric", "sum"],
    &["end", "metric", "count", "sum", "min", "max"],
];

/// `true` for the `-` every OTel format writes for an absent field.
fn is_absent_marker(value: &str) -> bool {
    value == "-"
}

/// `true` for a decimal / non-finite number — `dur_ms`, histogram `sum`,
/// `min`, `max`. Integers already pass [`is_safe_token`]; this adds the
/// fractional and IEEE special forms the `{:.3}` / `Display` writers emit.
fn is_numeric_value(value: &str) -> bool {
    matches!(value, "NaN" | "inf" | "-inf")
        || value
            .strip_prefix('-')
            .unwrap_or(value)
            .split_once('.')
            .is_some_and(|(int, frac)| {
                !int.is_empty()
                    && !frac.is_empty()
                    && int.bytes().all(|b| b.is_ascii_digit())
                    && frac.bytes().all(|b| b.is_ascii_digit())
            })
}

/// `true` for a compile-time label: a span/metric/service name or a tracing
/// target. Identifier-shaped with `.`/`:`/`-` separators and no whitespace,
/// so `materializer.run_foreground`, `agaric.ipc.duration`, and
/// `agaric-frontend` round-trip while any prose — a page title, a path, a
/// query — does not. Bounded so a long value cannot ride through on shape.
fn is_signal_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_')
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
}

/// The per-key allowance for a value in the skeleton prefix of an OTel line.
///
/// Deliberately narrow and per-key: each arm encodes the shape the format
/// writer can actually produce. `status` accepts only the closed set of status
/// tags — an `Error { description: … }` carries the error's text and is
/// redacted like any other free value. `body` (the bridged log message) gets
/// exactly the [`STABLE_MESSAGES`] exception the JSON path gives `message`.
fn skeleton_value_is_allowed(key: &str, value: &str) -> bool {
    if is_absent_marker(value) {
        return true;
    }
    match key {
        "dur_ms" | "sum" | "count" | "min" | "max" => is_numeric_value(value),
        "name" | "service" | "metric" | "target" | "level" => is_signal_label(value),
        "status" => matches!(value, "Unset" | "Ok" | "ok" | "error" | "Error"),
        "body" => STABLE_MESSAGES.contains(&value),
        // `end` / `trace` / `span` / `parent` carry a timestamp or a hex id,
        // both of which `is_safe_token` already covers; they need no widening
        // beyond the `-` marker handled above.
        _ => false,
    }
}

/// `true` if `key` is shaped like a field name our code (or the frontend
/// tracer) would emit. Keys are echoed verbatim — the schema of a record is
/// the skeleton a reader follows — but the attribute keys on an ingested
/// frontend span arrive over IPC, so an unbounded free-text "key" is possible
/// in a way it is not for the compiled-in log schema. Anything not shaped like
/// an identifier is redacted rather than echoed.
fn is_structural_key(key: &str) -> bool {
    is_signal_label(key)
}

/// Deny-by-default redaction for one tab-separated `key=value` OTel record.
///
/// Mirrors the JSON path's contract — KEYS are preserved, every VALUE must
/// earn its way out — with the two shape allowances the line formats need:
/// [`is_safe_token`] for any value, plus [`skeleton_value_is_allowed`] for the
/// format-owned leading fields.
///
/// The skeleton allowance is POSITIONAL, bound to one of the EXACT ordered
/// sequences in [`SKELETON_SEQUENCES`] — not merely to the flattened union of
/// their keys. A key extends the skeleton only while at least one candidate
/// sequence still expects exactly that key at exactly this position; once no
/// sequence does, every later segment (including one whose key happens to
/// collide with a DIFFERENT format's skeleton key, e.g. a `format_log_record`
/// line's 7th field named `name`) is an instrumentation-site attribute and
/// gets the plain deny-by-default test.
///
/// A segment with no `=` is not a key/value pair at all; it is treated
/// wholesale as a value (deny-by-default) rather than echoed. The one
/// exception is the whole-line truncation marker (see
/// [`is_truncation_marker_line`]), which is not a `key=value` record at all.
fn redact_kv_line(line: &str) -> String {
    if is_truncation_marker_line(line) {
        return line.to_owned();
    }

    let mut out = String::with_capacity(line.len());
    // Indices into `SKELETON_SEQUENCES` still consistent with every key seen
    // so far, at the position it was seen.
    let mut candidates: Vec<usize> = (0..SKELETON_SEQUENCES.len()).collect();
    let mut position = 0_usize;

    for (i, segment) in line.split('\t').enumerate() {
        if i > 0 {
            out.push('\t');
        }
        let Some((key, value)) = segment.split_once('=') else {
            candidates.clear();
            out.push_str(if is_safe_token(segment) {
                segment
            } else {
                REDACTED
            });
            continue;
        };

        let skeleton = candidates
            .iter()
            .any(|&c| SKELETON_SEQUENCES[c].get(position) == Some(&key));
        if skeleton {
            candidates.retain(|&c| SKELETON_SEQUENCES[c].get(position) == Some(&key));
        } else {
            candidates.clear();
        }
        position += 1;

        out.push_str(if is_structural_key(key) {
            key
        } else {
            REDACTED
        });
        out.push('=');
        if is_safe_token(value) || (skeleton && skeleton_value_is_allowed(key, value)) {
            out.push_str(value);
        } else {
            out.push_str(REDACTED);
        }
    }
    out
}

/// `true` for the whole-line truncation marker [`read_capped_file`] prepends
/// to an oversized file's tail (`…[truncated N bytes of older content]`).
///
/// It carries no `=`, so on the `OtelSignal` branch [`redact_kv_line`] would
/// otherwise deny-by-default it to `[REDACTED]` — the marker exists to tell
/// the reader content was DROPPED, and collapsing it erases that notice
/// (#3712). This only brings `OtelSignal` to the `TracingLog` branch's
/// behaviour, which already round-trips this exact line unchanged (a
/// non-JSON, non-needle-matching line falls through [`apply_allow_list`]
/// as-is).
///
/// The middle must be ALL ASCII DIGITS and non-empty, not merely "whatever
/// sits between the two literals". An exemption from a deny-by-default
/// redactor is a hole the width of whatever it lets through, and
/// `starts_with(prefix) && ends_with(suffix)` lets through everything in
/// between — a forged line reading `…[truncated <a page title> bytes of
/// older content]` would be echoed verbatim. Reaching that needs a `\n` in
/// a span attribute (`exporter::format_span` does not `sanitize_inline` its
/// name or attribute values, unlike `format_log_record`), so it is not
/// reachable today, but the redactor is the layer that is supposed to hold
/// when the layer above it does not. Constrained to digits, the whole line
/// is a compile-time literal plus a byte count derived from the file's own
/// size, and carries no user data by construction.
fn is_truncation_marker_line(line: &str) -> bool {
    const PREFIX: &str = "…[truncated ";
    const SUFFIX: &str = " bytes of older content]";
    line.strip_prefix(PREFIX)
        .and_then(|rest| rest.strip_suffix(SUFFIX))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Apply line-by-line redaction to an entire log file's contents.
///
/// H-9b: each line is dispatched independently — a bundle can mix JSON
/// (today's log, after the format switch) and text (older rolled files)
/// without confusing the pipeline.
///
/// `format` is the file's declared provenance (see [`LineFormat`]), not a
/// guess: the caller knows whether it read `agaric.log` or an OTel signal
/// file, and a file never silently gets the other format's treatment.
///
/// Builds the [`Redactor`] once before the loop so the Aho-Corasick
/// matcher (covering home / device_id / peer IDs) is shared
/// across every line in the file.
fn redact_log(contents: &str, ctx: &RedactionContext<'_>, format: LineFormat) -> String {
    let redactor = Redactor::new(ctx);
    let mut out = String::with_capacity(contents.len());
    for line in contents.split_inclusive('\n') {
        // `split_inclusive` preserves the trailing `\n`; strip it before
        // redacting so our length cap is measured on content, not the newline.
        let (body, newline) = match line.strip_suffix('\n') {
            Some(body) => (body, "\n"),
            None => (line, ""),
        };
        out.push_str(&redact_line_with_redactor(body, &redactor, format));
        out.push_str(newline);
    }
    out
}

/// Resolve the user's home directory as a string, if known. Used for path
/// redaction. Returns `None` when no home directory can be determined —
/// callers must treat the absence as "no home replacement" rather than
/// fabricating a path.
///
/// Uses `dirs::home_dir()` so that the platform-canonical source is
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
/// H-9a — `peer_device_ids` extends the redaction allow-list with a PII
/// vector that crosses the trust boundary when a bug-report ZIP is
/// uploaded to a public GitHub issue. It is only consulted when
/// `redact == true`; pass `&[]` if the value is unknown (e.g. the user
/// has no paired peers) and the scrub gracefully degrades to a noop.
#[tracing::instrument(skip(log_dir, home, device_id, peer_device_ids), err)]
#[expect(clippy::too_many_lines, reason = "#4639: split before growing")]
pub fn read_logs_for_report_inner(
    log_dir: &Path,
    redact: bool,
    home: Option<&str>,
    device_id: Option<&str>,
    peer_device_ids: &[String],
) -> Result<Vec<LogFileEntry>, AppError> {
    if !log_dir.is_dir() {
        return Ok(Vec::new());
    }

    let today = chrono::Utc::now().date_naive();
    let mut entries: Vec<(PathBuf, String)> = Vec::new();

    // Per-file silent-drop sites are now traced at warn level so a
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
                "skipping log file with invalid UTF-8 in name",
            );
            continue;
        };
        if !should_include_log_file(name, today) {
            // Out-of-window or unrecognised filename — common, not noteworthy.
            continue;
        }
        // #4283 — `entry.metadata()` is `lstat` (`Path::is_file` follows), so a
        // symlink planted under a valid log name is classified as a symlink
        // rather than as its target. The bundle is uploaded by hand rather than
        // pasted into an issue body, but it is uploaded to the same public
        // issue, so it gets the same rule — and `read_capped_file`'s
        // `O_NOFOLLOW` open backstops this one for both paths.
        if !entry.metadata().is_ok_and(|meta| meta.is_file()) {
            tracing::warn!(
                name = %name,
                "skipping log entry — not a regular file (symlink/dir/socket?)",
            );
            continue;
        }
        let path = entry.path();
        let contents = match read_capped_file(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    name = %name,
                    error = %e,
                    "skipping log file — read_capped_file failed (permission denied or io error?)",
                );
                continue;
            }
        };
        entries.push((path, contents));
    }

    // Sort newest-first so the bundle-size cap walk in
    // [`apply_bundle_cap`] drops the OLDEST files when the running total
    // exceeds [`MAX_BUNDLE_BYTES`]. `agaric.log` (today, no date suffix)
    // is treated as unconditionally newest here, but that name is never
    // actually produced by the production appender — see
    // `recent_errors_from_log_dir` for why the live "today" file is always
    // `agaric.log.YYYY-MM-DD`. This arm is a defensive/legacy allowance for
    // hand-written test fixtures and a possible future rotation-policy
    // change, not a description of production sort order. Rolled
    // `agaric.log.YYYY-MM-DD` files sort by descending date (newer date
    // before older). This also matches the existing comment's "today
    // first, then reverse-chrono" intent — the previous plain alphabetic
    // sort accidentally produced chronological-ascending order on the
    // dated suffixes (oldest dated first).
    entries.sort_by(|a, b| {
        let an = a.0.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let bn = b.0.file_name().and_then(|s| s.to_str()).unwrap_or("");
        // Defensive/legacy allowance, not production behavior — see the
        // comment above and `recent_errors_from_log_dir`.
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
            // Bundle the optional inputs into a
            // single RedactionContext so future allow-list extensions
            // don't grow the parameter list of every redaction helper.
            let ctx = RedactionContext {
                home,
                device_id,
                peer_device_ids,
            };
            redact_log(&contents, &ctx, LineFormat::TracingLog)
        } else {
            contents
        };
        out.push(LogFileEntry {
            name,
            contents: final_contents,
        });
    }

    // #2110 (M7) — fold the live OpenTelemetry signal files into the bundle.
    // Each of `traces/`, `otel-logs/`, `metrics/` is a daily-rotated sink
    // mirroring `agaric.log`; we take the newest (live tail) file from each
    // and run it through the SAME `read_capped_file` + `redact_log` pipeline.
    //
    // #3317 — these lines are NOT PII-safe by construction, and this comment
    // used to claim they were. They are tab-separated `key=value` records whose
    // attribute values are whatever the instrumentation site attached: the
    // import span really did carry the user's page title, and every `tracing`
    // event bridged into `otel-logs/` carries its fields verbatim. Because the
    // old dispatch keyed on "is this line JSON?", they took the weak allow-list
    // branch and were bundled unredacted. They now declare their format
    // (`LineFormat::OtelSignal`) and take the deny-by-default `key=value` path,
    // which is where the guarantee this comment asserts actually comes from.
    //
    // Ordering: these entries are appended AFTER the `agaric.log` block so the
    // newest-first [`apply_bundle_cap`] walk prioritises `agaric.log` — if the
    // 10 MiB cap trims anything, the OTel files (the supplementary signal) are
    // dropped before the primary log tail. Observability is off by default, so
    // a missing/empty subdir is the common case and [`newest_otel_file`] skips
    // it without error.
    for subdir in OTEL_SUBDIRS {
        let dir = log_dir.join(subdir);
        // #4283 — the same escape one level up. `newest_otel_file` already
        // refuses a symlinked *file*, and `read_capped_file` refuses to follow
        // one, but neither says anything about the DIRECTORY: `read_dir` on a
        // symlinked `traces/` enumerates whatever it points at, and the file
        // this then opens is a real regular file with a real name inside that
        // other directory — so the newest file in, say, `~/.ssh` would be read
        // and bundled with no link ever appearing in the path that is opened.
        // The subdirs are created by this app under its own log dir, so
        // requiring a real directory here costs nothing that exists.
        //
        // Stated plainly, because it is the one guard here that is NOT the
        // race-free shape `open_confined_log_file` has: this is an `lstat` on
        // a PATH gating a later `read_dir` on the same PATH, so an attacker
        // who can swap `<log_dir>/traces` for a symlink between the two wins,
        // and the per-file `O_NOFOLLOW` does not backstop it (the file the
        // walk then opens is a real regular file with a real name — that is
        // the whole shape of this escape). Closing the window needs
        // `openat`-relative I/O, which this crate cannot spell: it denies
        // `unsafe_code` and neither `std` nor any current dependency exposes a
        // safe `openat`. The residual is bounded by the same precondition as
        // the hard-link one — write access to the app's own log directory —
        // and unlike the pre-fix behaviour it costs the attacker a race
        // instead of nothing.
        if !fs::symlink_metadata(&dir).is_ok_and(|meta| meta.is_dir()) {
            continue;
        }
        let Some(path) = newest_otel_file(&dir) else {
            // Absent/empty/unreadable subdir (tracing never enabled, or no
            // regular files yet) — not noteworthy, skip silently.
            continue;
        };
        let contents = match read_capped_file(&path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!(
                    subdir = %subdir,
                    error = %e,
                    "skipping otel signal file — read_capped_file failed (permission denied or io error?)",
                );
                continue;
            }
        };
        let final_contents = if redact {
            let ctx = RedactionContext {
                home,
                device_id,
                peer_device_ids,
            };
            redact_log(&contents, &ctx, LineFormat::OtelSignal)
        } else {
            contents
        };
        // Name as `<subdir>/<filename>` so the OTel files are distinguishable
        // from the top-level `agaric.log*` entries in the bundle listing. The
        // filename falls back to the subdir basename only if the OS path has
        // no final component (it always does here — `newest_otel_file` returns
        // a real file path).
        let file_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(subdir)
            .to_string();
        out.push(LogFileEntry {
            name: format!("{subdir}/{file_name}"),
            contents: final_contents,
        });
    }

    Ok(apply_bundle_cap(out))
}

/// Enforce the cumulative [`MAX_BUNDLE_BYTES`] cap on a list of
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
/// Returns `peer_device_ids`: every `peer_id` from `peer_refs`. The
/// user-prompt referred to the column as `device_id`; the actual schema
/// (see `migrations/0001_initial.sql`) names it `peer_id` (the comment
/// notes "device UUID of remote peer"). The semantics — "every paired
/// peer's stable identifier" — are unchanged. On DB error we fall back to
/// an empty slice (fail-soft: a redaction miss beats a failed bug-report
/// dialog).
async fn fetch_redaction_extras(pool: &SqlitePool) -> Vec<String> {
    match sqlx::query_scalar!("SELECT peer_id FROM peer_refs")
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
    }
}

/// Tauri command: enumerate the log files eligible for inclusion in a
/// bug-report ZIP, applying per-file size caps and optional PII
/// redaction (home path, device id, peer device ids).
/// Delegates to [`read_logs_for_report_inner`].
#[tauri::command]
#[specta::specta]
pub async fn read_logs_for_report(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::db::ReadPool>,
    device_id: tauri::State<'_, agaric_sync::device::DeviceId>,
    redact: bool,
) -> Result<Vec<LogFileEntry>, AppError> {
    // #3334 — the `app_paths` seam, so a bug report describes the vault this
    // process actually opened rather than the one it would have opened by default.
    let data_dir = crate::app_paths::resolve_app_data_dir(&app).map_err(AppError::Io)?;
    let log_dir = log_dir_for_app_data(&data_dir);
    let home = home_dir_string();
    let peer_device_ids = if redact {
        fetch_redaction_extras(&pool.inner().0).await
    } else {
        Vec::new()
    };
    read_logs_for_report_inner(
        &log_dir,
        redact,
        home.as_deref(),
        Some(device_id.as_str()),
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

    // -- STABLE_MESSAGES drift guard (#700) ------------------------------

    /// #700 drift guard: every [`STABLE_MESSAGES`] entry is meant to pin a
    /// real `tracing::*!("…")` call site so the redaction deny-list keeps
    /// that diagnostic verbatim in a redacted bundle. If a call site's
    /// literal is edited (e.g. "run" → "build") without updating this list,
    /// the whitelist entry silently collapses to `[REDACTED]` in bug
    /// reports — the exact regression #700 documented.
    ///
    /// This test walks every `.rs` file under the crate's `src/` and
    /// asserts each STABLE_MESSAGES literal appears as a quoted string
    /// somewhere OTHER than the STABLE_MESSAGES array itself (i.e. at a
    /// genuine call site). It is a coarse substring check on purpose —
    /// the repo's standard grep-based drift-guard pattern — so it has no
    /// false negatives even though it can't prove the surrounding token is
    /// literally a `tracing::` macro.
    #[test]
    fn stable_messages_pin_real_call_sites() {
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

        // Collect every `.rs` file under a directory tree.
        fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read_dir src").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_rs(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    out.push(path);
                }
            }
        }

        // Scan the app crate's `src/` PLUS every extracted workspace member
        // crate sitting alongside it (`agaric-core`, `agaric-store`, …). The
        // #700 drift guard predates the layered-workspace split (#2621); once
        // modules like `fts` moved into `agaric-store`, their `tracing::*!`
        // call sites — which the app still surfaces through its log capture —
        // left this crate's `src/`. Discover sibling member `src/` dirs by
        // structure (a subdir with both `Cargo.toml` and `src/`) so future
        // extraction waves need no edit here.
        let mut src_roots = vec![manifest_dir.join("src")];
        for entry in std::fs::read_dir(manifest_dir)
            .expect("read_dir manifest")
            .flatten()
        {
            let dir = entry.path();
            if dir.is_dir() && dir.join("Cargo.toml").is_file() && dir.join("src").is_dir() {
                src_roots.push(dir.join("src"));
            }
        }

        let mut files = Vec::new();
        for root in &src_roots {
            collect_rs(root, &mut files);
        }
        assert!(!files.is_empty(), "found no .rs files under {src_roots:?}");

        // Concatenate all source for substring scanning.
        let mut all_src = String::new();
        for f in &files {
            all_src.push_str(&std::fs::read_to_string(f).expect("read source file"));
            all_src.push('\n');
        }

        let mut missing = Vec::new();
        for msg in STABLE_MESSAGES {
            // Each literal appears at least once: in the STABLE_MESSAGES
            // array. A genuine call site means it appears at least TWICE.
            let needle = format!("\"{msg}\"");
            let count = all_src.matches(&needle).count();
            if count < 2 {
                missing.push((*msg, count));
            }
        }

        assert!(
            missing.is_empty(),
            "STABLE_MESSAGES entries with no matching tracing call site \
             (each must appear as a string literal in a `tracing::*!` call \
             besides its STABLE_MESSAGES entry): {missing:?}"
        );
    }

    // -- SKELETON_SEQUENCES drift guard (#3980 note 3) -------------------

    /// #3980 note 3 drift guard: every [`SKELETON_SEQUENCES`] entry must be
    /// the ordered key list of a real OTel line-format writer, and every
    /// writer must have an entry.
    ///
    /// The same failure mode `stable_messages_pin_real_call_sites` pins for
    /// [`STABLE_MESSAGES`], one layer up: the table's doc calls editing it
    /// "the review point", but until now nothing made an edit to a writer
    /// REQUIRE one here. Add a field to `exporter::format_span` and the
    /// positional walk in [`redact_kv_line`] stops matching that sequence at
    /// the new key, so every field from there on — `dur_ms`, `status`, and
    /// the whole attribute tail — loses the skeleton allowance and collapses
    /// to `[REDACTED]` in every bundled trace line. That is fail-SAFE
    /// (over-redaction, never leakage) and therefore silent: the bundle
    /// still ships, just with no diagnostic value.
    ///
    /// The writers are found by scanning `agaric-observability`'s `src/` for
    /// a format literal beginning `"end={end}` on a non-comment line, then
    /// reading the `<key>=` heads of its `\t`-separated segments. Coarse on
    /// purpose, in the repo's grep-based drift-guard style — it cannot prove
    /// the literal is a `write!` format string.
    ///
    /// Two ways a writer drops out of `found` (#3980 round-three note 6), and
    /// both are worth naming because the recognition is what the guard rests
    /// on. It must lead with `end=` — every OTel line format writes the end
    /// timestamp first, since that is the key the sink is ordered on, so a
    /// writer breaking that convention would need an edit here anyway. And it
    /// must stay on ONE source line: this matches per line, so a format
    /// string rustfmt has wrapped is not seen. Neither residual is silent —
    /// a dropped writer fails the set equality below rather than passing —
    /// so both cost a confusing red build, not a missed drift. That is the
    /// opposite polarity from the scan in `commands::observability`, whose
    /// equivalent blind spots let a field through unscanned.
    #[test]
    fn skeleton_sequences_pin_real_line_format_writers() {
        let obs_src = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("agaric-observability")
            .join("src");

        fn collect_rs(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).expect("read_dir").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_rs(&path, out);
                } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
                    out.push(path);
                }
            }
        }

        let mut files = Vec::new();
        collect_rs(&obs_src, &mut files);
        assert!(!files.is_empty(), "found no .rs files under {obs_src:?}");

        // Every line format opens with the end timestamp; the doc-comment
        // sketches of the same shapes spell it `end=<rfc3339-ms>` and start
        // with `//`, so they are excluded twice over.
        const OPENER: &str = "\"end={end}";

        let mut found: Vec<Vec<String>> = Vec::new();
        for path in &files {
            let src = std::fs::read_to_string(path).expect("read source file");
            for line in src.lines() {
                if line.trim_start().starts_with("//") {
                    continue;
                }
                let Some(open_at) = line.find(OPENER) else {
                    continue;
                };
                let body = &line[open_at + 1..];
                let Some(close_at) = body.find('"') else {
                    continue;
                };
                let keys: Vec<String> = body[..close_at]
                    .split("\\t")
                    .filter_map(|seg| seg.split_once('=').map(|(k, _)| k.to_owned()))
                    .collect();
                found.push(keys);
            }
        }

        let mut found_sorted = found.clone();
        found_sorted.sort();
        let mut expected: Vec<Vec<String>> = SKELETON_SEQUENCES
            .iter()
            .map(|seq| seq.iter().map(|k| (*k).to_owned()).collect())
            .collect();
        expected.sort();

        assert_eq!(
            found_sorted, expected,
            "SKELETON_SEQUENCES has drifted from the OTel line-format writers \
             in agaric-observability. Each entry must be the EXACT ordered key \
             sequence one writer emits, and each writer must have an entry — \
             an unlisted or mis-ordered sequence does not lose the bundle, it \
             silently redacts the rest of every line of that shape down to \
             [REDACTED]. Writers found: {found:#?}"
        );
    }

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

    // -- is_error_or_warn_line ------------------------------------

    /// The helper must accept the on-disk format produced by
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

    /// The previous unbounded `line.contains(" ERROR ")` produced
    /// false positives whenever an INFO/DEBUG payload happened to mention
    /// the word " ERROR " in the message body. Bounding the substring
    /// search to the first 40 bytes (where the level always lives) means
    /// such body matches no longer trigger.
    #[test]
    fn is_error_or_warn_line_rejects_body_match() {
        let info_with_error_in_body = "2026-04-28T10:23:45.123456Z  INFO  agaric::module: this contains ERROR somewhere in the message body but level is INFO";
        assert!(
            !is_error_or_warn_line(info_with_error_in_body),
            "INFO line whose body mentions ERROR must NOT be classified as an error/warn line"
        );

        // Also guard against " WARN " appearing in a DEBUG body.
        let debug_with_warn_in_body = "2026-04-28T10:23:45.123456Z  DEBUG agaric::module: emitting WARN about future deprecation";
        assert!(
            !is_error_or_warn_line(debug_with_warn_in_body),
            "DEBUG line whose body mentions WARN must NOT be classified as an error/warn line"
        );
    }

    /// Defensive: the helper must not panic on an empty input and
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

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into(), None, &[]).unwrap();

        assert_eq!(md.device_id, DEV);
        assert_eq!(md.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(md.os, std::env::consts::OS);
        assert_eq!(md.arch, std::env::consts::ARCH);
        assert_eq!(md.recent_errors.len(), 2);
    }

    /// #4127 — pins that `recent_errors_from_log_dir` treats the file the
    /// real appender actually writes (`agaric.log.YYYY-MM-DD`, per
    /// `build_log_file_appender` in `lib.rs`) as PRIMARY, not merely as a
    /// fallback it happens to reach.
    ///
    /// A test that only asserts "the dated file's content is found" would
    /// pass against the pre-fix code too: that code checked a plain
    /// `agaric.log` first and fell back to the dated file when the plain one
    /// was absent, so with nothing else on disk the fallback alone already
    /// finds it. That is exactly why the primary branch's deadness went
    /// unnoticed. To actually discriminate, this test puts a STALE plain
    /// `agaric.log` on disk (as if left over from something else, or from a
    /// hypothetical future `Rotation::NEVER` config change) *alongside* the
    /// real dated file the appender wrote, with different content in each,
    /// and asserts the dated file's content wins. Pre-fix, the plain file's
    /// `is_file()` check comes first and short-circuits the function, so the
    /// stale content would win instead — silently wrong, and the specific
    /// shape of "dead primary branch" #4127 describes.
    #[test]
    fn recent_errors_from_log_dir_prefers_the_real_tracing_appender_file_over_a_stale_plain_one() {
        use std::io::Write as _;
        use tracing_appender::rolling::{RollingFileAppender, Rotation};

        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        // A stale plain `agaric.log`, distinct from what the appender
        // writes today. Must NOT win.
        fs::write(
            log_dir.join("agaric.log"),
            "2020-01-01 ERROR [agaric] STALE_MARKER\n",
        )
        .unwrap();

        // Mirrors `build_log_file_appender`'s configuration exactly, so the
        // filename this produces is the filename production actually
        // writes. Must win.
        let mut appender = RollingFileAppender::builder()
            .rotation(Rotation::DAILY)
            .filename_prefix("agaric.log")
            .build(&log_dir)
            .expect("appender must build in a writable temp dir");
        writeln!(appender, "2025-01-01 ERROR [agaric] M4127_MARKER").unwrap();
        appender.flush().unwrap();

        // Confirm the premise: both files exist, with distinct markers, so
        // the assertions below actually discriminate which one was read.
        assert!(
            log_dir.join("agaric.log").is_file(),
            "premise broken: the stale plain agaric.log must exist"
        );
        let today = chrono::Utc::now()
            .date_naive()
            .format("%Y-%m-%d")
            .to_string();
        assert!(
            log_dir.join(format!("agaric.log.{today}")).is_file(),
            "premise broken: tracing-appender must write agaric.log.YYYY-MM-DD"
        );

        let errors = recent_errors_from_log_dir(&log_dir);

        assert!(
            errors.iter().any(|l| l.contains("M4127_MARKER")),
            "recent_errors_from_log_dir must find the ERROR line in the \
             real tracing-appender-named file, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("STALE_MARKER")),
            "recent_errors_from_log_dir must NOT read the stale plain \
             agaric.log ahead of the real dated file, got: {errors:?}"
        );
    }

    // -- #4216: recent_errors must not be blind to prior log days ---------

    /// A synthetic "today" for the #4216 fixtures. Deliberately unrelated to
    /// the real calendar: every one of these tests drives
    /// `recent_errors_from_log_dir_at` with this date, so none of them
    /// depends on the day the suite happens to run (or on the suite not
    /// crossing UTC midnight mid-test).
    fn d4216_today() -> chrono::NaiveDate {
        chrono::NaiveDate::from_ymd_opt(2025, 3, 10).expect("valid fixture date")
    }

    /// The path `build_log_file_appender`'s `Rotation::DAILY` appender
    /// produces for `date` — the single place the fixtures spell that
    /// naming rule, so a test that has to reach a day's file after writing
    /// it (to stamp its mtime, say) cannot spell it differently.
    fn day_log_path(log_dir: &Path, date: chrono::NaiveDate) -> PathBuf {
        log_dir.join(format!("agaric.log.{}", date.format("%Y-%m-%d")))
    }

    /// Write `agaric.log.<date>` — the exact name `build_log_file_appender`'s
    /// `Rotation::DAILY` appender produces for that day.
    fn write_day_log(log_dir: &Path, date: chrono::NaiveDate, contents: &str) {
        fs::write(day_log_path(log_dir, date), contents).unwrap();
    }

    fn day_before(date: chrono::NaiveDate, days: i64) -> chrono::NaiveDate {
        date.checked_sub_signed(chrono::Duration::days(days))
            .expect("fixture date arithmetic must not overflow")
    }

    /// A synthetic mtime for the #4290 fixtures: `secs` seconds after the
    /// Unix epoch. Absolute values are irrelevant — only their ORDER is
    /// read — but they are far enough apart that no filesystem's timestamp
    /// granularity can collapse two of them together.
    fn t4290(secs: u64) -> std::time::SystemTime {
        std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs)
    }

    /// Stamp `path`'s mtime explicitly.
    ///
    /// #4290's rule compares mtimes, so a fixture that relies on write
    /// ORDER to produce them is only incidentally deterministic: two writes
    /// microseconds apart can land on one stamp if the filesystem's
    /// granularity is coarse, and a tie deliberately resolves toward the
    /// dated family. Stamping makes each direction of the comparison a
    /// property of the fixture rather than of the machine running it.
    fn set_mtime(path: &Path, at: std::time::SystemTime) {
        fs::File::options()
            .write(true)
            .open(path)
            .expect("fixture file must open for writing to carry an mtime stamp")
            .set_modified(at)
            .expect("filesystem must support setting mtime");
    }

    /// #4216 case 2 — a report about something that happened yesterday.
    ///
    /// Today's rolled file exists and is error-free; the errors the user is
    /// reporting are in yesterday's file, which the bundle already ships
    /// (`should_include_log_file` accepts it) but which the summary field a
    /// triager reads first never looked at.
    ///
    /// Discriminating by construction: today's file contains no ERROR/WARN
    /// line at all, so a pass cannot come from "today's errors were found".
    #[test]
    fn recent_errors_reads_a_prior_day_when_todays_file_has_no_errors() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let today = d4216_today();
        let yesterday = day_before(today, 1);

        write_day_log(
            &log_dir,
            yesterday,
            "2025-03-09T18:00:00Z ERROR [agaric] M4216_YESTERDAY\n",
        );
        write_day_log(&log_dir, today, "2025-03-10T09:00:00Z INFO [agaric] boot\n");

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            errors.iter().any(|l| l.contains("M4216_YESTERDAY")),
            "recent_errors must surface a prior day's ERROR when today's \
             file has none, got: {errors:?}"
        );
    }

    /// #4216 case 1 — the motivating shape: an error logged shortly BEFORE a
    /// UTC day rollover, read shortly AFTER it. At 00:10 UTC the appender has
    /// already rolled to a nearly-empty current-day file, so the incident
    /// twenty minutes earlier lives in `agaric.log.<yesterday>`.
    ///
    /// Covers both halves of the pair — the pre-rollover error AND the
    /// post-rollover one — and pins their relative order (chronological,
    /// newest last, matching the `BugReport::recent_errors` contract). A test
    /// asserting only the post-rollover line would pass before the fix.
    #[test]
    fn recent_errors_spans_the_utc_midnight_rollover_in_chronological_order() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let today = d4216_today();
        let yesterday = day_before(today, 1);

        // 23:50 — the incident, in the day that just rolled away.
        write_day_log(
            &log_dir,
            yesterday,
            "2025-03-09T23:49:00Z INFO [agaric] working\n\
             2025-03-09T23:50:00Z ERROR [agaric] M4216_BEFORE_MIDNIGHT\n",
        );
        // 00:05–00:09 — the freshly rolled file the user files against.
        write_day_log(
            &log_dir,
            today,
            "2025-03-10T00:05:00Z INFO [agaric] boot\n\
             2025-03-10T00:09:00Z ERROR [agaric] M4216_AFTER_MIDNIGHT\n",
        );

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        let before = errors
            .iter()
            .position(|l| l.contains("M4216_BEFORE_MIDNIGHT"));
        let after = errors
            .iter()
            .position(|l| l.contains("M4216_AFTER_MIDNIGHT"));

        assert!(
            before.is_some(),
            "the pre-rollover ERROR (23:50, yesterday's file) must reach \
             recent_errors, got: {errors:?}"
        );
        assert!(
            after.is_some(),
            "the post-rollover ERROR (00:09, today's file) must reach \
             recent_errors, got: {errors:?}"
        );
        assert!(
            before < after,
            "recent_errors is newest-last: the pre-rollover line must come \
             before the post-rollover one, got: {errors:?}"
        );
    }

    /// The multi-day window is bounded by the SAME retention the bundle
    /// already applies (`MAX_ROLLED_AGE_DAYS`, via `should_include_log_file`)
    /// — the summary field must not reach further back than the files that
    /// ship with the report.
    ///
    /// Both halves of the boundary pair are asserted: the oldest in-window
    /// day is read, the day one older is not. Dates are derived from
    /// `MAX_ROLLED_AGE_DAYS` so the test tracks the constant rather than
    /// re-hardcoding it.
    #[test]
    fn recent_errors_window_matches_the_bundle_retention_on_both_sides() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let today = d4216_today();
        let oldest_in_window = day_before(today, MAX_ROLLED_AGE_DAYS);
        let just_out_of_window = day_before(today, MAX_ROLLED_AGE_DAYS + 1);

        // Confirm the premise the pair rests on: these two days really do
        // straddle the bundle's own retention predicate.
        assert!(
            should_include_log_file(
                &format!("agaric.log.{}", oldest_in_window.format("%Y-%m-%d")),
                today
            ),
            "premise broken: the in-window day must be one the bundle ships"
        );
        assert!(
            !should_include_log_file(
                &format!("agaric.log.{}", just_out_of_window.format("%Y-%m-%d")),
                today
            ),
            "premise broken: the out-of-window day must be one the bundle drops"
        );

        write_day_log(
            &log_dir,
            oldest_in_window,
            "2025-03-03T10:00:00Z ERROR [agaric] M4216_IN_WINDOW\n",
        );
        write_day_log(
            &log_dir,
            just_out_of_window,
            "2025-03-02T10:00:00Z ERROR [agaric] M4216_OUT_OF_WINDOW\n",
        );
        write_day_log(&log_dir, today, "2025-03-10T09:00:00Z INFO [agaric] boot\n");

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            errors.iter().any(|l| l.contains("M4216_IN_WINDOW")),
            "the oldest day inside MAX_ROLLED_AGE_DAYS must be read, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4216_OUT_OF_WINDOW")),
            "a day older than MAX_ROLLED_AGE_DAYS must NOT be read — the \
             summary must not out-reach the bundle, got: {errors:?}"
        );
    }

    /// The cap is by LINE COUNT (`RECENT_ERRORS_CAP`), not by file: crossing
    /// a day boundary must not become a second, hidden cliff.
    ///
    /// Today's file carries `RECENT_ERRORS_CAP - 1` errors and yesterday's
    /// carries two, so exactly one line — the oldest — must be dropped.
    /// Asserting the surviving yesterday line makes this fail before the fix
    /// too; asserting the dropped one keeps the new multi-day read honest
    /// about its ceiling.
    #[test]
    fn recent_errors_caps_by_line_count_across_days_keeping_the_newest() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let today = d4216_today();
        let yesterday = day_before(today, 1);

        write_day_log(
            &log_dir,
            yesterday,
            "2025-03-09T22:00:00Z ERROR [agaric] M4216_DROPPED_OLDEST\n\
             2025-03-09T23:00:00Z ERROR [agaric] M4216_KEPT_OLDER\n",
        );
        let mut today_log = String::new();
        for i in 0..(RECENT_ERRORS_CAP - 1) {
            today_log.push_str(&format!(
                "2025-03-10T01:00:00Z ERROR [agaric] M4216_TODAY_{i}\n"
            ));
        }
        write_day_log(&log_dir, today, &today_log);

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert_eq!(
            errors.len(),
            RECENT_ERRORS_CAP,
            "the cross-day tail must be capped at RECENT_ERRORS_CAP lines, got: {errors:?}"
        );
        assert!(
            errors[0].contains("M4216_KEPT_OLDER"),
            "the newest of yesterday's errors must survive the cap and lead \
             the chronological list, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4216_DROPPED_OLDEST")),
            "the oldest line beyond the cap must be dropped, got: {errors:?}"
        );
        assert!(
            errors
                .iter()
                .any(|l| l.contains(&format!("M4216_TODAY_{}", RECENT_ERRORS_CAP - 2))),
            "today's newest error must always survive, got: {errors:?}"
        );
    }

    /// #4216 hardening — the multi-file walk must SKIP junk in the log dir,
    /// never abort on it. Pre-#4216 the function touched exactly one path;
    /// now it enumerates the whole directory, so every entry a hostile or
    /// merely-corrupted log dir can hold is newly reachable. A bug-report
    /// path that panics or errors on a junk file is worse than one that
    /// misses a day.
    ///
    /// Every junk shape carries its own marker and the ONE good day carries
    /// another, so the assertions discriminate "skipped the junk" from
    /// "returned nothing at all". The good day is `yesterday`, and today's
    /// name is taken by a directory — so this also fails pre-fix, where the
    /// single `agaric.log.<today>.is_file()` probe goes false and the walk
    /// falls through to an absent plain file.
    // Unix-only: builds the fixture with `PermissionsExt` and `symlink`, the
    // same reason its sibling `read_logs_warns_on_unreadable_file_and_excludes_it`
    // is gated. Without this, `cargo test` does not compile on Windows locally —
    // CI would not catch it, since the Windows target only builds the binary.
    #[cfg(unix)]
    #[test]
    fn recent_errors_skips_junk_names_and_unreadable_files_without_aborting() {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let today = d4216_today();

        // Unparseable dates and non-log names.
        fs::write(
            log_dir.join("agaric.log.2025-13-45"),
            "x ERROR [agaric] M4216_BAD_DATE\n",
        )
        .unwrap();
        fs::write(
            log_dir.join("agaric.log.notadate"),
            "x ERROR [agaric] M4216_NOT_A_DATE\n",
        )
        .unwrap();
        fs::write(
            log_dir.join("agaric.log.2025-03-08.gz"),
            "x ERROR [agaric] M4216_COMPRESSED\n",
        )
        .unwrap();

        // A DIRECTORY wearing today's log filename.
        let dir_named_like_a_log = log_dir.join(format!("agaric.log.{}", today.format("%Y-%m-%d")));
        fs::create_dir_all(&dir_named_like_a_log).unwrap();
        fs::write(
            dir_named_like_a_log.join("inner"),
            "x ERROR [agaric] M4216_INSIDE_DIR\n",
        )
        .unwrap();

        // A symlink to a directory, and a dangling symlink.
        std::os::unix::fs::symlink(dir.path(), log_dir.join("agaric.log.2025-03-07")).unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("does-not-exist"),
            log_dir.join("agaric.log.2025-03-06"),
        )
        .unwrap();

        // A file with no read permission.
        let unreadable = log_dir.join("agaric.log.2025-03-05");
        fs::write(&unreadable, "x ERROR [agaric] M4216_UNREADABLE\n").unwrap();
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        // Running as root defeats mode 0o000; only assert the skip when the
        // fixture actually denies the read.
        let read_is_really_denied = fs::read_to_string(&unreadable).is_err();

        // The one good day.
        write_day_log(
            &log_dir,
            day_before(today, 1),
            "x ERROR [agaric] M4216_GOOD_DAY\n",
        );

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            errors.iter().any(|l| l.contains("M4216_GOOD_DAY")),
            "the walk must survive every junk entry and still read the one \
             good day, got: {errors:?}"
        );
        for junk in [
            "M4216_BAD_DATE",
            "M4216_NOT_A_DATE",
            "M4216_COMPRESSED",
            "M4216_INSIDE_DIR",
        ] {
            assert!(
                !errors.iter().any(|l| l.contains(junk)),
                "{junk} must not be read — its filename is not a valid \
                 agaric.log.YYYY-MM-DD regular file, got: {errors:?}"
            );
        }
        if read_is_really_denied {
            assert!(
                !errors.iter().any(|l| l.contains("M4216_UNREADABLE")),
                "an unreadable day must be skipped, not surfaced, got: {errors:?}"
            );
        }
        // Derived, not hardcoded: as root, mode 0o000 does not deny the read,
        // so the unreadable day legitimately contributes its own line. Pinning
        // 1 unconditionally reddens every root run (Docker, devcontainers)
        // while staying green on GitHub's non-root runner — a failure only
        // some contributors would ever see.
        let expected = if read_is_really_denied { 1 } else { 2 };
        assert_eq!(
            errors.len(),
            expected,
            "only the good day (plus the unreadable one when the fixture could \
             not actually deny the read) should survive, got: {errors:?}"
        );

        // The junk shapes must agree between the two selectors — they share
        // `parse_rolled_log_date`, so pin that the bundle rejects them too.
        for junk_name in [
            "agaric.log.2025-13-45",
            "agaric.log.notadate",
            "agaric.log.2025-03-08.gz",
        ] {
            assert!(
                !should_include_log_file(junk_name, today),
                "{junk_name} must be rejected by the bundle selector as well"
            );
        }
    }

    // -- #4283: the report may only read the log dir's own regular files ---
    //
    // `recent_errors` is embedded in the body of a PUBLIC GitHub issue, and
    // both selectors used to decide what to read with `Path::is_file`, which
    // FOLLOWS symlinks. A link planted in the log directory under a valid log
    // name therefore pulled a file from anywhere the app can read into that
    // body. These fixtures plant exactly that link.
    //
    // Every assertion below is a PAIR — the planted secret is absent AND a
    // legitimate log line is still present — because "the secret is absent"
    // alone is satisfied by a great many things that are not the fix: a
    // fixture whose paths never existed, a permission error, an empty file, or
    // a change that broke log collection outright. Only the pair distinguishes
    // "refused to follow the link" from "read nothing at all", and the second
    // half is the one that fails if the fix over-reaches into the "refusing
    // links loses the logs the report is for" outcome #4283 declines to accept.

    /// The secret the fixtures plant OUTSIDE the log dir, shaped like a log
    /// line so that nothing but the confinement can keep it out: it carries
    /// the ` ERROR ` token `extract_recent_errors` selects on, so if the file
    /// is read at all this line is what gets published.
    #[cfg(unix)]
    const SECRET_LINE_4283: &str =
        "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_EXFILTRATED_SECRET\n";

    /// Write the out-of-log-dir "secret" and return its path. Placed under the
    /// TempDir but OUTSIDE `log_dir`, so the only way to it is the link.
    #[cfg(unix)]
    fn plant_secret_4283(root: &Path) -> PathBuf {
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("private.txt");
        fs::write(&secret, SECRET_LINE_4283).unwrap();
        secret
    }

    /// A symlink wearing a valid DATED log name must not be read, and the real
    /// dated file beside it must still be (#4283).
    ///
    /// Fails on pre-fix `main`: `path.is_file()` resolves the link to a
    /// regular file, `read_capped_file` reads it, and `M4283_EXFILTRATED_SECRET`
    /// lands in `recent_errors` — i.e. in the prefilled public issue body.
    #[cfg(unix)]
    #[test]
    fn recent_errors_refuses_a_dated_symlink_out_of_the_log_dir_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let today = d4216_today();

        let secret = plant_secret_4283(dir.path());
        // The link wears today's name — the newest day the walk reaches, so it
        // is read first and its lines are the ones that survive the cap.
        std::os::unix::fs::symlink(&secret, day_log_path(&log_dir, today)).unwrap();

        // …and a real log day beside it, so "nothing was read" cannot pass.
        write_day_log(
            &log_dir,
            day_before(today, 1),
            "2025-03-09T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        );

        // Fixture control: the link really does resolve to readable content.
        // Without this, a typo'd target would make the absence assertion below
        // pass for the wrong reason.
        assert_eq!(
            fs::read_to_string(day_log_path(&log_dir, today)).unwrap(),
            SECRET_LINE_4283,
            "fixture control: the planted link must resolve to the secret, so the \
             absence assertion below is about the fix and not about a broken fixture"
        );

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            !errors
                .iter()
                .any(|l| l.contains("M4283_EXFILTRATED_SECRET")),
            "#4283: a symlink out of the log dir must not be read — its content is \
             published into a public GitHub issue body. Got: {errors:?}"
        );
        assert!(
            errors.iter().any(|l| l.contains("M4283_LEGITIMATE_LOG")),
            "…and the real log beside it must still be read: a fix that stops \
             collecting logs would satisfy the assertion above while being useless. \
             Got: {errors:?}"
        );
        assert_eq!(
            errors.len(),
            1,
            "exactly the one legitimate line, got: {errors:?}"
        );
    }

    /// The same, for the undated `agaric.log` name (#4283).
    ///
    /// A separate guard: the plain name is not enumerated through `read_dir`,
    /// it is probed by `log_dir.join("agaric.log")`, and when it outranks the
    /// dated family it is read INSTEAD of it — so a link here is the whole of
    /// `recent_errors`, not one day of it.
    #[cfg(unix)]
    #[test]
    fn recent_errors_refuses_a_symlinked_plain_log_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let today = d4216_today();

        let secret = plant_secret_4283(dir.path());
        let plain = log_dir.join("agaric.log");
        std::os::unix::fs::symlink(&secret, &plain).unwrap();
        // The link's target is the NEWEST thing here, which is what makes the
        // plain-file branch win over the dated family (#4290 ranks by mtime).
        set_mtime(&secret, t4290(9_000));

        write_day_log(
            &log_dir,
            today,
            "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        );
        set_mtime(&day_log_path(&log_dir, today), t4290(1_000));

        assert_eq!(
            fs::read_to_string(&plain).unwrap(),
            SECRET_LINE_4283,
            "fixture control: the planted link must resolve to the secret"
        );

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            !errors
                .iter()
                .any(|l| l.contains("M4283_EXFILTRATED_SECRET")),
            "#4283: a symlinked `agaric.log` must not be read, got: {errors:?}"
        );
        assert!(
            errors.iter().any(|l| l.contains("M4283_LEGITIMATE_LOG")),
            "…and refusing it must fall through to the dated family rather than \
             returning nothing, got: {errors:?}"
        );
        assert_eq!(
            errors.len(),
            1,
            "exactly the one legitimate line, got: {errors:?}"
        );
    }

    /// A planted link must not be able to SUPPRESS the live log either (#4283).
    ///
    /// This is the assertion the enumeration filter alone answers, and the
    /// reason that filter is not redundant with the `O_NOFOLLOW` open. A dated
    /// entry that survives enumeration is fed to `plain_log_outranks_dated`;
    /// point it at something freshly touched and the plain file, which is the
    /// only one still being appended to, stops outranking the dated family; the
    /// open then refuses the link and the walk yields nothing at all. The report
    /// goes blind, and no symlink content is needed to do it.
    ///
    /// Read as a discriminator, this pins the ENUMERATION filter specifically:
    /// the link never reaches the ranking at all, because `entry.metadata()` is
    /// an `lstat` and drops it. The second, independent reason the same attack
    /// now fails — the ranking's own `stat` no longer follows either — is
    /// exercised on its own by
    /// `ranking_a_swapped_in_link_reads_its_own_mtime_not_its_targets_4283`,
    /// because an assertion that would pass for either reason cannot tell you
    /// that both are alive.
    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_cannot_suppress_the_live_plain_log_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let today = d4216_today();

        // The live log: the plain name, the file the app is appending to.
        let plain = log_dir.join("agaric.log");
        fs::write(
            &plain,
            "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        )
        .unwrap();
        set_mtime(&plain, t4290(5_000));

        // A link under a valid dated name, pointed at a file with a NEWER
        // mtime than the live log.
        let secret = plant_secret_4283(dir.path());
        set_mtime(&secret, t4290(9_000));
        std::os::unix::fs::symlink(&secret, day_log_path(&log_dir, today)).unwrap();

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            errors.iter().any(|l| l.contains("M4283_LEGITIMATE_LOG")),
            "#4283: a link in the log dir must not outrank — and so silence — the \
             live plain log. Got: {errors:?}"
        );
        assert!(
            !errors
                .iter()
                .any(|l| l.contains("M4283_EXFILTRATED_SECRET")),
            "…and the link's target must still not be read, got: {errors:?}"
        );
        assert_eq!(
            errors.len(),
            1,
            "exactly the one legitimate line, got: {errors:?}"
        );
    }

    /// The ranking `stat` must not follow a link either (#4283, review of #4488).
    ///
    /// The enumeration filter drops symlinks from `days` before ranking ever
    /// sees them, so the state under test is reachable only by winning the
    /// window between that `lstat` and the ranking — the residual documented on
    /// [`plain_log_outranks_dated`]. No in-process fixture can drive
    /// `recent_errors_from_log_dir_at` into it, so the ranking is called
    /// DIRECTLY with the post-swap candidate set. That is the point of the
    /// test: it isolates the layer the suppression test above cannot reach.
    ///
    /// Discriminating by construction: the link's TARGET is stamped newer than
    /// the live plain log, while the link's OWN mtime is its creation time and
    /// so older than both (the two real files are stamped into the future
    /// because `std` cannot set a link's own timestamps). A following
    /// `fs::metadata` therefore reads the target's stamp and demotes the live
    /// log — the pre-fix behaviour, and the only way this assertion can go red.
    #[cfg(unix)]
    #[test]
    fn ranking_a_swapped_in_link_reads_its_own_mtime_not_its_targets_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        let today = d4216_today();
        let now = std::time::SystemTime::now();

        // The live log, stamped ahead of the link's creation time.
        let plain = log_dir.join("agaric.log");
        fs::write(
            &plain,
            "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        )
        .unwrap();
        set_mtime(&plain, now + std::time::Duration::from_secs(3_600));

        // The link's target: newer still, so following the link wins the rank.
        let secret = plant_secret_4283(dir.path());
        set_mtime(&secret, now + std::time::Duration::from_secs(7_200));

        let link = day_log_path(&log_dir, today);
        std::os::unix::fs::symlink(&secret, &link).unwrap();

        assert!(
            plain_log_outranks_dated(&plain, &[(today, link)]),
            "#4283: ranking a candidate must not resolve it — a link swapped in \
             after enumeration must rank by its own mtime, not by the mtime of \
             whatever it points at, or it can demote the live plain log"
        );
    }

    /// The ZIP bundle takes the same rule (#4283).
    ///
    /// It is uploaded by hand rather than pasted into the issue body, but it is
    /// uploaded to the same public issue; the issue's option 2 (fix only the
    /// published path) is deliberately not what was done.
    #[cfg(unix)]
    #[test]
    fn read_logs_bundle_refuses_a_symlink_out_of_the_log_dir_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let secret = plant_secret_4283(dir.path());
        // The bundle selector has no clock seam, so the fixture uses the real
        // calendar: a link under yesterday's name, a real file under today's.
        let yesterday = (chrono::Utc::now().date_naive() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        std::os::unix::fs::symlink(&secret, log_dir.join(format!("agaric.log.{yesterday}")))
            .unwrap();
        fs::write(
            log_dir.join("agaric.log"),
            "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        )
        .unwrap();

        let out = read_logs_for_report_inner(&log_dir, false, None, None, &[]).unwrap();

        let joined = out
            .iter()
            .map(|e| e.contents.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !joined.contains("M4283_EXFILTRATED_SECRET"),
            "#4283: the bundle must not follow a symlink out of the log dir, got: {out:?}"
        );
        assert!(
            joined.contains("M4283_LEGITIMATE_LOG"),
            "…and must still bundle the real log beside it, got: {out:?}"
        );
        assert_eq!(
            out.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
            vec!["agaric.log"],
            "exactly the one real file, got: {out:?}"
        );
    }

    /// The OTel escape is one level up: a symlinked SUBDIR (#4283).
    ///
    /// Found while checking the rest of the bug-report payload for the same
    /// exposure. `newest_otel_file` already refuses a symlinked *file* and the
    /// open refuses to follow one — but neither says anything about the
    /// directory. `read_dir` on a symlinked `traces/` enumerates whatever it
    /// points at, and the winner is then a real regular file with a real name
    /// inside that other directory, so no link ever appears in the path that is
    /// opened and every file-level guard is satisfied.
    #[cfg(unix)]
    #[test]
    fn otel_signals_are_not_collected_through_a_symlinked_subdir_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        // A directory outside the log dir holding a perfectly ordinary file.
        let outside = dir.path().join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        fs::write(
            outside.join("id_rsa"),
            "name=secret\tvalue=M4283_EXFILTRATED_SECRET\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, log_dir.join("traces")).unwrap();

        // A REAL otel subdir beside it, so "collected nothing" cannot pass.
        let metrics = log_dir.join("metrics");
        fs::create_dir_all(&metrics).unwrap();
        fs::write(
            metrics.join("agaric-metrics.log"),
            "name=create_block\tvalue=M4283_LEGITIMATE_LOG\n",
        )
        .unwrap();
        fs::write(
            log_dir.join("agaric.log"),
            "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        )
        .unwrap();

        let out = read_logs_for_report_inner(&log_dir, false, None, None, &[]).unwrap();

        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        let joined = out
            .iter()
            .map(|e| e.contents.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            !joined.contains("M4283_EXFILTRATED_SECRET"),
            "#4283: a symlinked OTel subdir must not be enumerated, got: {names:?}"
        );
        assert!(
            !names.iter().any(|n| n.starts_with("traces/")),
            "…not even as an entry NAME, got: {names:?}"
        );
        assert!(
            names.contains(&"metrics/agaric-metrics.log"),
            "…while the real sibling subdir is still collected: a fix that stopped \
             collecting OTel signals entirely would satisfy the assertions above. \
             Got: {names:?}"
        );
        assert!(
            joined.contains("M4283_LEGITIMATE_LOG"),
            "…with its content, got: {out:?}"
        );
    }

    /// The gate itself, both arms (#4283).
    ///
    /// `recent_errors_*` and `read_logs_*` each hold TWO guards over the same
    /// symlink — the `lstat` enumeration filter and this open — so a test that
    /// only drove them could not tell which one was load-bearing. This drives
    /// the open directly.
    ///
    /// The accept arm is not decoration: a gate that refused everything would
    /// satisfy every refusal arm here and break log collection entirely.
    #[cfg(unix)]
    #[test]
    fn open_confined_log_file_refuses_links_and_non_files_but_opens_a_real_log_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        // Accept: an ordinary regular file directly inside the log dir.
        let real = log_dir.join("agaric.log");
        fs::write(&real, "M4283_LEGITIMATE_LOG\n").unwrap();
        assert!(
            open_confined_log_file(&real).is_ok(),
            "a regular file inside the log dir is exactly what the report is for"
        );
        assert_eq!(
            read_capped_file(&real).unwrap(),
            "M4283_LEGITIMATE_LOG\n",
            "…and its bytes must come back unchanged"
        );

        // Refuse: a symlink to a file outside the log dir.
        let secret = plant_secret_4283(dir.path());
        let link = log_dir.join("agaric.log.2025-03-10");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        assert!(
            open_confined_log_file(&link).is_err(),
            "O_NOFOLLOW must fail the open of a symlink rather than resolving it"
        );
        assert!(
            read_capped_file(&link).is_err(),
            "…so no caller can read through it either"
        );

        // Refuse: a symlink to a file INSIDE the log dir. Containment is about
        // the entry being a real file, not about where the link happens to
        // point — a link that resolves back inside is still a name the log
        // appender did not create, and allowing it would mean the rule depends
        // on a resolution step that the racy version is exactly the bug.
        let inside_link = log_dir.join("agaric.log.2025-03-09");
        std::os::unix::fs::symlink(&real, &inside_link).unwrap();
        assert!(
            open_confined_log_file(&inside_link).is_err(),
            "a symlink is refused for being a symlink, not for where it points"
        );

        // Refuse: a directory wearing a log name.
        let dir_named_like_a_log = log_dir.join("agaric.log.2025-03-08");
        fs::create_dir_all(&dir_named_like_a_log).unwrap();
        assert!(
            open_confined_log_file(&dir_named_like_a_log).is_err(),
            "the fstat on the open handle must refuse a directory"
        );

        // Refuse: a unix socket wearing a log name. Opening one is refused by
        // the kernel outright, which is the point — the report's rule is
        // "regular files only", and every other node type a filesystem can
        // hold is outside the accepted set rather than on a list of refusals.
        let socket_path = log_dir.join("agaric.log.2025-03-07");
        let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
        assert!(
            open_confined_log_file(&socket_path).is_err(),
            "a socket wearing a log name must not be opened as a log"
        );

        // Refuse: a FIFO wearing a log name — and, more to the point, refuse it
        // WITHOUT HANGING. Opening first and classifying second is what makes
        // `O_NONBLOCK` load-bearing: a blocking `open` on a FIFO waits for a
        // writer that never comes, so a regression here shows up as this test
        // never terminating rather than as a failed assertion. Shelled out
        // because `libc::mkfifo` is an `unsafe` call and this crate denies
        // `unsafe_code`; skipped if the platform has no `mkfifo` binary.
        let fifo = log_dir.join("agaric.log.2025-03-06");
        let made_fifo = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .is_ok_and(|s| s.success());
        if made_fifo {
            assert!(
                open_confined_log_file(&fifo).is_err(),
                "the fstat on the open handle must refuse a FIFO"
            );
        }
    }

    /// The enumeration filter's answer is never *inherited* by the read
    /// (#4283).
    ///
    /// Both selectors classify an entry once at `read_dir` time and then read
    /// it later through a path. That gap is where this bug class lives: the
    /// attacker who can plant a link in the log directory can also swap one in
    /// after the classification, and a reader that trusted the earlier answer
    /// would follow it. So this takes the filter's answer while the entry
    /// genuinely is a regular file, swaps a symlink in behind it, and requires
    /// the read to refuse anyway — the classification that governs the bytes
    /// has to be made at the open, on this file, not carried in from `days` or
    /// from the `should_include_log_file` loop.
    ///
    /// # What this does NOT prove
    ///
    /// Stated so a later reader does not over-read it: this cannot distinguish
    /// `O_NOFOLLOW` from an `lstat`-then-`open` pair *inside*
    /// `open_confined_log_file`, because a swap landing between those two
    /// syscalls is not something a test can schedule. Verified by mutation —
    /// rewriting the gate into that racy shape keeps this test green, while
    /// dropping `O_NOFOLLOW` altogether turns it red. The race-freedom argument
    /// rests on `open(2)`'s semantics (see [`open_confined_log_file`]), which
    /// is an argument about the syscall and not a claim any test here checks.
    ///
    /// The fixture control matters more than usual: the link is proven to
    /// resolve to the secret *through the same path* first, so "refused" cannot
    /// be a broken fixture, an absent file, or a permission error.
    #[cfg(unix)]
    #[test]
    fn open_confined_log_file_does_not_inherit_the_enumeration_filters_answer_4283() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let secret = plant_secret_4283(dir.path());
        let path = day_log_path(&log_dir, d4216_today());
        fs::write(
            &path,
            "2025-03-10T00:00:00.000000Z ERROR agaric: M4283_LEGITIMATE_LOG\n",
        )
        .unwrap();

        // What the enumeration filter answers, taken FIRST — while the entry is
        // genuinely a regular file, exactly as it is at `read_dir` time.
        assert!(
            is_regular_file_no_follow(&path),
            "precondition: the filter sees a real regular file at this instant"
        );

        // …and now the swap the filter's answer is stale against.
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&secret, &path).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            SECRET_LINE_4283,
            "fixture control: after the swap the SAME path resolves to the secret, so \
             the refusal below is the gate and not a missing file"
        );

        assert!(
            open_confined_log_file(&path).is_err(),
            "#4283: the open must refuse the swapped-in link. If this passes only \
             because a check ran before it, the check is stale by construction — \
             `O_NOFOLLOW` has to be what fails the open"
        );
        assert!(
            read_capped_file(&path).is_err(),
            "…and no caller can read through it"
        );
    }

    /// #4216 — the early exit must drop only OLDER lines, never newer ones.
    ///
    /// Three days, with the MIDDLE one carrying more errors than the cap:
    /// today has 5, yesterday has `RECENT_ERRORS_CAP + 10`, and the day
    /// before that has 5 that must never be reached. A walk that filled the
    /// cap from the wrong end — or that stopped before folding in the newest
    /// day — would show up here as a missing today-marker or a present
    /// oldest-day marker.
    #[test]
    fn recent_errors_early_exit_drops_only_older_days_never_newer_ones() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        let today = d4216_today();
        const TODAY_ERRORS: usize = 5;
        let middle_errors = RECENT_ERRORS_CAP + 10;

        write_day_log(
            &log_dir,
            day_before(today, 2),
            "x ERROR [agaric] M4216_OLDEST_DAY\n",
        );
        let mut middle = String::new();
        for i in 0..middle_errors {
            middle.push_str(&format!("x ERROR [agaric] M4216_MID_{i}\n"));
        }
        write_day_log(&log_dir, day_before(today, 1), &middle);
        let mut newest = String::new();
        for i in 0..TODAY_ERRORS {
            newest.push_str(&format!("x ERROR [agaric] M4216_NEW_{i}\n"));
        }
        write_day_log(&log_dir, today, &newest);

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert_eq!(
            errors.len(),
            RECENT_ERRORS_CAP,
            "the cross-day tail must be exactly RECENT_ERRORS_CAP, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4216_OLDEST_DAY")),
            "the day beyond the filled cap must never be reached, got: {errors:?}"
        );
        // The newest day survives in full, last, in order.
        let tail: Vec<&String> = errors.iter().rev().take(TODAY_ERRORS).rev().collect();
        for (i, line) in tail.iter().enumerate() {
            assert!(
                line.contains(&format!("M4216_NEW_{i}")),
                "today's errors must be the chronological tail, in order — \
                 position {i} was {line:?}, full: {errors:?}"
            );
        }
        // The middle day contributes its NEWEST lines, not its oldest.
        let kept_from_middle = RECENT_ERRORS_CAP - TODAY_ERRORS;
        let first_kept_mid = middle_errors - kept_from_middle;
        assert!(
            errors[0].contains(&format!("M4216_MID_{first_kept_mid}")),
            "the surviving middle-day lines must be its newest \
             {kept_from_middle}, so the list must start at MID_\
             {first_kept_mid}, got: {errors:?}"
        );
        assert!(
            !errors
                .iter()
                .any(|l| l.contains(&format!("M4216_MID_{}", first_kept_mid - 1))),
            "the line one older than the cap boundary must be dropped, got: {errors:?}"
        );
    }

    /// #4127 under #4216, deterministically: a stale plain `agaric.log`
    /// must never be MIXED INTO the dated family, not merely never
    /// preferred over it. The existing appender-driven #4127 test runs
    /// against the real clock and a single dated day; this one drives the
    /// `_at` seam with two dated days plus the stale plain file, which is
    /// the shape the multi-file walk newly makes reachable.
    ///
    /// The second half pins the fallback's ACTUAL trigger — no usable
    /// in-window dated file, which is broader than "no dated file at all".
    /// That half is characterisation, not #4216 coverage: it behaves the
    /// same before and after the fix, and exists to keep the code comment
    /// honest about when the plain file can still win.
    #[test]
    fn recent_errors_never_mixes_a_stale_plain_log_into_the_dated_family() {
        let today = d4216_today();

        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("agaric.log"),
            "x ERROR [agaric] M4216_STALE_PLAIN\n",
        )
        .unwrap();
        write_day_log(
            &log_dir,
            day_before(today, 1),
            "x ERROR [agaric] M4216_DATED_YESTERDAY\n",
        );
        write_day_log(&log_dir, today, "x ERROR [agaric] M4216_DATED_TODAY\n");

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert_eq!(
            errors.len(),
            2,
            "exactly the two dated days' errors — the plain file must not \
             be mixed in even though the cap had room, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4216_STALE_PLAIN")),
            "#4127: the stale plain agaric.log must never be read while a \
             dated in-window file exists, got: {errors:?}"
        );
        assert!(
            errors[0].contains("M4216_DATED_YESTERDAY") && errors[1].contains("M4216_DATED_TODAY"),
            "both dated days, chronological, newest last, got: {errors:?}"
        );

        // Characterisation: with every dated file OUT of the retention
        // window, `days` is empty and the plain fallback does fire. This is
        // unchanged from pre-#4216 (which also fell through whenever
        // `agaric.log.<today>` was absent), and it is why the fallback
        // comment says "no usable in-window dated file" rather than "no
        // dated file".
        let dir2 = TempDir::new().unwrap();
        let log_dir2 = dir2.path().join("logs");
        fs::create_dir_all(&log_dir2).unwrap();
        write_day_log(
            &log_dir2,
            day_before(today, MAX_ROLLED_AGE_DAYS + 3),
            "x ERROR [agaric] M4216_TOO_OLD\n",
        );
        fs::write(
            log_dir2.join("agaric.log"),
            "x ERROR [agaric] M4216_PLAIN_FALLBACK\n",
        )
        .unwrap();

        let fallback = recent_errors_from_log_dir_at(&log_dir2, today);
        assert!(
            fallback.iter().any(|l| l.contains("M4216_PLAIN_FALLBACK")),
            "with no in-window dated file the plain fallback must still \
             fire, got: {fallback:?}"
        );
        assert!(
            !fallback.iter().any(|l| l.contains("M4216_TOO_OLD")),
            "an out-of-window dated file must not be read, got: {fallback:?}"
        );
    }

    /// #4290 — a plain `agaric.log` NEWER than every in-window dated file
    /// is the live log, and must win.
    ///
    /// This is the `Rotation::NEVER` switch the fallback's own comment
    /// justified itself by, and the shape the pre-#4290 predicate got
    /// backwards: the dated files written before the switch stay inside
    /// [`MAX_ROLLED_AGE_DAYS`], so `days` is non-empty for the whole
    /// retention window and the "no usable in-window dated file" condition
    /// never fires. The triager's summary then stops on the day of the
    /// switch — blind to exactly the period they are reporting about.
    ///
    /// The fixture keeps a dated file for `today` itself, so the discarded
    /// family is unambiguously "usable and in-window": pre-fix this test
    /// sees only the dated markers.
    #[test]
    fn recent_errors_prefers_a_live_plain_log_over_stale_in_window_dated_files() {
        let today = d4216_today();

        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        write_day_log(
            &log_dir,
            day_before(today, 1),
            "x ERROR [agaric] M4290_DATED_OLDER\n",
        );
        write_day_log(&log_dir, today, "x ERROR [agaric] M4290_DATED_NEWER\n");
        fs::write(
            log_dir.join("agaric.log"),
            "x ERROR [agaric] M4290_LIVE_PLAIN\n",
        )
        .unwrap();

        set_mtime(&day_log_path(&log_dir, day_before(today, 1)), t4290(1_000));
        set_mtime(&day_log_path(&log_dir, today), t4290(2_000));
        set_mtime(&log_dir.join("agaric.log"), t4290(3_000));

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            errors.iter().any(|l| l.contains("M4290_LIVE_PLAIN")),
            "#4290: a plain agaric.log newer than every in-window dated \
             file is the live log and its errors must reach the report, \
             got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4290_DATED_NEWER")),
            "the frozen dated family must not be mixed into the live \
             plain file's errors, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4290_DATED_OLDER")),
            "the frozen dated family must not be mixed into the live \
             plain file's errors, got: {errors:?}"
        );
    }

    /// #4290's other direction, stated as a clock fact rather than as a
    /// side effect of fixture write order: a plain `agaric.log` OLDER than
    /// the dated family stays out of the report.
    ///
    /// `recent_errors_never_mixes_a_stale_plain_log_into_the_dated_family`
    /// pins the same guarantee, but its plain file is stale only because it
    /// happens to be written first. This one stamps the mtimes, so the
    /// #4127 default is pinned by the comparison the code actually makes.
    #[test]
    fn recent_errors_ignores_a_plain_log_older_than_the_dated_family() {
        let today = d4216_today();

        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        fs::write(
            log_dir.join("agaric.log"),
            "x ERROR [agaric] M4290_STALE_PLAIN\n",
        )
        .unwrap();
        write_day_log(
            &log_dir,
            day_before(today, 1),
            "x ERROR [agaric] M4290_LIVE_YESTERDAY\n",
        );
        write_day_log(&log_dir, today, "x ERROR [agaric] M4290_LIVE_TODAY\n");

        set_mtime(&log_dir.join("agaric.log"), t4290(1_000));
        set_mtime(&day_log_path(&log_dir, day_before(today, 1)), t4290(2_000));
        set_mtime(&day_log_path(&log_dir, today), t4290(3_000));

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            !errors.iter().any(|l| l.contains("M4290_STALE_PLAIN")),
            "#4127: a plain agaric.log older than the dated family is a \
             leftover and must never be read, got: {errors:?}"
        );
        assert_eq!(
            errors.len(),
            2,
            "exactly the two dated days, with the stale plain file neither \
             preferred nor mixed in, got: {errors:?}"
        );
        assert!(
            errors[0].contains("M4290_LIVE_YESTERDAY") && errors[1].contains("M4290_LIVE_TODAY"),
            "both dated days, chronological, newest last, got: {errors:?}"
        );
    }

    /// #4290 — an mtime TIE resolves toward the dated family.
    ///
    /// The comparison is strictly-newer, not newer-or-equal, and that is
    /// load-bearing rather than incidental: it is what keeps every
    /// pre-existing #4127 fixture green. Those fixtures write the stale
    /// plain file and the live dated file within microseconds of each
    /// other and rely on the plain one being older; on a filesystem whose
    /// timestamp granularity is coarse enough to collapse both writes onto
    /// one stamp, a newer-or-equal comparison would flip them and start
    /// preferring the stale file.
    #[test]
    fn recent_errors_gives_an_mtime_tie_to_the_dated_family() {
        let today = d4216_today();

        let dir = TempDir::new().unwrap();
        let log_dir = dir.path().join("logs");
        fs::create_dir_all(&log_dir).unwrap();

        fs::write(
            log_dir.join("agaric.log"),
            "x ERROR [agaric] M4290_TIED_PLAIN\n",
        )
        .unwrap();
        write_day_log(&log_dir, today, "x ERROR [agaric] M4290_TIED_DATED\n");

        let same_instant = t4290(2_000);
        set_mtime(&log_dir.join("agaric.log"), same_instant);
        set_mtime(&day_log_path(&log_dir, today), same_instant);

        let errors = recent_errors_from_log_dir_at(&log_dir, today);

        assert!(
            errors.iter().any(|l| l.contains("M4290_TIED_DATED")),
            "on a tie the dated family — what production writes — must \
             still be read, got: {errors:?}"
        );
        assert!(
            !errors.iter().any(|l| l.contains("M4290_TIED_PLAIN")),
            "a tie is not evidence that the plain file is live, so #4127's \
             default must hold, got: {errors:?}"
        );
    }

    #[test]
    fn collect_metadata_empty_log_dir_returns_empty_recent_errors() {
        let dir = TempDir::new().unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into(), None, &[]).unwrap();

        assert_eq!(md.recent_errors.len(), 0);
        assert_eq!(md.device_id, DEV);
    }

    #[test]
    fn collect_metadata_missing_log_file_but_existing_dir_is_safe() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(log_dir_for_app_data(dir.path())).unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into(), None, &[]).unwrap();

        assert_eq!(md.recent_errors.len(), 0);
    }

    /// A chatty session can grow `agaric.log` to tens of MB; the
    /// bug-report dialog must not stall the IPC thread on an unbounded
    /// `fs::read_to_string` of the live log. The fix caps each file read to
    /// the last `MAX_FILE_BYTES` bytes (truncating from the head).
    ///
    /// We assert the cap's *behaviour* deterministically rather than its
    /// wall-clock time. The previous `elapsed < 200ms` assertion measured
    /// machine contention, not code: on a saturated CI runner (nextest runs
    /// the whole suite in parallel) a tens-of-ms operation can blow past
    /// 200ms, so it flaked (observed TRY-1 FAIL → TRY-2 PASS). A capped read
    /// is bounded-fast *by construction*, so verifying the cap is applied
    /// subsumes the timing concern with zero flakiness: an ERROR marker at
    /// the HEAD of an oversized file must NOT survive (it lies before the
    /// last-`MAX_FILE_BYTES` window and is never read), while the TAIL marker
    /// must. Filler is `INFO`, so the two markers are the only ERROR lines —
    /// a missing head marker can only mean the file cap dropped it (not the
    /// `RECENT_ERRORS_CAP` of 20).
    #[test]
    fn collect_metadata_caps_oversized_log_file_to_the_tail() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();

        // ERROR marker at the very head, then > MAX_FILE_BYTES of INFO
        // filler, then an ERROR marker at the tail. The head marker sits well
        // inside the region the cap truncates away.
        let cap = usize::try_from(MAX_FILE_BYTES).unwrap_or(usize::MAX);
        let mut contents = String::with_capacity(cap + 8_192);
        contents.push_str("2025-01-01 ERROR [agaric] M31_HEAD_MARKER\n");
        while contents.len() < cap + 4_096 {
            contents.push_str("2025-01-01 INFO [agaric] filler line abcdefghijklmnopqrstuvwxyz\n");
        }
        contents.push_str("2025-01-01 ERROR [agaric] M31_TAIL_MARKER\n");
        fs::write(log_dir.join("agaric.log"), &contents).unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into(), None, &[]).unwrap();

        // Tail marker survives the cap-truncate-from-head path.
        assert!(
            md.recent_errors
                .iter()
                .any(|l| l.contains("M31_TAIL_MARKER")),
            "tail ERROR marker must survive the cap, got recent_errors: {:?}",
            md.recent_errors
        );
        // Head marker was truncated away by the read cap — it must NOT appear.
        // (If it did, the read was unbounded — the exact regression fixed.)
        assert!(
            !md.recent_errors
                .iter()
                .any(|l| l.contains("M31_HEAD_MARKER")),
            "head ERROR marker must be dropped by the read cap, got recent_errors: {:?}",
            md.recent_errors
        );
    }

    // -- #609: recent_errors redaction (issue-body path) ------------------

    /// #609 — the recent-error tail is embedded verbatim into the
    /// prefilled PUBLIC GitHub issue body by `formatReportBody`
    /// (`src/lib/bug-report.ts`), so it must go through the SAME
    /// redaction pipeline as the ZIP export. Happy path: `$HOME`, the
    /// local device_id, a peer device id, and any stray emails inside
    /// ERROR/WARN lines must all be scrubbed with their canonical
    /// markers before the lines leave the backend.
    #[test]
    fn collect_metadata_redacts_recent_errors_for_issue_body() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();
        let account = "alice@example.com";
        let peer = "peer-device-789";
        fs::write(
            log_dir.join("agaric.log"),
            format!(
                "2025-01-01 ERROR [agaric] open failed path={HOME}/notes.db\n\
                 2025-01-01 ERROR [agaric] device={DEV} sync failed with {peer}\n\
                 2025-01-01 WARN [agaric] push rejected for {account}, cc stray@example.org\n"
            ),
        )
        .unwrap();

        let md = collect_bug_report_metadata_inner(
            dir.path(),
            DEV.into(),
            Some(HOME),
            &[peer.to_string()],
        )
        .unwrap();

        assert_eq!(md.recent_errors.len(), 3);
        let joined = md.recent_errors.join("\n");
        assert!(
            !joined.contains(HOME),
            "home path must be redacted, got: {joined}"
        );
        assert!(
            joined.contains("~/notes.db"),
            "home must become ~, got: {joined}"
        );
        assert!(
            !joined.contains(DEV),
            "device id must be redacted, got: {joined}"
        );
        assert!(
            joined.contains("[REDACTED_DEVICE_ID]"),
            "device-id marker must be present, got: {joined}"
        );
        assert!(
            !joined.contains(peer),
            "peer device id must be redacted, got: {joined}"
        );
        assert!(
            joined.contains("[REDACTED:PEER_DEVICE_ID]"),
            "peer-device-id marker must be present, got: {joined}"
        );
        // Both the account email and the stray email now fall through to
        // the generic `[EMAIL]` catch-all regex — neither raw address
        // may survive.
        assert!(
            !joined.contains(account),
            "account email must be redacted, got: {joined}"
        );
        assert!(
            !joined.contains("stray@example.org"),
            "stray email must be redacted, got: {joined}"
        );
        assert!(
            joined.contains("[EMAIL]"),
            "generic email marker must be present, got: {joined}"
        );
    }

    /// #609 — redaction must be applied even when the optional redaction
    /// inputs are unknown (`None` / `&[]`): JSON-format lines still take
    /// the H-9b deny-list path, so free-text PII the needle list never
    /// knew about (a name, an arbitrary path) collapses to `[REDACTED]`
    /// while safe tokens (timestamp, level, target) survive.
    #[test]
    fn collect_metadata_recent_errors_json_lines_take_deny_list_path() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(
            log_dir.join("agaric.log"),
            concat!(
                r#"{"timestamp":"2026-04-28T10:23:45.123456Z","level":"ERROR","fields":{"message":"failed for user Bob Smith at /home/bob/secret"},"target":"agaric::sync"}"#,
                "\n",
            ),
        )
        .unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), DEV.into(), None, &[]).unwrap();

        assert_eq!(md.recent_errors.len(), 1);
        let line = &md.recent_errors[0];
        assert!(
            !line.contains("Bob Smith") && !line.contains("/home/bob/secret"),
            "free-text PII must be deny-listed, got: {line}"
        );
        assert!(
            line.contains("[REDACTED]"),
            "deny-list marker must be present, got: {line}"
        );
        assert!(
            line.contains("2026-04-28T10:23:45.123456Z") && line.contains("agaric::sync"),
            "safe tokens (timestamp, target) must survive, got: {line}"
        );
    }

    /// #609 evasion probe — the device id embedded INSIDE a JSON string
    /// value. JSON lines short-circuit before [`apply_allow_list`], so the
    /// Aho-Corasick needle pass (which carries the device-id needle) never
    /// runs on them — the deny-list alone must catch it. Two shapes:
    ///
    /// 1. The UUID inside a larger message string — the composite string
    ///    matches no safe-token pattern, so the whole value collapses to
    ///    `[REDACTED]`.
    /// 2. The UUID as a standalone leaf value — a hyphenated UUID matches
    ///    none of [`SAFE_TOKEN_PATTERNS`] (the hex-digest patterns are
    ///    dash-free exact lengths; the ULID pattern is 26-char Crockford),
    ///    so it is redacted too. This would NOT hold for a dash-stripped
    ///    32-hex rendering — the codebase never logs `Uuid::simple()`, and
    ///    this test pins the hyphenated invariant.
    #[test]
    fn collect_metadata_json_embedded_device_id_is_redacted() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();
        // Hyphenated UUID v4 — the on-disk device-id format
        // (`uuid::Uuid::new_v4().to_string()`, see `src/device.rs`).
        let device_id = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
        fs::write(
            log_dir.join("agaric.log"),
            format!(
                concat!(
                    r#"{{"timestamp":"2026-04-28T10:23:45Z","level":"ERROR","#,
                    r#""fields":{{"message":"sync failed for device {id}","peer":"{id}"}},"#,
                    r#""target":"agaric::sync"}}"#,
                    "\n",
                ),
                id = device_id
            ),
        )
        .unwrap();

        let md = collect_bug_report_metadata_inner(dir.path(), device_id.to_string(), None, &[])
            .unwrap();

        assert_eq!(md.recent_errors.len(), 1);
        let line = &md.recent_errors[0];
        assert!(
            !line.contains(device_id),
            "device id must not survive inside JSON string values, got: {line}"
        );
        assert!(
            line.contains("[REDACTED]"),
            "deny-list marker must be present, got: {line}"
        );
    }

    /// #609 edge — an EXISTING but empty `agaric.log` must yield an empty
    /// `recent_errors` (no panic, no synthetic lines) even with the full
    /// redaction input set supplied.
    #[test]
    fn collect_metadata_redaction_with_empty_log_file_returns_empty() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();
        fs::write(log_dir.join("agaric.log"), "").unwrap();

        let md = collect_bug_report_metadata_inner(
            dir.path(),
            DEV.into(),
            Some(HOME),
            &["peer-device-789".to_string()],
        )
        .unwrap();

        assert_eq!(md.recent_errors.len(), 0);
        assert_eq!(md.device_id, DEV);
    }

    /// #609 edge — already-redacted input must round-trip unchanged
    /// (idempotence): markers like `[REDACTED_DEVICE_ID]`, `~`, and
    /// `[EMAIL]` contain no needle and don't match the email shape, so a
    /// second pass through the pipeline is a no-op.
    #[test]
    fn collect_metadata_already_redacted_lines_are_stable() {
        let dir = TempDir::new().unwrap();
        let log_dir = log_dir_for_app_data(dir.path());
        fs::create_dir_all(&log_dir).unwrap();
        let already_redacted =
            "2025-01-01 ERROR [agaric] device=[REDACTED_DEVICE_ID] path=~/notes.db mail=[EMAIL]";
        fs::write(log_dir.join("agaric.log"), format!("{already_redacted}\n")).unwrap();

        let md = collect_bug_report_metadata_inner(
            dir.path(),
            DEV.into(),
            Some(HOME),
            &["peer-device-789".to_string()],
        )
        .unwrap();

        assert_eq!(md.recent_errors.len(), 1);
        assert_eq!(
            md.recent_errors[0], already_redacted,
            "already-redacted line must pass through unchanged"
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
        let out = read_logs_for_report_inner(dir.path(), false, None, None, &[]).unwrap();
        assert_eq!(out.len(), 0);
    }

    #[test]
    fn read_logs_nonexistent_dir_returns_empty() {
        let bogus = PathBuf::from("/tmp/agaric-nonexistent-bug-report-dir");
        let out = read_logs_for_report_inner(&bogus, false, None, None, &[]).unwrap();
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

        let out = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();

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

        let out = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();

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

        let out = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();
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

        let out = read_logs_for_report_inner(log_dir, true, Some(HOME), Some(DEV), &[]).unwrap();

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

        let out = read_logs_for_report_inner(log_dir, true, None, None, &[]).unwrap();

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

        let out = read_logs_for_report_inner(log_dir, false, Some(HOME), Some(DEV), &[]).unwrap();

        assert_eq!(out.len(), 1);
        assert!(out[0].contents.contains(DEV));
        assert!(out[0].contents.contains(HOME));
    }

    // -- #2110 (M7): OpenTelemetry signal files ---------------------------

    /// #2110 (M7) — newest-mtime selection. `newest_otel_file` must return
    /// the most-recently-modified regular file (the live tail of a daily-
    /// rotated sink), skip the older rolled sibling, and ignore non-file
    /// entries.
    #[test]
    fn newest_otel_file_picks_live_tail_over_rolled() {
        let dir = TempDir::new().unwrap();
        let subdir = dir.path().join("traces");
        fs::create_dir_all(&subdir).unwrap();
        // A rolled (older) day plus the live file. Write the rolled file
        // first, then the live one, and stamp the live file's mtime newer so
        // selection is deterministic regardless of write-order resolution.
        let rolled = subdir.join("agaric-traces.log.2026-06-28");
        let live = subdir.join("agaric-traces.log");
        fs::write(&rolled, "rolled span\n").unwrap();
        fs::write(&live, "live span\n").unwrap();
        // A non-file entry that must never be selected.
        fs::create_dir(subdir.join("agaric-traces.log.dir")).unwrap();
        // Force `rolled` strictly OLDER than `live` so newest-mtime selection
        // is deterministic regardless of filesystem mtime resolution.
        let older = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        fs::File::options()
            .write(true)
            .open(&rolled)
            .unwrap()
            .set_modified(older)
            .unwrap();

        let got = newest_otel_file(&subdir).expect("a regular file must be selected");
        assert_eq!(
            got.file_name().and_then(|s| s.to_str()),
            Some("agaric-traces.log"),
            "newest-mtime file (the live tail) must win, got: {got:?}"
        );
    }

    /// #2110 (M7) — `newest_otel_file` never errors on an absent or empty
    /// subdir: observability is off by default, so a missing `traces/` is
    /// the common case and must read as `None`, not a failure.
    #[test]
    fn newest_otel_file_absent_or_empty_is_none() {
        let dir = TempDir::new().unwrap();
        // Absent subdir.
        assert!(newest_otel_file(&dir.path().join("traces")).is_none());
        // Present but empty subdir.
        let empty = dir.path().join("metrics");
        fs::create_dir_all(&empty).unwrap();
        assert!(newest_otel_file(&empty).is_none());
    }

    /// #2110 (M7) — (a) a `log_dir` carrying all three OTel subdirs yields a
    /// `LogFileEntry` per signal, named `<subdir>/<filename>`, in addition to
    /// the `agaric.log` entry. The OTel entries come AFTER the `agaric.log`
    /// tail so the bundle cap trims them first.
    #[test]
    fn read_logs_includes_otel_signal_files_with_subdir_naming() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        fs::write(log_dir.join("agaric.log"), "today content\n").unwrap();
        // Realistic signal lines (tab-separated `key=value`) — #3317 made the
        // OTel branch parse that shape, so a prose fixture would no longer
        // exercise the production path.
        for (subdir, file, body) in [
            (
                "traces",
                "agaric-traces.log",
                "end=2026-08-09T10:23:45.123Z\tname=create_block\ttrace=-\tspan=-\t\
                 parent=-\tdur_ms=1.500\tstatus=Ok\n",
            ),
            (
                "otel-logs",
                "agaric-otel.log",
                "end=2026-08-09T10:23:45.123Z\tlevel=INFO\ttrace=-\tspan=-\t\
                 target=agaric::commands\tbody=compaction starting\n",
            ),
            (
                "metrics",
                "agaric-metrics.log",
                "end=2026-08-09T10:23:45.123Z\tmetric=agaric.ipc.duration\tcount=3\t\
                 sum=1.500\tmin=0.100\tmax=1.000\n",
            ),
        ] {
            let sd = log_dir.join(subdir);
            fs::create_dir_all(&sd).unwrap();
            fs::write(sd.join(file), body).unwrap();
        }

        let out = read_logs_for_report_inner(log_dir, true, Some(HOME), Some(DEV), &[]).unwrap();

        // agaric.log + 3 OTel signal files.
        assert_eq!(
            out.len(),
            4,
            "expected agaric.log + 3 OTel files, got: {out:?}"
        );
        // agaric.log is prioritised first (newest-first ordering).
        assert_eq!(out[0].name, "agaric.log");
        let names: Vec<&str> = out.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"traces/agaric-traces.log"),
            "traces entry must use <subdir>/<name>, got: {names:?}"
        );
        assert!(
            names.contains(&"otel-logs/agaric-otel.log"),
            "otel-logs entry must use <subdir>/<name>, got: {names:?}"
        );
        assert!(
            names.contains(&"metrics/agaric-metrics.log"),
            "metrics entry must use <subdir>/<name>, got: {names:?}"
        );
        // The OTel entries follow the agaric.log tail (cap-trim ordering).
        let traces_idx = names.iter().position(|n| n.starts_with("traces/")).unwrap();
        assert!(
            traces_idx > 0,
            "OTel entries must come after agaric.log, got: {names:?}"
        );
        // Content survived the (redact=true) pipeline for a PII-free body.
        let traces = out
            .iter()
            .find(|e| e.name == "traces/agaric-traces.log")
            .unwrap();
        assert!(
            traces.contents.contains("name=create_block"),
            "the span skeleton survives redaction: {}",
            traces.contents
        );
    }

    /// #2110 (M7) — (b) absent OTel subdirs ⇒ only the `agaric.log` entries,
    /// no error. The off-by-default observability path must not synthesize
    /// entries or fail the report.
    #[test]
    fn read_logs_absent_otel_subdirs_yields_only_agaric_log() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        fs::write(log_dir.join("agaric.log"), "today content\n").unwrap();

        let out = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();

        assert_eq!(out.len(), 1, "no OTel dirs ⇒ only agaric.log, got: {out:?}");
        assert_eq!(out[0].name, "agaric.log");
    }

    /// #2110 (M7) — (c) redaction still applies to an OTel line carrying a
    /// home path / device id (defense-in-depth). The OTel files flow through
    /// the SAME `redact_log` path as `agaric.log`, so a text-format line with
    /// `$HOME` and the local device id must be scrubbed.
    #[test]
    fn read_logs_redacts_otel_signal_lines() {
        let dir = TempDir::new().unwrap();
        let log_dir = dir.path();
        fs::write(log_dir.join("agaric.log"), "ok\n").unwrap();
        let sd = log_dir.join("traces");
        fs::create_dir_all(&sd).unwrap();
        // A span line that leaked a home path + device id as attributes.
        fs::write(
            sd.join("agaric-traces.log"),
            format!(
                "end=2026-08-09T10:23:45.123Z\tname=export\ttrace=-\tspan=-\tparent=-\t\
                 dur_ms=1.000\tstatus=Ok\tpath={HOME}/notes.db\tdevice={DEV}\n"
            ),
        )
        .unwrap();

        let out = read_logs_for_report_inner(log_dir, true, Some(HOME), Some(DEV), &[]).unwrap();

        let traces = out
            .iter()
            .find(|e| e.name == "traces/agaric-traces.log")
            .expect("traces entry must be present");
        assert!(
            !traces.contents.contains(HOME),
            "home path must be scrubbed in OTel file, got: {}",
            traces.contents
        );
        // #3317 — deny-by-default now fires FIRST: an attribute value that is
        // not a safe token never reaches the H-9a needle pass, so the path
        // collapses whole rather than surviving as `~/notes.db`. That is
        // strictly stronger; the needle pass still covers safe-token-shaped
        // identifiers (see `otel_branch_keeps_the_h9a_needle_scrubs`).
        assert!(
            traces.contents.contains("path=[REDACTED]"),
            "a filesystem path attribute must be denied by default, got: {}",
            traces.contents
        );
        assert!(
            !traces.contents.contains(DEV),
            "device id must be scrubbed in OTel file, got: {}",
            traces.contents
        );
        assert!(
            traces.contents.contains("device=[REDACTED_DEVICE_ID]")
                || traces.contents.contains("device=[REDACTED]"),
            "the device id must be replaced by a marker, got: {}",
            traces.contents
        );
    }

    // -- silent-drop sites now warn -------------------------------

    /// A non-file entry under the log dir (e.g., a directory)
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

        let out = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();

        assert_eq!(
            out.len(),
            1,
            "directory entry must be excluded; only agaric.log survives",
        );
        assert_eq!(out[0].name, "agaric.log");
    }

    /// A file whose `read_capped_file` fails (e.g., permission
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

        let out = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();

        if running_as_root {
            // Restore so TempDir cleanup works.
            fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).ok();
            assert!(
                out.iter().any(|e| e.name == "agaric.log"),
                "running as root: kernel ignores 0o000 mode, can't trigger the  warn path",
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

    // -- apply_bundle_cap -----------------------------------------

    /// When the running total stays under [`MAX_BUNDLE_BYTES`],
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

    /// When the running total exceeds [`MAX_BUNDLE_BYTES`] the
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

    /// H-9a (1) — an account email in a log line is scrubbed by the
    /// generic catch-all regex: the original literal must not survive
    /// and the `[EMAIL]` marker must be present.
    #[test]
    fn redact_line_replaces_email_via_generic_regex() {
        let line = "2025-01-01 INFO [agaric] account=me@gmail.com synced 12 events";
        let out = redact_line(line, &RedactionContext::default());
        assert!(
            !out.contains("me@gmail.com"),
            "account email must be redacted, got: {out}"
        );
        assert!(
            out.contains("[EMAIL]"),
            "generic [EMAIL] marker must be present, got: {out}"
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

    /// H-9a (3) — the catch-all email regex must scrub stray emails
    /// (e.g. an upstream library logging a support address, an error
    /// message echoing a third party's email).
    #[test]
    fn redact_line_email_regex_catches_unknown_emails() {
        let line = "2025-01-01 ERROR upstream=random@example.com timed out";
        // Any email present must fall to the catch-all regex.
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
        assert!(is_safe_token("agaric_core::error::AppError"));
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
        assert!(out.contains('~'), "tilde replacement: {out}");
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
        let out = redact_log(contents, &ctx, LineFormat::TracingLog);
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
        assert!(out.contains('~'), "tilde marker present: {out}");
    }

    /// Single-pass Aho-Corasick scrub on the text-fallback path must
    /// produce byte-identical output to the legacy cascade of
    /// `String::replace` calls for realistic inputs (home + device_id +
    /// multiple peers across multiple lines, in mixed order, including an
    /// overlap case where one peer's prefix is shared with another peer's
    /// full ID). The expected string below is the hand-computed result of
    /// the legacy ordering:
    ///   1. home -> `~`
    ///   2. device_id -> `[REDACTED_DEVICE_ID]`
    ///   3. each peer_device_id -> `[REDACTED:PEER_DEVICE_ID]`
    ///   4. generic email regex -> `[EMAIL]`
    ///
    /// The matcher uses `MatchKind::LeftmostLongest`, so when one peer
    /// (e.g. `01HZQ7-PEER-AAA`) is a substring of another
    /// (e.g. `01HZQ7-PEER-AAA-LONG`) the longest match wins — this is
    /// the secure-by-default posture and matches the user-intuitive
    /// "scrub the most-specific identifier" semantics.
    #[test]
    fn redact_log_single_pass_matches_legacy_output() {
        let peers = vec![
            "01HZQ7-PEER-AAA".to_string(),
            "01HZQ7-PEER-AAA-LONG".to_string(),
            "01HZQ7-PEER-BBB".to_string(),
        ];
        let ctx = RedactionContext {
            home: Some("/home/alice"),
            device_id: Some("DEV-LOCAL-XYZ"),
            peer_device_ids: &peers,
        };
        let input = "\
2025-01-01 INFO [agaric] path=/home/alice/notes.db device=DEV-LOCAL-XYZ\n\
2025-01-01 INFO [agaric] account=alice@gmail.com synced 5 events\n\
2025-01-01 DEBUG [sync] peer=01HZQ7-PEER-BBB forwarded to 01HZQ7-PEER-AAA\n\
2025-01-01 DEBUG [sync] long peer=01HZQ7-PEER-AAA-LONG reachable\n\
2025-01-01 ERROR upstream=bob@example.org timed out at /home/alice/cache\n";
        let expected = "\
2025-01-01 INFO [agaric] path=~/notes.db device=[REDACTED_DEVICE_ID]\n\
2025-01-01 INFO [agaric] account=[EMAIL] synced 5 events\n\
2025-01-01 DEBUG [sync] peer=[REDACTED:PEER_DEVICE_ID] forwarded to [REDACTED:PEER_DEVICE_ID]\n\
2025-01-01 DEBUG [sync] long peer=[REDACTED:PEER_DEVICE_ID] reachable\n\
2025-01-01 ERROR upstream=[EMAIL] timed out at ~/cache\n";
        let out = redact_log(input, &ctx, LineFormat::TracingLog);
        assert_eq!(
            out, expected,
            "single-pass Aho-Corasick output diverged from hand-computed legacy expectation"
        );
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

    // -- home_dir_string ------------------------------------------

    /// On Linux/macOS the standard CI environments set `$HOME`, so
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

    /// On Windows, `dirs::home_dir()` resolves through `USERPROFILE`
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

    // =================================================================
    // #3317 — OTel signal files take the deny-by-default kv path
    // =================================================================

    /// A realistic `otel-logs/agaric-otel.log` line: the bridged form of
    /// `tracing::info!(page = %page_title, blocks_total, space = %space_id, …)`
    /// from `import_markdown_with_progress`.
    fn otel_log_line(page_title: &str) -> String {
        format!(
            "end=2026-08-09T10:23:45.123Z\tlevel=INFO\t\
             trace=4bf92f3577b34da6a3ce929d0e0e4736\tspan=00f067aa0ba902b7\t\
             target=agaric::commands::pages::markdown\t\
             body=import: starting markdown import\t\
             page={page_title}\tblocks_total=42\tspace=01ARZ3NDEKTSV4RRFFQ69G5FAV"
        )
    }

    /// The headline #3317 regression: a page title bridged into an OTel log
    /// record must not survive redaction. Reverting `LineFormat::OtelSignal`
    /// to the old sniff (or `redact_kv_line` to `apply_allow_list`) turns this
    /// red — the title rides through the allow-list verbatim.
    #[test]
    fn otel_log_attribute_value_is_redacted() {
        let title = "Quarterly Board Notes/Layoffs";
        let out = redact_log(
            &format!("{}\n", otel_log_line(title)),
            &RedactionContext::default(),
            LineFormat::OtelSignal,
        );
        assert!(
            !out.contains(title),
            "a bridged page title must never survive into the bundle: {out}"
        );
        assert!(
            out.contains("page=[REDACTED]"),
            "the attribute KEY stays, the value goes: {out}"
        );
        // The structural skeleton stays readable — redaction that destroys the
        // whole line is not the goal.
        assert!(out.contains("level=INFO"), "level survives: {out}");
        assert!(
            out.contains("target=agaric::commands::pages::markdown"),
            "target survives: {out}"
        );
        assert!(
            out.contains("trace=4bf92f3577b34da6a3ce929d0e0e4736"),
            "trace id survives: {out}"
        );
        assert!(
            out.contains("blocks_total=42"),
            "an integer attribute survives: {out}"
        );
        assert!(
            out.contains("space=01ARZ3NDEKTSV4RRFFQ69G5FAV"),
            "a ULID attribute survives: {out}"
        );
    }

    /// Deny-by-default is the point: an attribute nobody has thought of yet is
    /// redacted without anyone editing this file. Any future
    /// `#[instrument(fields(…))]` / `tracing::info!(…)` field that carries free
    /// text is covered by construction.
    #[test]
    fn unknown_otel_attribute_with_free_text_is_denied_by_default() {
        let line = "end=2026-08-09T10:23:45.123Z\tlevel=INFO\ttrace=-\tspan=-\t\
                    target=agaric::commands::search\tbody=search\t\
                    a_field_invented_tomorrow=my private search phrase";
        let out = redact_line_with_redactor(
            line,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(
            out.ends_with("a_field_invented_tomorrow=[REDACTED]"),
            "an unknown attribute must be denied by default: {out}"
        );
    }

    /// A span line from `traces/`: the skeleton (dotted span name, fractional
    /// duration, status tag, `-` parent) must round-trip, while an attribute
    /// carrying a title must not.
    #[test]
    fn otel_span_line_keeps_skeleton_and_redacts_content() {
        let line = "end=2026-08-09T10:23:45.123Z\tname=materializer.run_foreground\t\
                    trace=4bf92f3577b34da6a3ce929d0e0e4736\tspan=00f067aa0ba902b7\t\
                    parent=-\tdur_ms=12.345\tstatus=Unset\t\
                    page_title=My Secret Page\tblocks_total=7";
        let out = redact_line_with_redactor(
            line,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(out.contains("name=materializer.run_foreground"), "{out}");
        assert!(out.contains("parent=-"), "{out}");
        assert!(out.contains("dur_ms=12.345"), "{out}");
        assert!(out.contains("status=Unset"), "{out}");
        assert!(out.contains("blocks_total=7"), "{out}");
        assert!(
            out.contains("page_title=[REDACTED]") && !out.contains("My Secret Page"),
            "a content-bearing span attribute must be redacted: {out}"
        );
    }

    /// The skeleton allowance is positional. An *attribute* that collides with
    /// a format key (`name`, `body`, `status`) sits after the skeleton run and
    /// gets the plain deny-by-default test, so it cannot borrow the widening.
    #[test]
    fn attribute_cannot_borrow_the_skeleton_allowance() {
        let line = "end=2026-08-09T10:23:45.123Z\tname=create_block\ttrace=-\tspan=-\t\
                    parent=-\tdur_ms=1.000\tstatus=Ok\tnote=Groceries\tname=Groceries";
        let out = redact_line_with_redactor(
            line,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(
            out.contains("name=create_block"),
            "the skeleton span name survives: {out}"
        );
        assert!(
            !out.contains("Groceries"),
            "a label-shaped attribute value after the skeleton must still be \
             redacted (it is not a safe token): {out}"
        );
        assert_eq!(
            out.matches("[REDACTED]").count(),
            2,
            "both trailing attributes are redacted: {out}"
        );
    }

    /// #3712 — the skeleton allowance must be bound to one format's EXACT
    /// key sequence, not to `SKELETON_KEYS` set membership. This line is a
    /// `format_log_record` skeleton (`end level trace span target body`,
    /// six fields) followed directly by an attribute named `name` — `name`
    /// is not part of `format_log_record`'s skeleton, but it IS a member of
    /// the flattened union (it belongs to `format_span` and
    /// `write_frontend_span`). A membership-only check keeps `in_skeleton`
    /// true across the boundary and lets `name`'s value borrow the
    /// `is_signal_label` widening reserved for a real span/log skeleton
    /// field; the position-bound check must not.
    ///
    /// Reverting `redact_kv_line` to the `SKELETON_KEYS`-membership check
    /// this replaced turns this red: the identifier-shaped project-name
    /// value slips through unredacted as `name=Q3-Layoffs-Plan`.
    #[test]
    fn skeleton_allowance_does_not_cross_a_different_formats_boundary() {
        let line = "end=2026-08-09T10:23:45.123Z\tlevel=INFO\ttrace=-\tspan=-\t\
                    target=agaric::commands::projects\t\
                    body=background queue full, dropping task\t\
                    name=Q3-Layoffs-Plan";
        let out = redact_line_with_redactor(
            line,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        // The genuine log-record skeleton still survives.
        assert!(out.contains("level=INFO"), "{out}");
        assert!(out.contains("target=agaric::commands::projects"), "{out}");
        assert!(
            out.contains("body=background queue full, dropping task"),
            "a STABLE_MESSAGES body inside the real skeleton still survives: {out}"
        );
        // The 7th field is past this format's skeleton — its value must be
        // denied by default, not waved through as if it were a span name.
        assert!(
            !out.contains("Q3-Layoffs-Plan"),
            "an attribute past the log-record skeleton must not borrow the \
             skeleton's identifier-label allowance: {out}"
        );
        assert!(
            out.contains("name=[REDACTED]"),
            "the out-of-bounds attribute is redacted: {out}"
        );
    }

    /// #3712 — the whole-line truncation marker `read_capped_file` prepends
    /// to an oversized file's tail carries no `=`, so on the `OtelSignal`
    /// branch `redact_kv_line`'s deny-by-default fallback used to collapse
    /// it to `[REDACTED]`, erasing the notice that content was dropped.
    ///
    /// Deleting `is_truncation_marker_line`'s early return in `redact_kv_line`
    /// turns this red: the marker becomes indistinguishable from any other
    /// unstructured line and is denied by default.
    #[test]
    fn otel_truncation_marker_survives_redaction() {
        let marker = "…[truncated 2048 bytes of older content]";
        let out = redact_line_with_redactor(
            marker,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert_eq!(out, marker, "the truncation marker must round-trip: {out}");
    }

    /// The truncation-marker exemption must be the marker, not its two
    /// bookends. `starts_with(prefix) && ends_with(suffix)` — the shape the
    /// exemption shipped as — echoes ANYTHING between them, so a line forged
    /// to wear the marker's bookends smuggles its middle straight past a
    /// deny-by-default redactor.
    ///
    /// Relaxing `is_truncation_marker_line` back to
    /// `starts_with(…) && ends_with(…)` turns this red: the page title in
    /// the middle is echoed verbatim.
    #[test]
    fn a_forged_truncation_marker_does_not_smuggle_content_through() {
        for forged in [
            "…[truncated Q3-Layoffs-Plan bytes of older content]",
            "…[truncated 2048 bytes of older content] extra bytes of older content]",
            "…[truncated  bytes of older content]",
        ] {
            let out = redact_line_with_redactor(
                forged,
                &Redactor::new(&RedactionContext::default()),
                LineFormat::OtelSignal,
            );
            assert_eq!(
                out, REDACTED,
                "only a digits-only byte count is exempt; this must be denied: {forged:?} -> {out}"
            );
        }
        // The real marker is unaffected by the tightening.
        assert!(is_truncation_marker_line(
            "…[truncated 2048 bytes of older content]"
        ));
    }

    /// A `body` outside [`STABLE_MESSAGES`] is redacted (a formatted message
    /// can interpolate user content); a stable literal survives, exactly as
    /// `message` does on the JSON path.
    #[test]
    fn otel_body_follows_the_stable_message_rule() {
        let base = "end=2026-08-09T10:23:45.123Z\tlevel=WARN\ttrace=-\tspan=-\t\
                    target=agaric::materializer\tbody=";
        let stable = redact_line_with_redactor(
            &format!("{base}background queue full, dropping task"),
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(
            stable.ends_with("body=background queue full, dropping task"),
            "a STABLE_MESSAGES body survives: {stable}"
        );
        let freeform = redact_line_with_redactor(
            &format!("{base}could not open /home/ada/notes/Private Journal.md"),
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(
            freeform.ends_with("body=[REDACTED]"),
            "a free-text body is redacted: {freeform}"
        );
    }

    /// A `status=Error { description: … }` embeds the error's text, which
    /// routinely names a path or a title. Only the closed set of status tags
    /// is allowed through.
    #[test]
    fn otel_span_error_status_description_is_redacted() {
        let line = "end=2026-08-09T10:23:45.123Z\tname=import_markdown\ttrace=-\tspan=-\t\
                    parent=-\tdur_ms=1.000\tstatus=Error { description: \"no such file: \
                    /home/ada/vault/Diary.md\" }";
        let out = redact_line_with_redactor(
            line,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(
            !out.contains("Diary.md"),
            "an error description must not survive: {out}"
        );
    }

    /// Frontend spans are ingested straight off the IPC, so an attribute KEY is
    /// as untrusted as its value. A prose "key" is redacted rather than echoed.
    #[test]
    fn free_text_attribute_key_is_redacted_too() {
        let line = "end=2026-08-09T10:23:45.123Z\tservice=agaric-frontend\t\
                    name=click_create_block\ttrace=-\tspan=-\tparent=-\tdur_ms=3.000\t\
                    status=ok\tthe user typed this=1";
        let out = redact_line_with_redactor(
            line,
            &Redactor::new(&RedactionContext::default()),
            LineFormat::OtelSignal,
        );
        assert!(out.contains("service=agaric-frontend"), "{out}");
        assert!(out.contains("status=ok"), "{out}");
        assert!(
            !out.contains("the user typed this"),
            "a prose attribute key must be redacted: {out}"
        );
    }

    /// H-9a is not lost on this branch: the static needles (home path, device
    /// id, peer ids) and the email catch-all still run after the deny-list, so
    /// an identifier that IS a safe token by shape is still scrubbed.
    #[test]
    fn otel_branch_keeps_the_h9a_needle_scrubs() {
        const DEV: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
        let line = format!(
            "end=2026-08-09T10:23:45.123Z\tname=sync.try_sync_with_peer\ttrace=-\tspan=-\t\
             parent=-\tdur_ms=1.000\tstatus=Ok\tpeer={DEV}"
        );
        let out = redact_line_with_redactor(
            &line,
            &Redactor::new(&RedactionContext {
                home: None,
                device_id: Some(DEV),
                peer_device_ids: &[],
            }),
            LineFormat::OtelSignal,
        );
        assert!(
            out.contains("peer=[REDACTED_DEVICE_ID]"),
            "the device-id needle still fires on the OTel branch: {out}"
        );
    }

    /// End-to-end + structural: EVERY subdir in [`OTEL_SUBDIRS`] is bundled
    /// through the deny-by-default path. Adding a fourth signal dir to that
    /// const inherits the treatment (one loop, one `LineFormat`), and this test
    /// proves it for whatever the const currently holds.
    #[test]
    fn every_otel_subdir_is_redacted_deny_by_default() {
        let dir = tempfile::tempdir().unwrap();
        let log_dir = dir.path();
        std::fs::write(log_dir.join("agaric.log"), "{}\n").unwrap();

        let secret = "Zzyzx Confidential Merger Memo";
        for subdir in OTEL_SUBDIRS {
            let sub = log_dir.join(subdir);
            std::fs::create_dir_all(&sub).unwrap();
            std::fs::write(
                sub.join("agaric-signal.log"),
                format!("{}\n", otel_log_line(secret)),
            )
            .unwrap();
        }

        let out = read_logs_for_report_inner(log_dir, true, None, None, &[]).unwrap();
        for subdir in OTEL_SUBDIRS {
            let entry = out
                .iter()
                .find(|e| e.name.starts_with(&format!("{subdir}/")))
                .unwrap_or_else(|| panic!("{subdir} must appear in the bundle: {out:?}"));
            assert!(
                !entry.contents.contains(secret),
                "{subdir} leaked user content into the bundle: {}",
                entry.contents
            );
        }

        // And the unredacted path is unchanged — `redact: false` is the user
        // explicitly asking for raw logs, so this must still round-trip.
        let raw = read_logs_for_report_inner(log_dir, false, None, None, &[]).unwrap();
        assert!(
            raw.iter().any(|e| e.contents.contains(secret)),
            "redact=false must still bundle the raw signal files"
        );
    }
}
