//! FEAT-5e — background connector task that mirrors Agaric's daily
//! agenda into the dedicated "Agaric Agenda" Google Calendar.
//!
//! # Responsibilities
//!
//! * **Own the push-lease** — on every cycle, try to claim or renew the
//!   lease via [`super::lease::claim_lease`].  Without the lease we
//!   stay idle so a sibling device does not receive phantom updates.
//! * **First-connect calendar creation** — if `gcal_settings.calendar_id`
//!   is still empty, call [`GcalApi::create_dedicated_calendar`] once
//!   (under lease) and persist the returned ID.
//! * **Per-date diff engine** — for each dirty date compute a digest,
//!   hash it, compare against `gcal_agenda_event_map.last_pushed_hash`,
//!   and `insert` / `patch` / `delete` the remote event.
//! * **Reconcile sweep** — every [`RECONCILE_INTERVAL`] re-add every
//!   date in `[today, today + window_days]` to the dirty set so a
//!   missed `DirtyEvent` or a crashed push catches up.
//! * **Debounce** — coalesce bursts of `DirtyEvent`s into a single
//!   cycle [`DEBOUNCE_WINDOW`] after the last event.
//! * **Recovery from calendar deletion** — if any call returns
//!   [`GcalErrorKind::CalendarGone`], wipe `gcal_agenda_event_map`,
//!   reset `calendar_id`, emit `gcal:calendar_recreated`, and let the
//!   next cycle rebuild.
//!
//! # Testability
//!
//! The connector is split into an outer loop (wired to Tokio primitives
//! and [`Clock`]) and a set of `*_inner` helpers that take their
//! dependencies as plain parameters.  Tests drive the helpers directly
//! with a `wiremock::MockServer`-backed [`GcalApi`] + [`MockTokenStore`]
//! + [`FixedClock`] — the production outer loop is not exercised in
//!   unit tests (that would require `tokio::time::pause`, which is
//!   brittle under `multi_thread` runtimes and fights the SQL-side
//!   timestamp comparisons).

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Days, NaiveDate, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{mpsc, Notify};

use crate::error::{AppError, GcalErrorKind};
use crate::pagination::ProjectedAgendaEntry;

use super::api::{EventPatch, GcalApi};
use super::digest::{self, DigestResult, Event, PrivacyMode};
use super::keyring_store::{GcalEvent, GcalEventEmitter, TokenStore};
use super::lease;
use super::models::{
    self, delete_event_map_by_date, get_event_map_for_date, upsert_event_map, GcalAgendaEventMap,
    GcalSettingKey,
};
use super::oauth::Token;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// How long after the last dirty event to wait before flushing the
/// accumulated dirty set.  Matches FEAT-5 parent § "Open questions".
pub const DEBOUNCE_WINDOW: Duration = Duration::from_millis(500);

/// Wall-clock cadence of the reconcile sweep.  Every interval, every
/// date in `[today, today + window_days]` is re-pushed unconditionally.
pub const RECONCILE_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Cap on the per-cycle fetch from `list_projected_agenda_inner`.
/// Matches FEAT-5 parent § "Per-date diff engine" — 500 is well above
/// any realistic single-date load and keeps pagination simple.
pub const AGENDA_FETCH_LIMIT: i64 = 500;

/// Default daily-digest window when `gcal_settings.window_days` is
/// unreadable or malformed.
pub const DEFAULT_WINDOW_DAYS: i64 = 30;

/// Minimum allowed window (per FEAT-5 parent clamp).
pub const MIN_WINDOW_DAYS: i64 = 7;

/// Maximum allowed window (per FEAT-5 parent clamp).
pub const MAX_WINDOW_DAYS: i64 = 90;

/// Human-readable summary for the dedicated calendar.
pub const DEDICATED_CALENDAR_NAME: &str = "Agaric Agenda";

// ---------------------------------------------------------------------------
// Event → EventPatch translation
// ---------------------------------------------------------------------------

/// Build an [`EventPatch`] from a digest [`Event`].  The connector has
/// already computed a complete fresh-state event by the time we reach a
/// PATCH; we copy every field set on `event` onto the patch so the
/// remote replaces what we last pushed.
///
/// Both `start.date` and `end.date` are inclusive `YYYY-MM-DD` strings on
/// the digest side; [`EventPatch::with_start`] / `with_end` take
/// [`NaiveDate`], so we parse them here.  A parse failure is
/// `AppError::Validation` so the surrounding [`classify_date_err`]
/// shovels it into [`DateFailure::Other`] (it would mean the digest
/// produced an invalid date, which is a programmer error).
fn event_to_patch(event: &Event) -> Result<EventPatch, AppError> {
    let start = NaiveDate::parse_from_str(&event.start.date, "%Y-%m-%d").map_err(|e| {
        AppError::Validation(format!(
            "gcal.connector.bad_start_date: {}: {e}",
            event.start.date
        ))
    })?;
    let end = NaiveDate::parse_from_str(&event.end.date, "%Y-%m-%d").map_err(|e| {
        AppError::Validation(format!(
            "gcal.connector.bad_end_date: {}: {e}",
            event.end.date
        ))
    })?;
    Ok(EventPatch::new()
        .with_summary(event.summary.clone())
        .with_description(event.description.clone())
        .with_start(start)
        .with_end(end)
        .with_transparency(event.transparency.clone()))
}

// ---------------------------------------------------------------------------
// Clock — injectable time source
// ---------------------------------------------------------------------------

/// Injectable clock for testability.  Production uses [`SystemClock`];
/// tests drive [`FixedClock`] to simulate midnight rollover + lease
/// expiry without any real sleeping.
///
/// `now()` returns UTC because the database stores RFC 3339 timestamps
/// in UTC and SQL-side comparisons must be timezone-consistent. In
/// contrast, `today()` returns the user's **local** date because every
/// caller (reconcile sweep window `[today, today + window_days]`,
/// journal-page lookup, agenda dates, GCal digest contents) wants the
/// user's current calendar day, not UTC's.  See REVIEW-LATER.md H-16.
pub trait Clock: Send + Sync + std::fmt::Debug {
    fn now(&self) -> DateTime<Utc>;
    fn today(&self) -> NaiveDate {
        chrono::Local::now().date_naive()
    }
}

/// Production clock — reads `Utc::now()` on every call.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
    // `today()` uses the trait default, which reads `chrono::Local::now()`
    // — the user's local date, not UTC.
}

/// Test clock — returns a caller-settable fixed instant.  Advancing
/// the clock is a `set()` call, not `tokio::time::advance` — we want
/// the SQL-side RFC 3339 comparators to see the advanced value.
#[derive(Debug)]
pub struct FixedClock {
    inner: std::sync::Mutex<DateTime<Utc>>,
}

impl FixedClock {
    #[must_use]
    pub fn new(initial: DateTime<Utc>) -> Self {
        Self {
            inner: std::sync::Mutex::new(initial),
        }
    }

    pub fn set(&self, now: DateTime<Utc>) {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = now;
    }

    pub fn advance(&self, by: chrono::Duration) {
        let mut g = self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *g += by;
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Override the trait default so test "today" stays deterministic
    /// across CI timezones.  Production `Clock::today()` reads
    /// `chrono::Local::now().date_naive()` (so the user's local day
    /// drives the reconcile window), but tests want the date_naive of
    /// the caller-set fixed instant — anything else would make
    /// midnight-rollover tests flaky on machines whose local TZ is not
    /// UTC.
    fn today(&self) -> NaiveDate {
        self.now().date_naive()
    }
}

// ---------------------------------------------------------------------------
// DirtyEvent / DirtyDate set
// ---------------------------------------------------------------------------

/// Payload passed to the connector from the materializer-property-change
/// hook (out of scope for this slice; lands in a follow-up).  Only the
/// `old`/`new` date set matters — the connector unions them into its
/// in-memory dirty set.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DirtyEvent {
    pub old_affected_dates: Vec<NaiveDate>,
    pub new_affected_dates: Vec<NaiveDate>,
}

impl DirtyEvent {
    /// Build a [`DirtyEvent`] that marks a single date as dirty (old
    /// value only).  Convenience used by tests and by the "force
    /// resync" command path.
    #[must_use]
    pub fn single(date: NaiveDate) -> Self {
        Self {
            old_affected_dates: vec![date],
            new_affected_dates: Vec::new(),
        }
    }

    /// Affected dates, de-duplicated.
    pub fn affected(&self) -> BTreeSet<NaiveDate> {
        self.old_affected_dates
            .iter()
            .chain(self.new_affected_dates.iter())
            .copied()
            .collect()
    }
}

// ---------------------------------------------------------------------------
// Handle — exposed to lib.rs + the Tauri commands
// ---------------------------------------------------------------------------

/// Handle for driving the connector task from outside.  Cheap to
/// clone; every method is fire-and-forget (never blocks on the task).
///
/// Produced by [`spawn_connector`]; shared via `tauri::State`.
#[derive(Debug, Clone)]
pub struct GcalConnectorHandle {
    dirty_tx: mpsc::UnboundedSender<DirtyEvent>,
    force_sweep: Arc<Notify>,
}

impl GcalConnectorHandle {
    /// Notify the connector that a set of dates is dirty.  The
    /// connector coalesces bursts inside [`DEBOUNCE_WINDOW`].
    pub fn notify_dirty(&self, event: DirtyEvent) {
        if let Err(e) = self.dirty_tx.send(event) {
            tracing::warn!(
                target: "gcal",
                error = %e,
                "failed to notify connector of dirty dates — task may have exited",
            );
        }
    }

    /// Request an immediate full-window resync.  Unlike
    /// [`Self::notify_dirty`], the current cycle is flushed even when
    /// no `DirtyEvent`s are pending.
    ///
    /// Uses [`tokio::sync::Notify::notify_one`] so a call that
    /// arrives before the task's `.notified()` await still produces
    /// the next flush — `notify_waiters` would silently drop the
    /// wake-up in that race window.
    pub fn force_resync(&self) {
        self.force_sweep.notify_one();
    }

    /// Test-only constructor so `#[cfg(test)]` code outside this
    /// module can wire up the channel + notify primitives directly.
    #[cfg(test)]
    #[doc(hidden)]
    pub fn __test_new(
        dirty_tx: mpsc::UnboundedSender<DirtyEvent>,
        force_sweep: Arc<Notify>,
    ) -> Self {
        Self {
            dirty_tx,
            force_sweep,
        }
    }
}

// ---------------------------------------------------------------------------
// Settings snapshot — read once per cycle
// ---------------------------------------------------------------------------

/// Subset of `gcal_settings` the cycle actually uses.  Read in a
/// single pass so the cycle does not issue N `get_setting` calls for
/// every date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GcalSettingsSnapshot {
    pub calendar_id: String,
    pub privacy_mode: PrivacyMode,
    pub window_days: i64,
}

impl GcalSettingsSnapshot {
    pub(crate) async fn read(pool: &SqlitePool) -> Result<Self, AppError> {
        let calendar_id = models::get_setting(pool, GcalSettingKey::CalendarId)
            .await?
            .unwrap_or_default();
        let privacy_mode_raw = models::get_setting(pool, GcalSettingKey::PrivacyMode)
            .await?
            .unwrap_or_default();
        let privacy_mode = PrivacyMode::from_setting(&privacy_mode_raw);
        let window_raw = models::get_setting(pool, GcalSettingKey::WindowDays)
            .await?
            .unwrap_or_default();
        let window_days = parse_window_days(&window_raw);
        Ok(Self {
            calendar_id,
            privacy_mode,
            window_days,
        })
    }
}

fn parse_window_days(raw: &str) -> i64 {
    raw.parse::<i64>()
        .ok()
        .map(|n| n.clamp(MIN_WINDOW_DAYS, MAX_WINDOW_DAYS))
        .unwrap_or(DEFAULT_WINDOW_DAYS)
}

// ---------------------------------------------------------------------------
// Cycle entry points (testable)
// ---------------------------------------------------------------------------

/// Full dirty set the cycle operates on: an in-memory cache of dates
/// that have pending pushes.  Kept as a `BTreeSet` so the cycle
/// processes dates in order (aesthetically nicer logs + deterministic
/// test assertions).
pub type DirtySet = BTreeSet<NaiveDate>;

/// Outcome of one cycle invocation.  Communicated to the outer loop
/// so it can decide whether to retry with backoff.
///
/// `HardFailure` carries the structured [`GcalErrorKind`] so callers
/// (and tests) can match on the variant directly instead of doing
/// substring matching on a formatted string.  Use the [`Display`]
/// impl for log lines — the per-variant format is centralised in
/// [`kind_display`] and shared with [`classify_date_err`] so the cycle
/// and per-date paths stay byte-equivalent for the same kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CycleOutcome {
    /// Cycle ran to completion.  Some / all dates may have been
    /// skipped due to recoverable per-event errors; the connector
    /// stays live.
    Ok,
    /// Lease is held by another device — nothing was pushed this
    /// cycle.  The outer loop waits and retries on the next tick.
    LeaseUnavailable,
    /// Hard failure that requires operator intervention.  Outer loop
    /// does not retry; Settings UI surfaces the error via the emitter.
    HardFailure(GcalErrorKind),
}

impl std::fmt::Display for CycleOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Ok => f.write_str("ok"),
            Self::LeaseUnavailable => f.write_str("lease_unavailable"),
            Self::HardFailure(kind) => f.write_str(&kind_display(kind)),
        }
    }
}

/// Canonical string form of a [`GcalErrorKind`] for the cycle's
/// log/UI surface.  Shared between the [`CycleOutcome`] [`Display`]
/// impl and [`classify_date_err`] so the two classifiers cannot
/// drift out of sync on per-variant wording (REVIEW-LATER MAINT-140
/// + MAINT-151(h)).
///
/// These strings are intentionally distinct from
/// [`GcalErrorKind`]'s thiserror [`Display`] output — they are the
/// short, machine-greppable summaries used in tracing fields, not
/// the user-facing prose carried inside [`AppError`].
fn kind_display(kind: &GcalErrorKind) -> String {
    match kind {
        GcalErrorKind::Unauthorized => "unauthorized (reauth required)".to_owned(),
        GcalErrorKind::Forbidden(msg) => format!("forbidden: {msg}"),
        GcalErrorKind::RateLimited { retry_after_ms } => {
            format!("rate_limited: retry after {retry_after_ms}ms")
        }
        GcalErrorKind::ServerError { status } => format!("server_error: HTTP {status}"),
        GcalErrorKind::Transport(msg) => format!("transport: {msg}"),
        GcalErrorKind::InvalidRequest(msg) => format!("invalid_request: {msg}"),
        GcalErrorKind::CalendarGone => "calendar_gone".to_owned(),
        GcalErrorKind::EventGone => "event_gone".to_owned(),
    }
}

/// Run a single cycle end-to-end.  Entry point for the unit-test
/// suite — the outer Tokio loop in [`spawn_connector`] wraps this in
/// lease-renewal + `fetch_with_auto_refresh` + backoff logic.
///
/// * `dirty`: dates the cycle must evaluate.  On entry to the
///   reconcile path the caller fills this with every date in
///   `[today, today + window_days]`; on the event-driven path it
///   holds the accumulated dirty set since the last flush.
/// * `token`: the current OAuth access token.  Tests pass a dummy
///   (the wiremock mock server ignores its contents).
pub async fn run_cycle(
    pool: &SqlitePool,
    api: &GcalApi,
    emitter: &Arc<dyn GcalEventEmitter>,
    device_id: &str,
    clock: &dyn Clock,
    token: &Token,
    dirty: &DirtySet,
) -> Result<CycleOutcome, AppError> {
    let now = clock.now();

    // 1. Try to claim/renew the lease.  Without it, idle.
    let have_lease = lease::claim_lease(pool, device_id, now).await?;
    if !have_lease {
        tracing::debug!(
            target: "gcal",
            device = device_id,
            "push-lease held by another device — idle",
        );
        return Ok(CycleOutcome::LeaseUnavailable);
    }

    // 2. Read settings once.  If a writer changes them mid-cycle the
    // next cycle picks up the new snapshot.
    let settings = GcalSettingsSnapshot::read(pool).await?;

    // 3. First-connect flow: if no calendar_id yet, create one.  Any
    // failure here is returned as a HardFailure so the outer loop can
    // decide whether to retry (recoverable 5xx) or surface (403).
    let calendar_id = if settings.calendar_id.is_empty() {
        match api
            .create_dedicated_calendar(token, DEDICATED_CALENDAR_NAME)
            .await
        {
            Ok(id) => {
                models::set_setting(pool, GcalSettingKey::CalendarId, &id).await?;
                id
            }
            Err(e) => {
                return classify_cycle_failure(emitter, &e);
            }
        }
    } else {
        settings.calendar_id.clone()
    };

    // 4. Per-date iteration.  We intentionally do NOT short-circuit on
    // the first failure — a transient 5xx on one date should not block
    // a successful push to a sibling date.  Hard failures (401 / 403 /
    // CalendarGone) are returned to the caller for the whole cycle.
    for date in dirty {
        match push_date(pool, api, token, &settings, &calendar_id, *date).await {
            Ok(_) => {}
            Err(DateFailure::CalendarGone) => {
                // Whole cycle has to abort — the calendar is gone.
                recover_calendar_gone(pool, emitter).await?;
                return Ok(CycleOutcome::Ok);
            }
            Err(DateFailure::Unauthorized) => {
                emitter.emit(GcalEvent::ReauthRequired);
                return Ok(CycleOutcome::HardFailure(GcalErrorKind::Unauthorized));
            }
            Err(DateFailure::Forbidden(msg)) => {
                emitter.emit(GcalEvent::PushDisabled);
                return Ok(CycleOutcome::HardFailure(GcalErrorKind::Forbidden(msg)));
            }
            Err(DateFailure::Skipped(reason)) => {
                tracing::warn!(
                    target: "gcal",
                    date = %date,
                    reason = %reason,
                    "skipped date for this cycle — will retry on next sweep",
                );
            }
            Err(DateFailure::Other(e)) => return Err(e),
        }
    }

    Ok(CycleOutcome::Ok)
}

#[derive(Debug)]
enum DateFailure {
    /// 401 — stop the cycle, emit reauth.
    Unauthorized,
    /// 403 — stop the cycle, emit push-disabled.
    Forbidden(String),
    /// 404 on calendar — abort cycle, recover.
    CalendarGone,
    /// Transient / per-event error — log and continue with the next date.
    Skipped(String),
    /// Unexpected AppError — propagate to the caller.
    Other(AppError),
}

fn classify_cycle_failure(
    emitter: &Arc<dyn GcalEventEmitter>,
    err: &AppError,
) -> Result<CycleOutcome, AppError> {
    if let AppError::Gcal(kind) = err {
        // Side effects (event emission) per kind — only the variants
        // the Settings UI surfaces a banner for fire here.  The
        // remaining recognised variants (rate-limit / 5xx /
        // invalid-request) are silent at the emitter level; the
        // tracing log line in [`spawn_connector`] still records them.
        match kind {
            GcalErrorKind::Unauthorized => emitter.emit(GcalEvent::ReauthRequired),
            GcalErrorKind::Forbidden(_) => emitter.emit(GcalEvent::PushDisabled),
            _ => {}
        }
        return Ok(CycleOutcome::HardFailure(kind.clone()));
    }
    // Non-Gcal `AppError` is unexpected here (every transport-layer
    // failure is mapped to `AppError::Gcal(...)` upstream in `api.rs`)
    // — log it and surface as a synthetic `InvalidRequest` so the
    // outer loop's `HardFailure` branch still fires + clears the
    // dirty set, matching the pre-MAINT-140 behaviour.
    tracing::error!(
        target: "gcal",
        error = ?err,
        "hard failure in cycle setup",
    );
    Ok(CycleOutcome::HardFailure(GcalErrorKind::InvalidRequest(
        err.to_string(),
    )))
}

/// Evaluate a single date: fetch agenda entries, compute digest, hash,
/// compare, push/patch/delete.
#[tracing::instrument(skip(pool, api, token, settings), fields(date = %date))]
async fn push_date(
    pool: &SqlitePool,
    api: &GcalApi,
    token: &Token,
    settings: &GcalSettingsSnapshot,
    calendar_id: &str,
    date: NaiveDate,
) -> Result<(), DateFailure> {
    let date_str = date.format("%Y-%m-%d").to_string();

    // Fetch agenda entries for the date.
    let entries = crate::commands::list_projected_agenda_inner(
        pool,
        date_str.clone(),
        date_str.clone(),
        Some(AGENDA_FETCH_LIMIT),
    )
    .await
    .map_err(DateFailure::Other)?;

    // Resolve page titles in bulk via a single json_each() query.
    let page_titles = resolve_page_titles(pool, &entries)
        .await
        .map_err(DateFailure::Other)?;

    // Compute the digest.
    let digest_result =
        digest::digest_for_date(date, &entries, &page_titles, settings.privacy_mode);

    // Hash the digest payload for idempotency.
    let fresh_hash = hash_digest(&digest_result).map_err(DateFailure::Other)?;

    // Compare against map row.
    let prior = get_event_map_for_date(pool, &date_str)
        .await
        .map_err(DateFailure::Other)?;

    match (digest_result, prior) {
        // No entries and no map row — nothing to do.
        (DigestResult::Delete, None) => Ok(()),
        // No entries + existing row → delete remote event + map row.
        (DigestResult::Delete, Some(prior)) => {
            match api
                .delete_event(token, calendar_id, &prior.gcal_event_id)
                .await
            {
                Ok(()) => {}
                Err(AppError::Gcal(GcalErrorKind::EventGone)) => {
                    // Already gone remotely — fine; drop the map row.
                }
                Err(e) => return Err(classify_date_err(&e)),
            }
            delete_event_map_by_date(pool, &date_str)
                .await
                .map_err(DateFailure::Other)?;
            Ok(())
        }
        // Entries + no prior row → fresh insert.
        (DigestResult::Create(event), None) => {
            let response = api
                .insert_event(token, calendar_id, &event)
                .await
                .map_err(|e| classify_date_err(&e))?;
            let entry = GcalAgendaEventMap {
                date: date_str,
                gcal_event_id: response.id,
                last_pushed_hash: fresh_hash,
                last_pushed_at: crate::now_rfc3339(),
            };
            upsert_event_map(pool, &entry)
                .await
                .map_err(DateFailure::Other)?;
            Ok(())
        }
        // Entries + prior row → compare hashes; patch on mismatch.
        (DigestResult::Create(event), Some(prior)) => {
            if prior.last_pushed_hash == fresh_hash {
                // No-op — the remote state is already in sync.
                return Ok(());
            }
            // Translate the digest event into the API's `EventPatch`
            // shape — see `event_to_patch` for the inclusive-date /
            // optional-field handling.  A parse failure here is a
            // programmer error (digest produced an invalid date) and
            // surfaces as `DateFailure::Other`.
            let patch = event_to_patch(&event).map_err(|e| classify_date_err(&e))?;
            match api
                .patch_event(token, calendar_id, &prior.gcal_event_id, &patch)
                .await
            {
                Ok(_resp) => {
                    // The `EventResponse` is intentionally unused: the
                    // connector's per-date dedup is hash-based on the
                    // local digest payload (`fresh_hash`), so nothing
                    // about the remote echo would change our decision
                    // for this date.  Awaiting it is what proves the
                    // write succeeded; the body itself is discarded.
                    let entry = GcalAgendaEventMap {
                        date: date_str,
                        gcal_event_id: prior.gcal_event_id,
                        last_pushed_hash: fresh_hash,
                        last_pushed_at: crate::now_rfc3339(),
                    };
                    upsert_event_map(pool, &entry)
                        .await
                        .map_err(DateFailure::Other)?;
                    Ok(())
                }
                Err(AppError::Gcal(GcalErrorKind::EventGone)) => {
                    // Remote event disappeared — drop the stale map row
                    // and re-insert on the next cycle.  Removing the row
                    // is enough for this cycle; the `fresh_hash` value
                    // was never pushed so the map row cannot lie.
                    delete_event_map_by_date(pool, &date_str)
                        .await
                        .map_err(DateFailure::Other)?;
                    Err(DateFailure::Skipped("event_gone".to_owned()))
                }
                Err(e) => Err(classify_date_err(&e)),
            }
        }
    }
}

/// Map an [`AppError`] raised from a per-event client call onto the
/// [`DateFailure`] taxonomy used by [`push_date`].
///
/// Per-variant string formatting is centralised in [`kind_display`]
/// so this classifier and [`classify_cycle_failure`] cannot drift
/// (REVIEW-LATER MAINT-140 + MAINT-151(h)).  Outer enum-variant
/// routing (`Unauthorized` / `Forbidden` / `CalendarGone` end the
/// cycle; everything else is `Skipped`) stays here — only the
/// reason-string formatting goes through the helper.
fn classify_date_err(err: &AppError) -> DateFailure {
    if let AppError::Gcal(kind) = err {
        match kind {
            GcalErrorKind::Unauthorized => DateFailure::Unauthorized,
            GcalErrorKind::Forbidden(msg) => DateFailure::Forbidden(msg.clone()),
            GcalErrorKind::CalendarGone => DateFailure::CalendarGone,
            // EventGone / RateLimited / ServerError / Transport /
            // InvalidRequest are all "skip this date, retry on next
            // sweep" — the reason string comes from the shared
            // formatter.
            GcalErrorKind::EventGone
            | GcalErrorKind::RateLimited { .. }
            | GcalErrorKind::ServerError { .. }
            | GcalErrorKind::Transport(_)
            | GcalErrorKind::InvalidRequest(_) => DateFailure::Skipped(kind_display(kind)),
        }
    } else {
        DateFailure::Other(AppError::Validation(format!(
            "gcal.connector.unexpected_error: {err}"
        )))
    }
}

/// Recover from a `CalendarGone` response: wipe the map, reset the
/// calendar_id, emit `calendar_recreated` so the UI refreshes, and let
/// the next cycle re-create the calendar.
///
/// **M-89:** the event-map wipe and `calendar_id` reset are wrapped in
/// a single `BEGIN IMMEDIATE` transaction so a crash between the two
/// writes cannot leave the post-state inconsistent (empty map but
/// `calendar_id` still pointing at the gone calendar).
///
/// **MAINT-151(i):** the inlined `set_setting` UPDATE that used to
/// live here now goes through [`models::set_setting_in_tx`], which
/// takes any `sqlx::Executor` (including `&mut Transaction`).  This
/// keeps both call sites — pool-based [`models::set_setting`] and
/// transaction-bound recovery — funneled through the same UPDATE
/// shape and `NotFound` policy.  `oauth_account_email` is
/// intentionally untouched here (that is finding M-95).
async fn recover_calendar_gone(
    pool: &SqlitePool,
    emitter: &Arc<dyn GcalEventEmitter>,
) -> Result<(), AppError> {
    tracing::warn!(
        target: "gcal",
        "calendar gone — wiping event map, resetting calendar_id",
    );
    let mut tx = crate::db::begin_immediate_logged(pool, "gcal_recover_calendar_gone").await?;

    sqlx::query!("DELETE FROM gcal_agenda_event_map")
        .execute(&mut *tx)
        .await?;

    models::set_setting_in_tx(&mut *tx, GcalSettingKey::CalendarId.as_str(), "").await?;

    tx.commit().await?;
    emitter.emit(GcalEvent::CalendarRecreated);
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers — page-title bulk resolution (json_each() batch query)
// ---------------------------------------------------------------------------

/// Resolve every distinct `page_id` referenced by `entries` in a
/// single query via `json_each()` batching (AGENTS.md backend pattern
/// 3).  Missing pages are simply absent from the result map — the
/// digest formatter falls back to `(unknown page)`.
async fn resolve_page_titles(
    pool: &SqlitePool,
    entries: &[ProjectedAgendaEntry],
) -> Result<HashMap<String, String>, AppError> {
    let mut ids: Vec<&str> = entries
        .iter()
        .filter_map(|e| e.block.page_id.as_deref())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let ids_json = serde_json::to_string(&ids).map_err(AppError::Json)?;
    // Recursive-CTE filter on `is_conflict = 0` is implicit here: we
    // join on `blocks.id` directly and constrain on `is_conflict = 0`
    // in the WHERE clause.  The entries list is already conflict-free
    // upstream but the JOIN being explicit is the safer shape.
    let rows = sqlx::query!(
        "SELECT b.id AS id, b.content AS content \
         FROM blocks b \
         JOIN json_each(?) j ON j.value = b.id \
         WHERE b.is_conflict = 0",
        ids_json,
    )
    .fetch_all(pool)
    .await?;
    let mut out = HashMap::with_capacity(rows.len());
    for row in rows {
        if let Some(content) = row.content {
            out.insert(row.id, content);
        }
    }
    Ok(out)
}

/// Canonical hash of the digest result.  The hash only fluctuates
/// when the formatted event body changes — a content refactor that
/// stabilises the output keeps the hash constant across versions.
fn hash_digest(digest: &DigestResult) -> Result<String, AppError> {
    let bytes = serde_json::to_vec(digest).map_err(AppError::Json)?;
    Ok(blake3::hash(&bytes).to_hex().to_string())
}

// ---------------------------------------------------------------------------
// Date-range helpers
// ---------------------------------------------------------------------------

/// Fill `dirty` with every date in `[today, today + window_days)`.
/// Used by the reconcile sweep and by `force_gcal_resync`.
///
/// **I-GCalSpaces-4 — Caller-side invariant.** Callers MUST pass
/// `window_days >= MIN_WINDOW_DAYS` (currently 7). The function uses
/// `window_days.max(0)` defensively, so a 0 or negative value silently
/// produces an empty `dirty` set rather than panicking — but that
/// silently disables the push window for that tick. The canonical
/// sanitizer is [`parse_window_days`], which clamps user-supplied
/// strings to `[MIN_WINDOW_DAYS, MAX_WINDOW_DAYS]` and returns
/// `DEFAULT_WINDOW_DAYS` on empty/garbage. Any future caller that
/// constructs `window_days` through a different path (e.g. computed
/// from a duration, or read from a different settings key) must apply
/// the same lower bound or risk silently disabling push without any
/// log breadcrumb. The `debug_assert!` below will fire in dev/test
/// builds if a caller drifts; release builds preserve the
/// silent-empty-set fallback so the connector never crashes.
pub fn fill_full_window(dirty: &mut DirtySet, today: NaiveDate, window_days: i64) {
    debug_assert!(
        window_days >= MIN_WINDOW_DAYS,
        "fill_full_window: window_days ({window_days}) < MIN_WINDOW_DAYS ({MIN_WINDOW_DAYS}) \
         — caller must clamp via `parse_window_days` or apply the same lower bound"
    );
    for i in 0..window_days.max(0) {
        if let Some(d) = today.checked_add_days(Days::new(i.cast_unsigned())) {
            dirty.insert(d);
        }
    }
}

/// Apply a `force_resync` request to the in-memory dirty set.
///
/// M-87: `force_resync` semantics are "dispatch a full-window resync",
/// NOT "clear the queued dirty set" — the latter silently dropped every
/// pending date when the user hit "Resync now" in Settings. This helper
/// centralises the priming behaviour so the outer loop's
/// `force_sweep.notified()` arm can be unit-tested without spinning up
/// the whole task.
pub fn handle_force_resync(dirty: &mut DirtySet, today: NaiveDate) {
    fill_full_window(dirty, today, MAX_WINDOW_DAYS);
}

// ---------------------------------------------------------------------------
// Outer task — spawn + event loop
// ---------------------------------------------------------------------------

/// Handle + drop-guard wiring for the production task.  Kept tiny so
/// `lib.rs` can stash the handle in Tauri managed state without
/// specializing over a generic client type.
pub struct ConnectorTask {
    pub handle: GcalConnectorHandle,
    _shutdown: Arc<Notify>,
}

/// Spawn the connector task.  Returns the handle + a `ConnectorTask`
/// that keeps the task alive for the process lifetime (drop the
/// `ConnectorTask` → wake shutdown → task exits on next iteration).
#[cfg(not(tarpaulin_include))]
pub fn spawn_connector(
    pool: SqlitePool,
    api: Arc<GcalApi>,
    token_store: Arc<dyn TokenStore>,
    emitter: Arc<dyn GcalEventEmitter>,
    device_id: String,
) -> ConnectorTask {
    let (dirty_tx, dirty_rx) = mpsc::unbounded_channel::<DirtyEvent>();
    let force_sweep = Arc::new(Notify::new());
    let shutdown = Arc::new(Notify::new());

    let handle = GcalConnectorHandle {
        dirty_tx,
        force_sweep: force_sweep.clone(),
    };

    let loop_pool = pool;
    let loop_api = api;
    let loop_store = token_store;
    let loop_emitter = emitter;
    let loop_force = force_sweep.clone();
    let loop_shutdown = shutdown.clone();

    tauri::async_runtime::spawn(async move {
        let clock = SystemClock;
        run_task_loop(
            loop_pool,
            loop_api,
            loop_store,
            loop_emitter,
            device_id,
            clock,
            dirty_rx,
            loop_force,
            loop_shutdown,
        )
        .await;
    });

    ConnectorTask {
        handle,
        _shutdown: shutdown,
    }
}

/// Event-loop body.  Extracted so we can instantiate it with an
/// in-test clock if we ever add integration tests.  The function is
/// deliberately boring — the per-cycle logic is in [`run_cycle`].
#[cfg(not(tarpaulin_include))]
#[allow(clippy::too_many_arguments)]
async fn run_task_loop(
    pool: SqlitePool,
    api: Arc<GcalApi>,
    token_store: Arc<dyn TokenStore>,
    emitter: Arc<dyn GcalEventEmitter>,
    device_id: String,
    clock: impl Clock,
    mut dirty_rx: mpsc::UnboundedReceiver<DirtyEvent>,
    force_sweep: Arc<Notify>,
    shutdown: Arc<Notify>,
) {
    let mut dirty: DirtySet = DirtySet::new();
    // `None` means no flush is currently armed.  Reconcile / force-sweep
    // / dirty arrivals all set this to `Now + DEBOUNCE_WINDOW`; the
    // dedicated `sleep_until` arm in the `select!` fires the cycle.
    let mut next_flush_at: Option<tokio::time::Instant> = None;

    let mut reconcile = tokio::time::interval(RECONCILE_INTERVAL);
    reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            biased;
            _ = shutdown.notified() => break,
            _ = force_sweep.notified() => {
                // M-87: `force_resync` must DISPATCH a full-window resync,
                // not clear the dirty set. The previous `dirty.clear()`
                // silently dropped every queued date.
                handle_force_resync(&mut dirty, clock.today());
                tracing::info!(
                    target: "gcal",
                    primed = dirty.len(),
                    "force_resync: primed full-window dirty set",
                );
                next_flush_at = Some(tokio::time::Instant::now() + DEBOUNCE_WINDOW);
            }
            maybe_ev = dirty_rx.recv() => match maybe_ev {
                Some(ev) => {
                    dirty.extend(ev.affected());
                    next_flush_at =
                        Some(tokio::time::Instant::now() + DEBOUNCE_WINDOW);
                }
                None => break,
            },
            _ = reconcile.tick() => {
                handle_force_resync(&mut dirty, clock.today());
                tracing::debug!(
                    target: "gcal",
                    primed = dirty.len(),
                    "reconcile tick: primed full-window dirty set",
                );
                next_flush_at = Some(tokio::time::Instant::now() + DEBOUNCE_WINDOW);
            }
            () = async {
                match next_flush_at {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                next_flush_at = None;
                if dirty.is_empty() {
                    continue;
                }
                match token_store.load().await {
                    Ok(None) => {
                        tracing::debug!(
                            target: "gcal",
                            "gcal: no token loaded — idle",
                        );
                        // User has not connected GCal yet — drop this
                        // batch; a future `dirty_producer` event will
                        // re-arm the debounce once a token is stored.
                        dirty.clear();
                    }
                    Err(e) => {
                        tracing::warn!(
                            target: "gcal",
                            error = %e,
                            "gcal: failed to load token — skipping cycle",
                        );
                        // Keep `dirty` populated so the next reconcile
                        // tick / dirty arrival retries once the token
                        // store recovers.
                    }
                    Ok(Some(token)) => {
                        match run_cycle(
                            &pool,
                            &api,
                            &emitter,
                            &device_id,
                            &clock,
                            &token,
                            &dirty,
                        )
                        .await
                        {
                            Ok(CycleOutcome::Ok)
                            | Ok(CycleOutcome::LeaseUnavailable) => {
                                dirty.clear();
                            }
                            Ok(CycleOutcome::HardFailure(kind)) => {
                                let reason = kind_display(&kind);
                                tracing::warn!(
                                    target: "gcal",
                                    reason = %reason,
                                    "gcal: hard failure — clearing dirty set; \
                                     emitter has surfaced reauth/push-disabled",
                                );
                                dirty.clear();
                            }
                            Err(e) => {
                                tracing::error!(
                                    target: "gcal",
                                    error = ?e,
                                    "gcal: cycle error — keeping dirty set \
                                     for next reconcile tick",
                                );
                            }
                        }
                    }
                }
            }
        }
    }
    tracing::info!(target: "gcal", "connector task exited");
}

// ---------------------------------------------------------------------------
// Test doubles + tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test helpers — exposed pub(crate) so sibling test modules
// (commands/gcal.rs::tests in particular) can build a `Token` without
// having to repeat the `secrecy` plumbing.
// ---------------------------------------------------------------------------

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use secrecy::SecretString;

    /// Build a throwaway Token for tests — wiremock ignores its
    /// contents (it just round-trips the bearer header verbatim).
    pub fn dummy_token() -> Token {
        Token {
            access: SecretString::from("mock-access".to_owned()),
            refresh: SecretString::from("mock-refresh".to_owned()),
            expires_at: Utc::now() + chrono::Duration::hours(1),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::dummy_token;
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::keyring_store::{GcalEvent, RecordingEventEmitter};
    use chrono::{Duration as ChronoDuration, TimeZone};
    use serde_json::json;
    use std::path::PathBuf;
    use tempfile::TempDir;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const DEV_A: &str = "device-AAAAAAAAAAAAAAAAAAAAAAAAAA";
    const DEV_B: &str = "device-BBBBBBBBBBBBBBBBBBBBBBBBBB";

    /// Calendar id wiremock returns from the `create_calendar` response.
    /// Tests that need to reference the calendar id (in path matchers,
    /// or assertions on persisted settings) use this constant.
    const TEST_CAL_ID: &str = "cal_TEST_1";

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 4, 22, 10, 0, 0).unwrap()
    }

    fn fixed_date() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 4, 22).unwrap()
    }

    fn make_ulid(i: u64) -> String {
        // Deterministic 26-char Crockford base32 ID derived from `i`.
        // Uses the valid Crockford alphabet (no I, L, O, U); padding
        // with '0' so the tests don't accidentally produce 0-length IDs.
        const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
        let mut out = [b'0'; 26];
        let mut v = i;
        for slot in out.iter_mut().rev() {
            *slot = CROCKFORD[(v & 0x1f) as usize];
            v >>= 5;
        }
        String::from_utf8(out.to_vec()).unwrap()
    }

    /// Build a [`GcalApi`] pointed at the given wiremock server.  Each
    /// test owns its own server + api so the rate-limit bucket is fresh
    /// and there's no cross-test mock interference.
    fn make_api(server: &MockServer) -> GcalApi {
        GcalApi::with_base_url(&server.uri()).expect("api construction must succeed")
    }

    /// Build a recording event emitter and the `Arc<dyn ...>` upcast the
    /// connector takes.  Returns both so tests can assert on the
    /// recorded events.
    fn emitter_pair() -> (Arc<dyn GcalEventEmitter>, Arc<RecordingEventEmitter>) {
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();
        (emitter, recorder)
    }

    /// Mount a `POST /calendars` mock that returns the given calendar
    /// id.  Returns the [`MockServer`] guard so the caller controls the
    /// lifetime / `.expect(N)` assertion.
    async fn mount_create_calendar(server: &MockServer, calendar_id: &str) {
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": calendar_id,
                "summary": "Agaric Agenda",
            })))
            .mount(server)
            .await;
    }

    /// Build the JSON body wiremock returns from `events.insert` /
    /// `events.patch` mocks.  GCal stores `end.date = start.date + 1`
    /// for an all-day event; this helper computes that shift so each
    /// caller doesn't have to re-derive it inline.
    fn event_response_body(event_id: &str, date: &str) -> serde_json::Value {
        let parsed = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
        let plus_one = (parsed + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        json!({
            "id": event_id,
            "summary": format!("Agaric Agenda — {date}"),
            "description": "",
            "start": {"date": date},
            "end": {"date": plus_one},
            "transparency": "transparent",
        })
    }

    /// Create a page + a todo block due on `date`.  Writes directly to
    /// `blocks` / `block_properties` / `agenda_cache` (bypassing the op
    /// log) — the connector under test reads only from materialised
    /// tables so this is the minimum needed to exercise the flow.
    async fn seed_block_due_on(pool: &SqlitePool, content: &str, date: &str) -> (String, String) {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let seq = NEXT.fetch_add(1, Ordering::AcqRel);
        let page_id = make_ulid(seq * 1000);
        let block_id = make_ulid(seq * 1000 + 1);

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_type, page_id) \
             VALUES (?, 'page', 'Test Page', NULL, 0, NULL, 0, NULL, ?)",
        )
        .bind(&page_id)
        .bind(&page_id)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO blocks (id, block_type, content, parent_id, position, \
             deleted_at, is_conflict, conflict_type, todo_state, due_date, page_id) \
             VALUES (?, 'content', ?, ?, 1, NULL, 0, NULL, 'TODO', ?, ?)",
        )
        .bind(&block_id)
        .bind(content)
        .bind(&page_id)
        .bind(date)
        .bind(&page_id)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT OR REPLACE INTO projected_agenda_cache \
             (block_id, projected_date, source) VALUES (?, ?, 'due_date')",
        )
        .bind(&block_id)
        .bind(date)
        .execute(pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT OR REPLACE INTO block_properties \
             (block_id, key, value_date) VALUES (?, 'due_date', ?)",
        )
        .bind(&block_id)
        .bind(date)
        .execute(pool)
        .await
        .unwrap();

        (page_id, block_id)
    }

    /// Move a block from `old_date` to `new_date` (updates both the
    /// `blocks.due_date` column and the `projected_agenda_cache` row).
    async fn move_block_due(pool: &SqlitePool, block_id: &str, old_date: &str, new_date: &str) {
        sqlx::query("UPDATE blocks SET due_date = ? WHERE id = ?")
            .bind(new_date)
            .bind(block_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "DELETE FROM projected_agenda_cache \
             WHERE block_id = ? AND projected_date = ?",
        )
        .bind(block_id)
        .bind(old_date)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO projected_agenda_cache (block_id, projected_date, source) \
             VALUES (?, ?, 'due_date')",
        )
        .bind(block_id)
        .bind(new_date)
        .execute(pool)
        .await
        .unwrap();
    }

    /// Soft-delete a block — projected_agenda_cache row is removed by
    /// the materializer in production; we emulate that here.
    async fn soft_delete(pool: &SqlitePool, block_id: &str) {
        let now = crate::now_rfc3339();
        sqlx::query("UPDATE blocks SET deleted_at = ? WHERE id = ?")
            .bind(&now)
            .bind(block_id)
            .execute(pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM projected_agenda_cache WHERE block_id = ?")
            .bind(block_id)
            .execute(pool)
            .await
            .unwrap();
    }

    /// Count requests received by `server` whose method+path-prefix
    /// match the given filter.  `path_prefix` is matched as a starts-with
    /// against the request URL path so callers can ignore query strings
    /// (the connector does not append any, but defensive).
    async fn count_requests(server: &MockServer, http_method: &str, path_prefix: &str) -> usize {
        let received = server
            .received_requests()
            .await
            .expect("MockServer must be configured to record requests");
        received
            .iter()
            .filter(|r| r.method.as_str() == http_method && r.url.path().starts_with(path_prefix))
            .count()
    }

    // ── First-connect flow ─────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_connect_creates_calendar_and_persists_id() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_CAL_ID,
                "summary": "Agaric Agenda",
            })))
            .expect(1)
            .mount(&server)
            .await;
        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let dirty: DirtySet = DirtySet::new();
        let outcome = run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);
        let persisted = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap();
        assert_eq!(
            persisted.as_deref(),
            Some(TEST_CAL_ID),
            "calendar_id must be persisted after create_calendar"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn push_lease_contention_blocks_second_device() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        // Only A creates the calendar; B is blocked at the lease check
        // and never issues an HTTP call.
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_CAL_ID,
            })))
            .expect(1)
            .mount(&server)
            .await;
        let api = make_api(&server);
        let (emitter_a, _) = emitter_pair();
        let (emitter_b, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let dirty = DirtySet::new();

        let a = run_cycle(&pool, &api, &emitter_a, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(a, CycleOutcome::Ok);

        let b = run_cycle(&pool, &api, &emitter_b, DEV_B, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(b, CycleOutcome::LeaseUnavailable);

        // Defensive count: only one POST /calendars hit the server.
        assert_eq!(
            count_requests(&server, "POST", "/calendars").await,
            1,
            "blocked device must NOT call create_calendar"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn after_lease_expires_second_device_takes_over() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        // Only one create_calendar should happen — A creates, then B
        // re-uses the persisted calendar_id.
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_CAL_ID,
            })))
            .expect(1)
            .mount(&server)
            .await;
        let api = make_api(&server);
        let (emitter_a, _) = emitter_pair();
        let (emitter_b, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let dirty = DirtySet::new();

        // A claims, does first-connect (creates calendar).
        assert_eq!(
            run_cycle(&pool, &api, &emitter_a, DEV_A, &clock, &token, &dirty)
                .await
                .unwrap(),
            CycleOutcome::Ok
        );

        // Jump past lease expiry — B can now claim.
        clock.advance(ChronoDuration::seconds(
            lease::LEASE_EXPIRY_SECS.cast_signed() + 1,
        ));
        let b = run_cycle(&pool, &api, &emitter_b, DEV_B, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(b, CycleOutcome::Ok);
        let state = lease::read_current_lease(&pool).await.unwrap();
        assert_eq!(
            state.device_id, DEV_B,
            "B must hold the lease after seizure"
        );
    }

    // ── Per-date push flow ─────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dirty_date_inserts_event_and_populates_map() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        let evt_id = "evt_TEST_1";
        mount_create_calendar(&server, TEST_CAL_ID).await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(event_response_body(evt_id, "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let date = fixed_date();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);

        let outcome = run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);

        // Map row populated.
        let map = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap()
            .expect("map row must exist");
        assert_eq!(
            map.gcal_event_id, evt_id,
            "map row must hold the event id assigned by the server"
        );
        assert!(
            !map.last_pushed_hash.is_empty(),
            "last_pushed_hash must be populated"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unchanged_hash_is_a_noop_on_the_second_cycle() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        let evt_id = "evt_TEST_1";
        mount_create_calendar(&server, TEST_CAL_ID).await;
        // `.expect(1)` is the assertion — a second POST would fail it.
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(event_response_body(evt_id, "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);

        // First cycle pushes.
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        // Second cycle with unchanged data → no extra ops.
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // Verify there was exactly one POST to events (mock's
        // `.expect(1)` assertion covers this on Drop, but explicit
        // assertion provides a clearer failure message).
        assert_eq!(
            count_requests(&server, "POST", &format!("/calendars/{TEST_CAL_ID}/events")).await,
            1,
            "unchanged digest must not produce a second push",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn soft_delete_last_entry_deletes_remote_event_and_map_row() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        let evt_id = "evt_TEST_1";
        mount_create_calendar(&server, TEST_CAL_ID).await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(event_response_body(evt_id, "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events/{evt_id}")))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        let (_page, block) = seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // Soft-delete the only entry for the date.
        soft_delete(&pool, &block).await;

        // Next cycle should delete the remote event + drop the map row.
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        let row = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap();
        assert!(
            row.is_none(),
            "map row must be removed after empty-day delete"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn drag_drop_across_dates_emits_exactly_one_op_per_side() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        let evt_a = "evt_DATE_A";
        let evt_b = "evt_DATE_B";
        mount_create_calendar(&server, TEST_CAL_ID).await;
        // Date A's insert (request body contains start.date 2026-04-22).
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .and(body_string_contains("\"date\":\"2026-04-22\""))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(event_response_body(evt_a, "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;
        // Date B's insert (request body contains 2026-04-23).
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .and(body_string_contains("\"date\":\"2026-04-23\""))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(event_response_body(evt_b, "2026-04-23")),
            )
            .expect(1)
            .mount(&server)
            .await;
        // Date A's delete after the drag.
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events/{evt_a}")))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let date_a = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        let date_b = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        let (_page, block) = seed_block_due_on(&pool, "Drag me", "2026-04-22").await;

        // First cycle: insert on date A.
        let mut dirty = DirtySet::new();
        dirty.insert(date_a);
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // Move the block to date B; both dates now dirty.
        move_block_due(&pool, &block, "2026-04-22", "2026-04-23").await;
        let mut dirty = DirtySet::new();
        dirty.insert(date_a);
        dirty.insert(date_b);
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // Per-mock `.expect(1)` covers the assertions on drop; an
        // explicit total-count check here makes the failure message
        // clearer if the connector ever drifts.
        assert_eq!(
            count_requests(&server, "POST", &format!("/calendars/{TEST_CAL_ID}/events")).await,
            2,
            "exactly two inserts (one per date) must reach the server",
        );
        assert_eq!(
            count_requests(
                &server,
                "DELETE",
                &format!("/calendars/{TEST_CAL_ID}/events/"),
            )
            .await,
            1,
            "exactly one delete (date A's evt) must reach the server",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn coalescing_10_dirty_events_on_same_date_produces_1_push() {
        // The `run_cycle` is idempotent on the dirty set — calling
        // it once with {date} is the "coalesced" semantic.  This test
        // pins that invariant: 10 `DirtyEvent`s from the hook layer
        // collapse into 1 push when the outer loop debounces them.
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        mount_create_calendar(&server, TEST_CAL_ID).await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(event_response_body("evt_TEST_1", "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        // Simulate the debounce: collect 10 DirtyEvents, union them
        // into a single BTreeSet, then call run_cycle once.
        let mut dirty = DirtySet::new();
        for _ in 0..10 {
            dirty.extend(DirtyEvent::single(date).affected());
        }
        assert_eq!(dirty.len(), 1, "dirty set must dedup to exactly 1 date");
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
    }

    // ── Calendar-gone recovery ─────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn calendar_gone_recovery_wipes_map_and_resets_id() {
        // Production CalendarGone path: a 404 on `POST /events` is
        // mapped to `GcalErrorKind::CalendarGone` (the calendar itself
        // is the missing resource).  We exercise this by:
        //   1. First cycle pushes successfully — calendar created, map
        //      row + persisted calendar_id populated.
        //   2. A NEW date is seeded.  Its push takes the insert branch
        //      (no prior map row), and the events mock now returns 404,
        //      triggering the CalendarGone recovery.
        //
        // The original MockGcalClient version forced CalendarGone on the
        // PATCH path, which is not realistic — `GcalApi::patch_event`
        // only ever returns EventGone on 404.  This is exactly the
        // testing-via-trait drift MAINT-139 retires.
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        mount_create_calendar(&server, TEST_CAL_ID).await;
        // First cycle's insert succeeds; .up_to_n_times(1) so the next
        // POST falls through to the 404 mock below.
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(event_response_body("evt_TEST_1", "2026-04-22")),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        // Second-cycle insert → 404 (CalendarGone).
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, rec) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date_1 = fixed_date();
        let date_2 = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        // First cycle: create calendar + push date_1.
        let mut dirty = DirtySet::new();
        dirty.insert(date_1);
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert!(
            !models::get_setting(&pool, GcalSettingKey::CalendarId)
                .await
                .unwrap()
                .unwrap_or_default()
                .is_empty(),
            "calendar_id must be set after first push"
        );

        // Second cycle: push a new date, which takes the insert branch
        // and gets 404 → CalendarGone → recover.
        seed_block_due_on(&pool, "Another task", "2026-04-23").await;
        let mut dirty_2 = DirtySet::new();
        dirty_2.insert(date_2);
        let outcome = run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty_2)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);

        // Calendar id cleared + map wiped.
        let cal_id = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(cal_id, "", "calendar_id must be reset after CalendarGone");
        assert!(
            rec.events().contains(&GcalEvent::CalendarRecreated),
            "calendar_recreated event must be emitted, got {:?}",
            rec.events()
        );
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count.0, 0,
            "event map must be empty after CalendarGone recovery"
        );
    }

    // ── 401 / unauthorized flow ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unauthorized_emits_reauth_required_and_pauses() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        // 401 on the create_calendar call — first-connect fails.
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;
        let api = make_api(&server);
        let (emitter, rec) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let outcome = run_cycle(
            &pool,
            &api,
            &emitter,
            DEV_A,
            &clock,
            &token,
            &DirtySet::new(),
        )
        .await
        .unwrap();
        assert!(
            matches!(
                outcome,
                CycleOutcome::HardFailure(GcalErrorKind::Unauthorized)
            ),
            "401 on first-connect must surface HardFailure(Unauthorized), got {outcome:?}"
        );
        assert!(
            rec.events().contains(&GcalEvent::ReauthRequired),
            "reauth_required must be emitted, got {:?}",
            rec.events()
        );
    }

    // ── Offline / retry semantics ──────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn transient_server_error_skips_that_date_not_the_whole_cycle() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        mount_create_calendar(&server, TEST_CAL_ID).await;
        // Date A's insert (the BTreeSet iterates in date order, A first)
        // returns 503.  The date is skipped; the cycle continues to B.
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .and(body_string_contains("\"date\":\"2026-04-22\""))
            .respond_with(ResponseTemplate::new(503))
            .expect(1)
            .mount(&server)
            .await;
        // Date B's insert succeeds.
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .and(body_string_contains("\"date\":\"2026-04-23\""))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(event_response_body("evt_DATE_B", "2026-04-23")),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let date_a = fixed_date();
        let date_b = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        seed_block_due_on(&pool, "On A", "2026-04-22").await;
        seed_block_due_on(&pool, "On B", "2026-04-23").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date_a);
        dirty.insert(date_b);
        let outcome = run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);

        // Date A: no map row (transient error); date B: map row landed.
        assert!(
            models::get_event_map_for_date(&pool, "2026-04-22")
                .await
                .unwrap()
                .is_none(),
            "date A must NOT have a map row after a transient 5xx",
        );
        let map_b = models::get_event_map_for_date(&pool, "2026-04-23")
            .await
            .unwrap()
            .expect("date B must have a map row");
        assert_eq!(map_b.gcal_event_id, "evt_DATE_B");
    }

    // ── Midnight rollover (window advances, old dates untouched) ───

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn midnight_rollover_leaves_old_tail_events_intact() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        mount_create_calendar(&server, TEST_CAL_ID).await;
        // Only the first cycle's insert reaches the server.
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(event_response_body("evt_OLD", "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let old_tail = fixed_date();
        seed_block_due_on(&pool, "Old tail", "2026-04-22").await;
        let mut dirty = DirtySet::new();
        dirty.insert(old_tail);
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // Advance the clock by 24 hours.  The old date is no longer in
        // any dirty set computed by `fill_full_window`, so the cycle
        // must not delete it.
        clock.advance(ChronoDuration::days(1));
        let mut new_dirty = DirtySet::new();
        fill_full_window(&mut new_dirty, clock.today(), 30);
        // Feed the full window to the cycle; the old_tail is NOT in it.
        assert!(
            !new_dirty.contains(&old_tail),
            "fill_full_window must not revisit the pre-rollover day"
        );

        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &new_dirty)
            .await
            .unwrap();

        // The map row for the pre-rollover day is left alone — no
        // DeleteEvent call on its gcal_event_id.
        let row = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap()
            .expect("pre-rollover map row must survive");
        assert_eq!(row.gcal_event_id, "evt_OLD");
        assert_eq!(
            count_requests(
                &server,
                "DELETE",
                &format!("/calendars/{TEST_CAL_ID}/events/")
            )
            .await,
            0,
            "midnight rollover must not retro-delete pre-window events",
        );
    }

    // ── MAINT-139 — patch_event return-type drift regression ───────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn patch_event_consumes_response_and_persists_new_hash() {
        // MAINT-139 regression: previously the connector's `GcalApiAdapter`
        // discarded the `EventResponse` from `GcalApi::patch_event` and
        // forwarded `()` through the `GcalClient` trait.  After retiring
        // the adapter the connector calls `GcalApi::patch_event`
        // directly — this test pins both halves of that contract:
        //
        //   1. The `EventResponse` future is *awaited* (i.e. the PATCH
        //      actually reaches the server — `.expect(1)` enforces it).
        //   2. The connector persists the post-patch `fresh_hash` in
        //      the map row (which only happens on a successful PATCH).
        //   3. The map row's `gcal_event_id` is unchanged (proves we
        //      took the patch branch, not insert).
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        let evt_id = "evt_PATCHABLE";
        mount_create_calendar(&server, TEST_CAL_ID).await;
        // First-cycle insert.
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200).set_body_json(event_response_body(evt_id, "2026-04-22")),
            )
            .expect(1)
            .mount(&server)
            .await;
        // Second-cycle PATCH must hit the server exactly once.
        Mock::given(method("PATCH"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events/{evt_id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": evt_id,
                "summary": "Patched",
                "description": "",
                "start": {"date": "2026-04-22"},
                "end": {"date": "2026-04-23"},
                "transparency": "transparent",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        let pre = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap()
            .expect("map row must exist after first push");
        assert_eq!(pre.gcal_event_id, evt_id);

        // Mutate the digest by adding a sibling block on the same date —
        // hash flips, connector takes the patch branch.
        seed_block_due_on(&pool, "Another task", "2026-04-22").await;
        run_cycle(&pool, &api, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        let post = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap()
            .expect("map row must still exist after patch");
        assert_eq!(
            post.gcal_event_id, evt_id,
            "patch must reuse the prior event id (not reinsert)",
        );
        assert_ne!(
            post.last_pushed_hash, pre.last_pushed_hash,
            "patch must persist the post-patch fresh_hash — proof that the EventResponse \
             future was awaited and the success branch ran",
        );
    }

    // ── Clock: local-vs-UTC `today()` (REVIEW-LATER H-16) ──────────

    /// `SystemClock::today()` must reflect the user's **local** date,
    /// not UTC's, so that the GCal reconcile window
    /// `[today, today + window_days]`, the journal-page lookup, and the
    /// digest contents all match the user's calendar day.
    ///
    /// Known limitation: this assertion is theoretically flaky if the
    /// test runs across the local-midnight boundary (the call to
    /// `today()` and the call to `Local::now().date_naive()` could
    /// straddle it).  In practice the two calls are microseconds apart
    /// so the window of flakiness is vanishingly small; we tolerate it.
    #[test]
    fn system_clock_today_uses_local_timezone() {
        let clock = SystemClock;
        // Compare both before and after to absorb a midnight rollover
        // happening between the two reads — at least one of the two
        // local-now reads must agree with `today()`.
        let local_before = chrono::Local::now().date_naive();
        let today = clock.today();
        let local_after = chrono::Local::now().date_naive();
        assert!(
            today == local_before || today == local_after,
            "SystemClock::today() = {today} should match \
             chrono::Local::now().date_naive() (before={local_before}, \
             after={local_after}); H-16 regression — production clock \
             must use the user's local date, not UTC's"
        );
        // Sanity: `now()` still returns UTC.
        let _: DateTime<Utc> = clock.now();
    }

    /// `FixedClock::today()` must remain the date_naive of its caller-
    /// set fixed UTC instant, so tests stay deterministic regardless of
    /// the host's local timezone (CI runs in UTC; developer machines do
    /// not).  This guards against accidentally inheriting the new
    /// trait default that reads `chrono::Local::now()`.
    #[test]
    fn fixed_clock_today_remains_deterministic_for_tests() {
        // 2026-04-22 10:00 UTC — picked so that the date is the same in
        // both UTC and any plausible local TZ at that wall-clock time.
        let instant = Utc.with_ymd_and_hms(2026, 4, 22, 10, 0, 0).unwrap();
        let clock = FixedClock::new(instant);
        assert_eq!(
            clock.today(),
            instant.date_naive(),
            "FixedClock::today() must equal the fixed instant's UTC \
             date_naive — anything else makes midnight-rollover tests \
             flaky on machines whose local TZ is not UTC"
        );
        assert_eq!(clock.now(), instant);
    }

    /// Cross-check that on a UTC instant late enough in the day to fall
    /// on different calendar dates in UTC vs. a far-east local zone,
    /// `FixedClock::today()` still tracks the UTC date (test
    /// determinism), while a hypothetical user in that east-of-UTC zone
    /// would see a different `Local::now().date_naive()`.  This is the
    /// concrete behavioural difference that motivates H-16: the
    /// production trait default reads `Local`, but tests pin to UTC.
    #[test]
    fn clock_today_local_differs_from_utc_at_midnight_boundary() {
        // 23:30 UTC on 2026-04-22 — in any zone east of UTC+00:30 the
        // local date is already 2026-04-23.
        let instant = Utc.with_ymd_and_hms(2026, 4, 22, 23, 30, 0).unwrap();
        let clock = FixedClock::new(instant);
        // FixedClock pins to UTC date for determinism.
        assert_eq!(clock.today(), NaiveDate::from_ymd_opt(2026, 4, 22).unwrap());
        // For the same instant a user in (say) UTC+05:00 would see
        // the local date as 2026-04-23 — that is the asymmetry the
        // production `SystemClock` now resolves in favour of "local".
        let east_offset = chrono::FixedOffset::east_opt(5 * 3600).unwrap();
        assert_eq!(
            instant.with_timezone(&east_offset).date_naive(),
            NaiveDate::from_ymd_opt(2026, 4, 23).unwrap(),
            "sanity check: chosen instant straddles the UTC/east-of-UTC \
             midnight boundary"
        );
    }

    // ── settings snapshot + helpers ────────────────────────────────

    #[test]
    fn parse_window_days_clamps_and_defaults() {
        assert_eq!(parse_window_days("30"), 30);
        assert_eq!(parse_window_days("6"), MIN_WINDOW_DAYS);
        assert_eq!(parse_window_days("91"), MAX_WINDOW_DAYS);
        assert_eq!(parse_window_days(""), DEFAULT_WINDOW_DAYS);
        assert_eq!(parse_window_days("junk"), DEFAULT_WINDOW_DAYS);
    }

    #[test]
    fn fill_full_window_produces_exactly_window_days_entries() {
        let mut dirty = DirtySet::new();
        let today = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        fill_full_window(&mut dirty, today, 30);
        assert_eq!(dirty.len(), 30);
        assert!(dirty.contains(&today));
        assert!(dirty.contains(&NaiveDate::from_ymd_opt(2026, 5, 21).unwrap()));
        assert!(!dirty.contains(&NaiveDate::from_ymd_opt(2026, 5, 22).unwrap()));
    }

    #[test]
    fn handle_force_resync_primes_full_window_and_preserves_existing_entries() {
        // M-87 regression: `force_resync` must DISPATCH (prime the full
        // window), not CLEAR the dirty set. Earlier code silently dropped
        // every pending date when the user hit "Resync now" in Settings.
        let mut dirty = DirtySet::new();
        let today = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        // Pre-existing dirty entries — both inside and outside the new window.
        let outside = NaiveDate::from_ymd_opt(2025, 12, 31).unwrap();
        let inside = today + chrono::Duration::days(3);
        dirty.insert(outside);
        dirty.insert(inside);

        handle_force_resync(&mut dirty, today);

        // The full window is now primed, AND the previously-queued
        // out-of-window date survives (we dispatch, we do not clear).
        // `try_from` is infallible at runtime for our 90-day const but
        // keeps clippy's truncation lint happy without a suppression.
        let window = usize::try_from(MAX_WINDOW_DAYS).expect("MAX_WINDOW_DAYS fits usize");
        assert!(
            dirty.len() > window,
            "force_resync must prime full window AND retain prior dirty entries; got {}",
            dirty.len()
        );
        assert!(
            dirty.contains(&today),
            "today must be in the primed full-window dirty set"
        );
        assert!(
            dirty.contains(&outside),
            "out-of-window pre-existing dirty entries must NOT be dropped",
        );
        assert!(
            dirty.contains(&inside),
            "in-window pre-existing dirty entries must survive (dispatch, not clear)",
        );
        let last = today + chrono::Duration::days(MAX_WINDOW_DAYS - 1);
        assert!(
            dirty.contains(&last),
            "last day of the full window (today + MAX-1) must be primed"
        );
    }

    #[test]
    fn dirty_event_affected_deduplicates_old_and_new() {
        let d = fixed_date();
        let ev = DirtyEvent {
            old_affected_dates: vec![d, d],
            new_affected_dates: vec![d],
        };
        assert_eq!(ev.affected().len(), 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn empty_dirty_set_still_acquires_lease_and_runs_first_connect() {
        let (pool, _dir) = test_pool().await;
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_CAL_ID,
            })))
            .expect(1)
            .mount(&server)
            .await;
        let api = make_api(&server);
        let (emitter, _) = emitter_pair();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let outcome = run_cycle(
            &pool,
            &api,
            &emitter,
            DEV_A,
            &clock,
            &token,
            &DirtySet::new(),
        )
        .await
        .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);
    }

    // ── REVIEW-LATER C-1 — wired task loop dispatches `run_cycle` ──
    //
    // Smoke test: spawning the connector and pushing a `DirtyEvent`
    // through the channel must result in `run_cycle` actually running
    // (observed here as at least one `create_calendar` or
    // `insert_event` request landing on the wiremock server).  Before
    // C-1 the loop only collected events and ticked, so the entire
    // FEAT-5e push pipeline was dead; this test catches a regression
    // to that state.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn task_loop_dispatches_run_cycle_on_dirty_event() {
        use crate::gcal_push::keyring_store::{MockTokenStore, TokenStore};
        use std::time::Duration as StdDuration;

        let (pool, _dir) = test_pool().await;

        // Seed a block due on the date we're about to mark dirty so
        // run_cycle has actual work to push (ensures `insert_event`
        // fires after the first-connect `create_calendar`).
        let _ = seed_block_due_on(&pool, "Smoke C-1", "2026-04-22").await;
        let date = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();

        let server = MockServer::start().await;
        mount_create_calendar(&server, TEST_CAL_ID).await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(event_response_body("evt_C1", "2026-04-22")),
            )
            .mount(&server)
            .await;

        let api: Arc<GcalApi> = Arc::new(make_api(&server));

        let token_store: Arc<MockTokenStore> = Arc::new(MockTokenStore::new());
        token_store.store(&dummy_token()).await.unwrap();
        let dyn_token_store: Arc<dyn TokenStore> = token_store;

        let recorder = Arc::new(RecordingEventEmitter::new());
        let dyn_emitter: Arc<dyn GcalEventEmitter> = recorder;

        let task = spawn_connector(
            pool.clone(),
            api,
            dyn_token_store,
            dyn_emitter,
            DEV_A.to_owned(),
        );

        // Trigger a cycle — debounce is 500 ms so the cycle should
        // fire well within the 1.5 s budget below.
        task.handle.notify_dirty(DirtyEvent::single(date));

        let observed = tokio::time::timeout(StdDuration::from_millis(1500), async {
            loop {
                let calls = count_requests(&server, "POST", "/calendars").await;
                if calls > 0 {
                    return calls;
                }
                tokio::time::sleep(StdDuration::from_millis(25)).await;
            }
        })
        .await
        .expect(
            "run_cycle must run within 1.5s of a DirtyEvent — \
             the spawned task loop is not dispatching cycles (C-1 regression)",
        );
        assert!(
            observed > 0,
            "expected at least one POST /calendars (or events) request on the wiremock server",
        );

        // Drop the task handle so the connector's spawned future is
        // released before the runtime tears down.  (`ConnectorTask`
        // does not currently expose a graceful-shutdown trigger; the
        // drop relies on tokio cancelling the task on runtime shutdown.)
        drop(task);
    }
}

// ---------------------------------------------------------------------------
// M-89 — atomicity of `recover_calendar_gone`
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests_m89 {
    //! Coverage for REVIEW-LATER item M-89: `recover_calendar_gone`
    //! must wipe `gcal_agenda_event_map` and reset
    //! `gcal_settings.calendar_id` in a single `BEGIN IMMEDIATE`
    //! transaction so a crash between the two writes cannot leave the
    //! post-state inconsistent.
    //!
    //! These tests assert the *post-condition* (zero rows in the map
    //! AND `calendar_id == ""`) which is what callers actually care
    //! about.  Crash-injection between the two writes is not testable
    //! at this layer — the BEGIN IMMEDIATE wrapper is verified
    //! structurally by inspection of the implementation.

    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::keyring_store::RecordingEventEmitter;
    use std::path::PathBuf;
    use tempfile::TempDir;

    async fn fresh_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("m89.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    /// Insert N synthetic rows into `gcal_agenda_event_map` so the
    /// `DELETE FROM ...` inside the recovery has something to wipe.
    async fn seed_map_rows(pool: &SqlitePool, n: usize) {
        for i in 0..n {
            // Dates are date-only strings; offset-of-day math is fine
            // here (no row uses `2026-04-32`).
            let date = format!("2026-04-{:02}", i + 1);
            let event_id = format!("evt_seed_{i}");
            let hash = format!("hash_seed_{i}");
            let pushed_at = "2026-04-22T10:00:00.000Z";
            sqlx::query(
                "INSERT INTO gcal_agenda_event_map \
                 (date, gcal_event_id, last_pushed_hash, last_pushed_at) \
                 VALUES (?, ?, ?, ?)",
            )
            .bind(&date)
            .bind(&event_id)
            .bind(&hash)
            .bind(pushed_at)
            .execute(pool)
            .await
            .unwrap();
        }
    }

    async fn count_map_rows(pool: &SqlitePool) -> i64 {
        let row: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(pool)
            .await
            .unwrap();
        row.0
    }

    #[tokio::test]
    async fn recover_calendar_gone_is_atomic() {
        let (pool, _dir) = fresh_pool().await;

        // Pre-state: N rows in the map, calendar_id pointing at a
        // (now-gone) remote calendar.
        seed_map_rows(&pool, 5).await;
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_xyz")
            .await
            .unwrap();

        assert_eq!(count_map_rows(&pool).await, 5, "pre-state: 5 map rows");
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::CalendarId)
                .await
                .unwrap()
                .as_deref(),
            Some("cal_xyz"),
            "pre-state: calendar_id must point at the gone calendar"
        );

        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        recover_calendar_gone(&pool, &emitter).await.unwrap();

        // Post-state: map empty, calendar_id reset.
        assert_eq!(
            count_map_rows(&pool).await,
            0,
            "post-state: gcal_agenda_event_map must be empty"
        );
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::CalendarId)
                .await
                .unwrap()
                .as_deref(),
            Some(""),
            "post-state: calendar_id must be reset to empty string"
        );
        assert!(
            recorder.events().contains(&GcalEvent::CalendarRecreated),
            "calendar_recreated event must fire after a successful recovery"
        );
    }

    #[tokio::test]
    async fn recover_calendar_gone_m89_does_not_clear_oauth_account_email() {
        // Optional assertion (per the brief) — proves the recovery
        // does not over-reach and accidentally wipe other settings.
        // `oauth_account_email` is finding M-95, out of scope here.
        let (pool, _dir) = fresh_pool().await;

        seed_map_rows(&pool, 2).await;
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_xyz")
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "user@example.com")
            .await
            .unwrap();

        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        recover_calendar_gone(&pool, &emitter).await.unwrap();

        let email = models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
            .await
            .unwrap();
        assert_eq!(
            email.as_deref(),
            Some("user@example.com"),
            "oauth_account_email must be untouched by recover_calendar_gone (that is M-95)"
        );
    }
}
