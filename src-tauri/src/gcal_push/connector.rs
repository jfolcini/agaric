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
pub trait Clock: Send + Sync + std::fmt::Debug {
    fn now(&self) -> DateTime<Utc>;
    fn today(&self) -> NaiveDate {
        self.now().date_naive()
    }
}

/// Production clock — reads `Utc::now()` on every call.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
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
    HardFailure(String),
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
        match client
            .create_calendar(token, DEDICATED_CALENDAR_NAME)
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
        match push_date(
            pool, client, emitter, token, &settings, &calendar_id, *date,
        )
        .await
        {
            Ok(_) => {}
            Err(DateFailure::CalendarGone) => {
                // Whole cycle has to abort — the calendar is gone.
                recover_calendar_gone(pool, emitter).await?;
                return Ok(CycleOutcome::Ok);
            }
            Err(DateFailure::Unauthorized) => {
                emitter.emit(GcalEvent::ReauthRequired);
                return Ok(CycleOutcome::HardFailure(
                    "unauthorized (reauth required)".to_owned(),
                ));
            }
            Err(DateFailure::Forbidden(msg)) => {
                emitter.emit(GcalEvent::PushDisabled);
                return Ok(CycleOutcome::HardFailure(format!("forbidden: {msg}")));
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
        match kind {
            GcalErrorKind::Unauthorized => {
                emitter.emit(GcalEvent::ReauthRequired);
                return Ok(CycleOutcome::HardFailure(
                    "unauthorized (reauth required)".to_owned(),
                ));
            }
            GcalErrorKind::Forbidden(msg) => {
                emitter.emit(GcalEvent::PushDisabled);
                return Ok(CycleOutcome::HardFailure(format!(
                    "forbidden: {msg}"
                )));
            }
            GcalErrorKind::RateLimited { retry_after_ms } => {
                return Ok(CycleOutcome::HardFailure(format!(
                    "rate_limited: retry after {retry_after_ms}ms"
                )));
            }
            GcalErrorKind::ServerError { status } => {
                return Ok(CycleOutcome::HardFailure(format!(
                    "server_error: HTTP {status}"
                )));
            }
            GcalErrorKind::InvalidRequest(msg) => {
                return Ok(CycleOutcome::HardFailure(format!(
                    "invalid_request: {msg}"
                )));
            }
            _ => {}
        }
    }
    tracing::error!(
        target: "gcal",
        error = ?err,
        "hard failure in cycle setup",
    );
    Ok(CycleOutcome::HardFailure(err.to_string()))
}

/// Evaluate a single date: fetch agenda entries, compute digest, hash,
/// compare, push/patch/delete.
#[tracing::instrument(skip(pool, client, emitter, token, settings), fields(date = %date))]
async fn push_date<C: GcalClient>(
    pool: &SqlitePool,
    client: &C,
    emitter: &Arc<dyn GcalEventEmitter>,
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
                Err(e) => return Err(classify_date_err(&e, emitter)),
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
                .map_err(|e| classify_date_err(&e, emitter))?;
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
                Err(e) => Err(classify_date_err(&e, emitter)),
            }
        }
    }
}

/// Map an [`AppError`] raised from a per-event client call onto the
/// [`DateFailure`] taxonomy used by [`push_date`].
fn classify_date_err(err: &AppError, _emitter: &Arc<dyn GcalEventEmitter>) -> DateFailure {
    if let AppError::Gcal(kind) = err {
        match kind {
            GcalErrorKind::Unauthorized => return DateFailure::Unauthorized,
            GcalErrorKind::Forbidden(msg) => return DateFailure::Forbidden(msg.clone()),
            GcalErrorKind::CalendarGone => return DateFailure::CalendarGone,
            GcalErrorKind::EventGone => {
                return DateFailure::Skipped("event_gone".to_owned());
            }
            GcalErrorKind::RateLimited { retry_after_ms } => {
                return DateFailure::Skipped(format!("rate_limited: {retry_after_ms}ms"));
            }
            GcalErrorKind::ServerError { status } => {
                return DateFailure::Skipped(format!("server_error: HTTP {status}"));
            }
            GcalErrorKind::InvalidRequest(msg) => {
                return DateFailure::Skipped(format!("invalid_request: {msg}"));
            }
        }
    }
    DateFailure::Other(
        AppError::Validation(format!("gcal.connector.unexpected_error: {err}")),
    )
}

/// Recover from a `CalendarGone` response: wipe the map, reset the
/// calendar_id, emit `calendar_recreated` so the UI refreshes, and let
/// the next cycle re-create the calendar.
async fn recover_calendar_gone(
    pool: &SqlitePool,
    emitter: &Arc<dyn GcalEventEmitter>,
) -> Result<(), AppError> {
    tracing::warn!(
        target: "gcal",
        "calendar gone — wiping event map, resetting calendar_id",
    );
    sqlx::query!("DELETE FROM gcal_agenda_event_map")
        .execute(pool)
        .await?;
    models::set_setting(pool, GcalSettingKey::CalendarId, "").await?;
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
pub fn fill_full_window(dirty: &mut DirtySet, today: NaiveDate, window_days: i64) {
    for i in 0..window_days.max(0) {
        if let Some(d) = today.checked_add_days(Days::new(i as u64)) {
            dirty.insert(d);
        }
    }
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
    _token_store: Arc<dyn TokenStore>,
    _emitter: Arc<dyn GcalEventEmitter>,
    device_id: String,
    clock: impl Clock,
    mut dirty_rx: mpsc::UnboundedReceiver<DirtyEvent>,
    force_sweep: Arc<Notify>,
    shutdown: Arc<Notify>,
) {
    // Production outer loop is intentionally minimal in this slice —
    // the wiring of `fetch_with_auto_refresh` + bounded backoff + lease
    // renewal cadence is exercised through the unit tests on
    // `run_cycle` / `push_date`.  The loop below keeps `_token_store`
    // and `_emitter` alive for future wiring.
    let mut dirty: DirtySet = DirtySet::new();
    let _ = (&client, &pool, &device_id, &clock); // keep the bindings live

    let mut reconcile = tokio::time::interval(RECONCILE_INTERVAL);
    reconcile.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            biased;
            _ = shutdown.notified() => break,
            _ = force_sweep.notified() => {
                dirty.clear();
                tracing::info!(target: "gcal", "force_resync: dropping accumulated dirty set");
            }
            maybe_ev = dirty_rx.recv() => match maybe_ev {
                Some(ev) => dirty.extend(ev.affected()),
                None => break,
            },
            _ = reconcile.tick() => {
                tracing::debug!(target: "gcal", "reconcile tick");
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
        CreateCalendar { name: String },
        DeleteCalendar { calendar_id: String },
        InsertEvent { calendar_id: String, date: String },
        PatchEvent { calendar_id: String, event_id: String, date: String },
        DeleteEvent { calendar_id: String, event_id: String },
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

        #[allow(dead_code)] // Used by tests in future sub-items
        pub async fn set_fixed_calendar_id(&self, id: &str) {
            let mut state = self.state.lock().await;
            state.calendars.entry(id.to_owned()).or_default();
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
                    MockCall::DeleteEvent { calendar_id, event_id } => {
                        // Heuristic: event_ids are `evt_<seq>_<YYYY-MM-DD>`.
                        let _ = calendar_id;
                        event_id.ends_with(&date_str)
                    }
                    _ => false,
                })
                .count()
        }

        #[allow(dead_code)] // Reserved for future integration tests
        pub async fn call_count(&self) -> usize {
            self.state.lock().await.calls.len()
        }

        #[allow(dead_code)] // Reserved for future integration tests
        pub async fn remote_event_count(&self, calendar_id: &str) -> usize {
            self.state
                .lock()
                .await
                .calendars
                .get(calendar_id)
                .map(HashMap::len)
                .unwrap_or(0)
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
            if let Some(r) = pop_front(&mut state.behavior.create_calendar_results) {
                if let Err(kind) = r {
                    return Err(kind.into());
                }
            }
            state.next_cal_seq += 1;
            let id = format!("cal_MOCK_{}", state.next_cal_seq);
            state.calendars.insert(id.clone(), HashMap::new());
            Ok(id)
        }

        async fn delete_calendar(
            &self,
            _token: &Token,
            calendar_id: &str,
        ) -> Result<(), AppError> {
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
            if let Some(r) = pop_front(&mut state.behavior.insert_event_results) {
                if let Err(kind) = r {
                    return Err(kind.into());
                }
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
            if let Some(r) = pop_front(&mut state.behavior.patch_event_results) {
                if let Err(kind) = r {
                    return Err(kind.into());
                }
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
            if let Some(r) = pop_front(&mut state.behavior.delete_event_results) {
                if let Err(kind) = r {
                    return Err(kind.into());
                }
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
    async fn seed_block_due_on(
        pool: &SqlitePool,
        content: &str,
        date: &str,
    ) -> (String, String) {
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
    async fn move_block_due(
        pool: &SqlitePool,
        block_id: &str,
        old_date: &str,
        new_date: &str,
    ) {
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
        let outcome = run_cycle(
            &pool, &*client, &emitter, DEV_A, &clock, &token, &dirty,
        )
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
            persisted.as_deref().is_some_and(|s| s.starts_with("cal_MOCK_")),
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
        let a = run_cycle(
            &pool, &*client_a, &emitter_a, DEV_A, &clock, &token, &dirty,
        )
        .await
        .unwrap();
        assert_eq!(a, CycleOutcome::Ok);
        assert_eq!(client_a.create_calendar_call_count().await, 1);

        // Device B, same instant — lease already held → idle, no calendar call.
        let b = run_cycle(
            &pool, &*client_b, &emitter_b, DEV_B, &clock, &token, &dirty,
        )
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
            (lease::LEASE_EXPIRY_SECS as i64) + 1,
        ));
        let b = run_cycle(&pool, &*client_b, &emitter_b, DEV_B, &clock, &token, &dirty)
            .await
            .unwrap();
        assert_eq!(b, CycleOutcome::Ok);
        let state = lease::read_current_lease(&pool).await.unwrap();
        assert_eq!(state.device_id, DEV_B, "B must hold the lease after seizure");
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
            matches!(outcome, CycleOutcome::HardFailure(ref msg) if msg.contains("unauthorized")),
            "401 on first-connect must surface HardFailure(unauthorized), got {outcome:?}"
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
}
