//! Shared wall-clock timestamp helper.
//!
//! Pure formatting over `chrono::Utc::now()` — no DB access, no other app
//! module. Lives in `agaric-core` so store/engine/app modules can read it
//! *downward* instead of reaching up into the `agaric` crate root, where
//! it used to live (`crate::now_rfc3339`). The `agaric` crate re-exports it
//! (`pub use agaric_core::time::now_rfc3339;`) so every existing
//! `crate::now_rfc3339()` call site resolves unchanged.

/// Return the current UTC time as an RFC 3339 string with millisecond
/// precision and a `Z` suffix (e.g. `2025-01-15T12:34:56.789Z`).
///
/// This helper is retained only for legacy TEXT timestamp columns not yet
/// migrated to INTEGER epoch-ms (e.g. `property_definitions.created_at`,
/// written at `commands/properties.rs`) and for non-database log/display
/// use (per AGENTS.md "Timestamp encoding for new tables"). Timestamp
/// columns that have been migrated are **not** stored as RFC 3339 strings:
/// `op_log.created_at` is `INTEGER NOT NULL CHECK (created_at >= 0)`
/// epoch-ms (migration `0079_op_log_created_at_ms.sql`), sourced from
/// `crate::db::now_ms()` and compared numerically. The reverse-op "find prior op" queries
/// (`reverse::block_ops::find_prior_text` / `find_prior_position`,
/// `reverse::property_ops::find_prior_property`,
/// `reverse::attachment_ops::reverse_delete_attachment`) rely on that
/// integer ordering, which is intrinsically monotonic — there is no
/// lex-collation or `Z`-suffix hazard, and no write-time assertion.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// Pin down the format of the `now_rfc3339()` string itself: fixed-width
// millisecond precision with a literal `Z` suffix. This is a property of
// the log/display helper only — it is unrelated to `op_log.created_at`,
// which is INTEGER epoch-ms (migration 0079) compared numerically. See
// the doc-comment on `now_rfc3339`.
#[cfg(test)]
mod now_rfc3339_tests {
    use super::now_rfc3339;

    /// Two consecutive `now_rfc3339()` calls must:
    ///   1. Both end with `Z` — the suffix is what makes
    ///      `op_log.created_at` lex-monotonic. Production code paths
    ///      under `reverse::block_ops`, `reverse::property_ops`, and
    ///      `reverse::attachment_ops` compare timestamps with
    ///      `created_at < ?` and `ORDER BY created_at DESC`. That is
    ///      only correct when every value shares the same fixed-width
    ///      `…Z` shape — a future ingest path that introduced
    ///      `+00:00`-suffixed timestamps would silently break "find
    ///      prior op" lookups even though both encode the same instant.
    ///   2. Sort lex-monotonically as time advances — `t1 <= t2`
    ///      lexicographically when `t1` was sampled before `t2`. This
    ///      only holds because chrono produces a fixed-width
    ///      `YYYY-MM-DDTHH:MM:SS.sssZ` representation; the assertions
    ///      below catch any future change to `now_rfc3339`'s output
    ///      shape that would silently break that ordering.
    #[test]
    fn now_rfc3339_produces_lex_monotonic_z_suffix() {
        let t1 = now_rfc3339();

        assert!(
            t1.ends_with('Z'),
            "now_rfc3339() output `{t1}` must end with `Z` — the  \
             lex-monotonic invariant on op_log.created_at depends on every \
             stored timestamp sharing the same `…Z` shape (see the \
             doc-comment on `now_rfc3339` and on `op_log::OpRecord`)"
        );

        // Verify lex-monotonicity with two fixed instants instead of
        // wall-clock calls (which are flaky under NTP step-back).
        // `now_rfc3339` uses `SecondsFormat::Millis` + `use_z = true`,
        // producing a fixed-width `YYYY-MM-DDTHH:MM:SS.sssZ` string whose
        // lexicographic order tracks real time — these constants exercise
        // that property without touching the system clock.
        use chrono::TimeZone as _;
        let earlier = chrono::Utc
            .with_ymd_and_hms(2020, 1, 1, 0, 0, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let later = chrono::Utc
            .with_ymd_and_hms(2030, 1, 1, 0, 0, 0)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(
            earlier < later,
            "rfc3339 with SecondsFormat::Millis must be lex-monotonic for \
             sequential instants: `{earlier}` must be less than `{later}`. \
             A change to `now_rfc3339`'s format (e.g. variable-width \
             fractional seconds or mixed `Z`/`+00:00` suffixes) would \
             break op_log compaction and reverse-op prior-lookup queries"
        );
    }
}
