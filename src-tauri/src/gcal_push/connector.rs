//! FEAT-5e — background connector task that mirrors Agaric's daily
//! agenda into the dedicated "Agaric Agenda" Google Calendar.
//!
//! # Responsibilities
//!
//! * **Own the push-lease** — on every cycle, try to claim or renew the
//!   lease via [`super::lease::claim_lease`].  Without the lease we
//!   stay idle so a sibling device does not receive phantom updates.
//! * **First-connect calendar creation** — if `gcal_settings.calendar_id`
//!   is still empty, call [`GcalClient::create_calendar`] once (under
//!   lease) and persist the returned ID.
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
//! with a [`MockGcalClient`] + [`MockTokenStore`] + [`FixedClock`] — the
//! production outer loop is not exercised in unit tests (that would
//! require `tokio::time::pause`, which is brittle under `multi_thread`
//! runtimes and fights the SQL-side timestamp comparisons).

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Days, NaiveDate, Utc};
use serde::Serialize;
use sqlx::SqlitePool;
use tokio::sync::{mpsc, Notify};

use crate::error::{AppError, GcalErrorKind};
use crate::pagination::ProjectedAgendaEntry;

use super::api::{EventId, GcalApi};
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
// GcalClient trait
// ---------------------------------------------------------------------------

/// Seam between the connector and the underlying HTTP client.  Mirrors
/// the subset of `GcalApi` the connector actually calls.  Tests use
/// [`MockGcalClient`]; production wires through [`GcalApiAdapter`]
/// which forwards to [`GcalApi`].
#[async_trait]
pub trait GcalClient: Send + Sync {
    /// Create the dedicated "Agaric Agenda" calendar; return its ID.
    async fn create_calendar(&self, token: &Token, name: &str) -> Result<String, AppError>;

    /// Delete the dedicated calendar.  Used by the disconnect path.
    async fn delete_calendar(&self, token: &Token, calendar_id: &str) -> Result<(), AppError>;

    /// Insert a digest event; return the assigned event ID.
    async fn insert_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event: &Event,
    ) -> Result<EventId, AppError>;

    /// Patch an existing event (full replacement of the fields we set).
    async fn patch_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
        event: &Event,
    ) -> Result<(), AppError>;

    /// Delete an event.
    async fn delete_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------
// Production adapter: GcalApi → GcalClient
// ---------------------------------------------------------------------------

/// Production adapter that forwards every [`GcalClient`] call to the
/// landed stateless [`GcalApi`].  Kept as a thin wrapper so the
/// connector does not depend on `GcalApi` directly — tests can drop in
/// a [`MockGcalClient`] without touching `reqwest`.
#[derive(Clone, Debug)]
pub struct GcalApiAdapter {
    pub api: Arc<GcalApi>,
}

impl GcalApiAdapter {
    #[must_use]
    pub fn new(api: GcalApi) -> Self {
        Self { api: Arc::new(api) }
    }
}

#[async_trait]
impl GcalClient for GcalApiAdapter {
    async fn create_calendar(&self, token: &Token, name: &str) -> Result<String, AppError> {
        self.api.create_dedicated_calendar(token, name).await
    }

    async fn delete_calendar(&self, token: &Token, calendar_id: &str) -> Result<(), AppError> {
        self.api.delete_calendar(token, calendar_id).await
    }

    async fn insert_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event: &Event,
    ) -> Result<EventId, AppError> {
        let resp = self.api.insert_event(token, calendar_id, event).await?;
        Ok(resp.id)
    }

    async fn patch_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
        event: &Event,
    ) -> Result<(), AppError> {
        let patch = super::api::EventPatch::new()
            .with_summary(event.summary.clone())
            .with_description(event.description.clone())
            .with_start(
                NaiveDate::parse_from_str(&event.start.date, "%Y-%m-%d").map_err(|e| {
                    AppError::Validation(format!(
                        "gcal.connector.bad_start_date: {}: {e}",
                        event.start.date
                    ))
                })?,
            )
            .with_end(
                NaiveDate::parse_from_str(&event.end.date, "%Y-%m-%d").map_err(|e| {
                    AppError::Validation(format!(
                        "gcal.connector.bad_end_date: {}: {e}",
                        event.end.date
                    ))
                })?,
            )
            .with_transparency(event.transparency.clone());
        let _ = self
            .api
            .patch_event(token, calendar_id, event_id, &patch)
            .await?;
        Ok(())
    }

    async fn delete_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), AppError> {
        self.api.delete_event(token, calendar_id, event_id).await
    }
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
///   (the [`MockGcalClient`] ignores it).
pub async fn run_cycle<C: GcalClient>(
    pool: &SqlitePool,
    client: &C,
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
        match client.create_calendar(token, DEDICATED_CALENDAR_NAME).await {
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
        match push_date(pool, client, token, &settings, &calendar_id, *date).await {
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
#[tracing::instrument(skip(pool, client, token, settings), fields(date = %date))]
async fn push_date<C: GcalClient>(
    pool: &SqlitePool,
    client: &C,
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
            match client
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
            let event_id = client
                .insert_event(token, calendar_id, &event)
                .await
                .map_err(|e| classify_date_err(&e))?;
            let entry = GcalAgendaEventMap {
                date: date_str,
                gcal_event_id: event_id,
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
            match client
                .patch_event(token, calendar_id, &prior.gcal_event_id, &event)
                .await
            {
                Ok(()) => {
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
    client: Arc<dyn GcalClient>,
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
    let loop_client = client;
    let loop_store = token_store;
    let loop_emitter = emitter;
    let loop_force = force_sweep.clone();
    let loop_shutdown = shutdown.clone();

    tauri::async_runtime::spawn(async move {
        let clock = SystemClock;
        run_task_loop(
            loop_pool,
            loop_client,
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
async fn run_task_loop<C: GcalClient + ?Sized>(
    pool: SqlitePool,
    client: Arc<C>,
    token_store: Arc<dyn TokenStore>,
    emitter: Arc<dyn GcalEventEmitter>,
    device_id: String,
    clock: impl Clock,
    mut dirty_rx: mpsc::UnboundedReceiver<DirtyEvent>,
    force_sweep: Arc<Notify>,
    shutdown: Arc<Notify>,
) {
    // `run_cycle` is generic over `C: GcalClient` (Sized).  The outer
    // task loop accepts an `Arc<dyn GcalClient>` (?Sized) coming out
    // of `spawn_connector`, so we wrap `&C` in this thin sized adapter
    // before each cycle dispatch.  The adapter is only ever held for
    // the duration of a single `run_cycle` call.
    struct ClientAdapter<'a, C: GcalClient + ?Sized> {
        inner: &'a C,
    }

    #[async_trait]
    impl<'a, C: GcalClient + ?Sized> GcalClient for ClientAdapter<'a, C> {
        async fn create_calendar(&self, token: &Token, name: &str) -> Result<String, AppError> {
            self.inner.create_calendar(token, name).await
        }
        async fn delete_calendar(&self, token: &Token, calendar_id: &str) -> Result<(), AppError> {
            self.inner.delete_calendar(token, calendar_id).await
        }
        async fn insert_event(
            &self,
            token: &Token,
            calendar_id: &str,
            event: &Event,
        ) -> Result<EventId, AppError> {
            self.inner.insert_event(token, calendar_id, event).await
        }
        async fn patch_event(
            &self,
            token: &Token,
            calendar_id: &str,
            event_id: &str,
            event: &Event,
        ) -> Result<(), AppError> {
            self.inner
                .patch_event(token, calendar_id, event_id, event)
                .await
        }
        async fn delete_event(
            &self,
            token: &Token,
            calendar_id: &str,
            event_id: &str,
        ) -> Result<(), AppError> {
            self.inner.delete_event(token, calendar_id, event_id).await
        }
    }

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
                        let adapter = ClientAdapter { inner: &*client };
                        match run_cycle(
                            &pool,
                            &adapter,
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

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use secrecy::SecretString;
    use tokio::sync::Mutex;

    /// Mock [`GcalClient`] that keeps an in-memory calendar + event
    /// table and records every call in order.  Each op accepts an
    /// optional error override via [`MockBehavior`].
    #[derive(Debug)]
    pub struct MockGcalClient {
        pub state: Mutex<MockState>,
    }

    #[derive(Debug, Default)]
    pub struct MockState {
        pub calendars: HashMap<String, HashMap<String, Event>>,
        pub next_cal_seq: u64,
        pub next_evt_seq: u64,
        pub calls: Vec<MockCall>,
        pub behavior: MockBehavior,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum MockCall {
        CreateCalendar {
            name: String,
        },
        DeleteCalendar {
            calendar_id: String,
        },
        InsertEvent {
            calendar_id: String,
            date: String,
        },
        PatchEvent {
            calendar_id: String,
            event_id: String,
            date: String,
        },
        DeleteEvent {
            calendar_id: String,
            event_id: String,
        },
    }

    /// Programmable error behaviour.  Every `..._result` field, if
    /// non-empty, is popped from the front on each call — tests can
    /// thus script a sequence like "fail, fail, succeed".
    #[derive(Debug, Default)]
    pub struct MockBehavior {
        pub create_calendar_results: Vec<Result<(), GcalErrorKind>>,
        pub insert_event_results: Vec<Result<(), GcalErrorKind>>,
        pub patch_event_results: Vec<Result<(), GcalErrorKind>>,
        pub delete_event_results: Vec<Result<(), GcalErrorKind>>,
    }

    impl MockGcalClient {
        pub fn new() -> Self {
            Self {
                state: Mutex::new(MockState::default()),
            }
        }

        pub async fn create_calendar_call_count(&self) -> usize {
            self.state
                .lock()
                .await
                .calls
                .iter()
                .filter(|c| matches!(c, MockCall::CreateCalendar { .. }))
                .count()
        }

        pub async fn event_ops_for_date(&self, date: &NaiveDate) -> usize {
            let date_str = date.format("%Y-%m-%d").to_string();
            self.state
                .lock()
                .await
                .calls
                .iter()
                .filter(|c| match c {
                    MockCall::InsertEvent { date: d, .. }
                    | MockCall::PatchEvent { date: d, .. } => d == &date_str,
                    MockCall::DeleteEvent {
                        calendar_id,
                        event_id,
                    } => {
                        // Heuristic: event_ids are `evt_<seq>_<YYYY-MM-DD>`.
                        let _ = calendar_id;
                        event_id.ends_with(&date_str)
                    }
                    _ => false,
                })
                .count()
        }

        pub async fn force_next_insert_error(&self, err: GcalErrorKind) {
            self.state
                .lock()
                .await
                .behavior
                .insert_event_results
                .push(Err(err));
        }

        pub async fn force_next_patch_error(&self, err: GcalErrorKind) {
            self.state
                .lock()
                .await
                .behavior
                .patch_event_results
                .push(Err(err));
        }

        pub async fn force_next_create_calendar_error(&self, err: GcalErrorKind) {
            self.state
                .lock()
                .await
                .behavior
                .create_calendar_results
                .push(Err(err));
        }
    }

    #[async_trait]
    impl GcalClient for MockGcalClient {
        async fn create_calendar(&self, _token: &Token, name: &str) -> Result<String, AppError> {
            let mut state = self.state.lock().await;
            state.calls.push(MockCall::CreateCalendar {
                name: name.to_owned(),
            });
            if let Some(Err(kind)) = pop_front(&mut state.behavior.create_calendar_results) {
                return Err(kind.into());
            }
            state.next_cal_seq += 1;
            let id = format!("cal_MOCK_{}", state.next_cal_seq);
            state.calendars.insert(id.clone(), HashMap::new());
            Ok(id)
        }

        async fn delete_calendar(&self, _token: &Token, calendar_id: &str) -> Result<(), AppError> {
            let mut state = self.state.lock().await;
            state.calls.push(MockCall::DeleteCalendar {
                calendar_id: calendar_id.to_owned(),
            });
            state.calendars.remove(calendar_id);
            Ok(())
        }

        async fn insert_event(
            &self,
            _token: &Token,
            calendar_id: &str,
            event: &Event,
        ) -> Result<EventId, AppError> {
            let mut state = self.state.lock().await;
            state.calls.push(MockCall::InsertEvent {
                calendar_id: calendar_id.to_owned(),
                date: event.start.date.clone(),
            });
            if let Some(Err(kind)) = pop_front(&mut state.behavior.insert_event_results) {
                return Err(kind.into());
            }
            state.next_evt_seq += 1;
            let id = format!("evt_{}_{}", state.next_evt_seq, event.start.date);
            match state.calendars.get_mut(calendar_id) {
                Some(cal) => {
                    cal.insert(id.clone(), event.clone());
                }
                None => {
                    return Err(GcalErrorKind::CalendarGone.into());
                }
            }
            Ok(id)
        }

        async fn patch_event(
            &self,
            _token: &Token,
            calendar_id: &str,
            event_id: &str,
            event: &Event,
        ) -> Result<(), AppError> {
            let mut state = self.state.lock().await;
            state.calls.push(MockCall::PatchEvent {
                calendar_id: calendar_id.to_owned(),
                event_id: event_id.to_owned(),
                date: event.start.date.clone(),
            });
            if let Some(Err(kind)) = pop_front(&mut state.behavior.patch_event_results) {
                return Err(kind.into());
            }
            match state.calendars.get_mut(calendar_id) {
                Some(cal) => {
                    if cal.contains_key(event_id) {
                        cal.insert(event_id.to_owned(), event.clone());
                        Ok(())
                    } else {
                        Err(GcalErrorKind::EventGone.into())
                    }
                }
                None => Err(GcalErrorKind::CalendarGone.into()),
            }
        }

        async fn delete_event(
            &self,
            _token: &Token,
            calendar_id: &str,
            event_id: &str,
        ) -> Result<(), AppError> {
            let mut state = self.state.lock().await;
            state.calls.push(MockCall::DeleteEvent {
                calendar_id: calendar_id.to_owned(),
                event_id: event_id.to_owned(),
            });
            if let Some(Err(kind)) = pop_front(&mut state.behavior.delete_event_results) {
                return Err(kind.into());
            }
            match state.calendars.get_mut(calendar_id) {
                Some(cal) => match cal.remove(event_id) {
                    Some(_) => Ok(()),
                    None => Err(GcalErrorKind::EventGone.into()),
                },
                None => Err(GcalErrorKind::CalendarGone.into()),
            }
        }
    }

    fn pop_front<T>(v: &mut Vec<T>) -> Option<T> {
        if v.is_empty() {
            None
        } else {
            Some(v.remove(0))
        }
    }

    /// Build a throwaway Token for tests — the mock client ignores it.
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
    use super::testing::*;
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::keyring_store::{GcalEvent, RecordingEventEmitter};
    use chrono::{Duration as ChronoDuration, TimeZone};
    use std::path::PathBuf;
    use tempfile::TempDir;

    const DEV_A: &str = "device-AAAAAAAAAAAAAAAAAAAAAAAAAA";
    const DEV_B: &str = "device-BBBBBBBBBBBBBBBBBBBBBBBBBB";

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

    fn client_and_emitter() -> (
        Arc<MockGcalClient>,
        Arc<dyn GcalEventEmitter>,
        Arc<RecordingEventEmitter>,
    ) {
        let client = Arc::new(MockGcalClient::new());
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();
        (client, emitter, recorder)
    }

    // ── First-connect flow ─────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn first_connect_creates_calendar_and_persists_id() {
        let (pool, _dir) = test_pool().await;
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let dirty: DirtySet = DirtySet::new();
        let outcome = run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);
        assert_eq!(
            client.create_calendar_call_count().await,
            1,
            "first-connect must call create_calendar exactly once"
        );
        let persisted = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap();
        assert!(
            persisted
                .as_deref()
                .is_some_and(|s| s.starts_with("cal_MOCK_")),
            "calendar_id must be persisted after create_calendar, got {persisted:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn push_lease_contention_blocks_second_device() {
        let (pool, _dir) = test_pool().await;
        let (client_a, emitter_a, _rec_a) = client_and_emitter();
        let (client_b, emitter_b, _rec_b) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let dirty = DirtySet::new();

        // Device A claims the lease and creates the calendar.
        let a = run_cycle(&pool, &*client_a, &emitter_a, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(a, CycleOutcome::Ok);
        assert_eq!(client_a.create_calendar_call_count().await, 1);

        // Device B, same instant — lease already held → idle, no calendar call.
        let b = run_cycle(&pool, &*client_b, &emitter_b, DEV_B, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(b, CycleOutcome::LeaseUnavailable);
        assert_eq!(
            client_b.create_calendar_call_count().await,
            0,
            "blocked device must NOT call create_calendar"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn after_lease_expires_second_device_takes_over() {
        let (pool, _dir) = test_pool().await;
        let (client_a, emitter_a, _) = client_and_emitter();
        let (client_b, emitter_b, _) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let dirty = DirtySet::new();

        // A claims, does first-connect (creates calendar).
        assert_eq!(
            run_cycle(&pool, &*client_a, &emitter_a, DEV_A, &clock, &token, &dirty)
                .await
                .unwrap(),
            CycleOutcome::Ok
        );

        // Jump past lease expiry — B can now claim.
        clock.advance(ChronoDuration::seconds(
            lease::LEASE_EXPIRY_SECS.cast_signed() + 1,
        ));
        let b = run_cycle(&pool, &*client_b, &emitter_b, DEV_B, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(b, CycleOutcome::Ok);
        let state = lease::read_current_lease(&pool).await.unwrap();
        assert_eq!(
            state.device_id, DEV_B,
            "B must hold the lease after seizure"
        );
        // Calendar already exists — B does NOT re-create it.
        assert_eq!(client_b.create_calendar_call_count().await, 0);
    }

    // ── Per-date push flow ─────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn dirty_date_inserts_event_and_populates_map() {
        let (pool, _dir) = test_pool().await;
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let date = fixed_date();
        let (_page, _block) = seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);

        let outcome = run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);

        // Exactly one insert_event call.
        assert_eq!(
            client.event_ops_for_date(&date).await,
            1,
            "exactly one event op for the dirty date"
        );
        // Map row populated.
        let map = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap()
            .expect("map row must exist");
        assert!(map.gcal_event_id.starts_with("evt_"));
        assert!(!map.last_pushed_hash.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn unchanged_hash_is_a_noop_on_the_second_cycle() {
        let (pool, _dir) = test_pool().await;
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);

        // First cycle pushes.
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        // Second cycle with unchanged data → no extra ops.
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        assert_eq!(
            client.event_ops_for_date(&date).await,
            1,
            "unchanged digest must not produce a second push"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn soft_delete_last_entry_deletes_remote_event_and_map_row() {
        let (pool, _dir) = test_pool().await;
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        let (_page, block) = seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(client.event_ops_for_date(&date).await, 1);

        // Soft-delete the only entry for the date.
        soft_delete(&pool, &block).await;

        // Next cycle should delete the remote event + drop the map row.
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // One delete call for this date.
        let state = client.state.lock().await;
        let deletes = state
            .calls
            .iter()
            .filter(|c| matches!(c, MockCall::DeleteEvent { .. }))
            .count();
        assert_eq!(deletes, 1, "exactly one delete_event call after empty day");
        drop(state);

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
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let date_a = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        let date_b = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        let (_page, block) = seed_block_due_on(&pool, "Drag me", "2026-04-22").await;

        // First cycle: insert on date A.
        let mut dirty = DirtySet::new();
        dirty.insert(date_a);
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(client.event_ops_for_date(&date_a).await, 1);
        assert_eq!(client.event_ops_for_date(&date_b).await, 0);

        // Move the block to date B; both dates now dirty.
        move_block_due(&pool, &block, "2026-04-22", "2026-04-23").await;
        let mut dirty = DirtySet::new();
        dirty.insert(date_a);
        dirty.insert(date_b);
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();

        // Date A: one additional delete op (total ops for date_a = 2).
        // Date B: one insert.
        let state = client.state.lock().await;
        let a_deletes = state
            .calls
            .iter()
            .filter(|c| matches!(c, MockCall::DeleteEvent { .. }))
            .count();
        let b_inserts = state
            .calls
            .iter()
            .filter(|c| matches!(c, MockCall::InsertEvent { date, .. } if date == "2026-04-23"))
            .count();
        assert_eq!(a_deletes, 1, "exactly one delete for date A after drag");
        assert_eq!(b_inserts, 1, "exactly one insert for date B after drag");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn coalescing_10_dirty_events_on_same_date_produces_1_push() {
        // The `run_cycle` is idempotent on the dirty set — calling
        // it once with {date} is the "coalesced" semantic.  This test
        // pins that invariant: 10 `DirtyEvent`s from the hook layer
        // collapse into 1 push when the outer loop debounces them.
        let (pool, _dir) = test_pool().await;
        let (client, emitter, _rec) = client_and_emitter();
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
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(
            client.event_ops_for_date(&date).await,
            1,
            "coalesced flush produces exactly 1 push per affected date"
        );
    }

    // ── Calendar-gone recovery ─────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn calendar_gone_recovery_wipes_map_and_resets_id() {
        let (pool, _dir) = test_pool().await;
        let (client, emitter, rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();
        let date = fixed_date();
        seed_block_due_on(&pool, "Ship it", "2026-04-22").await;

        let mut dirty = DirtySet::new();
        dirty.insert(date);

        // First cycle: create calendar + push date.
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
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

        // Force the mock to fail the next patch with CalendarGone.  The
        // second cycle sees the new block below and diffs the digest
        // → patches the existing event → mock returns CalendarGone.
        client
            .force_next_patch_error(GcalErrorKind::CalendarGone)
            .await;
        // Trigger a change so the digest hash flips and we try to push again.
        let (_p2, _b2) = seed_block_due_on(&pool, "Another task", "2026-04-22").await;

        let outcome = run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
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
        // Entire event map wiped by recover_calendar_gone.
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
        let (client, emitter, rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        // First pass — create the calendar so the 401 happens on the
        // second, event-level call.
        client
            .force_next_create_calendar_error(GcalErrorKind::Unauthorized)
            .await;

        let outcome = run_cycle(
            &pool,
            &*client,
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
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let date_a = fixed_date();
        let date_b = NaiveDate::from_ymd_opt(2026, 4, 23).unwrap();
        seed_block_due_on(&pool, "On A", "2026-04-22").await;
        seed_block_due_on(&pool, "On B", "2026-04-23").await;

        // Force the first insert (date A — BTreeSet is ordered) to
        // return a 5xx — the mock pops from the front per call.
        client
            .force_next_insert_error(GcalErrorKind::ServerError { status: 503 })
            .await;

        let mut dirty = DirtySet::new();
        dirty.insert(date_a);
        dirty.insert(date_b);
        let outcome = run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);

        // Date A: zero successful pushes (the error was on its insert).
        // Date B: one insert that completed.
        assert_eq!(
            client.event_ops_for_date(&date_b).await,
            1,
            "date B must still be pushed after date A's transient 5xx"
        );
    }

    // ── Midnight rollover (window advances, old dates untouched) ───

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn midnight_rollover_leaves_old_tail_events_intact() {
        let (pool, _dir) = test_pool().await;
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let old_tail = fixed_date();
        seed_block_due_on(&pool, "Old tail", "2026-04-22").await;
        let mut dirty = DirtySet::new();
        dirty.insert(old_tail);
        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(client.event_ops_for_date(&old_tail).await, 1);

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

        run_cycle(&pool, &*client, &emitter, DEV_A, &clock, &token, &new_dirty)
            .await
            .unwrap();

        // The map row for the pre-rollover day is left alone — no
        // DeleteEvent call for its gcal_event_id.
        let row = models::get_event_map_for_date(&pool, "2026-04-22")
            .await
            .unwrap()
            .expect("pre-rollover map row must survive");
        let state = client.state.lock().await;
        let deletes_for_old_event = state
            .calls
            .iter()
            .filter(|c| matches!(c, MockCall::DeleteEvent { event_id, .. } if event_id == &row.gcal_event_id))
            .count();
        assert_eq!(
            deletes_for_old_event, 0,
            "midnight rollover must not retro-delete pre-window events"
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
        let (client, emitter, _rec) = client_and_emitter();
        let clock = FixedClock::new(t0());
        let token = dummy_token();

        let outcome = run_cycle(
            &pool,
            &*client,
            &emitter,
            DEV_A,
            &clock,
            &token,
            &DirtySet::new(),
        )
        .await
        .unwrap();
        assert_eq!(outcome, CycleOutcome::Ok);
        assert_eq!(client.create_calendar_call_count().await, 1);
    }

    // ── REVIEW-LATER C-1 — wired task loop dispatches `run_cycle` ──
    //
    // Smoke test: spawning the connector and pushing a `DirtyEvent`
    // through the channel must result in `run_cycle` actually running
    // (observed here as at least one `create_calendar` or
    // `insert_event` call on the mock).  Before C-1 the loop only
    // collected events and ticked, so the entire FEAT-5e push pipeline
    // was dead; this test catches a regression to that state.
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

        // Build doubles — keep an `Arc<MockGcalClient>` for assertions
        // and pass an `Arc<dyn GcalClient>` (the production shape) into
        // `spawn_connector`.
        let client: Arc<MockGcalClient> = Arc::new(MockGcalClient::new());
        let dyn_client: Arc<dyn GcalClient> = client.clone();

        let token_store: Arc<MockTokenStore> = Arc::new(MockTokenStore::new());
        token_store.store(&dummy_token()).await.unwrap();
        let dyn_token_store: Arc<dyn TokenStore> = token_store;

        let recorder = Arc::new(RecordingEventEmitter::new());
        let dyn_emitter: Arc<dyn GcalEventEmitter> = recorder;

        let task = spawn_connector(
            pool.clone(),
            dyn_client,
            dyn_token_store,
            dyn_emitter,
            DEV_A.to_owned(),
        );

        // Trigger a cycle — debounce is 500 ms so the cycle should
        // fire well within the 1.5 s budget below.
        task.handle.notify_dirty(DirtyEvent::single(date));

        let observed = tokio::time::timeout(StdDuration::from_millis(1500), async {
            loop {
                let calls = client.create_calendar_call_count().await
                    + client.event_ops_for_date(&date).await;
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
            "expected at least one create_calendar or insert_event call",
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
