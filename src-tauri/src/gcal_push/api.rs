//! FEAT-5c — stateless Google Calendar API v3 client for the Agaric
//! daily-agenda digest push connector.
//!
//! # Scope
//!
//! * Create / delete the dedicated "Agaric Agenda" calendar (one per
//!   account; ID persisted in `gcal_settings.calendar_id` by
//!   FEAT-5e).
//! * Insert / patch / delete / get an all-day digest event on the
//!   dedicated calendar.
//! * Translate the FEAT-5d [`digest::Event`] (inclusive end-date) to
//!   and from GCal's exclusive-end wire format.
//! * Classify every HTTP response into [`GcalErrorKind`] — callers
//!   decide retry semantics per variant (FEAT-5e).
//!
//! # What this module does NOT do
//!
//! * **Retry.** `GcalApi` is stateless and issues exactly one
//!   request per public method.  Retry / back-off policy lives in
//!   FEAT-5e's connector where the error-class dispatch is
//!   implemented.
//! * **Token refresh.** Callers wrap each call in
//!   [`crate::gcal_push::oauth::fetch_with_auto_refresh`]; the API
//!   layer just returns `GcalErrorKind::Unauthorized` on 401.
//! * **Middleware.** `reqwest-middleware`, `tower-http`, and similar
//!   stacks are explicitly rejected (FEAT-5 parent rejected-deps list)
//!   — the per-error-class retry is not a good fit for generic
//!   transient-retry middleware.
//!
//! # Rate limiting
//!
//! Every public method awaits an [`InstantBucket`] token before issuing
//! the HTTP request.  10 QPS sustained, 25-burst.  Implemented inline
//! as a `VecDeque<Instant>` with sleep-until-oldest-falls-out — ~40
//! lines, no new deps.  See FEAT-5 parent rejected-deps list for why
//! `governor` / `leaky-bucket` were ruled out.
//!
//! # All-day end-date translation
//!
//! FEAT-5d's [`digest::Event`] uses **inclusive** `start == end` for a
//! one-day all-day event.  GCal's v3 API uses **exclusive** end:
//! `end.date = start.date + 1`.  This module is the single place where
//! the shim lives: the request body adds one day on the way out,
//! [`EventResponse`] subtracts one day on the way back so callers
//! (FEAT-5e's connector) can keep comparing `digest::Event` round-trips
//! without worrying about which side of the wire they are on.

use std::collections::VecDeque;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use chrono::{Days, NaiveDate};
use secrecy::ExposeSecret;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{AppError, GcalErrorKind};

use super::digest::{Event, EventDate};
use super::oauth::Token;

// ---------------------------------------------------------------------------
// Public API surface
// ---------------------------------------------------------------------------

/// Google Calendar ID (opaque string assigned by Google on calendar
/// creation).  Persisted in `gcal_settings.calendar_id` by FEAT-5e.
pub type CalendarId = String;

/// Opaque per-event ID assigned by Google on event creation.  Stored
/// per-date in `gcal_agenda_event_map.gcal_event_id`.
pub type EventId = String;

/// Full response body returned by the GCal API for event endpoints.
/// The caller (FEAT-5e) reads `id` to populate
/// `gcal_agenda_event_map`, and uses the decoded [`Event`] to diff
/// against the locally computed digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventResponse {
    /// GCal-assigned opaque event ID.
    pub id: EventId,
    /// The event body as Agaric sees it — `end` has already been
    /// translated from GCal's exclusive convention back to the
    /// digest-module's inclusive convention.
    pub event: Event,
}

/// Partial event update used by [`GcalApi::patch_event`].  All fields
/// optional — only the non-`None` ones are serialised into the PATCH
/// body.  Omitted fields keep their existing value on the server.
///
/// Construct via [`EventPatch::new`] and chain `.with_summary(…)` etc.
/// `Default::default()` yields an empty patch (legal but a no-op on
/// the server — callers should avoid sending one).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct EventPatch {
    pub summary: Option<String>,
    pub description: Option<String>,
    /// Inclusive start date (`YYYY-MM-DD`).  The API layer translates
    /// to GCal's wire format on serialise.
    pub start: Option<NaiveDate>,
    /// Inclusive end date (`YYYY-MM-DD`).  Mirrors [`Event::end`].
    pub end: Option<NaiveDate>,
    pub transparency: Option<String>,
}

impl EventPatch {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn with_summary(mut self, summary: impl Into<String>) -> Self {
        self.summary = Some(summary.into());
        self
    }

    #[must_use]
    pub fn with_description(mut self, description: impl Into<String>) -> Self {
        self.description = Some(description.into());
        self
    }

    #[must_use]
    pub fn with_start(mut self, start: NaiveDate) -> Self {
        self.start = Some(start);
        self
    }

    #[must_use]
    pub fn with_end(mut self, end: NaiveDate) -> Self {
        self.end = Some(end);
        self
    }

    #[must_use]
    pub fn with_transparency(mut self, transparency: impl Into<String>) -> Self {
        self.transparency = Some(transparency.into());
        self
    }
}

// ---------------------------------------------------------------------------
// GcalApi struct
// ---------------------------------------------------------------------------

/// Stateless wrapper over the Google Calendar API v3.
///
/// Owns a shared [`reqwest::Client`] (process-global via a
/// `OnceLock`) and an in-memory [`InstantBucket`] rate limiter.
/// Cloning is cheap — the client is `Arc`-backed internally and the
/// bucket is behind an `Arc<Mutex<…>>`.
#[derive(Clone)]
pub struct GcalApi {
    client: reqwest::Client,
    bucket: Arc<Mutex<InstantBucket>>,
    base_url: String,
}

impl std::fmt::Debug for GcalApi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GcalApi")
            .field("base_url", &self.base_url)
            // client + bucket deliberately omitted — their Debug
            // impls are noisy and bucket's internal state races
            // under contention.
            .finish()
    }
}

/// Production Google Calendar base URL.
pub const GOOGLE_CALENDAR_BASE_URL: &str = "https://www.googleapis.com/calendar/v3";

/// Maximum sustained queries-per-second we will send to Google.
/// Google's stated v3 quota is 500 QPS per user project, so 10 QPS
/// leaves orders-of-magnitude headroom while keeping us far from ever
/// tripping the upstream rate limiter under normal use.
const RATE_LIMIT_QPS: usize = 10;

/// Allow a short burst of `RATE_LIMIT_BURST` requests before the
/// sustained-QPS gate engages.  Covers the "initial first-connect
/// flood" on a fresh account: N dates × `insert_event` in rapid
/// succession.  See FEAT-5 parent for the user-experience rationale.
const RATE_LIMIT_BURST: usize = 25;

/// Default wait hint when a 429 response omits the `Retry-After`
/// header — matches Google's typical client-library behaviour.
const DEFAULT_RETRY_AFTER_MS: u64 = 1000;

impl GcalApi {
    /// Construct a production `GcalApi` pointing at the real Google
    /// Calendar endpoint.
    ///
    /// # Errors
    /// [`AppError::Validation`] if the shared HTTP client fails to
    /// build (would indicate a malformed rustls setup — not expected
    /// in practice).
    pub fn new() -> Result<Self, AppError> {
        Self::with_base_url(GOOGLE_CALENDAR_BASE_URL.to_owned())
    }

    /// Construct a `GcalApi` pointing at an arbitrary base URL.
    /// Used by the `wiremock`-backed tests in this module.  The
    /// `base_url` must NOT include a trailing slash.
    ///
    /// # Errors
    /// [`AppError::Validation`] if the shared HTTP client fails to
    /// build.
    pub fn with_base_url(base_url: String) -> Result<Self, AppError> {
        Ok(Self {
            client: shared_client()?,
            bucket: Arc::new(Mutex::new(InstantBucket::new(
                RATE_LIMIT_BURST,
                Duration::from_secs(1),
                RATE_LIMIT_QPS,
            ))),
            base_url: base_url.trim_end_matches('/').to_owned(),
        })
    }

    /// Create the dedicated "Agaric Agenda" calendar for the connected
    /// user.  Called once per account on first connect — the returned
    /// [`CalendarId`] is persisted in `gcal_settings.calendar_id` by
    /// FEAT-5e's first-connect flow.
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant — callers map per FEAT-5e's retry
    /// taxonomy.
    #[tracing::instrument(skip(self, token), err)]
    pub async fn create_dedicated_calendar(
        &self,
        token: &Token,
        name: &str,
    ) -> Result<CalendarId, AppError> {
        #[derive(Serialize)]
        struct CreateCalendarReq<'a> {
            summary: &'a str,
        }

        #[derive(Deserialize)]
        struct CreateCalendarResp {
            id: String,
        }

        self.bucket.lock().await.take().await;

        let url = format!("{}/calendars", self.base_url);
        let req = CreateCalendarReq { summary: name };

        let resp = self
            .client
            .post(&url)
            .bearer_auth(token.access.expose_secret())
            .json(&req)
            .send()
            .await
            .map_err(reqwest_to_gcal_err)?;

        let status = resp.status();
        if status.is_success() {
            let body: CreateCalendarResp = resp.json().await.map_err(reqwest_to_gcal_err)?;
            return Ok(body.id);
        }
        Err(classify_error(status, &resp_headers(&resp), false).into())
    }

    /// Delete the dedicated calendar.  Invoked when the user chooses
    /// "Disconnect and delete the Agaric Agenda calendar" in Settings
    /// (FEAT-5f).
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant.  A 404 on this path is
    /// [`GcalErrorKind::CalendarGone`] — the user had already deleted
    /// the calendar externally, which is effectively success from the
    /// caller's perspective (the connector maps this to `Ok(())` at
    /// its own layer).
    #[tracing::instrument(skip(self, token), err)]
    pub async fn delete_calendar(
        &self,
        token: &Token,
        calendar_id: &str,
    ) -> Result<(), AppError> {
        self.bucket.lock().await.take().await;

        let url = format!("{}/calendars/{}", self.base_url, calendar_id);
        let resp = self
            .client
            .delete(&url)
            .bearer_auth(token.access.expose_secret())
            .send()
            .await
            .map_err(reqwest_to_gcal_err)?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        Err(classify_error(status, &resp_headers(&resp), /*on_event*/ false).into())
    }

    /// Insert a new event into the dedicated calendar.  Returns the
    /// assigned [`EventId`] inside an [`EventResponse`].
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant.  404 here is
    /// [`GcalErrorKind::CalendarGone`] — the dedicated calendar was
    /// deleted externally and the connector must recover.
    #[tracing::instrument(skip(self, token), err)]
    pub async fn insert_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event: &Event,
    ) -> Result<EventResponse, AppError> {
        self.bucket.lock().await.take().await;

        let url = format!("{}/calendars/{}/events", self.base_url, calendar_id);
        let wire_event = WireEvent::from_digest_event(event)?;

        let resp = self
            .client
            .post(&url)
            .bearer_auth(token.access.expose_secret())
            .json(&wire_event)
            .send()
            .await
            .map_err(reqwest_to_gcal_err)?;

        let status = resp.status();
        if status.is_success() {
            let body: WireEventResponse = resp.json().await.map_err(reqwest_to_gcal_err)?;
            return body.into_event_response();
        }
        // 404 on /calendars/{id}/events targets the calendar, not a
        // specific event — map to CalendarGone.
        Err(classify_error(status, &resp_headers(&resp), /*on_event*/ false).into())
    }

    /// Patch an existing event.  Only fields set on `patch` are
    /// written.
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant.  404 here is
    /// [`GcalErrorKind::EventGone`] — the event was deleted externally
    /// (e.g. the user removed it in GCal's UI); the connector drops
    /// its map row and re-creates on next push.
    #[tracing::instrument(skip(self, token), err)]
    pub async fn patch_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
        patch: &EventPatch,
    ) -> Result<EventResponse, AppError> {
        self.bucket.lock().await.take().await;

        let url = format!(
            "{}/calendars/{}/events/{}",
            self.base_url, calendar_id, event_id
        );
        let wire_patch = WireEventPatch::from_patch(patch);

        let resp = self
            .client
            .patch(&url)
            .bearer_auth(token.access.expose_secret())
            .json(&wire_patch)
            .send()
            .await
            .map_err(reqwest_to_gcal_err)?;

        let status = resp.status();
        if status.is_success() {
            let body: WireEventResponse = resp.json().await.map_err(reqwest_to_gcal_err)?;
            return body.into_event_response();
        }
        Err(classify_error(status, &resp_headers(&resp), /*on_event*/ true).into())
    }

    /// Delete a single event.  Idempotent-ish — if the event was
    /// already gone, this returns [`GcalErrorKind::EventGone`]; callers
    /// treat that as success at their own layer.
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant.
    #[tracing::instrument(skip(self, token), err)]
    pub async fn delete_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), AppError> {
        self.bucket.lock().await.take().await;

        let url = format!(
            "{}/calendars/{}/events/{}",
            self.base_url, calendar_id, event_id
        );
        let resp = self
            .client
            .delete(&url)
            .bearer_auth(token.access.expose_secret())
            .send()
            .await
            .map_err(reqwest_to_gcal_err)?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        Err(classify_error(status, &resp_headers(&resp), /*on_event*/ true).into())
    }

    /// GET a single event.  Used by FEAT-5e's reconcile sweep to
    /// verify the remote copy still exists.
    ///
    /// # Returns
    /// * `Ok(Some(_))` on a 200 response.
    /// * `Ok(None)` if the event was deleted externally (HTTP 404 on
    ///   an event path).
    /// * `Err(AppError::Gcal(CalendarGone))` if the calendar itself is
    ///   gone (404 on the calendar path — detection heuristic below).
    /// * Any other [`GcalErrorKind`] for other failure modes.
    ///
    /// # 404 disambiguation heuristic
    ///
    /// GCal returns 404 on `/calendars/{id}/events/{event_id}` whether
    /// the calendar or the event is the missing resource.  The
    /// response body sometimes helps (`"calendarId"` in the error
    /// reason) but is not guaranteed.  We treat a 404 here as
    /// `EventGone` by default — callers who need to distinguish
    /// should probe the calendar itself via a `list_calendars`
    /// equivalent, which is out of scope for this module (we only own
    /// one calendar, its ID is known).
    #[tracing::instrument(skip(self, token), err)]
    pub async fn get_event(
        &self,
        token: &Token,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<Option<EventResponse>, AppError> {
        self.bucket.lock().await.take().await;

        let url = format!(
            "{}/calendars/{}/events/{}",
            self.base_url, calendar_id, event_id
        );
        let resp = self
            .client
            .get(&url)
            .bearer_auth(token.access.expose_secret())
            .send()
            .await
            .map_err(reqwest_to_gcal_err)?;

        let status = resp.status();
        if status.is_success() {
            let body: WireEventResponse = resp.json().await.map_err(reqwest_to_gcal_err)?;
            return body.into_event_response().map(Some);
        }
        match classify_error(status, &resp_headers(&resp), /*on_event*/ true) {
            // 404 on event path → treat as "gone"; map to Ok(None) so
            // the reconcile sweep can simply re-insert.
            GcalErrorKind::EventGone => Ok(None),
            other => Err(other.into()),
        }
    }
}

// ---------------------------------------------------------------------------
// Wire-format shims (inclusive ↔ exclusive end-date)
// ---------------------------------------------------------------------------

/// Wire-format event body sent to `events.insert`.  Mirrors
/// [`digest::Event`] except `end.date` is GCal's exclusive convention
/// (`start + 1 day`).
#[derive(Debug, Serialize)]
struct WireEvent {
    summary: String,
    description: String,
    start: EventDate,
    end: EventDate,
    transparency: String,
}

impl WireEvent {
    fn from_digest_event(event: &Event) -> Result<Self, AppError> {
        Ok(Self {
            summary: event.summary.clone(),
            description: event.description.clone(),
            start: event.start.clone(),
            end: EventDate {
                date: shift_date_forward(&event.end.date, 1)?,
            },
            transparency: event.transparency.clone(),
        })
    }
}

/// Wire-format PATCH body.  All fields optional; `#[serde(skip_serializing_if = "Option::is_none")]`
/// drops the ones the caller did not set.
#[derive(Debug, Default, Serialize)]
struct WireEventPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start: Option<EventDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end: Option<EventDate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    transparency: Option<String>,
}

impl WireEventPatch {
    fn from_patch(patch: &EventPatch) -> Self {
        Self {
            summary: patch.summary.clone(),
            description: patch.description.clone(),
            start: patch.start.map(|d| EventDate {
                date: d.format("%Y-%m-%d").to_string(),
            }),
            end: patch.end.map(|d| {
                // Exclusive-end shim: GCal stores `end = start + 1`
                // for a one-day all-day event.
                let plus_one = d + Days::new(1);
                EventDate {
                    date: plus_one.format("%Y-%m-%d").to_string(),
                }
            }),
            transparency: patch.transparency.clone(),
        }
    }
}

/// Wire-format event-response body returned by `events.insert` /
/// `events.get` / `events.patch`.  We deserialise into this and then
/// translate the exclusive `end.date` back to the inclusive form the
/// digest module uses.
#[derive(Debug, Deserialize)]
struct WireEventResponse {
    id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    description: String,
    start: EventDate,
    end: EventDate,
    #[serde(default)]
    transparency: String,
}

impl WireEventResponse {
    fn into_event_response(self) -> Result<EventResponse, AppError> {
        let inclusive_end = shift_date_forward(&self.end.date, -1)?;
        Ok(EventResponse {
            id: self.id,
            event: Event {
                summary: self.summary,
                description: self.description,
                start: self.start,
                end: EventDate {
                    date: inclusive_end,
                },
                transparency: if self.transparency.is_empty() {
                    "transparent".to_owned()
                } else {
                    self.transparency
                },
            },
        })
    }
}

/// Add (or subtract) whole days from a `YYYY-MM-DD` date string and
/// return the new string.  Used by the exclusive/inclusive shim in
/// both directions.
fn shift_date_forward(date_str: &str, delta_days: i64) -> Result<String, AppError> {
    let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .map_err(|e| AppError::Validation(format!("gcal.api.malformed_date: {date_str}: {e}")))?;
    let shifted = if delta_days >= 0 {
        date.checked_add_days(Days::new(delta_days as u64))
    } else {
        // Safe conversion: delta_days is negative, so negating gives
        // a positive value that fits in u64.
        date.checked_sub_days(Days::new((-delta_days) as u64))
    }
    .ok_or_else(|| {
        AppError::Validation(format!(
            "gcal.api.date_arithmetic_overflow: {date_str} + {delta_days}"
        ))
    })?;
    Ok(shifted.format("%Y-%m-%d").to_string())
}

// ---------------------------------------------------------------------------
// HTTP-status → GcalErrorKind classifier
// ---------------------------------------------------------------------------

/// Copy response headers into a plain `Vec<(name, value)>` so we can
/// continue consuming the body without racing the borrow checker.
fn resp_headers(resp: &reqwest::Response) -> Vec<(String, String)> {
    resp.headers()
        .iter()
        .map(|(k, v)| {
            (
                k.as_str().to_owned(),
                v.to_str().unwrap_or_default().to_owned(),
            )
        })
        .collect()
}

/// Map a non-2xx HTTP status + header slice to the matching
/// [`GcalErrorKind`] variant.
///
/// `on_event`: `true` if the request targeted an event path
/// (`/calendars/{id}/events/{event_id}`), `false` for a calendar-level
/// path (`/calendars/{id}` or `/calendars/{id}/events`).  Distinguishes
/// 404-on-event from 404-on-calendar, which require different recovery.
fn classify_error(
    status: reqwest::StatusCode,
    headers: &[(String, String)],
    on_event: bool,
) -> GcalErrorKind {
    let code = status.as_u16();
    match code {
        400 => GcalErrorKind::InvalidRequest(format!("HTTP {code}")),
        401 => GcalErrorKind::Unauthorized,
        403 => GcalErrorKind::Forbidden(format!("HTTP {code}")),
        404 => {
            if on_event {
                GcalErrorKind::EventGone
            } else {
                GcalErrorKind::CalendarGone
            }
        }
        409 => GcalErrorKind::InvalidRequest(format!("HTTP {code}: conflict")),
        429 => GcalErrorKind::RateLimited {
            retry_after_ms: retry_after_from_headers(headers),
        },
        500..=599 => GcalErrorKind::ServerError { status: code },
        // Other 4xx codes fall through to InvalidRequest — callers
        // surface the message and do not retry.
        _ => GcalErrorKind::InvalidRequest(format!("unexpected HTTP {code}")),
    }
}

/// Parse the `Retry-After` header as an integer number of seconds.
/// Falls back to [`DEFAULT_RETRY_AFTER_MS`] when absent, malformed, or
/// not a simple integer.  We intentionally do NOT parse the HTTP-date
/// form of `Retry-After` (RFC 7231 §7.1.3) — Google's v3 API always
/// emits the seconds form for 429 responses, and a simpler parser is
/// cheaper to maintain than handling the rare date-form edge case.
fn retry_after_from_headers(headers: &[(String, String)]) -> u64 {
    for (name, value) in headers {
        if name.eq_ignore_ascii_case("retry-after") {
            if let Ok(secs) = value.trim().parse::<u64>() {
                return secs.saturating_mul(1000);
            }
        }
    }
    DEFAULT_RETRY_AFTER_MS
}

/// Map a bare [`reqwest::Error`] (network failure, JSON parse failure)
/// into [`AppError`].  Network errors surface as
/// [`GcalErrorKind::ServerError`] with status 0 — callers treat that
/// as a transient failure and retry with back-off.
///
/// JSON-parse failures in the response body are distinctive enough to
/// return [`AppError::Json`] via the existing `#[from]` impl, so
/// callers can distinguish them from HTTP-layer errors if desired.
fn reqwest_to_gcal_err(err: reqwest::Error) -> AppError {
    if err.is_decode() {
        AppError::Validation(format!("gcal.api.decode_failed: {err}"))
    } else {
        // Connect / timeout / protocol error — transient, same class
        // as a 5xx.  We use status=0 as the sentinel for "no status
        // because no response".
        AppError::Gcal(GcalErrorKind::ServerError { status: 0 })
    }
}

// ---------------------------------------------------------------------------
// Shared reqwest::Client
// ---------------------------------------------------------------------------

/// Return the process-global `reqwest::Client`, lazily built on first
/// use.  `reqwest::Client` is `Arc`-backed, so cloning is cheap; the
/// `OnceLock` keeps us from re-building (a ~ms operation that would
/// thrash connection pooling if done per `GcalApi::new()`).
fn shared_client() -> Result<reqwest::Client, AppError> {
    static CELL: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(existing) = CELL.get() {
        return Ok(existing.clone());
    }
    let built = reqwest::Client::builder()
        .user_agent("Agaric/1.0 (gcal_push)")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Validation(format!("gcal.api.http_client_build_failed: {e}")))?;
    // Benign race: two threads may both get into `build()` on first
    // call; whichever `set_if_none`s first wins, the other's client
    // is dropped.  Either way the stored client is a valid shared
    // handle.
    Ok(CELL.get_or_init(|| built).clone())
}

// ---------------------------------------------------------------------------
// Rate limiter (InstantBucket)
// ---------------------------------------------------------------------------

/// Sliding-window token bucket.  Holds up to `burst` request
/// timestamps; the oldest timestamp must be older than `window` before
/// a new one is admitted, and then only at a rate of `sustained_qps`
/// per second after the initial burst drains.
///
/// Implemented as a `VecDeque<Instant>` so eviction is O(1) at the
/// front.  `take().await` returns once the next slot is free.
#[derive(Debug)]
pub(crate) struct InstantBucket {
    /// Recent request timestamps, oldest at the front.
    recent: VecDeque<Instant>,
    /// Burst size — how many back-to-back requests we allow before
    /// the sustained rate engages.
    burst: usize,
    /// Sliding-window length over which `sustained_qps` is measured.
    window: Duration,
    /// Sustained queries per second once burst is exhausted.
    sustained_qps: usize,
}

impl InstantBucket {
    fn new(burst: usize, window: Duration, sustained_qps: usize) -> Self {
        Self {
            recent: VecDeque::with_capacity(burst),
            burst,
            window,
            sustained_qps,
        }
    }

    /// Sleep until a token is available, then record the current
    /// instant in the bucket.  Called with the bucket's lock held so
    /// the critical section is tight — `take` drops the lock across
    /// its internal sleep.
    async fn take(&mut self) {
        loop {
            let now = Instant::now();
            // Drop expired entries from the front.
            while let Some(oldest) = self.recent.front() {
                if now.duration_since(*oldest) >= self.window {
                    self.recent.pop_front();
                } else {
                    break;
                }
            }

            if self.recent.len() < self.burst {
                // Under the burst ceiling — admit immediately.
                self.recent.push_back(now);
                return;
            }

            // Burst ceiling hit — compute how long until the oldest
            // entry expires.  Sleep for at least that long, plus the
            // sustained-QPS inter-request gap, so we do not immediately
            // overshoot.
            let sleep_for = self.recent.front().map_or(self.window, |&oldest| {
                let elapsed = now.saturating_duration_since(oldest);
                let remaining = self.window.saturating_sub(elapsed);
                // Add the sustained gap so successive admissions are
                // spaced, not clustered.
                let gap = if self.sustained_qps == 0 {
                    Duration::ZERO
                } else {
                    Duration::from_millis(1000 / self.sustained_qps as u64)
                };
                remaining + gap
            });

            // Drop the lock while sleeping — but we are already inside
            // the caller's `.lock().await` guard so the next request
            // will queue on it.  Sleep then re-check.
            tokio::time::sleep(sleep_for).await;
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration as ChronoDuration, Utc};
    use secrecy::SecretString;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    const TEST_CAL_ID: &str = "cal_ABCDEF";
    const TEST_EVENT_ID: &str = "evt_123";

    /// Build a dummy access token for API tests — no real secrecy
    /// needed since wiremock is local-only.
    fn make_token() -> Token {
        Token {
            access: SecretString::from("dummy-access-token".to_owned()),
            refresh: SecretString::from("dummy-refresh".to_owned()),
            expires_at: Utc::now() + ChronoDuration::hours(1),
        }
    }

    /// Build an API pointed at the given wiremock URI.  Uses a fresh
    /// bucket per test so concurrent tests do not interfere with each
    /// other's rate-limiter state.
    fn make_api(base: &str) -> GcalApi {
        GcalApi::with_base_url(base.to_owned()).expect("api construction must succeed")
    }

    fn make_event(date: &str) -> Event {
        Event {
            summary: format!("Agaric Agenda — {date}"),
            description: "· TODO do the thing".to_owned(),
            start: EventDate {
                date: date.to_owned(),
            },
            end: EventDate {
                date: date.to_owned(),
            },
            transparency: "transparent".to_owned(),
        }
    }

    // ── create_dedicated_calendar ──────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_dedicated_calendar_returns_id_on_200() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .and(header("authorization", "Bearer dummy-access-token"))
            .and(body_string_contains("Agaric Agenda"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "cal_XYZ",
                "summary": "Agaric Agenda",
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let id = api
            .create_dedicated_calendar(&make_token(), "Agaric Agenda")
            .await
            .expect("create must succeed");
        assert_eq!(id, "cal_XYZ");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn create_dedicated_calendar_maps_401_to_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api
            .create_dedicated_calendar(&make_token(), "Agaric Agenda")
            .await;
        assert!(
            matches!(
                result,
                Err(AppError::Gcal(GcalErrorKind::Unauthorized))
            ),
            "401 must map to Unauthorized, got {result:?}"
        );
    }

    // ── delete_calendar ────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_calendar_204_is_success() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{TEST_CAL_ID}")))
            .and(header("authorization", "Bearer dummy-access-token"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        api.delete_calendar(&make_token(), TEST_CAL_ID)
            .await
            .expect("204 must be Ok");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_calendar_404_is_calendar_gone() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{TEST_CAL_ID}")))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api.delete_calendar(&make_token(), TEST_CAL_ID).await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::CalendarGone))),
            "404 on calendar path must map to CalendarGone, got {result:?}"
        );
    }

    // ── insert_event ───────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn insert_event_roundtrips_with_exclusive_end_shim() {
        let server = MockServer::start().await;

        // Use an atomic to capture the raw request body the server
        // saw, so we can assert the `end.date` was advanced by one day
        // on the wire.
        let captured_body: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
        let captured_body_clone = captured_body.clone();

        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .and(header("authorization", "Bearer dummy-access-token"))
            .respond_with(move |req: &Request| {
                let body: Value = serde_json::from_slice(&req.body).unwrap_or(json!({}));
                let captured = captured_body_clone.clone();
                tokio::spawn(async move {
                    *captured.lock().await = Some(body);
                });
                // Server echoes back with an exclusive end + assigned ID.
                ResponseTemplate::new(200).set_body_json(json!({
                    "id": TEST_EVENT_ID,
                    "summary": "Agaric Agenda — 2026-04-22",
                    "description": "· TODO do the thing",
                    "start": { "date": "2026-04-22" },
                    "end":   { "date": "2026-04-23" },
                    "transparency": "transparent",
                }))
            })
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let event = make_event("2026-04-22");
        let resp = api
            .insert_event(&make_token(), TEST_CAL_ID, &event)
            .await
            .expect("insert must succeed");

        assert_eq!(resp.id, TEST_EVENT_ID);
        // Response translated back to inclusive end = start.
        assert_eq!(resp.event.end.date, "2026-04-22");
        assert_eq!(resp.event.start.date, "2026-04-22");
        assert_eq!(resp.event.transparency, "transparent");

        // Give the async-spawned body capture a chance to land before
        // we check it.  If wiremock ever exposes synchronous body
        // capture we can drop this.
        for _ in 0..50 {
            if captured_body.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let body = captured_body
            .lock()
            .await
            .clone()
            .expect("server must have captured the request body");
        assert_eq!(
            body["end"]["date"].as_str(),
            Some("2026-04-23"),
            "request body's end.date must be advanced one day (exclusive-end shim), got {body}"
        );
        assert_eq!(
            body["start"]["date"].as_str(),
            Some("2026-04-22"),
            "request body's start.date is unchanged (inclusive start), got {body}"
        );
    }

    // ── patch_event ────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn patch_event_200_returns_updated_event() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_EVENT_ID,
                "summary": "new summary",
                "description": "new body",
                "start": { "date": "2026-04-22" },
                "end":   { "date": "2026-04-23" },
                "transparency": "transparent",
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let patch = EventPatch::new()
            .with_summary("new summary")
            .with_description("new body");
        let resp = api
            .patch_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID, &patch)
            .await
            .expect("patch must succeed");
        assert_eq!(resp.id, TEST_EVENT_ID);
        assert_eq!(resp.event.summary, "new summary");
        assert_eq!(resp.event.end.date, "2026-04-22"); // shim back to inclusive
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn patch_event_404_is_event_gone() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let patch = EventPatch::new().with_summary("x");
        let result = api
            .patch_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID, &patch)
            .await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::EventGone))),
            "404 on event path must map to EventGone, got {result:?}"
        );
    }

    // ── delete_event ───────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_event_204_is_success() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        api.delete_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID)
            .await
            .expect("204 must be Ok");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_event_404_is_event_gone() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api
            .delete_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID)
            .await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::EventGone))),
            "404 on event path must map to EventGone, got {result:?}"
        );
    }

    // ── get_event ──────────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_event_200_returns_some() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_EVENT_ID,
                "summary": "Agaric Agenda — 2026-04-22",
                "description": "",
                "start": { "date": "2026-04-22" },
                "end":   { "date": "2026-04-23" },
                "transparency": "transparent",
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let resp = api
            .get_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID)
            .await
            .expect("get must succeed");
        let unwrapped = resp.expect("must be Some");
        assert_eq!(unwrapped.id, TEST_EVENT_ID);
        assert_eq!(unwrapped.event.end.date, "2026-04-22");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn get_event_404_returns_none() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let resp = api
            .get_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID)
            .await
            .expect("get must succeed as Ok(None), not Err");
        assert!(
            resp.is_none(),
            "404 on event path from get_event must map to Ok(None), got {resp:?}"
        );
    }

    // ── error-code mapping matrix ──────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_400_maps_to_invalid_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        assert!(
            matches!(
                result,
                Err(AppError::Gcal(GcalErrorKind::InvalidRequest(_)))
            ),
            "400 must map to InvalidRequest, got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_403_maps_to_forbidden() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Forbidden(_)))),
            "403 must map to Forbidden, got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_409_maps_to_invalid_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(409))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        assert!(
            matches!(
                result,
                Err(AppError::Gcal(GcalErrorKind::InvalidRequest(_)))
            ),
            "409 must map to InvalidRequest (caller-fixable), got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_429_with_retry_after_parses_seconds_to_ms() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "5"))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        match result {
            Err(AppError::Gcal(GcalErrorKind::RateLimited { retry_after_ms })) => {
                assert_eq!(
                    retry_after_ms, 5_000,
                    "Retry-After: 5 must translate to 5000 ms, got {retry_after_ms}"
                );
            }
            other => panic!("expected RateLimited{{ retry_after_ms: 5000 }}, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_429_without_retry_after_uses_default() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        match result {
            Err(AppError::Gcal(GcalErrorKind::RateLimited { retry_after_ms })) => {
                assert_eq!(
                    retry_after_ms, DEFAULT_RETRY_AFTER_MS,
                    "429 without Retry-After must fall back to default 1000 ms, got {retry_after_ms}"
                );
            }
            other => panic!(
                "expected RateLimited with default retry_after_ms, got {other:?}"
            ),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_500_maps_to_server_error_500() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        match result {
            Err(AppError::Gcal(GcalErrorKind::ServerError { status })) => {
                assert_eq!(status, 500, "500 body must carry status=500");
            }
            other => panic!("expected ServerError{{status:500}}, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn status_503_maps_to_server_error_503() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/calendars"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let api = make_api(&server.uri());
        let result = api.create_dedicated_calendar(&make_token(), "x").await;
        match result {
            Err(AppError::Gcal(GcalErrorKind::ServerError { status })) => {
                assert_eq!(status, 503);
            }
            other => panic!("expected ServerError{{status:503}}, got {other:?}"),
        }
    }

    // ── date-shim helpers ──────────────────────────────────────────

    #[test]
    fn shift_date_forward_adds_one_day() {
        let out = shift_date_forward("2026-04-22", 1).unwrap();
        assert_eq!(out, "2026-04-23");
    }

    #[test]
    fn shift_date_forward_subtracts_one_day() {
        let out = shift_date_forward("2026-04-23", -1).unwrap();
        assert_eq!(out, "2026-04-22");
    }

    #[test]
    fn shift_date_forward_crosses_month_boundary() {
        let out = shift_date_forward("2026-04-30", 1).unwrap();
        assert_eq!(out, "2026-05-01");
    }

    #[test]
    fn shift_date_forward_rejects_malformed_date() {
        let result = shift_date_forward("not-a-date", 1);
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("gcal.api.malformed_date")),
            "malformed date must surface Validation with namespaced key, got {result:?}"
        );
    }

    // ── rate-limiter ───────────────────────────────────────────────

    /// 30 requests at full throttle should stall at least once the
    /// 25-burst ceiling is hit.  Assert the total elapsed time is at
    /// least `(30 - 25)` * `(1000 / RATE_LIMIT_QPS)` ms — each
    /// post-burst admission is gated by the sustained-QPS gap added
    /// in `take()`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rate_limiter_throttles_beyond_burst() {
        let bucket = Arc::new(Mutex::new(InstantBucket::new(
            RATE_LIMIT_BURST,
            Duration::from_secs(1),
            RATE_LIMIT_QPS,
        )));
        let start = Instant::now();

        // Fire 30 takes in serial — we cannot race them in parallel
        // because the mutex serialises anyway.
        let n: usize = 30;
        let counter = Arc::new(AtomicUsize::new(0));
        for _ in 0..n {
            bucket.lock().await.take().await;
            counter.fetch_add(1, Ordering::SeqCst);
        }
        let elapsed = start.elapsed();

        // 30 - 25 = 5 post-burst admissions, each gated by at least
        // the sustained-QPS gap (100 ms at 10 QPS).  Lower-bound the
        // assertion to give CI schedulers some slack — if the
        // throttle broke, we would see <100 ms total.
        let expected_min_ms: u128 =
            ((n - RATE_LIMIT_BURST) as u128) * (1_000 / RATE_LIMIT_QPS as u128);
        assert!(
            elapsed.as_millis() >= expected_min_ms,
            "30 takes must stall for at least ({n} - {RATE_LIMIT_BURST}) * \
             (1000 / {RATE_LIMIT_QPS}) = {expected_min_ms}ms after the burst ceiling, \
             got {}ms",
            elapsed.as_millis()
        );
        assert_eq!(
            counter.load(Ordering::SeqCst),
            n,
            "all {n} takes must eventually complete"
        );
    }

    /// Burst admissions under the ceiling should be immediate —
    /// pins the lower bound so a future refactor that adds a
    /// sleep-on-every-admission bug will trip this test.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rate_limiter_allows_full_burst_immediately() {
        let bucket = Arc::new(Mutex::new(InstantBucket::new(
            RATE_LIMIT_BURST,
            Duration::from_secs(1),
            RATE_LIMIT_QPS,
        )));
        let start = Instant::now();
        for _ in 0..RATE_LIMIT_BURST {
            bucket.lock().await.take().await;
        }
        let elapsed = start.elapsed();
        // Allow generous headroom for CI — 250 ms covers a cold async
        // runtime and any scheduler hiccup, but would catch a regression
        // that introduced a per-admission sleep.
        assert!(
            elapsed.as_millis() < 250,
            "{RATE_LIMIT_BURST} admissions inside the burst must be near-instant, got {}ms",
            elapsed.as_millis()
        );
    }

    // ── Debug redaction ────────────────────────────────────────────

    #[test]
    fn gcal_api_debug_does_not_leak_client_internals() {
        let api = GcalApi::with_base_url("http://example.invalid".to_owned()).unwrap();
        let debug = format!("{api:?}");
        // The base URL is fine (not a secret); we just pin that
        // sensitive-looking internals do not bleed in by accident.
        assert!(
            debug.contains("http://example.invalid"),
            "Debug should at least carry base_url, got: {debug}"
        );
        assert!(
            !debug.to_lowercase().contains("bearer"),
            "Debug must not leak any bearer-looking strings, got: {debug}"
        );
    }

    // ── WireEventPatch field-omission ──────────────────────────────

    #[test]
    fn wire_event_patch_omits_none_fields_on_serialize() {
        let patch = WireEventPatch::from_patch(&EventPatch::new().with_summary("only summary"));
        let json = serde_json::to_value(&patch).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(
            obj.len(),
            1,
            "unset Option fields must be skipped via #[serde(skip_serializing_if)], \
             got {} keys: {obj:?}",
            obj.len()
        );
        assert_eq!(obj.get("summary").and_then(Value::as_str), Some("only summary"));
    }

    #[test]
    fn wire_event_patch_end_date_shifts_forward_one_day() {
        let patch = WireEventPatch::from_patch(
            &EventPatch::new().with_end(NaiveDate::from_ymd_opt(2026, 4, 30).unwrap()),
        );
        let json = serde_json::to_value(&patch).unwrap();
        assert_eq!(
            json["end"]["date"].as_str(),
            Some("2026-05-01"),
            "patch end.date must carry the exclusive-end shim across month boundaries"
        );
    }
}
