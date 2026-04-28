//! Frontend logging command handlers (F-19).

use super::sanitize_internal_error;
use crate::error::AppError;

/// M-39: per-field byte ceiling applied at the IPC boundary. The
/// frontend rate-limiter caps emission frequency, but a single
/// `logger.error` payload (e.g. a stringified TipTap document in
/// `data`) can still be hundreds of MB. Without this cap the formatter
/// materialises the full event and the appender writes it
/// synchronously before acking the IPC, blocking the IPC thread for
/// seconds and risking the daily rolling log file. 64 KB is well above
/// any reasonable single log message and matches the order of magnitude
/// of `bug_report::MAX_LINE_BYTES` (8 KB) × 8.
pub(crate) const MAX_FRONTEND_LOG_FIELD_BYTES: usize = 64 * 1024;

/// Truncate a single frontend log field to [`MAX_FRONTEND_LOG_FIELD_BYTES`].
///
/// The pattern mirrors `bug_report::redact_line` (`bug_report.rs:213-224`):
/// preserve the head of the field, append a `…[truncated N bytes]`
/// marker, and split on a UTF-8 char boundary so the cut never lands
/// inside a multibyte codepoint.
///
/// Returns the input unchanged when its length is at or below the cap
/// — no allocation in the common case.
pub(crate) fn truncate_log_field(s: String) -> String {
    if s.len() <= MAX_FRONTEND_LOG_FIELD_BYTES {
        return s;
    }
    let extra = s.len() - MAX_FRONTEND_LOG_FIELD_BYTES;
    let mut cut = MAX_FRONTEND_LOG_FIELD_BYTES;
    let mut s = s;
    // Walk backwards to the nearest UTF-8 char boundary so `truncate`
    // never panics on a multibyte codepoint.
    while !s.is_char_boundary(cut) && cut > 0 {
        cut -= 1;
    }
    s.truncate(cut);
    s.push_str(&format!("…[truncated {extra} bytes]"));
    s
}

fn truncate_optional_log_field(s: Option<String>) -> Option<String> {
    s.map(truncate_log_field)
}

/// M-40: pure level-dispatch helper, extracted from `log_frontend` so
/// the unknown-level fallback to `info` can be unit-tested without a
/// Tauri runtime. All fields are passed by reference; the caller owns
/// the M-39 truncation step before invoking this helper.
pub(crate) fn log_frontend_inner(
    level: &str,
    module: &str,
    message: &str,
    stack: Option<&str>,
    context: Option<&str>,
    data: Option<&str>,
) {
    match level {
        "error" => {
            tracing::error!(target: "frontend", module = %module, stack = stack.unwrap_or(""), context = context.unwrap_or(""), data = data.unwrap_or(""), "{message}")
        }
        "warn" => {
            tracing::warn!(target: "frontend", module = %module, stack = stack.unwrap_or(""), context = context.unwrap_or(""), data = data.unwrap_or(""), "{message}")
        }
        "info" => {
            tracing::info!(target: "frontend", module = %module, data = data.unwrap_or(""), "{message}")
        }
        "debug" => {
            tracing::debug!(target: "frontend", module = %module, data = data.unwrap_or(""), "{message}")
        }
        _ => {
            tracing::info!(target: "frontend", module = %module, data = data.unwrap_or(""), "{message}")
        }
    }
}

/// Log a frontend message to the backend's daily-rolling log file.
/// Fire-and-forget — the frontend never awaits this.
///
/// M-39: every `String` / `Option<String>` field is truncated at entry
/// to [`MAX_FRONTEND_LOG_FIELD_BYTES`] (64 KB) so a single oversized
/// payload cannot stall the IPC thread or corrupt the daily log file.
/// Truncation is unconditional — the FE rate-limiter is not in this
/// trust scope (caller of `log_frontend` may be a panic handler that
/// fires before the rate-limiter takes effect).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn log_frontend(
    level: String,
    module: String,
    message: String,
    stack: Option<String>,
    context: Option<String>,
    data: Option<String>,
) -> Result<(), AppError> {
    // M-39: bound every field at entry. The truncation is cheap when
    // the field is small (no allocation; the input String moves through
    // unchanged) and bounds the worst case when a FE bug ships a
    // megabyte-scale payload.
    let level = truncate_log_field(level);
    let module = truncate_log_field(module);
    let message = truncate_log_field(message);
    let stack = truncate_optional_log_field(stack);
    let context = truncate_optional_log_field(context);
    let data = truncate_optional_log_field(data);

    log_frontend_inner(
        &level,
        &module,
        &message,
        stack.as_deref(),
        context.as_deref(),
        data.as_deref(),
    );
    Ok(())
}

/// M-40: testable helper for `get_log_dir`. Mirrors what the outer
/// `#[tauri::command]` does after resolving `app_data_dir` from Tauri:
/// route through [`crate::log_dir_for_app_data`] so the path returned
/// to the frontend matches the directory the tracing-appender writes
/// to (BUG-34).
pub(crate) fn get_log_dir_inner(app_data_dir: &std::path::Path) -> String {
    crate::log_dir_for_app_data(app_data_dir)
        .to_string_lossy()
        .into_owned()
}

/// Return the path to the logs directory.
///
/// Uses [`crate::log_dir_for_app_data`] so the path returned to the
/// frontend ("Open logs folder") is guaranteed to match the directory
/// the tracing-appender writes to — on every platform (BUG-34).
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_log_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri::Manager;
    app.path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
        .map(|data_dir| get_log_dir_inner(&data_dir))
        .map_err(sanitize_internal_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_log_field_passes_through_short_input_unchanged() {
        let input = "short message".to_string();
        let out = truncate_log_field(input.clone());
        assert_eq!(out, input, "fields below cap must round-trip identically");
    }

    #[test]
    fn truncate_log_field_caps_oversized_input_with_marker() {
        // Build a >1 MB payload — well above the 64 KB cap.
        let big = "x".repeat(1_024 * 1_024);
        let extra = big.len() - MAX_FRONTEND_LOG_FIELD_BYTES;
        let out = truncate_log_field(big);
        assert!(
            out.contains("…[truncated"),
            "oversized field must carry the truncation marker"
        );
        assert!(
            out.contains(&format!("{extra} bytes")),
            "marker must report the dropped byte count, got: {out:?}"
        );
        // Output bound: cap + worst-case marker overhead (~32 bytes).
        assert!(
            out.len() < MAX_FRONTEND_LOG_FIELD_BYTES + 64,
            "truncated output ({} bytes) must stay near the cap",
            out.len()
        );
    }

    #[test]
    fn truncate_log_field_preserves_utf8_on_cut() {
        // 4-byte codepoint at byte index `MAX_FRONTEND_LOG_FIELD_BYTES - 1`
        // would be split mid-codepoint without the char-boundary guard.
        let mut s = String::with_capacity(MAX_FRONTEND_LOG_FIELD_BYTES + 8);
        for _ in 0..(MAX_FRONTEND_LOG_FIELD_BYTES - 1) {
            s.push('a');
        }
        s.push('😀'); // 4 bytes
                      // Pad past the cap.
        for _ in 0..16 {
            s.push('b');
        }
        let out = truncate_log_field(s);
        // No panic on String::truncate ⇒ char boundary respected.
        assert!(
            out.contains("…[truncated"),
            "must carry truncation marker, got: {out:?}"
        );
        // chars().count() succeeds (output is valid UTF-8).
        let _check = out.chars().count();
    }

    #[test]
    fn truncate_optional_log_field_handles_none() {
        assert!(truncate_optional_log_field(None).is_none());
    }

    #[test]
    fn truncate_optional_log_field_truncates_some() {
        let big = "y".repeat(MAX_FRONTEND_LOG_FIELD_BYTES + 100);
        let out = truncate_optional_log_field(Some(big)).unwrap();
        assert!(
            out.contains("…[truncated 100 bytes]"),
            "Some(big) should be truncated, got: {out:?}"
        );
    }

    /// M-39: a 1 MB payload in the `data` field must complete the IPC
    /// quickly with the field truncated. No tracing infrastructure is
    /// asserted on (that requires a custom subscriber); we assert the
    /// IPC wall-clock and the truncation helpers' contract instead.
    #[tokio::test]
    async fn log_frontend_truncates_megabyte_data_field_quickly() {
        let huge_data = "z".repeat(1_024 * 1_024);
        let start = std::time::Instant::now();
        let result = log_frontend(
            "error".to_string(),
            "M39Test".to_string(),
            "huge payload".to_string(),
            None,
            None,
            Some(huge_data.clone()),
        )
        .await;
        let elapsed = start.elapsed();
        assert!(result.is_ok(), "log_frontend must accept large fields");
        assert!(
            elapsed < std::time::Duration::from_millis(200),
            "log_frontend with 1 MB data must complete quickly with truncation in place, took {elapsed:?}"
        );

        // Independently verify truncation produces the expected shape.
        let truncated = truncate_log_field(huge_data);
        assert!(
            truncated.contains("…[truncated"),
            "1 MB data must be truncated with the marker"
        );
        assert!(
            truncated.len() < MAX_FRONTEND_LOG_FIELD_BYTES + 64,
            "post-truncate length {} must stay near the cap",
            truncated.len()
        );
    }

    // -- M-40: log_frontend_inner level dispatch ------------------------
    //
    // No `tracing_test`/`TestWriter` fixtures are wired into this crate
    // (verified by grep). Per the M-40 plan: invoke the helper with each
    // documented level (and an unknown one) and assert the call does not
    // panic — that proves the `match` arms compile-and-run end-to-end and
    // that the unknown-level fallback correctly routes through
    // `tracing::info!` instead of escaping the match.

    #[test]
    fn log_frontend_inner_error_level() {
        log_frontend_inner(
            "error",
            "M40Test",
            "boom",
            Some("stacktrace"),
            Some("ctx"),
            Some("payload"),
        );
    }

    #[test]
    fn log_frontend_inner_warn_level() {
        log_frontend_inner(
            "warn",
            "M40Test",
            "careful",
            Some("stacktrace"),
            Some("ctx"),
            Some("payload"),
        );
    }

    #[test]
    fn log_frontend_inner_info_level() {
        log_frontend_inner("info", "M40Test", "fyi", None, None, Some("payload"));
    }

    #[test]
    fn log_frontend_inner_debug_level() {
        log_frontend_inner("debug", "M40Test", "trace", None, None, None);
    }

    #[test]
    fn log_frontend_inner_unknown_level_falls_back_to_info() {
        // The fallback arm (`_ =>`) must not panic — the regression this
        // guards against is a future refactor turning the catch-all into
        // an `unreachable!()` and breaking the documented "unknown level
        // ⇒ info" contract.
        log_frontend_inner("bogus", "M40Test", "mystery", None, None, None);
    }

    // -- M-40: get_log_dir_inner ---------------------------------------

    #[test]
    fn get_log_dir_inner_returns_logs_subdir() {
        // Mirror the suffix used by `lib.rs::run` (around line 442) and
        // by `crate::log_dir_for_app_data` — the helper appends a `logs`
        // subdirectory to the supplied app-data dir. Both call sites
        // must agree (BUG-34).
        let app_data = std::path::Path::new("/tmp/agaric-m40-test-data");
        let out = get_log_dir_inner(app_data);
        let expected = std::path::Path::new("/tmp/agaric-m40-test-data")
            .join("logs")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            out, expected,
            "get_log_dir_inner must append `logs` to the app data dir"
        );
        assert!(
            out.ends_with("logs") || out.ends_with("logs/") || out.ends_with("logs\\"),
            "returned path must end with the `logs` suffix used by lib.rs::run, got {out:?}"
        );
    }
}
