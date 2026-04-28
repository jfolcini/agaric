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

/// Per-request timeout for the shared `reqwest::Client`.  Covers the
/// total request lifetime — connect + TLS handshake + read.  Keep in
/// the same neighbourhood as Google's own client-library default; a
/// timeout that is too short turns a slow-but-healthy upstream into a
/// transient transport error and triggers retry storms, while one
/// that is too long lets a hung connection block the connector's
/// per-cycle deadline.
const HTTP_CLIENT_TIMEOUT: Duration = Duration::from_secs(30);

impl GcalApi {
    /// Construct a production `GcalApi` pointing at the real Google
    /// Calendar endpoint.
    ///
    /// # Errors
    /// [`AppError::Validation`] if the shared HTTP client fails to
    /// build (would indicate a malformed rustls setup — not expected
    /// in practice).
    pub fn new() -> Result<Self, AppError> {
        Self::with_base_url(GOOGLE_CALENDAR_BASE_URL)
    }

    /// Construct a `GcalApi` pointing at an arbitrary base URL.
    /// Used by the `wiremock`-backed tests in this module.  The
    /// `base_url` must NOT include a trailing slash.
    ///
    /// # Errors
    /// [`AppError::Validation`] if the shared HTTP client fails to
    /// build.
    pub fn with_base_url(base_url: &str) -> Result<Self, AppError> {
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

        let url = format!("{}/calendars", self.base_url);
        let body: CreateCalendarResp = self
            .send_json(
                reqwest::Method::POST,
                &url,
                token,
                Some(&CreateCalendarReq { summary: name }),
                NotFoundMeans::CalendarGone,
            )
            .await?;
        Ok(body.id)
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
    pub async fn delete_calendar(&self, token: &Token, calendar_id: &str) -> Result<(), AppError> {
        let url = join_calendar_path(&self.base_url, calendar_id, &[])?;
        self.send_empty(
            reqwest::Method::DELETE,
            &url,
            token,
            NotFoundMeans::CalendarGone,
        )
        .await
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
        let url = join_calendar_path(&self.base_url, calendar_id, &["events"])?;
        let wire_event = WireEvent::from_digest_event(event)?;
        // 404 on /calendars/{id}/events targets the calendar, not a
        // specific event — map to CalendarGone.
        let body: WireEventResponse = self
            .send_json(
                reqwest::Method::POST,
                &url,
                token,
                Some(&wire_event),
                NotFoundMeans::CalendarGone,
            )
            .await?;
        body.into_event_response()
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
        let url = join_calendar_path(&self.base_url, calendar_id, &["events", event_id])?;
        let wire_patch = WireEventPatch::from_patch(patch);
        let body: WireEventResponse = self
            .send_json(
                reqwest::Method::PATCH,
                &url,
                token,
                Some(&wire_patch),
                NotFoundMeans::EventGone,
            )
            .await?;
        body.into_event_response()
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
        let url = join_calendar_path(&self.base_url, calendar_id, &["events", event_id])?;
        self.send_empty(
            reqwest::Method::DELETE,
            &url,
            token,
            NotFoundMeans::EventGone,
        )
        .await
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
        let url = join_calendar_path(&self.base_url, calendar_id, &["events", event_id])?;
        // 404 on event path → treat as "gone"; map to Ok(None) so the
        // reconcile sweep can simply re-insert.
        let body: WireEventResponse = match self
            .send_json::<(), _>(
                reqwest::Method::GET,
                &url,
                token,
                None,
                NotFoundMeans::EventGone,
            )
            .await
        {
            Ok(b) => b,
            Err(AppError::Gcal(GcalErrorKind::EventGone)) => return Ok(None),
            Err(e) => return Err(e),
        };
        body.into_event_response().map(Some)
    }

    // ---------------------------------------------------------------
    // Private HTTP helpers — shared skeleton for every public method:
    // bucket-take → bearer auth → optional JSON body → send → translate
    // via `reqwest_to_gcal_err` / `classify_error`.  `not_found_means`
    // is the same enum passed to `classify_error` (event vs calendar
    // path) so a 404 maps to the correct [`GcalErrorKind`] variant.
    // ---------------------------------------------------------------

    /// Issue a request that expects a JSON body in the response and
    /// optionally serialises a JSON body in the request.
    async fn send_json<B, T>(
        &self,
        method: reqwest::Method,
        url: &str,
        token: &Token,
        body: Option<&B>,
        not_found_means: NotFoundMeans,
    ) -> Result<T, AppError>
    where
        B: Serialize + ?Sized,
        T: serde::de::DeserializeOwned,
    {
        InstantBucket::take(&self.bucket).await;

        let mut req = self
            .client
            .request(method, url)
            .bearer_auth(token.access.expose_secret());
        if let Some(b) = body {
            req = req.json(b);
        }
        let resp = req.send().await.map_err(|e| reqwest_to_gcal_err(&e))?;

        let status = resp.status();
        if status.is_success() {
            return resp.json::<T>().await.map_err(|e| reqwest_to_gcal_err(&e));
        }
        Err(classify_error(status, &resp_headers(&resp), not_found_means).into())
    }

    /// Issue a request that does not send or expect a JSON body — the
    /// success path is just "HTTP 2xx, drop the body".  Used by the
    /// two `delete_*` paths.
    async fn send_empty(
        &self,
        method: reqwest::Method,
        url: &str,
        token: &Token,
        not_found_means: NotFoundMeans,
    ) -> Result<(), AppError> {
        InstantBucket::take(&self.bucket).await;

        let resp = self
            .client
            .request(method, url)
            .bearer_auth(token.access.expose_secret())
            .send()
            .await
            .map_err(|e| reqwest_to_gcal_err(&e))?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        Err(classify_error(status, &resp_headers(&resp), not_found_means).into())
    }
}

/// Build a `/calendars/{calendar_id}[/...suffix]` URL by joining
/// percent-encoded path segments onto `base_url`.
///
/// Uses [`url::Url::path_segments_mut`], which percent-encodes each
/// pushed segment using the path-segment encode set.  `/`, `?`, `#`,
/// and other reserved characters inside `calendar_id` / suffix
/// components are escaped (e.g. `/` → `%2F`); ordinary ASCII calendar
/// IDs (like `<id>@group.calendar.google.com`) round-trip unchanged.
///
/// We pull `url` (already a direct dep via `deeplink`) instead of
/// `format!`-splicing raw IDs, which would let an `event_id`
/// containing `/` craft a path like
/// `/calendars/{cal}/events/foo/bar` — wrong target on the server.
fn join_calendar_path(
    base_url: &str,
    calendar_id: &str,
    suffix: &[&str],
) -> Result<String, AppError> {
    let mut url = url::Url::parse(base_url)
        .map_err(|e| AppError::Validation(format!("gcal.api.invalid_base_url: {e}")))?;
    {
        let mut segs = url
            .path_segments_mut()
            .map_err(|()| AppError::Validation("gcal.api.base_url_cannot_be_base".into()))?;
        segs.push("calendars").push(calendar_id);
        for s in suffix {
            segs.push(s);
        }
    }
    Ok(url.into())
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
        date.checked_add_days(Days::new(delta_days.cast_unsigned()))
    } else {
        // Safe conversion: delta_days is negative, so negating gives
        // a positive value that fits in u64.
        date.checked_sub_days(Days::new((-delta_days).cast_unsigned()))
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

/// What an HTTP 404 means at the call site that issued the request.
/// Replaces the previous `on_event: bool` flag — a typed enum makes
/// the call sites self-documenting (no need for the
/// `/*on_event*/ true` comment-as-name workaround) and removes the
/// "which way is true?" reading-time penalty.  MAINT-151(a).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NotFoundMeans {
    /// Path is `/calendars/{id}` or `/calendars/{id}/events` — a 404
    /// here means the dedicated calendar was deleted externally.
    /// Maps to [`GcalErrorKind::CalendarGone`].
    CalendarGone,
    /// Path is `/calendars/{id}/events/{event_id}` — a 404 here means
    /// the event row was deleted in the GCal UI.  Maps to
    /// [`GcalErrorKind::EventGone`].
    EventGone,
}

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
/// `not_found_means`: how a 404 response should be classified for the
/// call site that issued the request — see [`NotFoundMeans`].
fn classify_error(
    status: reqwest::StatusCode,
    headers: &[(String, String)],
    not_found_means: NotFoundMeans,
) -> GcalErrorKind {
    let code = status.as_u16();
    match code {
        400 => GcalErrorKind::InvalidRequest(format!("HTTP {code}")),
        401 => GcalErrorKind::Unauthorized,
        403 => GcalErrorKind::Forbidden(format!("HTTP {code}")),
        404 => match not_found_means {
            NotFoundMeans::EventGone => GcalErrorKind::EventGone,
            NotFoundMeans::CalendarGone => GcalErrorKind::CalendarGone,
        },
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
/// [`GcalErrorKind::Transport`] — callers treat that as a transient
/// failure and retry with back-off (MAINT-151(b)).
///
/// JSON-parse failures in the response body are distinctive enough to
/// return [`AppError::Json`] via the existing `#[from]` impl, so
/// callers can distinguish them from HTTP-layer errors if desired.
fn reqwest_to_gcal_err(err: &reqwest::Error) -> AppError {
    if err.is_decode() {
        AppError::Validation(format!("gcal.api.decode_failed: {err}"))
    } else {
        // Connect / timeout / protocol error — transient, same retry
        // class as a 5xx but distinct in the taxonomy so logs and the
        // CycleOutcome display do not print a misleading "HTTP 0".
        AppError::Gcal(GcalErrorKind::Transport(err.to_string()))
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
        .timeout(HTTP_CLIENT_TIMEOUT)
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
    /// instant in the bucket.
    ///
    /// Takes the bucket's `Mutex` by reference rather than `&mut self`
    /// so that the lock can be released across the internal sleep.
    /// Each iteration: acquire the guard, evict expired entries and
    /// either admit (push the new timestamp and return) or compute
    /// how long to wait, drop the guard explicitly, then sleep.
    /// Concurrent callers can therefore overlap whenever the bucket
    /// is not saturated — the rate-limit semantics still hit ~10 QPS
    /// because every admission contends for the same shared state,
    /// but we no longer serialise callers behind one another's sleeps.
    async fn take(bucket: &Mutex<Self>) {
        loop {
            let mut guard = bucket.lock().await;
            let now = Instant::now();
            // Drop expired entries from the front.
            while let Some(oldest) = guard.recent.front() {
                if now.duration_since(*oldest) >= guard.window {
                    guard.recent.pop_front();
                } else {
                    break;
                }
            }

            if guard.recent.len() < guard.burst {
                // Under the burst ceiling — admit immediately.
                guard.recent.push_back(now);
                return;
            }

            // Burst ceiling hit — compute how long until the oldest
            // entry expires.  Sleep for at least that long, plus the
            // sustained-QPS inter-request gap, so we do not immediately
            // overshoot.
            let sleep_for = guard.recent.front().map_or(guard.window, |&oldest| {
                let elapsed = now.saturating_duration_since(oldest);
                let remaining = guard.window.saturating_sub(elapsed);
                // Add the sustained gap so successive admissions are
                // spaced, not clustered.
                let gap = if guard.sustained_qps == 0 {
                    Duration::ZERO
                } else {
                    Duration::from_millis(1000 / guard.sustained_qps as u64)
                };
                remaining + gap
            });

            // Release the lock before sleeping so concurrent callers
            // can enter the bucket while we wait.  Re-check on the
            // next loop iteration after re-acquiring the guard.
            drop(guard);
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
        GcalApi::with_base_url(base).expect("api construction must succeed")
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
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
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
            other => panic!("expected RateLimited with default retry_after_ms, got {other:?}"),
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
            InstantBucket::take(&bucket).await;
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
            InstantBucket::take(&bucket).await;
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

    /// Regression for L-125: when the bucket is saturated and a caller
    /// is sleeping inside `take()`, the bucket's mutex MUST be released
    /// across the sleep so a concurrent caller can enter the bucket
    /// rather than queueing on the lock.  Under the pre-fix
    /// implementation the outer `.lock().await` guard was held for the
    /// entire `take()` call (including the sleep), so `try_lock()`
    /// from another task would always fail.  Under the fixed impl the
    /// guard is dropped before sleeping and `try_lock()` succeeds.
    ///
    /// Runs in real time (not `start_paused`) because `InstantBucket`
    /// stores `std::time::Instant` rather than `tokio::time::Instant`,
    /// so paused-time auto-advance and the bucket's expiry check
    /// disagree and produce a busy loop.  A short window keeps the
    /// total wall-clock cost modest.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn instant_bucket_releases_lock_during_sleep() {
        // burst = 1 + a short window so the spawned take must sleep
        // briefly but the test still finishes promptly.
        let bucket = Arc::new(Mutex::new(InstantBucket::new(
            1,
            Duration::from_millis(200),
            10,
        )));

        // Saturate the bucket so any further `take` will sleep.
        InstantBucket::take(&bucket).await;

        // Spawn a take that will be forced to sleep.
        let bucket_for_task = Arc::clone(&bucket);
        let handle = tokio::spawn(async move {
            InstantBucket::take(&bucket_for_task).await;
        });

        // Yield repeatedly so the spawned task is polled past its
        // `bucket.lock().await` and parks on `tokio::time::sleep`.
        for _ in 0..16 {
            tokio::task::yield_now().await;
        }

        // The fix: lock must be released across the sleep.  With the
        // pre-fix impl this `try_lock` would fail because the spawned
        // task would still be holding the guard while it awaits sleep.
        match bucket.try_lock() {
            Ok(guard) => drop(guard),
            Err(e) => panic!(
                "InstantBucket::take must drop its guard before sleeping (L-125), \
                 try_lock returned: {e:?}"
            ),
        }

        // Let the spawned take wake up, re-acquire the guard, and
        // record its admission so the test exits cleanly.
        handle.await.expect("spawned take must complete");
    }

    // ── Debug redaction ────────────────────────────────────────────

    #[test]
    fn gcal_api_debug_does_not_leak_client_internals() {
        let api = GcalApi::with_base_url("http://example.invalid").unwrap();
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
        assert_eq!(
            obj.get("summary").and_then(Value::as_str),
            Some("only summary")
        );
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

    // ── URL-encoding (L-131) ───────────────────────────────────────

    /// Special characters in calendar/event IDs must be percent-encoded
    /// in the path so they cannot escape their segment.  This is the
    /// minimum signal that `join_calendar_path` does the right thing
    /// before we exercise it through wiremock.
    #[test]
    fn join_calendar_path_percent_encodes_slash_in_calendar_id() {
        let url = join_calendar_path("https://example.invalid", "cal/with/slash", &[])
            .expect("must build url");
        assert_eq!(url, "https://example.invalid/calendars/cal%2Fwith%2Fslash");
    }

    #[test]
    fn join_calendar_path_percent_encodes_event_id_suffix() {
        let url = join_calendar_path(
            "https://example.invalid",
            "cal_ABC",
            &["events", "evt/with?special#chars"],
        )
        .expect("must build url");
        // `/`, `?`, `#` are all reserved and must be escaped inside a
        // single path segment.
        assert_eq!(
            url,
            "https://example.invalid/calendars/cal_ABC/events/evt%2Fwith%3Fspecial%23chars"
        );
    }

    /// Real Google calendar IDs look like
    /// `<opaque>@group.calendar.google.com` — those characters are
    /// safe in a path segment and must NOT be encoded.  Regression
    /// check that the cleanup did not break ordinary IDs.
    #[test]
    fn join_calendar_path_passes_through_google_shaped_calendar_id() {
        let google_id = "abc123def@group.calendar.google.com";
        let url = join_calendar_path("https://example.invalid", google_id, &["events"])
            .expect("must build url");
        assert_eq!(
            url,
            format!("https://example.invalid/calendars/{google_id}/events")
        );
    }

    /// The production base URL is `https://www.googleapis.com/calendar/v3`
    /// — i.e. it carries a path prefix.  `path_segments_mut().push(...)`
    /// must EXTEND that prefix, not replace it.  Regression guard for
    /// the most realistic call shape this helper sees in practice.
    #[test]
    fn join_calendar_path_extends_existing_base_path() {
        let url = join_calendar_path(GOOGLE_CALENDAR_BASE_URL, "cal_ABC", &["events", "evt_123"])
            .expect("must build url");
        assert_eq!(
            url,
            "https://www.googleapis.com/calendar/v3/calendars/cal_ABC/events/evt_123"
        );
    }

    /// `Url::path_segments_mut()` returns `Err(())` for cannot-be-a-base
    /// URLs (e.g. `mailto:`).  The helper must surface this as a
    /// `Validation` error rather than panicking.
    #[test]
    fn join_calendar_path_rejects_cannot_be_a_base_url() {
        let err = join_calendar_path("mailto:foo@example.invalid", "cal", &[])
            .expect_err("mailto: is cannot-be-a-base; helper must reject");
        match err {
            AppError::Validation(msg) => {
                assert!(
                    msg.contains("base_url_cannot_be_base"),
                    "unexpected validation message: {msg}"
                );
            }
            other => panic!("expected AppError::Validation, got {other:?}"),
        }
    }

    /// End-to-end: a `delete_calendar` call with a calendar_id
    /// containing `/` reaches the server with `%2F`, not a literal
    /// slash that would target a different resource.  Wiremock's
    /// `path` matcher compares against the percent-encoded request
    /// URL, so we assert against the encoded form.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_calendar_percent_encodes_calendar_id_with_slash() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/calendars/evil%2Fpath"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        api.delete_calendar(&make_token(), "evil/path")
            .await
            .expect("delete_calendar with slash in id must reach the encoded path");
    }

    /// Sanity: a Google-shaped calendar id still hits the existing
    /// `/calendars/{id}` mock untouched after switching to
    /// `join_calendar_path`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn delete_calendar_works_with_google_shaped_id() {
        let google_id = "abc123def@group.calendar.google.com";
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{google_id}")))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        api.delete_calendar(&make_token(), google_id)
            .await
            .expect("delete_calendar must succeed for a Google-shaped id");
    }
}
