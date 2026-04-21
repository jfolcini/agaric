//! FEAT-5d — pure (date, entries, page_titles, privacy_mode) → one
//! all-day Google Calendar digest event.
//!
//! This module is deliberately tiny and side-effect free: it takes the
//! already-projected agenda entries for a single date and returns
//! either [`DigestResult::Create`] with a formatted [`Event`] JSON body
//! or [`DigestResult::Delete`] when that date has no entries.  It does
//! NOT query the DB, NOT call the GCal API, NOT depend on tokio.  The
//! connector (FEAT-5e) wraps this, hashes the output, and drives
//! create/patch/delete on the remote calendar.
//!
//! # Canonicalisation
//!
//! Before formatting the digest, entries are sorted in-memory by
//! `(entry.source, entry.block.todo_state, entry.block.id)`.  The
//! connector's `blake3::hash()` of the serialized [`Event`] depends on
//! this ordering being stable across runs — the pure function is the
//! single place where canonicalisation happens.  Every ordering tweak
//! must go through this function so the hash stays deterministic.
//!
//! # Description cap
//!
//! Google Calendar accepts up to 8192 bytes in `description`.  This
//! module caps at 4096 characters — half the raw limit — to leave
//! headroom for multi-byte content and future prefixes.  When the cap
//! is exceeded, the tail of the per-entry lines is replaced with
//! `\n… and N more in Agaric` (greedy: fill as many entries as
//! possible, then compute the drop count from what's left).
//!
//! # Privacy modes
//!
//! * [`PrivacyMode::Full`] — the description is a block of
//!   `[state-marker] <breadcrumb> › <content-prefix>` lines, one per
//!   entry.
//! * [`PrivacyMode::Minimal`] — the description is the empty string;
//!   callers who share their "Agaric Agenda" calendar publicly get only
//!   the summary + the all-day date.
//!
//! The summary is identical in both modes so the event shape stays
//! predictable regardless of the user's privacy preference.

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use crate::pagination::ProjectedAgendaEntry;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Output of [`digest_for_date`].  Either instructs the connector to
/// push a freshly built event payload, or to drop any existing mapping
/// for the date because it no longer has agenda entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DigestResult {
    /// Push this event body.  Event id is assigned by the connector.
    Create(Event),
    /// The date has no entries — if a map row exists, delete the remote
    /// event and the map row; if no row exists, skip.
    Delete,
}

/// An all-day Google Calendar event body, shaped for the GCal v3 API.
///
/// The connector serialises this to JSON and POSTs / PATCHes it — this
/// module does not emit HTTP.  `transparency = "transparent"` keeps the
/// user's availability free on their primary calendar even when the
/// Agaric Agenda calendar shows an event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event {
    /// `"Agaric Agenda — <Weekday> <Mon DD>"` in both privacy modes.
    pub summary: String,
    /// Formatted per-entry digest (full mode) or empty (minimal).  Never
    /// exceeds `DESCRIPTION_CAP` characters.
    pub description: String,
    /// Inclusive start date in `YYYY-MM-DD`.
    pub start: EventDate,
    /// End date in `YYYY-MM-DD`.  Matches `start` for a one-day all-day
    /// event — per FEAT-5 spec.  (The API layer may translate to GCal's
    /// exclusive-end convention when it serialises.)
    pub end: EventDate,
    /// Always `"transparent"`.  The digest is informational, not a
    /// "busy" block — users should not show as unavailable all day.
    pub transparency: String,
}

/// GCal all-day event date wrapper.  Always `{"date": "YYYY-MM-DD"}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EventDate {
    pub date: String,
}

/// Which privacy mode the digest runs in.  Mirrors the `privacy_mode`
/// row in `gcal_settings` (see FEAT-5a `models.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivacyMode {
    /// Full per-entry digest in the description.  Default.
    Full,
    /// Empty description — summary only.  For users who share the
    /// Agaric Agenda calendar publicly.
    Minimal,
}

impl PrivacyMode {
    /// Decode the string stored in `gcal_settings.privacy_mode`.  Any
    /// value other than the literal `"minimal"` maps to
    /// [`PrivacyMode::Full`] — this is a feature, not a bug: an unknown
    /// or corrupted setting defaults to the richer (safer) mode so the
    /// user does not silently lose their agenda detail.
    #[must_use]
    pub fn from_setting(value: &str) -> Self {
        match value {
            "minimal" => PrivacyMode::Minimal,
            _ => PrivacyMode::Full,
        }
    }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Hard ceiling on the `description` field.  GCal's raw limit is 8192
/// bytes — half that leaves headroom for multi-byte content and any
/// future prefixes FEAT-5 parent may add (e.g. a leading device tag).
const DESCRIPTION_CAP: usize = 4096;

/// Truncate page titles to this many characters in the breadcrumb.
const BREADCRUMB_MAX_CHARS: usize = 60;

/// Truncate block content to this many characters in the per-entry
/// prefix.
const CONTENT_MAX_CHARS: usize = 80;

/// Sentinel the summary always starts with — included here so the
/// property-test that asserts this invariant lives next to the value
/// it pins.
pub const SUMMARY_PREFIX: &str = "Agaric Agenda — ";

/// Breadcrumb fallback when `page_titles` does not contain a block's
/// `page_id`.  FEAT-5d spec § "Description (full mode)".
const UNKNOWN_PAGE_LABEL: &str = "(unknown page)";

/// Separator between breadcrumb and content prefix.  The glyph is
/// `U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK` with single
/// ASCII spaces on each side.
const BREADCRUMB_SEPARATOR: &str = " \u{203A} ";

/// Suffix appended when the description is truncated to fit
/// [`DESCRIPTION_CAP`].  `N` is substituted at runtime for the number
/// of entries dropped from the tail.
const OVERFLOW_TEMPLATE: &str = "\n… and {N} more in Agaric";

/// State markers per `todo_state`.  The untyped fallback (`None` or an
/// unrecognised state) is the same as TODO so consumers can skim the
/// description for "what's open" without learning Agaric-specific
/// marker glyphs.  Characters pinned in this file so a grep finds the
/// authoritative set; also pinned by snapshot tests below.
const MARKER_TODO: &str = "[ ]";
const MARKER_DOING: &str = "[\u{00B7}]"; // middle dot
const MARKER_DONE: &str = "[x]";
const MARKER_CANCELLED: &str = "[\u{2014}]"; // em dash

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Build one all-day digest event from the agenda entries for a single
/// date.
///
/// * `date` — local calendar date the digest represents.  Used to
///   format the summary (`%a %b %d`) and to fill `start` / `end`.
/// * `entries` — the output of `list_projected_agenda_inner(date,
///   date, …)` upstream; already excludes soft-deleted and conflict
///   copies.  Order is not required; this function sorts internally.
/// * `page_titles` — `page_id → title` lookup table supplied by the
///   connector.  Missing keys fall back to [`UNKNOWN_PAGE_LABEL`].
/// * `privacy_mode` — controls description content (full vs empty).
///
/// # Canonical order
///
/// Sorted by `(source, todo_state, block_id)` before rendering so the
/// blake3 hash of the serialized [`Event`] is deterministic for a
/// given input.  Connector retries depend on this.
///
/// # Cost
///
/// `O(n log n)` from the sort on `n = entries.len()`, plus `O(total
/// content bytes)` for description assembly.  No allocations past the
/// final `String`.
#[must_use]
pub fn digest_for_date(
    date: NaiveDate,
    entries: &[ProjectedAgendaEntry],
    page_titles: &HashMap<String, String>,
    privacy_mode: PrivacyMode,
) -> DigestResult {
    if entries.is_empty() {
        return DigestResult::Delete;
    }

    // Canonicalise.  Sort by (source, todo_state, block_id).  Option<T>
    // sorts None < Some(_) naturally, which is what we want —
    // untyped-state entries come first within a source bucket.
    let mut canonical: Vec<&ProjectedAgendaEntry> = entries.iter().collect();
    canonical.sort_by(|a, b| {
        a.source
            .cmp(&b.source)
            .then_with(|| a.block.todo_state.cmp(&b.block.todo_state))
            .then_with(|| a.block.id.cmp(&b.block.id))
    });

    let summary = format_summary(date);
    let description = match privacy_mode {
        PrivacyMode::Full => format_description_full(&canonical, page_titles),
        PrivacyMode::Minimal => String::new(),
    };

    let date_str = date.format("%Y-%m-%d").to_string();
    DigestResult::Create(Event {
        summary,
        description,
        start: EventDate {
            date: date_str.clone(),
        },
        end: EventDate { date: date_str },
        transparency: "transparent".to_owned(),
    })
}

// ---------------------------------------------------------------------------
// Internals — summary
// ---------------------------------------------------------------------------

/// `"Agaric Agenda — Tue Apr 22"`.  Identical in both privacy modes:
/// the summary always pins the date; privacy only hides the body.
fn format_summary(date: NaiveDate) -> String {
    // `%a` → abbreviated weekday name, `%b` → abbreviated month name,
    // `%d` → zero-padded day-of-month.  All three are ASCII in the C
    // locale chrono uses, so no locale-drift risk.
    let human = date.format("%a %b %d").to_string();
    // Sanity-check: the month-day must match the input; `format` uses
    // the date's fields, so this is just here to silence the unused
    // `Datelike` import warning and to document the expected shape.
    debug_assert!(human.contains(&format!("{:02}", date.day())));
    format!("{SUMMARY_PREFIX}{human}")
}

// ---------------------------------------------------------------------------
// Internals — description (full mode)
// ---------------------------------------------------------------------------

/// Assemble the full-mode description, applying greedy truncation.
fn format_description_full(
    canonical: &[&ProjectedAgendaEntry],
    page_titles: &HashMap<String, String>,
) -> String {
    // Render every entry into its final line first — truncation is
    // entry-granular, not byte-granular, so the decision has to happen
    // on complete lines.
    let lines: Vec<String> = canonical
        .iter()
        .map(|e| format_entry_line(e, page_titles))
        .collect();

    let joined = lines.join("\n");
    if joined.chars().count() <= DESCRIPTION_CAP {
        return joined;
    }

    // Overflow path.  Fill as many entries as fit, leaving enough room
    // for the overflow suffix (which grows by digits as N grows — the
    // loop reserves space for the final count, not a pessimistic upper
    // bound, by rebuilding the prefix after each drop).
    truncate_with_overflow_suffix(&lines)
}

/// Shrink the joined line set until prefix + overflow-suffix fits.
fn truncate_with_overflow_suffix(lines: &[String]) -> String {
    // Greedy from the tail: keep `kept` lines, drop the rest.  Recompute
    // the suffix length each time `dropped` rolls over to another digit.
    let total = lines.len();
    // Binary search would be marginally faster but N is at most a few
    // hundred in practice; linear keeps the logic obviously correct.
    for kept in (0..total).rev() {
        let dropped = total - kept;
        let suffix = overflow_suffix(dropped);
        let prefix: String = lines[..kept].join("\n");
        let prefix_len = prefix.chars().count();
        let suffix_len = suffix.chars().count();
        if prefix_len + suffix_len <= DESCRIPTION_CAP {
            let mut out = String::with_capacity(prefix.len() + suffix.len());
            out.push_str(&prefix);
            out.push_str(&suffix);
            return out;
        }
    }
    // All entries dropped — the suffix alone still must fit.  N = total.
    // Guarded to never exceed the cap even under pathological inputs.
    let suffix = overflow_suffix(total);
    let cap = DESCRIPTION_CAP;
    suffix.chars().take(cap).collect()
}

fn overflow_suffix(dropped: usize) -> String {
    OVERFLOW_TEMPLATE.replace("{N}", &dropped.to_string())
}

/// Format one entry as `[marker] breadcrumb › content`.
fn format_entry_line(
    entry: &ProjectedAgendaEntry,
    page_titles: &HashMap<String, String>,
) -> String {
    let marker = state_marker(entry.block.todo_state.as_deref());
    let breadcrumb = breadcrumb_for(entry, page_titles);
    let content_prefix = content_prefix_for(entry);
    format!("{marker} {breadcrumb}{BREADCRUMB_SEPARATOR}{content_prefix}")
}

/// Map `todo_state` → bracketed marker.  Unknown / `None` → same as
/// TODO.  Pinned in snapshot tests below.
fn state_marker(state: Option<&str>) -> &'static str {
    match state {
        Some("TODO") => MARKER_TODO,
        Some("DOING") => MARKER_DOING,
        Some("DONE") => MARKER_DONE,
        Some("CANCELLED") => MARKER_CANCELLED,
        // None or any other string — treat as TODO-equivalent.
        _ => MARKER_TODO,
    }
}

/// Resolve the block's page title, truncating to [`BREADCRUMB_MAX_CHARS`].
fn breadcrumb_for(entry: &ProjectedAgendaEntry, page_titles: &HashMap<String, String>) -> String {
    let title = entry
        .block
        .page_id
        .as_ref()
        .and_then(|id| page_titles.get(id))
        .map(String::as_str)
        .unwrap_or(UNKNOWN_PAGE_LABEL);
    truncate_with_ellipsis(title, BREADCRUMB_MAX_CHARS)
}

/// Extract and truncate the block's content to [`CONTENT_MAX_CHARS`].
fn content_prefix_for(entry: &ProjectedAgendaEntry) -> String {
    let content = entry.block.content.as_deref().unwrap_or("");
    // Entries without content still need a visible body; we emit an
    // empty string rather than a placeholder so the separator alone
    // marks the absence.  This is rare — agenda blocks usually have
    // content — and matches how Agaric renders empty blocks elsewhere.
    truncate_with_ellipsis(content, CONTENT_MAX_CHARS)
}

/// Truncate `s` to at most `max_chars` *characters*, appending `…` iff
/// truncation actually happened.  Counts Unicode code points via
/// `char_indices`, so multi-byte text is cut on code-point boundaries
/// (not bytes).
fn truncate_with_ellipsis(s: &str, max_chars: usize) -> String {
    let mut iter = s.char_indices();
    // Walk `max_chars + 1` characters; if we consume the (max_chars +
    // 1)-th, the string needs an ellipsis.
    let mut cut_byte = s.len();
    let mut has_more = false;
    for (kept, (idx, _)) in iter.by_ref().enumerate() {
        if kept == max_chars {
            cut_byte = idx;
            has_more = true;
            break;
        }
    }
    if !has_more {
        return s.to_owned();
    }
    let mut out = String::with_capacity(cut_byte + 3);
    out.push_str(&s[..cut_byte]);
    out.push('\u{2026}'); // …
    out
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pagination::BlockRow;

    // ── Fixtures ─────────────────────────────────────────────────────

    const DATE: &str = "2026-04-22"; // Wednesday
    const PAGE_A: &str = "PAGE01AAAAAAAAAAAAAAAAAAAA";
    const PAGE_B: &str = "PAGE02BBBBBBBBBBBBBBBBBBBB";

    fn fixed_date() -> NaiveDate {
        NaiveDate::parse_from_str(DATE, "%Y-%m-%d").unwrap()
    }

    /// Build a minimal `BlockRow` with everything defaulted except the
    /// fields we care about in digest tests.
    fn block(id: &str, content: &str, state: Option<&str>, page_id: Option<&str>) -> BlockRow {
        BlockRow {
            id: id.to_owned(),
            block_type: "content".to_owned(),
            content: Some(content.to_owned()),
            parent_id: None,
            position: Some(1),
            deleted_at: None,
            is_conflict: false,
            conflict_type: None,
            todo_state: state.map(str::to_owned),
            priority: None,
            due_date: None,
            scheduled_date: None,
            page_id: page_id.map(str::to_owned),
        }
    }

    fn entry(id: &str, content: &str, state: Option<&str>, source: &str) -> ProjectedAgendaEntry {
        ProjectedAgendaEntry {
            block: block(id, content, state, Some(PAGE_A)),
            projected_date: DATE.to_owned(),
            source: source.to_owned(),
        }
    }

    fn page_titles() -> HashMap<String, String> {
        let mut m = HashMap::new();
        m.insert(PAGE_A.to_owned(), "Projects".to_owned());
        m.insert(PAGE_B.to_owned(), "Inbox".to_owned());
        m
    }

    // ── Empty → Delete ──────────────────────────────────────────────

    #[test]
    fn empty_entries_returns_delete_in_full_mode() {
        let got = digest_for_date(fixed_date(), &[], &page_titles(), PrivacyMode::Full);
        assert_eq!(got, DigestResult::Delete);
    }

    #[test]
    fn empty_entries_returns_delete_in_minimal_mode() {
        let got = digest_for_date(fixed_date(), &[], &page_titles(), PrivacyMode::Minimal);
        assert_eq!(got, DigestResult::Delete);
    }

    // ── PrivacyMode parsing ─────────────────────────────────────────

    #[test]
    fn privacy_mode_from_setting_minimal_exactly_matches_lowercase() {
        assert_eq!(PrivacyMode::from_setting("minimal"), PrivacyMode::Minimal);
    }

    #[test]
    fn privacy_mode_from_setting_defaults_unknown_to_full() {
        assert_eq!(PrivacyMode::from_setting("full"), PrivacyMode::Full);
        assert_eq!(PrivacyMode::from_setting(""), PrivacyMode::Full);
        assert_eq!(PrivacyMode::from_setting("MINIMAL"), PrivacyMode::Full); // case-sensitive
        assert_eq!(PrivacyMode::from_setting("junk"), PrivacyMode::Full);
    }

    // ── Single-entry smoke (per state × per source × per mode) ──────

    fn assert_single_entry_summary(got: &DigestResult, expected_date_fragment: &str) {
        let DigestResult::Create(e) = got else {
            panic!("expected Create, got {got:?}");
        };
        assert!(
            e.summary.starts_with(SUMMARY_PREFIX),
            "summary must start with SUMMARY_PREFIX, got {:?}",
            e.summary
        );
        assert!(
            e.summary.ends_with(expected_date_fragment),
            "summary must end with date fragment {expected_date_fragment:?}, got {:?}",
            e.summary
        );
    }

    #[test]
    fn single_todo_due_full_emits_expected_marker_and_body() {
        let entries = vec![entry(
            "BLK01111111111111111111111",
            "Ship it",
            Some("TODO"),
            "due_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        assert_single_entry_summary(&got, "Wed Apr 22");
        let DigestResult::Create(e) = &got else {
            unreachable!()
        };
        assert_eq!(e.description, "[ ] Projects \u{203A} Ship it");
        assert_eq!(e.start.date, DATE);
        assert_eq!(e.end.date, DATE);
        assert_eq!(e.transparency, "transparent");
    }

    #[test]
    fn single_doing_scheduled_full_emits_middot_marker() {
        let entries = vec![entry(
            "BLK02111111111111111111111",
            "Drafting",
            Some("DOING"),
            "scheduled_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(e) = got else {
            unreachable!()
        };
        assert!(
            e.description.starts_with("[\u{00B7}]"),
            "DOING marker must be middot, got {:?}",
            e.description
        );
    }

    #[test]
    fn single_done_due_full_emits_x_marker() {
        let entries = vec![entry(
            "BLK03111111111111111111111",
            "Completed",
            Some("DONE"),
            "due_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(e) = got else {
            unreachable!()
        };
        assert!(
            e.description.starts_with("[x]"),
            "DONE marker must be [x], got {:?}",
            e.description
        );
    }

    #[test]
    fn single_cancelled_scheduled_full_emits_em_dash_marker() {
        let entries = vec![entry(
            "BLK04111111111111111111111",
            "Nope",
            Some("CANCELLED"),
            "scheduled_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(e) = got else {
            unreachable!()
        };
        assert!(
            e.description.starts_with("[\u{2014}]"),
            "CANCELLED marker must be em dash, got {:?}",
            e.description
        );
    }

    #[test]
    fn single_untyped_state_full_uses_todo_marker_fallback() {
        let entries = vec![entry(
            "BLK05111111111111111111111",
            "Loose note",
            None,
            "due_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(e) = got else {
            unreachable!()
        };
        assert!(
            e.description.starts_with("[ ]"),
            "untyped state must fall back to TODO marker, got {:?}",
            e.description
        );
    }

    #[test]
    fn unknown_todo_state_falls_back_to_todo_marker() {
        let entries = vec![entry(
            "BLK06111111111111111111111",
            "Weird",
            Some("WAITING"),
            "due_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(e) = got else {
            unreachable!()
        };
        assert!(
            e.description.starts_with("[ ]"),
            "unknown state must fall back to TODO marker, got {:?}",
            e.description
        );
    }

    // ── Minimal mode ────────────────────────────────────────────────

    #[test]
    fn minimal_mode_produces_empty_description_even_with_entries() {
        let entries = vec![
            entry(
                "BLKA1111111111111111111111",
                "one",
                Some("TODO"),
                "due_date",
            ),
            entry(
                "BLKA2111111111111111111111",
                "two",
                Some("DONE"),
                "scheduled_date",
            ),
            entry(
                "BLKA3111111111111111111111",
                "three",
                Some("DOING"),
                "due_date",
            ),
            entry(
                "BLKA4111111111111111111111",
                "four",
                Some("CANCELLED"),
                "due_date",
            ),
            entry("BLKA5111111111111111111111", "five", None, "scheduled_date"),
        ];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Minimal);
        let DigestResult::Create(e) = got else {
            unreachable!()
        };
        assert_eq!(e.description, "");
        // Summary shape is identical in both modes per FEAT-5d spec
        // override: pinning here to catch accidental regressions.
        assert_eq!(e.summary, "Agaric Agenda — Wed Apr 22");
    }

    // ── Breadcrumb fallback ─────────────────────────────────────────

    #[test]
    fn missing_page_title_falls_back_to_unknown_page_label() {
        let mut e = entry(
            "BLKB1111111111111111111111",
            "orphaned",
            Some("TODO"),
            "due_date",
        );
        e.block.page_id = Some("DOES_NOT_EXIST".to_owned());
        let got = digest_for_date(fixed_date(), &[e], &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        assert!(
            ev.description.contains(UNKNOWN_PAGE_LABEL),
            "missing page_title must fall back to {UNKNOWN_PAGE_LABEL}, got {:?}",
            ev.description
        );
    }

    #[test]
    fn null_page_id_falls_back_to_unknown_page_label() {
        let mut e = entry(
            "BLKB2111111111111111111111",
            "rootless",
            Some("TODO"),
            "due_date",
        );
        e.block.page_id = None;
        let got = digest_for_date(fixed_date(), &[e], &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        assert!(
            ev.description.contains(UNKNOWN_PAGE_LABEL),
            "null page_id must fall back to {UNKNOWN_PAGE_LABEL}"
        );
    }

    // ── Truncation ──────────────────────────────────────────────────

    #[test]
    fn page_title_over_60_chars_is_truncated_with_ellipsis() {
        let long_title = "x".repeat(100);
        let mut titles = HashMap::new();
        titles.insert(PAGE_A.to_owned(), long_title.clone());
        let e = entry("BLKT1111111111111111111111", "hi", Some("TODO"), "due_date");
        let got = digest_for_date(fixed_date(), &[e], &titles, PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        // Breadcrumb is 60 "x"s + "…" = 61 chars.
        let expected_breadcrumb = format!("{}\u{2026}", "x".repeat(BREADCRUMB_MAX_CHARS));
        assert_eq!(
            ev.description,
            format!("[ ] {expected_breadcrumb}{BREADCRUMB_SEPARATOR}hi")
        );
    }

    #[test]
    fn page_title_at_exactly_60_chars_is_not_truncated() {
        let exact = "y".repeat(BREADCRUMB_MAX_CHARS);
        let mut titles = HashMap::new();
        titles.insert(PAGE_A.to_owned(), exact.clone());
        let e = entry("BLKT2111111111111111111111", "hi", Some("TODO"), "due_date");
        let got = digest_for_date(fixed_date(), &[e], &titles, PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        assert!(
            ev.description.contains(&exact),
            "exactly 60 chars must not be truncated"
        );
        assert!(
            !ev.description.contains("y\u{2026}"),
            "no ellipsis should appear after an exact-fit title"
        );
    }

    #[test]
    fn content_over_80_chars_is_truncated_with_ellipsis() {
        let long_content = "a".repeat(200);
        let e = entry(
            "BLKT3111111111111111111111",
            &long_content,
            Some("TODO"),
            "due_date",
        );
        let got = digest_for_date(fixed_date(), &[e], &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        let expected_content = format!("{}\u{2026}", "a".repeat(CONTENT_MAX_CHARS));
        assert!(
            ev.description.ends_with(&expected_content),
            "content must be truncated at 80 chars with ellipsis, got {:?}",
            ev.description
        );
    }

    #[test]
    fn multi_byte_content_truncated_on_char_boundary_not_byte() {
        // "水" is 3 bytes in UTF-8; 100 copies = 300 bytes but 100
        // chars.  Truncation must respect char boundaries.
        let s = "水".repeat(100);
        let e = entry("BLKT4111111111111111111111", &s, Some("TODO"), "due_date");
        let got = digest_for_date(fixed_date(), &[e], &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        // The description is well-formed UTF-8 (no sliced code point).
        // `String` already guarantees this, but we assert the expected
        // shape: 80 "水"s + "…".
        let expected = format!("{}\u{2026}", "水".repeat(CONTENT_MAX_CHARS));
        assert!(
            ev.description.ends_with(&expected),
            "multi-byte content must be truncated on char boundary, got {:?}",
            ev.description
        );
    }

    // ── Mixed-state ordering ────────────────────────────────────────

    #[test]
    fn entries_are_sorted_by_source_then_state_then_id() {
        // Build out-of-order so the sort is observable.
        let entries = vec![
            entry(
                "BLKZZZZZZZZZZZZZZZZZZZZZZZ",
                "last-id",
                Some("TODO"),
                "scheduled_date",
            ),
            entry(
                "BLKAAAAAAAAAAAAAAAAAAAAAAA",
                "first-id",
                Some("TODO"),
                "scheduled_date",
            ),
            entry(
                "BLKMMMMMMMMMMMMMMMMMMMMMMM",
                "mid-id",
                Some("DOING"),
                "due_date",
            ),
            entry(
                "BLKMMMMMMMMMMMMMMMMMMMMMMN",
                "after-mid",
                Some("DONE"),
                "due_date",
            ),
            entry(
                "BLKMMMMMMMMMMMMMMMMMMMMMMO",
                "untyped-due",
                None,
                "due_date",
            ),
        ];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        let lines: Vec<&str> = ev.description.split('\n').collect();
        assert_eq!(lines.len(), 5, "one line per entry");
        // due_date bucket first (alphabetical vs scheduled_date).
        // Within due_date: None < Some("DOING") < Some("DONE").
        assert!(
            lines[0].contains("untyped-due"),
            "None sorts before Some(_)"
        );
        assert!(
            lines[1].contains("mid-id"),
            "DOING before DONE alphabetically"
        );
        assert!(lines[2].contains("after-mid"), "DONE comes after DOING");
        // scheduled_date bucket second.  Both TODO, so block_id
        // tiebreaker applies: BLKAAA… before BLKZZZ….
        assert!(
            lines[3].contains("first-id"),
            "block_id tiebreaker: AAA first"
        );
        assert!(
            lines[4].contains("last-id"),
            "block_id tiebreaker: ZZZ last"
        );
    }

    // ── Description overflow ────────────────────────────────────────

    /// Generate `n` synthetic entries big enough to blow past
    /// DESCRIPTION_CAP when concatenated.
    fn many_entries(n: usize) -> Vec<ProjectedAgendaEntry> {
        (0..n)
            .map(|i| {
                // block_id is left-padded so sort order is deterministic.
                let id = format!("BLK{i:023}");
                // ~80 chars of content → each line is ~100+ chars once
                // marker, breadcrumb, and separator are added.
                let content = format!("entry-{i}-{}", "x".repeat(70));
                entry(&id, &content, Some("TODO"), "due_date")
            })
            .collect()
    }

    #[test]
    fn truncation_triggers_on_many_entries_and_fits_within_cap() {
        let entries = many_entries(200);
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        let char_count = ev.description.chars().count();
        assert!(
            char_count <= DESCRIPTION_CAP,
            "description must fit in {DESCRIPTION_CAP} chars, got {char_count}"
        );
        // Overflow tail is present.
        assert!(
            ev.description.ends_with(" more in Agaric"),
            "truncated description must end with overflow suffix, got tail {:?}",
            ev.description
                .chars()
                .rev()
                .take(40)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        );
        // Extract N from "\n… and N more in Agaric".
        let idx = ev.description.rfind("\n\u{2026} and ").unwrap();
        let tail = &ev.description[idx + "\n\u{2026} and ".len()..];
        let n_str = tail.split(' ').next().unwrap();
        let n: usize = n_str.parse().unwrap();
        // Kept lines = 200 - dropped N.  Count state markers.
        let marker_count = ev.description.matches("[ ]").count();
        assert_eq!(
            marker_count + n,
            200,
            "kept markers ({marker_count}) + dropped ({n}) must equal total 200"
        );
    }

    #[test]
    fn no_overflow_suffix_when_content_fits() {
        let entries = vec![entry(
            "BLKF1111111111111111111111",
            "short",
            Some("TODO"),
            "due_date",
        )];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        assert!(
            !ev.description.contains("more in Agaric"),
            "single-entry digest must not emit overflow suffix"
        );
    }

    // ── State-marker count invariant (belt-and-suspenders) ──────────

    #[test]
    fn mixed_day_has_one_marker_per_entry() {
        let entries = vec![
            entry("BLKD1111111111111111111111", "a", Some("TODO"), "due_date"),
            entry("BLKD2111111111111111111111", "b", Some("DOING"), "due_date"),
            entry("BLKD3111111111111111111111", "c", Some("DONE"), "due_date"),
            entry(
                "BLKD4111111111111111111111",
                "d",
                Some("CANCELLED"),
                "due_date",
            ),
        ];
        let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let DigestResult::Create(ev) = got else {
            unreachable!()
        };
        // Count each marker once in the expected places.
        assert_eq!(ev.description.matches("[ ]").count(), 1);
        assert_eq!(ev.description.matches("[\u{00B7}]").count(), 1);
        assert_eq!(ev.description.matches("[x]").count(), 1);
        assert_eq!(ev.description.matches("[\u{2014}]").count(), 1);
    }

    // ── Determinism ─────────────────────────────────────────────────

    #[test]
    fn same_input_produces_same_output_across_calls() {
        let entries = vec![
            entry(
                "BLKX1111111111111111111111",
                "alpha",
                Some("TODO"),
                "due_date",
            ),
            entry(
                "BLKX2111111111111111111111",
                "beta",
                Some("DOING"),
                "scheduled_date",
            ),
            entry("BLKX3111111111111111111111", "gamma", None, "due_date"),
        ];
        let a = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        let b = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        assert_eq!(a, b, "digest must be deterministic for identical input");
    }

    #[test]
    fn permuted_input_produces_same_output() {
        let mut entries = vec![
            entry(
                "BLKY1111111111111111111111",
                "alpha",
                Some("TODO"),
                "due_date",
            ),
            entry(
                "BLKY2111111111111111111111",
                "beta",
                Some("DOING"),
                "scheduled_date",
            ),
            entry("BLKY3111111111111111111111", "gamma", None, "due_date"),
        ];
        let a = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        entries.reverse();
        let b = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
        assert_eq!(
            a, b,
            "permutation of input must not change output (canonicalisation)"
        );
    }

    // ── Property tests (proptest) ───────────────────────────────────

    mod props {
        use super::*;
        use proptest::prelude::*;

        fn arb_todo_state() -> impl Strategy<Value = Option<String>> {
            prop_oneof![
                Just(None),
                Just(Some("TODO".to_owned())),
                Just(Some("DOING".to_owned())),
                Just(Some("DONE".to_owned())),
                Just(Some("CANCELLED".to_owned())),
            ]
        }

        fn arb_source() -> impl Strategy<Value = String> {
            prop_oneof![
                Just("due_date".to_owned()),
                Just("scheduled_date".to_owned()),
            ]
        }

        fn arb_entry() -> impl Strategy<Value = ProjectedAgendaEntry> {
            (
                // block_id: fixed prefix + digits/letters so the ULID shape looks
                // plausible and the strings are ASCII.
                "BLK[A-Z0-9]{23}",
                // content: up to ~200 chars of printable ASCII and a
                // few CJK / accented code points to exercise multibyte.
                proptest::string::string_regex("[a-zA-Z0-9 !?#\\[\\]水ñ]{0,200}").unwrap(),
                arb_todo_state(),
                arb_source(),
                // page_id may be missing or one of two known pages.
                prop_oneof![
                    Just(None),
                    Just(Some(PAGE_A.to_owned())),
                    Just(Some(PAGE_B.to_owned())),
                    Just(Some("UNKNOWNPAGE99999999999999".to_owned())),
                ],
            )
                .prop_map(|(id, content, state, source, page_id)| {
                    ProjectedAgendaEntry {
                        block: BlockRow {
                            id,
                            block_type: "content".to_owned(),
                            content: Some(content),
                            parent_id: None,
                            position: Some(1),
                            deleted_at: None,
                            is_conflict: false,
                            conflict_type: None,
                            todo_state: state,
                            priority: None,
                            due_date: None,
                            scheduled_date: None,
                            page_id,
                        },
                        projected_date: DATE.to_owned(),
                        source,
                    }
                })
        }

        fn arb_privacy() -> impl Strategy<Value = PrivacyMode> {
            prop_oneof![Just(PrivacyMode::Full), Just(PrivacyMode::Minimal)]
        }

        proptest! {
            #![proptest_config(ProptestConfig::with_cases(256))]

            /// Property 1: Delete iff entries.is_empty().
            #[test]
            fn delete_iff_entries_empty(
                entries in prop::collection::vec(arb_entry(), 0..20),
                privacy in arb_privacy(),
            ) {
                let got = digest_for_date(fixed_date(), &entries, &page_titles(), privacy);
                match got {
                    DigestResult::Delete => prop_assert!(entries.is_empty()),
                    DigestResult::Create(_) => prop_assert!(!entries.is_empty()),
                }
            }

            /// Property 2: output is deterministic for a fixed input.
            #[test]
            fn output_is_deterministic(
                entries in prop::collection::vec(arb_entry(), 0..30),
                privacy in arb_privacy(),
            ) {
                let a = digest_for_date(fixed_date(), &entries, &page_titles(), privacy);
                let b = digest_for_date(fixed_date(), &entries, &page_titles(), privacy);
                prop_assert_eq!(a, b);
            }

            /// Property 3: description ≤ DESCRIPTION_CAP chars in both modes.
            #[test]
            fn description_always_within_cap(
                entries in prop::collection::vec(arb_entry(), 0..80),
                privacy in arb_privacy(),
            ) {
                let got = digest_for_date(fixed_date(), &entries, &page_titles(), privacy);
                if let DigestResult::Create(e) = got {
                    prop_assert!(
                        e.description.chars().count() <= DESCRIPTION_CAP,
                        "description exceeded cap ({} chars)",
                        e.description.chars().count()
                    );
                }
            }

            /// Property 4: summary always starts with SUMMARY_PREFIX.
            #[test]
            fn summary_prefix_is_stable(
                entries in prop::collection::vec(arb_entry(), 1..10),
                privacy in arb_privacy(),
            ) {
                let got = digest_for_date(fixed_date(), &entries, &page_titles(), privacy);
                if let DigestResult::Create(e) = got {
                    prop_assert!(e.summary.starts_with(SUMMARY_PREFIX));
                }
            }

            /// Property 5: in full mode, (markers kept in description) +
            /// (entries dropped by overflow suffix) == entries.len().
            #[test]
            fn marker_accounting_matches_entry_count(
                entries in prop::collection::vec(arb_entry(), 1..40),
            ) {
                let got = digest_for_date(fixed_date(), &entries, &page_titles(), PrivacyMode::Full);
                let DigestResult::Create(e) = got else {
                    prop_assert!(false, "non-empty entries must yield Create");
                    return Ok(());
                };
                // Sum of all marker appearances: each entry contributes
                // exactly one `[ ]` / `[·]` / `[x]` / `[—]` at line start,
                // so the total across the four markers equals the kept
                // line count.  Use line count for robustness against
                // tests where content might contain `[ ]` by chance.
                let kept_lines = if e.description.is_empty() {
                    0
                } else if e.description.ends_with(" more in Agaric") {
                    // Last line is the overflow suffix — not a marker
                    // line.  Count newline-prefixed entries:
                    // kept_lines == split('\n').count() - 1.
                    e.description.split('\n').count() - 1
                } else {
                    e.description.split('\n').count()
                };
                let dropped = if let Some(idx) = e.description.rfind("\n\u{2026} and ") {
                    let tail = &e.description[idx + "\n\u{2026} and ".len()..];
                    let n_str = tail.split(' ').next().unwrap();
                    n_str.parse::<usize>().unwrap_or(0)
                } else {
                    0
                };
                prop_assert_eq!(kept_lines + dropped, entries.len());
            }
        }
    }

    // ── insta snapshot tests ───────────────────────────────────────

    // Disambiguating test dates so the snapshots are not all the same
    // Wednesday.
    fn date(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn snapshot_empty_day_returns_delete() {
        let got = digest_for_date(date("2026-04-20"), &[], &page_titles(), PrivacyMode::Full);
        insta::assert_yaml_snapshot!("digest_empty_day", got);
    }

    #[test]
    fn snapshot_single_entry_day() {
        let entries = vec![entry(
            "BLKS1111111111111111111111",
            "Review PR #42",
            Some("TODO"),
            "due_date",
        )];
        let got = digest_for_date(
            date("2026-04-22"),
            &entries,
            &page_titles(),
            PrivacyMode::Full,
        );
        insta::assert_yaml_snapshot!("digest_single_entry", got);
    }

    #[test]
    fn snapshot_mixed_state_day() {
        let entries = vec![
            entry(
                "BLKS21111111111111111111111",
                "Design review",
                Some("TODO"),
                "due_date",
            ),
            entry(
                "BLKS22222222222222222222222",
                "Writing spec",
                Some("DOING"),
                "scheduled_date",
            ),
            entry(
                "BLKS23333333333333333333333",
                "Ship v1.0",
                Some("DONE"),
                "due_date",
            ),
            entry(
                "BLKS24444444444444444444444",
                "Legacy migration",
                Some("CANCELLED"),
                "scheduled_date",
            ),
            entry(
                "BLKS25555555555555555555555",
                "Loose note",
                None,
                "due_date",
            ),
        ];
        let got = digest_for_date(
            date("2026-04-23"),
            &entries,
            &page_titles(),
            PrivacyMode::Full,
        );
        insta::assert_yaml_snapshot!("digest_mixed_state_day", got);
    }

    #[test]
    fn snapshot_truncation_triggering_day() {
        let entries = many_entries(200);
        let got = digest_for_date(
            date("2026-04-24"),
            &entries,
            &page_titles(),
            PrivacyMode::Full,
        );
        // The snapshot pins the entire truncated body so future changes
        // to the overflow-suffix template are caught.
        insta::assert_yaml_snapshot!("digest_truncation_day", got);
    }

    #[test]
    fn snapshot_minimal_mode_with_entries() {
        let entries = vec![
            entry(
                "BLKS31111111111111111111111",
                "Private item 1",
                Some("TODO"),
                "due_date",
            ),
            entry(
                "BLKS32222222222222222222222",
                "Private item 2",
                Some("DONE"),
                "scheduled_date",
            ),
        ];
        let got = digest_for_date(
            date("2026-04-25"),
            &entries,
            &page_titles(),
            PrivacyMode::Minimal,
        );
        insta::assert_yaml_snapshot!("digest_minimal_mode", got);
    }

    /// FEAT-5d spec mentions a "tag-heavy day" snapshot; the current
    /// `ProjectedAgendaEntry` struct does not carry tag data (tags live
    /// in `block_tags`), so this snapshot instead exercises a day with
    /// many distinct pages — the analogue "metadata-heavy" axis the
    /// digest actually has control over.  Flagged to the orchestrator.
    #[test]
    fn snapshot_multi_page_heavy_day() {
        let mut titles = page_titles();
        titles.insert(
            "PAGE03CCCCCCCCCCCCCCCCCCCC".to_owned(),
            "Personal".to_owned(),
        );
        titles.insert("PAGE04DDDDDDDDDDDDDDDDDDDD".to_owned(), "Work".to_owned());
        titles.insert(
            "PAGE05EEEEEEEEEEEEEEEEEEEE".to_owned(),
            "Reading List".to_owned(),
        );
        let entries = vec![
            ProjectedAgendaEntry {
                block: block(
                    "BLKS41111111111111111111111",
                    "Grocery run",
                    Some("TODO"),
                    Some("PAGE03CCCCCCCCCCCCCCCCCCCC"),
                ),
                projected_date: "2026-04-26".to_owned(),
                source: "due_date".to_owned(),
            },
            ProjectedAgendaEntry {
                block: block(
                    "BLKS42222222222222222222222",
                    "Standup",
                    Some("DONE"),
                    Some("PAGE04DDDDDDDDDDDDDDDDDDDD"),
                ),
                projected_date: "2026-04-26".to_owned(),
                source: "scheduled_date".to_owned(),
            },
            ProjectedAgendaEntry {
                block: block(
                    "BLKS43333333333333333333333",
                    "Finish 'Designing Data-Intensive Applications'",
                    Some("DOING"),
                    Some("PAGE05EEEEEEEEEEEEEEEEEEEE"),
                ),
                projected_date: "2026-04-26".to_owned(),
                source: "due_date".to_owned(),
            },
            ProjectedAgendaEntry {
                block: block(
                    "BLKS44444444444444444444444",
                    "Retro notes",
                    None,
                    Some(PAGE_A),
                ),
                projected_date: "2026-04-26".to_owned(),
                source: "scheduled_date".to_owned(),
            },
            ProjectedAgendaEntry {
                block: block(
                    "BLKS45555555555555555555555",
                    "Archive old emails",
                    Some("CANCELLED"),
                    Some(PAGE_B),
                ),
                projected_date: "2026-04-26".to_owned(),
                source: "due_date".to_owned(),
            },
        ];
        let got = digest_for_date(date("2026-04-26"), &entries, &titles, PrivacyMode::Full);
        insta::assert_yaml_snapshot!("digest_multi_page_day", got);
    }
}
