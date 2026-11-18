//! Pure ISO-date (`YYYY-MM-DD`) validators.
//!
//! Foundation-shaped date-string validation shared by the block write-path
//! (`agaric_engine::block_ops`), the recurrence projector
//! (`agaric_engine::recurrence`), and the app command surface
//! (`crate::commands::{journal, agenda, properties, blocks::queries}`). They
//! depend only on [`crate::error::AppError`] + `chrono`, so they sit at the
//! bottom of the DAG (#2633) rather than in the engine layer where they used
//! to live (`agaric_engine::block_ops`). `agaric_engine::block_ops` re-exports
//! both (`pub use agaric_core::date_validation::…`) so every existing
//! `block_ops::validate_date_format` / `crate::domain::block_ops::…` call site
//! resolves unchanged.

use crate::error::AppError;

/// Validate that `s` parses as a calendar-valid `YYYY-MM-DD` date.
///
/// I-CommandsCRUD-6: previously did only structural validation (month
/// 01–12, day 01–31) and explicitly accepted impossible combinations
/// (Feb 30, Apr 31), relying on downstream callers to handle them. The
/// agenda path (`list_projected_agenda_inner`) re-parsed via
/// `NaiveDate::parse_from_str` and rejected with a different error
/// shape — inconsistent failure for the same input depending on which
/// command consumed it.
///
/// Now uses `NaiveDate::parse_from_str` directly so impossible dates
/// are rejected at the boundary with a single canonical error message.
/// The agenda re-parse becomes redundant and can be removed in a
/// follow-up; this change keeps the validator's return type stable so
/// existing callers don't need updating.
///
/// Chrono's `%Y-%m-%d` accepts non-zero-padded forms like
/// `2025-1-1` and 2-digit years like `25-1-1`. Pre-validate the strict
/// shape (`\d{4}-\d{2}-\d{2}`) before delegating calendar validity to
/// chrono — otherwise these slip through and downstream callers get
/// surprising "valid" dates that the canonical date format invariant
/// rejects.
pub fn validate_date_format(s: &str) -> Result<(), AppError> {
    let bytes = s.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !shape_ok {
        return Err(AppError::validation(format!(
            "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
        )));
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d")
        .map(|_| ())
        .map_err(|_| {
            AppError::validation(format!(
                "expected YYYY-MM-DD format with calendar-valid date, got '{s}'"
            ))
        })
}

/// I-CommandsCRUD-8: previously a separate structural validator that
/// drifted from `validate_date_format`. Now delegates so there is one
/// source of truth for ISO-date validation across the commands surface.
pub fn is_valid_iso_date(s: &str) -> bool {
    validate_date_format(s).is_ok()
}

/// What [`read_datetime`] made of a text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadDatetime {
    /// The instant in UTC, as a `datetime` property stores it:
    /// `YYYY-MM-DDTHH:MMZ`.
    pub canonical: String,
    /// The text named seconds other than `00`, which the value does not keep.
    pub seconds_dropped: bool,
}

/// Read a `datetime` property value (#6758) from user or file text:
/// `YYYY-MM-DD`, then `T` or one space, then `HH:MM` or `HH:MM:SS`, then
/// nothing, `Z`, `±HH:MM` or `±HHMM`. A text with no zone is a local time in
/// `tz`; one in a daylight-saving gap is no instant, and one a clock showed
/// twice is the earlier. A day alone is a date, never a datetime.
pub fn read_datetime<Tz: chrono::TimeZone>(s: &str, tz: &Tz) -> Option<ReadDatetime> {
    let (day, rest) = s.split_at_checked(10)?;
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .filter(|_| is_valid_iso_date(day))?;
    let rest = rest.strip_prefix(['T', ' '])?;
    let (hours, rest) = rest.split_at_checked(2)?;
    let (minutes, rest) = rest.strip_prefix(':')?.split_at_checked(2)?;
    let (seconds, zone) = match rest.strip_prefix(':') {
        Some(rest) => rest.split_at_checked(2)?,
        None => ("00", rest),
    };
    // Checked with the seconds the text names, kept without them.
    date.and_hms_opt(
        two_digits(hours)?,
        two_digits(minutes)?,
        two_digits(seconds)?,
    )?;
    let local = date.and_hms_opt(two_digits(hours)?, two_digits(minutes)?, 0)?;
    let utc = match zone {
        "" => tz.from_local_datetime(&local).earliest()?.naive_utc(),
        "Z" => local,
        offset => local.checked_sub_offset(read_offset(offset)?)?,
    };
    let canonical = utc.format(STORED_DATETIME).to_string();
    // A year outside 0000..=9999 is not four digits.
    (canonical.len() == STORED_DATETIME_LEN).then(|| ReadDatetime {
        canonical,
        seconds_dropped: seconds != "00",
    })
}

const STORED_DATETIME: &str = "%Y-%m-%dT%H:%MZ";
const STORED_DATETIME_LEN: usize = "YYYY-MM-DDTHH:MMZ".len();

fn two_digits(s: &str) -> Option<u32> {
    (s.len() == 2 && s.bytes().all(|b| b.is_ascii_digit()))
        .then(|| s.parse().ok())
        .flatten()
}

/// `±HH:MM` or `±HHMM`.
fn read_offset(s: &str) -> Option<chrono::FixedOffset> {
    let (sign, rest) = s.split_at_checked(1)?;
    let (hours, minutes) = rest.split_at_checked(2)?;
    let minutes = minutes.strip_prefix(':').unwrap_or(minutes);
    let (hours, minutes) = (two_digits(hours)?, two_digits(minutes)?);
    let seconds =
        i32::try_from((hours < 24 && minutes < 60).then_some(hours * 3600 + minutes * 60)?).ok()?;
    match sign {
        "+" => chrono::FixedOffset::east_opt(seconds),
        "-" => chrono::FixedOffset::west_opt(seconds),
        _ => None,
    }
}

/// The instant a stored `datetime` names.
fn stored_datetime(s: &str) -> Option<chrono::NaiveDateTime> {
    is_canonical_datetime(s)
        .then(|| chrono::NaiveDateTime::parse_from_str(s, STORED_DATETIME).ok())
        .flatten()
}

/// `s` is a `datetime` property's stored form: `YYYY-MM-DDTHH:MMZ`, naming a
/// real date and time.
pub fn is_canonical_datetime(s: &str) -> bool {
    read_datetime(s, &chrono::Utc).is_some_and(|read| read.canonical == s)
}

/// A stored `datetime` (`YYYY-MM-DDTHH:MMZ`) as Markdown shows it: the local
/// time in `tz` with that instant's offset, `2026-11-14T09:30+01:00`. `None`
/// for a text that is not a stored datetime.
pub fn write_datetime<Tz: chrono::TimeZone>(canonical: &str, tz: &Tz) -> Option<String>
where
    Tz::Offset: std::fmt::Display,
{
    let local = tz.from_utc_datetime(&stored_datetime(canonical)?);
    Some(local.format("%Y-%m-%dT%H:%M%:z").to_string())
}

/// The stored-form bounds of the calendar day `day` (`YYYY-MM-DD`) in `tz`:
/// its first instant, and the next day's. A `datetime` value falls on the day
/// when it is at or after the first and before the second.
pub fn local_day_bounds<Tz: chrono::TimeZone>(day: &str, tz: &Tz) -> Option<(String, String)> {
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .ok()
        .filter(|_| is_valid_iso_date(day))?;
    let start = |date: chrono::NaiveDate| {
        let midnight = date.and_hms_opt(0, 0, 0)?;
        // A day whose midnight the clocks skip starts an hour later.
        let first = tz.from_local_datetime(&midnight).earliest().or_else(|| {
            tz.from_local_datetime(&midnight.checked_add_signed(chrono::TimeDelta::hours(1))?)
                .earliest()
        })?;
        let stored = first.naive_utc().format(STORED_DATETIME).to_string();
        (stored.len() == STORED_DATETIME_LEN).then_some(stored)
    };
    Some((start(date)?, start(date.succ_opt()?)?))
}

#[cfg(test)]
mod tests {
    use super::{is_valid_iso_date, validate_date_format};

    #[test]
    fn rejects_impossible_calendar_dates() {
        // Feb 30 / Apr 31 are structurally shaped but calendar-invalid; the
        // pre-#642 structural-only validator accepted them.
        assert!(validate_date_format("2025-02-30").is_err());
        assert!(validate_date_format("2025-04-31").is_err());
    }

    #[test]
    fn leap_year_rules() {
        // 2024 is a leap year (Feb 29 valid); 2025 is not.
        assert!(validate_date_format("2024-02-29").is_ok());
        assert!(validate_date_format("2025-02-29").is_err());
    }

    #[test]
    fn rejects_non_strict_shapes() {
        // chrono's `%Y-%m-%d` alone would accept these; the strict shape
        // pre-check rejects non-zero-padded / short-year forms.
        for bad in [
            "2025-1-1",
            "25-1-1",
            "2025/01/01",
            "2025-01-01T00:00:00",
            "",
        ] {
            assert!(
                validate_date_format(bad).is_err(),
                "expected `{bad}` to be rejected"
            );
        }
    }

    #[test]
    fn accepts_valid_iso_dates() {
        for good in ["2025-01-01", "2000-12-31", "2026-07-18"] {
            assert!(
                validate_date_format(good).is_ok(),
                "expected `{good}` to be valid"
            );
        }
    }

    #[test]
    fn is_valid_iso_date_delegates_to_validate_date_format() {
        // The two must never drift: `is_valid_iso_date` is a thin `.is_ok()`
        // over `validate_date_format` (I-CommandsCRUD-8).
        for input in ["2025-01-01", "2025-02-30", "2025-1-1", "not-a-date"] {
            assert_eq!(
                is_valid_iso_date(input),
                validate_date_format(input).is_ok(),
                "delegation invariant broken for `{input}`"
            );
        }
    }

    mod datetime_6758 {
        use super::super::{
            ReadDatetime, is_canonical_datetime, local_day_bounds, read_datetime, write_datetime,
        };
        use chrono::{FixedOffset, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};

        /// Central European time by its rule: UTC+2 from 01:00 UTC on the
        /// last Sunday of March to 01:00 UTC on the last Sunday of October,
        /// UTC+1 otherwise. A real zone's gap and overlap, with no tz data.
        #[derive(Clone, Copy)]
        struct Cet;

        fn last_sunday(year: i32, month: u32) -> NaiveDateTime {
            use chrono::Datelike;
            let mut day = NaiveDate::from_ymd_opt(year, month, 31).unwrap();
            while day.weekday() != chrono::Weekday::Sun {
                day = day.pred_opt().unwrap();
            }
            day.and_hms_opt(1, 0, 0).unwrap()
        }

        fn cet_offset(utc: &NaiveDateTime) -> FixedOffset {
            use chrono::Datelike;
            let summer = *utc >= last_sunday(utc.year(), 3) && *utc < last_sunday(utc.year(), 10);
            FixedOffset::east_opt(if summer { 7200 } else { 3600 }).unwrap()
        }

        impl TimeZone for Cet {
            type Offset = FixedOffset;
            fn from_offset(_: &FixedOffset) -> Self {
                Cet
            }
            fn offset_from_local_date(&self, _: &NaiveDate) -> LocalResult<FixedOffset> {
                unreachable!("not used by from_local_datetime")
            }
            fn offset_from_local_datetime(
                &self,
                local: &NaiveDateTime,
            ) -> LocalResult<FixedOffset> {
                let fits = |secs: i32| {
                    let offset = FixedOffset::east_opt(secs).unwrap();
                    (cet_offset(&(*local - offset)) == offset).then_some(offset)
                };
                match (fits(7200), fits(3600)) {
                    (Some(a), Some(b)) => LocalResult::Ambiguous(a, b),
                    (Some(one), None) | (None, Some(one)) => LocalResult::Single(one),
                    (None, None) => LocalResult::None,
                }
            }
            fn offset_from_utc_date(&self, _: &NaiveDate) -> FixedOffset {
                unreachable!("not used by from_utc_datetime")
            }
            fn offset_from_utc_datetime(&self, utc: &NaiveDateTime) -> FixedOffset {
                cet_offset(utc)
            }
        }

        fn read(s: &str) -> Option<(String, bool)> {
            read_datetime(s, &Cet).map(|r| (r.canonical, r.seconds_dropped))
        }

        fn kept(canonical: &str) -> Option<(String, bool)> {
            Some((canonical.to_owned(), false))
        }

        #[test]
        fn a_zoneless_text_is_a_local_time() {
            assert_eq!(read("2026-11-14T09:30"), kept("2026-11-14T08:30Z"));
            assert_eq!(read("2026-11-14 09:30"), kept("2026-11-14T08:30Z"));
            assert_eq!(read("2026-07-01T00:15"), kept("2026-06-30T22:15Z"));
        }

        #[test]
        fn a_text_with_a_zone_is_converted_to_utc() {
            assert_eq!(read("2026-11-14T09:30Z"), kept("2026-11-14T09:30Z"));
            assert_eq!(read("2026-11-14T09:30+01:00"), kept("2026-11-14T08:30Z"));
            assert_eq!(read("2026-11-14T09:30-0530"), kept("2026-11-14T15:00Z"));
            assert_eq!(read("2026-11-14 23:30-05:00"), kept("2026-11-15T04:30Z"));
            assert_eq!(read("2026-11-14T09:30+00:00"), kept("2026-11-14T09:30Z"));
        }

        #[test]
        fn seconds_are_dropped_and_reported_when_not_zero() {
            assert_eq!(read("2026-11-14T09:30:00"), kept("2026-11-14T08:30Z"));
            assert_eq!(
                read("2026-11-14T09:30:45"),
                Some(("2026-11-14T08:30Z".to_owned(), true))
            );
            assert_eq!(
                read("2026-11-14T09:30:59Z"),
                Some(("2026-11-14T09:30Z".to_owned(), true))
            );
        }

        #[test]
        fn a_local_time_in_a_gap_is_refused_and_a_repeated_one_is_the_earlier() {
            // 2026-03-29: 02:00 → 03:00. 2026-10-25: 03:00 → 02:00.
            assert_eq!(read("2026-03-29T02:30"), None);
            assert_eq!(read("2026-03-29T03:00"), kept("2026-03-29T01:00Z"));
            assert_eq!(read("2026-10-25T02:30"), kept("2026-10-25T00:30Z"));
            assert_eq!(read("2026-10-25T02:30+01:00"), kept("2026-10-25T01:30Z"));
        }

        #[test]
        fn anything_else_is_not_a_datetime() {
            for bad in [
                "2026-11-14",
                "2026-11-14T",
                "2026-11-14T09",
                "2026-11-14T9:30",
                "2026-11-14T09:30:5",
                "2026-11-14T24:00",
                "2026-11-14T09:60",
                "2026-11-14T09:30:60",
                "2026-02-30T09:30",
                "2026-11-14  09:30",
                "2026-11-14t09:30",
                "2026-11-14T09:30z",
                "2026-11-14T09:30 Z",
                "2026-11-14T09:30+1",
                "2026-11-14T09:30+01",
                "2026-11-14T09:30+24:00",
                "2026-11-14T09:30+01:60",
                "2026-11-14T09:30.5",
                " 2026-11-14T09:30",
                "2026-11-14T09:30 ",
                "2026-11-14T09:30é",
                "９999-11-14T09:30",
                "soon",
                "",
            ] {
                assert_eq!(read(bad), None, "{bad:?}");
            }
            // The year the stored form has four digits for.
            assert_eq!(read("9999-12-31T23:30-01:00"), None);
        }

        #[test]
        fn only_the_stored_form_is_canonical() {
            assert!(is_canonical_datetime("2026-11-14T08:30Z"));
            for bad in [
                "2026-11-14T08:30",
                "2026-11-14 08:30Z",
                "2026-11-14T08:30:00Z",
                "2026-11-14T08:30+00:00",
                "2026-11-14T24:30Z",
                "2026-02-30T08:30Z",
                "2026-11-14",
            ] {
                assert!(!is_canonical_datetime(bad), "{bad:?}");
            }
        }

        #[test]
        fn a_stored_instant_is_written_as_local_time_with_its_offset() {
            let write = |s: &str| write_datetime(s, &Cet);
            assert_eq!(
                write("2026-11-14T08:30Z"),
                Some("2026-11-14T09:30+01:00".to_owned())
            );
            assert_eq!(
                write("2026-06-30T22:15Z"),
                Some("2026-07-01T00:15+02:00".to_owned())
            );
            assert_eq!(
                write_datetime("2026-11-14T08:30Z", &Utc),
                Some("2026-11-14T08:30+00:00".to_owned())
            );
            assert_eq!(write("2026-11-14T09:30"), None);
            assert_eq!(write("2026-11-14"), None);
        }

        #[test]
        fn what_is_written_reads_back_as_the_same_instant() {
            for stored in [
                "2026-11-14T08:30Z",
                "2026-10-25T00:30Z",
                "2026-10-25T01:30Z",
            ] {
                let written = write_datetime(stored, &Cet).unwrap();
                assert_eq!(
                    read_datetime(&written, &Utc),
                    Some(ReadDatetime {
                        canonical: stored.to_owned(),
                        seconds_dropped: false
                    })
                );
            }
        }

        #[test]
        fn a_day_is_bounded_by_its_local_midnights() {
            let bounds = |day: &str| local_day_bounds(day, &Cet);
            let pair = |a: &str, b: &str| Some((a.to_owned(), b.to_owned()));
            assert_eq!(
                bounds("2026-11-14"),
                pair("2026-11-13T23:00Z", "2026-11-14T23:00Z")
            );
            // The day the clocks go back is 25 hours long.
            assert_eq!(
                bounds("2026-10-25"),
                pair("2026-10-24T22:00Z", "2026-10-25T23:00Z")
            );
            assert_eq!(
                local_day_bounds("2026-11-14", &FixedOffset::west_opt(5 * 3600).unwrap()),
                pair("2026-11-14T05:00Z", "2026-11-15T05:00Z")
            );
            assert_eq!(bounds("2026-11-14T09:30"), None);
            assert_eq!(bounds("2026-02-30"), None);
        }
    }
}
