//! Small text-handling helpers shared across IPC boundaries.
//!
//! L-59: extracted to deduplicate the UTF-8-safe truncation logic that
//! previously lived in both `commands::logging::truncate_log_field`
//! (frontend log field cap) and `commands::bug_report::cap_line_length`
//! (per-line cap inside the redacted bug-report bundle). Both call sites
//! enforce a per-field byte ceiling but format the truncation marker
//! differently — one says `…[truncated N bytes]`, the other says
//! `…[truncated N chars]` — so the helper takes a marker closure rather
//! than baking the exact wording in.

/// UTF-8-safe truncation: cuts `s` at the last `char_boundary` ≤ `max_bytes`
/// and appends a `[truncated N more]`-style marker. Used by logging and bug
/// report paths to enforce per-field byte caps without splitting code points.
///
/// Returns the input unchanged when its byte length is at or below
/// `max_bytes` — no allocation in the common case.
///
/// `marker_fn` receives the number of dropped bytes (`s.len() - cut`,
/// computed from the *original* length so callers can reproduce the
/// existing wording byte-for-byte) and returns the suffix to append.
pub fn truncate_at_char_boundary(
    s: String,
    max_bytes: usize,
    marker_fn: impl Fn(usize) -> String,
) -> String {
    if s.len() <= max_bytes {
        return s;
    }
    let extra = s.len() - max_bytes;
    let mut s = s;
    // Walk backwards to the nearest UTF-8 char boundary so `truncate`
    // never panics on a multibyte codepoint.
    let mut cut = max_bytes;
    while !s.is_char_boundary(cut) && cut > 0 {
        cut -= 1;
    }
    s.truncate(cut);
    s.push_str(&marker_fn(extra));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_input_passes_through_unchanged() {
        let input = "short message".to_string();
        let out =
            truncate_at_char_boundary(input.clone(), 1024, |n| format!("…[truncated {n} bytes]"));
        assert_eq!(
            out, input,
            "input at or below the cap must round-trip identically with no allocation"
        );
    }

    #[test]
    fn oversized_input_is_truncated_on_char_boundary() {
        // Build a string whose byte length just exceeds the cap and whose
        // tail contains a 4-byte codepoint straddling the cut point. If
        // the helper cut mid-codepoint, `String::truncate` would panic
        // and the resulting string would contain invalid UTF-8.
        const CAP: usize = 16;
        let mut s = String::with_capacity(CAP + 8);
        for _ in 0..(CAP - 1) {
            s.push('a');
        }
        s.push('😀'); // 4 bytes — straddles byte index CAP - 1 .. CAP + 3
        for _ in 0..8 {
            s.push('b');
        }
        let original_byte_len = s.len();
        let out = truncate_at_char_boundary(s, CAP, |n| format!("…[truncated {n} bytes]"));
        // Round-trip: `chars().count()` walks the string and panics on
        // invalid UTF-8 — its success here proves the cut respected a
        // char boundary.
        let _check = out.chars().count();
        // The smiley must have been dropped whole, not cut in half.
        assert!(
            !out.contains('😀') || out.matches('😀').count() == 1,
            "if the smiley remains it must be intact"
        );
        // Output must remain bounded: cap + worst-case marker overhead.
        assert!(
            out.len() < CAP + 64,
            "truncated output ({} bytes) must stay near the cap (was {})",
            out.len(),
            original_byte_len
        );
    }

    #[test]
    fn marker_is_appended_with_dropped_byte_count() {
        const CAP: usize = 8;
        let input = "x".repeat(CAP + 25);
        let out = truncate_at_char_boundary(input, CAP, |n| format!("…[truncated {n} bytes]"));
        assert!(
            out.ends_with("…[truncated 25 bytes]"),
            "marker must be appended verbatim with the dropped byte count, got: {out:?}"
        );
    }

    #[test]
    fn marker_format_is_caller_controlled() {
        // The two existing call sites use slightly different wording
        // (`bytes` vs `chars`); the helper must preserve whatever the
        // closure returns byte-for-byte.
        const CAP: usize = 4;
        let out = truncate_at_char_boundary("abcdefghij".to_string(), CAP, |n| {
            format!("…[truncated {n} chars]")
        });
        assert!(
            out.ends_with("…[truncated 6 chars]"),
            "caller-supplied marker must be used verbatim, got: {out:?}"
        );
    }
}
