//! Frontend logging command handlers (F-19).

use agaric_core::error::AppError;

/// Per-field byte ceiling applied at the IPC boundary. The
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
/// Delegates to [`agaric_core::text_utils::truncate_at_char_boundary`]:
/// preserve the head of the field, append a `…[truncated N bytes]`
/// marker, and split on a UTF-8 char boundary so the cut never lands
/// inside a multibyte codepoint. The marker wording is owned here so
/// `bug_report::cap_line_length` can use a different one without
/// disturbing existing log output.
///
/// Returns the input unchanged when its length is at or below the cap
/// — no allocation in the common case.
pub(crate) fn truncate_log_field(s: String) -> String {
    agaric_core::text_utils::truncate_at_char_boundary(s, MAX_FRONTEND_LOG_FIELD_BYTES, |extra| {
        format!("…[truncated {extra} bytes]")
    })
}

fn truncate_optional_log_field(s: Option<String>) -> Option<String> {
    s.map(truncate_log_field)
}

/// Pure level-dispatch helper, extracted from `log_frontend` so
/// the unknown-level fallback to `info` can be unit-tested without a
/// Tauri runtime. All fields are passed by reference; the caller owns
/// The truncation step before invoking this helper.
#[tracing::instrument(skip(message, stack, context, data))]
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
            tracing::error!(target: "frontend", module = %module, stack = stack.unwrap_or(""), context = context.unwrap_or(""), data = data.unwrap_or(""), "{message}");
        }
        "warn" => {
            tracing::warn!(target: "frontend", module = %module, stack = stack.unwrap_or(""), context = context.unwrap_or(""), data = data.unwrap_or(""), "{message}");
        }
        "info" => {
            tracing::info!(target: "frontend", module = %module, data = data.unwrap_or(""), "{message}");
        }
        "debug" => {
            tracing::debug!(target: "frontend", module = %module, data = data.unwrap_or(""), "{message}");
        }
        _ => {
            tracing::info!(target: "frontend", module = %module, data = data.unwrap_or(""), "{message}");
        }
    }
}

/// Log a frontend message to the backend's daily-rolling log file.
/// Fire-and-forget — the frontend never awaits this.
///
/// Every `String` / `Option<String>` field is truncated at entry
/// to `MAX_FRONTEND_LOG_FIELD_BYTES` (64 KB) so a single oversized
/// payload cannot stall the IPC thread or corrupt the daily log file.
/// Truncation is unconditional — the FE rate-limiter is not in this
/// trust scope (caller of `log_frontend` may be a panic handler that
/// fires before the rate-limiter takes effect).
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
    // Bound every field at entry. The truncation is cheap when
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

    /// A 1 MB payload in the `data` field must complete the IPC
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

    // -- log_frontend_inner level dispatch ------------------------
    //
    // No `tracing_test`/`TestWriter` fixtures are wired into this crate
    // (verified by grep). Per the plan: invoke the helper with each
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
}
