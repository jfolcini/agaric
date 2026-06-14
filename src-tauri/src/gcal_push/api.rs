//! FEAT-5c — stateless Google Calendar API v3 client for the Agaric
//! daily-agenda digest push connector.
//!
//! # Scope
//!
//! * Create / delete the dedicated "Agaric Agenda" calendar (one per
//!   account; ID persisted in `gcal_settings.calendar_id` by
//!   FEAT-5e).
//! * Insert / patch / delete an all-day digest event on the
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
//! * **Token refresh.** The connector wraps each cycle in
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
//! as a classic token bucket (capacity = burst, refill = sustained
//! QPS) — ~40 lines, no new deps.  See FEAT-5 parent rejected-deps
//! list for why `governor` / `leaky-bucket` were ruled out.
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

use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use chrono::{Days, NaiveDate};
use secrecy::{ExposeSecret, SecretString};
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

/// One entry from the Google `calendarList` collection — just the two
/// fields the calendar-adoption reconcile needs (#859): the opaque
/// [`CalendarId`] and the human `summary` we match against
/// [`DEDICATED_CALENDAR_NAME`].
///
/// #859 — used by the connector's first-connect flow to look up an
/// already-created "Agaric Agenda" calendar before issuing a fresh
/// `create_dedicated_calendar`.  A crash between a successful
/// `create_dedicated_calendar` and the local `set_setting` that
/// persists `calendar_id` leaves an orphan empty calendar; listing
/// first and ADOPTING it makes the ensure-calendar path idempotent —
/// the orphan is reused, not duplicated.
///
/// [`DEDICATED_CALENDAR_NAME`]: crate::gcal_push::connector::DEDICATED_CALENDAR_NAME
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CalendarListEntry {
    /// GCal-assigned opaque calendar ID.
    pub id: CalendarId,
    /// Human-readable calendar title (the `summary` field).
    pub summary: String,
}

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
    /// Google's OAuth 2.0 token-revocation endpoint
    /// (`https://oauth2.googleapis.com/revoke` in production).  Held as
    /// its own field — and not derived from `base_url` — because the
    /// revoke endpoint lives on a different host (`oauth2.googleapis.com`)
    /// than the Calendar API (`www.googleapis.com/calendar/v3`).
    /// `with_base_url` points it at `{base}/revoke` so the wiremock tests
    /// can mount a `/revoke` matcher on the same mock server.
    revoke_url: String,
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

/// Google's OAuth 2.0 token-revocation endpoint (RFC 7009).  POSTing a
/// `token=<refresh-or-access-token>` form body here invalidates the
/// token (and, for a refresh token, the whole grant) server-side.  Used
/// by [`GcalApi::revoke_token`] on disconnect so the broad
/// `.../auth/calendar` grant does not stay valid on Google's side after
/// the user disconnects (#690).
pub const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

/// Per-request timeout for the best-effort revoke call.  Deliberately
/// shorter than [`HTTP_CLIENT_TIMEOUT`]: revoke is best-effort and runs
/// inline on the disconnect path, so a hung revoke must not stall the
/// local cleanup the user is waiting on.  A revoke that does not
/// complete within this budget is logged and abandoned — Google will
/// expire the grant on its own schedule.
const REVOKE_TIMEOUT: Duration = Duration::from_secs(10);

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
        let mut api = Self::with_base_url(GOOGLE_CALENDAR_BASE_URL)?;
        // The Calendar API and the OAuth revoke endpoint live on
        // different hosts, so the production revoke URL is the canonical
        // Google endpoint rather than `{base}/revoke`.
        api.revoke_url = GOOGLE_REVOKE_URL.to_owned();
        Ok(api)
    }

    /// Construct a `GcalApi` pointing at an arbitrary base URL.
    /// Used by the `wiremock`-backed tests in this module.  The
    /// `base_url` must NOT include a trailing slash.
    ///
    /// # Errors
    /// [`AppError::Validation`] if the shared HTTP client fails to
    /// build.
    pub fn with_base_url(base_url: &str) -> Result<Self, AppError> {
        let base_url = base_url.trim_end_matches('/').to_owned();
        // Tests point this at a wiremock server; deriving `{base}/revoke`
        // lets the same mock server serve a `/revoke` matcher.  The
        // production `new()` overrides this with the canonical Google
        // revoke endpoint, which lives on a different host.
        let revoke_url = format!("{base_url}/revoke");
        Ok(Self {
            client: shared_client()?,
            bucket: Arc::new(Mutex::new(InstantBucket::new(
                RATE_LIMIT_BURST,
                RATE_LIMIT_QPS,
            ))),
            base_url,
            revoke_url,
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

    /// List the calendars on the connected account's calendar list
    /// (`GET /users/me/calendarList`).
    ///
    /// #859 — used by the connector's first-connect flow as a
    /// lookup-before-create reconcile, mirroring the #631 events fix.
    /// `create_dedicated_calendar` → `set_setting(CalendarId, …)` is
    /// non-atomic across the network boundary: a crash between the two
    /// leaves an untracked "Agaric Agenda" calendar, and the next boot
    /// would see an empty `calendar_id` and create a SECOND empty
    /// calendar — the orphan would never be reused or cleaned up.
    /// Instead the connector lists first and ADOPTS a calendar whose
    /// `summary` matches [`DEDICATED_CALENDAR_NAME`].
    ///
    /// Only `id` + `summary` are decoded; every other `calendarList`
    /// field (access role, colours, notification settings) is ignored.
    /// A page token is deliberately NOT followed: the dedicated calendar
    /// is created by Agaric and lives near the top of a freshly-connected
    /// account's (typically tiny) list; the single page Google returns by
    /// default is ample for finding it, and unbounded pagination here
    /// would burn the first-connect cycle's lease budget. `summary` is
    /// `#[serde(default)]`-tolerant so a calendar lacking the field
    /// (never the dedicated one) decodes as `""` and simply never matches.
    ///
    /// [`DEDICATED_CALENDAR_NAME`]: crate::gcal_push::connector::DEDICATED_CALENDAR_NAME
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant — callers map per FEAT-5e's retry
    /// taxonomy.  A 404 on this collection path is unexpected (the
    /// `calendarList` endpoint always exists for an authenticated user);
    /// we classify it as [`GcalErrorKind::CalendarGone`] for symmetry
    /// with the other calendar-scoped calls.
    #[tracing::instrument(skip(self, token), err)]
    pub async fn list_calendars(&self, token: &Token) -> Result<Vec<CalendarListEntry>, AppError> {
        #[derive(Deserialize)]
        struct CalendarListResp {
            #[serde(default)]
            items: Vec<CalendarListItem>,
        }

        #[derive(Deserialize)]
        struct CalendarListItem {
            id: String,
            #[serde(default)]
            summary: String,
        }

        let url = format!("{}/users/me/calendarList", self.base_url);
        let body: CalendarListResp = self
            .send_json(
                reqwest::Method::GET,
                &url,
                token,
                None::<&()>,
                NotFoundMeans::CalendarGone,
            )
            .await?;
        Ok(body
            .items
            .into_iter()
            .map(|item| CalendarListEntry {
                id: item.id,
                summary: item.summary,
            })
            .collect())
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

    /// Best-effort revoke of the connected account's OAuth grant via
    /// Google's RFC 7009 revocation endpoint (#690).
    ///
    /// Posts `token=<refresh-token>` to [`GOOGLE_REVOKE_URL`].  Revoking
    /// the **refresh** token invalidates the entire grant (the paired
    /// access tokens included), so a single call tears down the
    /// server-side `.../auth/calendar` authorization that
    /// `disconnect_gcal` would otherwise leave valid in any keyring
    /// backup.
    ///
    /// This is **best-effort**: the caller invokes it before clearing
    /// local state and treats any error as non-fatal.  A `Result` is
    /// returned only so the caller can log *why* a revoke failed; an
    /// `Err` here MUST NOT abort the disconnect.  Network failures, an
    /// already-revoked token (Google answers 400 `invalid_token`), and
    /// timeouts all surface as `Err` and are expected in normal
    /// operation.
    ///
    /// Unlike the Calendar API calls this does not pass through the
    /// shared rate-limiter or the `classify_error` taxonomy: it targets
    /// a different host, the only caller discards the error, and we set
    /// a short [`REVOKE_TIMEOUT`] so a hung endpoint cannot stall the
    /// disconnect the user is waiting on.
    ///
    /// # Errors
    /// [`AppError::Validation`] keyed `gcal.revoke_failed` on a
    /// transport error or a non-2xx response from Google.
    #[tracing::instrument(skip(self, refresh_token), err)]
    pub async fn revoke_token(&self, refresh_token: &SecretString) -> Result<(), AppError> {
        // RFC 7009 §2.1 — the revocation request is a
        // `application/x-www-form-urlencoded` POST carrying `token=…`.
        // We build the body via `form_urlencoded` (the `url` crate is
        // already a direct dep) and set the header explicitly rather
        // than relying on reqwest's optional `urlencoded`/form feature,
        // which this build does not enable.
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("token", refresh_token.expose_secret())
            .finish();
        let resp = self
            .client
            .post(&self.revoke_url)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .body(body)
            .timeout(REVOKE_TIMEOUT)
            .send()
            .await
            .map_err(|e| {
                // L-129 discipline: never interpolate a server-controlled
                // error body; the reqwest Display here is the transport
                // error (status/url-kind), which carries no token bytes.
                AppError::Validation(format!("gcal.revoke_failed: transport error: {e}"))
            })?;

        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        // Do NOT read the response body — Google echoes the supplied
        // token-class hints in some error responses and the body is not
        // needed to decide best-effort success/failure.
        Err(AppError::Validation(format!(
            "gcal.revoke_failed: http {}",
            status.as_u16()
        )))
    }

    /// Insert a new event into the dedicated calendar.  Returns the
    /// assigned [`EventId`] inside an [`EventResponse`].
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant.  404 here is
    /// [`GcalErrorKind::CalendarGone`] — the dedicated calendar was
    /// deleted externally and the connector must recover.
    // #632: `event` must be in `skip(...)` — `Event` derives `Debug`
    // and its `description` carries the rendered agenda digest (the
    // user's note text + page titles). Recording it as a span field
    // would flow note content into agaric.log whenever gcal spans are
    // enabled — the same channel L-129/L-130 scrubbed token bytes from.
    #[tracing::instrument(skip(self, token, event), err)]
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
    // #632: `patch` must be in `skip(...)` for the same reason as
    // `insert_event`'s `event` — `EventPatch::description` is the
    // rendered digest (user note content) and must not become a
    // recorded span field.
    #[tracing::instrument(skip(self, token, patch), err)]
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

    /// List the events on the dedicated calendar that overlap the given
    /// local date (`[date T00:00:00Z, date+1 T00:00:00Z)`).
    ///
    /// #631 — used by the connector's lookup-before-insert
    /// reconciliation: a crash between a successful `insert_event` and
    /// the local `upsert_event_map` leaves an untracked remote event;
    /// blindly re-inserting on the next cycle would duplicate it.  The
    /// connector lists first and adopts a matching orphan instead.
    ///
    /// The UTC day-window is intentionally generous for an all-day
    /// event (GCal interprets `timeMin`/`timeMax` against the event's
    /// calendar-local span), so callers MUST re-filter the returned
    /// events by `event.start.date` — neighbours from adjacent days can
    /// appear at timezone boundaries.
    ///
    /// # Errors
    /// Any [`GcalErrorKind`] variant.  404 here targets the calendar
    /// collection path → [`GcalErrorKind::CalendarGone`].
    #[tracing::instrument(skip(self, token), err)]
    pub async fn list_events_for_day(
        &self,
        token: &Token,
        calendar_id: &str,
        date: NaiveDate,
    ) -> Result<Vec<EventResponse>, AppError> {
        let base = join_calendar_path(&self.base_url, calendar_id, &["events"])?;
        let next = date.checked_add_days(Days::new(1)).ok_or_else(|| {
            AppError::Validation(format!("gcal.api.date_arithmetic_overflow: {date} + 1"))
        })?;
        let mut url = url::Url::parse(&base)
            .map_err(|e| AppError::Validation(format!("gcal.api.invalid_base_url: {e}")))?;
        url.query_pairs_mut()
            .append_pair("timeMin", &format!("{}T00:00:00Z", date.format("%Y-%m-%d")))
            .append_pair("timeMax", &format!("{}T00:00:00Z", next.format("%Y-%m-%d")))
            .append_pair("singleEvents", "true")
            // The dedicated calendar holds at most one digest event per
            // date; 50 gives ample headroom for pathological duplicate
            // pile-ups while keeping the response bounded.
            .append_pair("maxResults", "50");
        let body: WireEventListResponse = self
            .send_json(
                reqwest::Method::GET,
                url.as_str(),
                token,
                None::<&()>,
                NotFoundMeans::CalendarGone,
            )
            .await?;
        // Drop non-all-day items (timed/recurring events a user may have
        // added to the dedicated calendar); only all-day events can be
        // adoption candidates.  `filter_map` over `Result<Option<_>>`:
        // keep the `Ok(Some)`s, skip the `Ok(None)`s, surface the first
        // `Err` (a malformed all-day date) for the caller to classify.
        body.items
            .into_iter()
            .filter_map(|item| item.into_all_day_event_response().transpose())
            .collect()
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
///
/// #687 — tolerant decode: `start`/`end` accept either the all-day
/// `{"date": "YYYY-MM-DD"}` shape we push or the timed
/// `{"dateTime": "..."}` shape a user-converted event echoes back.
/// A 2xx body that still cannot yield dates maps to
/// [`GcalErrorKind::InvalidRequest`] (per-date skip) instead of a
/// cycle-aborting `AppError::Validation` — see
/// [`WireEventTime::into_all_day_date`].
#[derive(Debug, Deserialize)]
struct WireEventResponse {
    id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    start: WireEventTime,
    #[serde(default)]
    end: WireEventTime,
    #[serde(default)]
    transparency: String,
}

/// Tolerant `start`/`end` shape for event-response bodies (#687).
/// GCal returns `{date}` for all-day events and `{dateTime}` for timed
/// events; a digest event the user converted to timed in the GCal UI
/// echoes back as `dateTime` and must not wedge the connector.
#[derive(Debug, Default, Deserialize)]
struct WireEventTime {
    #[serde(default)]
    date: Option<String>,
    #[serde(default, rename = "dateTime")]
    date_time: Option<String>,
}

impl WireEventTime {
    /// Reduce to a `YYYY-MM-DD` date string: prefer the all-day `date`
    /// field; fall back to the calendar-date prefix of `dateTime`.
    /// `field` names the slot ("start" / "end") for the error message.
    fn into_date(self, field: &str) -> Result<(String, WireTimeKind), AppError> {
        if let Some(date) = self.date {
            return Ok((date, WireTimeKind::AllDay));
        }
        if let Some(dt) = self.date_time {
            // RFC 3339 begins with the calendar date — validate the
            // prefix so garbage cannot masquerade as a date.
            let prefix: String = dt.chars().take(10).collect();
            if NaiveDate::parse_from_str(&prefix, "%Y-%m-%d").is_ok() {
                return Ok((prefix, WireTimeKind::Timed));
            }
        }
        Err(nonconforming_response_err(&format!(
            "event response carries no usable {field} date"
        )))
    }
}

/// Whether a [`WireEventTime`] decoded from the all-day `date` field
/// or from a timed `dateTime`.  The exclusive-end −1-day shim only
/// applies to the all-day shape — a timed event's end is on the same
/// calendar day it names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireTimeKind {
    AllDay,
    Timed,
}

/// #687 — a syntactically-2xx-but-semantically-broken event echo is a
/// remote-data problem scoped to one date, not a connector bug: map it
/// to [`GcalErrorKind::InvalidRequest`] so [`classify_date_err`] in
/// the connector files it under `DateFailure::Skipped` (retry next
/// sweep) instead of `DateFailure::Other` (cycle abort + permanently
/// re-wedged dirty set).
///
/// [`classify_date_err`]: crate::gcal_push::connector
fn nonconforming_response_err(detail: &str) -> AppError {
    AppError::Gcal(GcalErrorKind::InvalidRequest(format!(
        "gcal.api.nonconforming_event_response: {detail}"
    )))
}

impl WireEventResponse {
    fn into_event_response(self) -> Result<EventResponse, AppError> {
        let (start_date, _) = self.start.into_date("start")?;
        let (end_date, end_kind) = self.end.into_date("end")?;
        let inclusive_end = match end_kind {
            // All-day events store the exclusive convention
            // (`end = start + 1`) — shift back to inclusive.
            WireTimeKind::AllDay => shift_date_forward(&end_date, -1)
                .map_err(|e| nonconforming_response_err(&e.to_string()))?,
            // Timed events end on the calendar day they name.
            WireTimeKind::Timed => end_date,
        };
        Ok(EventResponse {
            id: self.id,
            event: Event {
                summary: self.summary,
                description: self.description,
                start: EventDate { date: start_date },
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

/// Wire-format response body returned by `events.list`.  Only `items`
/// is consumed — `nextPageToken` is deliberately ignored because the
/// connector caps the request at `maxResults=50` and only needs to know
/// whether ANY digest event already exists for the date (#631).
///
/// Items deserialise into [`WireListItem`], whose `start`/`end` reuse
/// the tolerant [`WireEventTime`] shape (#687): a user-added **timed**
/// event on the dedicated calendar serialises `start.dateTime` (no
/// `start.date`), and a recurring master can omit them entirely.
/// Modelling those as a required all-day `EventDate` would fail the
/// WHOLE listing's JSON decode — and because the adoption caller maps
/// that decode error to `DateFailure::Other`, a single stray timed
/// event would abort the entire push cycle, blocking every date's
/// digest until the user removed it.  All-day-only items are the only
/// adoption candidates, so non-all-day items are simply dropped.
#[derive(Debug, Deserialize)]
struct WireEventListResponse {
    #[serde(default)]
    items: Vec<WireListItem>,
}

/// One `events.list` item, tolerant of the non-all-day shapes a
/// user-managed calendar can contain (timed events, recurring masters).
/// Only items carrying both `start.date` and `end.date` round-trip into
/// an [`EventResponse`]; the rest are skipped by
/// [`WireListItem::into_all_day_event_response`].
#[derive(Debug, Deserialize)]
struct WireListItem {
    id: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    description: String,
    // #687 + #631 — reuse the tolerant [`WireEventTime`] decode (date OR
    // dateTime OR absent) introduced for the single-event response path.
    // A user-converted timed event echoes `start.dateTime`; modelling
    // `start`/`end` as a required all-day `EventDate` would fail the
    // WHOLE listing's JSON decode and wedge the connector.  Sharing the
    // primitive keeps both paths tolerant of the same shapes.
    #[serde(default)]
    start: WireEventTime,
    #[serde(default)]
    end: WireEventTime,
    #[serde(default)]
    transparency: String,
}

impl WireListItem {
    /// Convert to an [`EventResponse`] iff this is an **all-day** event
    /// (both `start` and `end` decode from the all-day `date` field).
    /// Returns `Ok(None)` for every non-adoption shape so the caller
    /// drops it without failing the batch:
    ///
    ///   * a **timed** event (`start.dateTime`) — a digest event the
    ///     user converted to timed in the GCal UI, or any user-created
    ///     timed event on the dedicated calendar.  Its `dateTime`
    ///     decodes to a real calendar date, but it is [`WireTimeKind::Timed`]
    ///     and must be SKIPPED for adoption, never matched/overwritten
    ///     (#631);
    ///   * a recurring master / placeholder with no usable dates.
    ///
    /// `Err` only on a genuinely malformed all-day `end.date` (the
    /// exclusive→inclusive shim can't parse it).
    fn into_all_day_event_response(self) -> Result<Option<EventResponse>, AppError> {
        // `into_date` already classifies the shape; tolerate its
        // per-item failures (no usable date) as "skip", not "abort the
        // whole listing".
        let Ok((start_date, start_kind)) = self.start.into_date("start") else {
            return Ok(None);
        };
        let Ok((end_date, end_kind)) = self.end.into_date("end") else {
            return Ok(None);
        };
        // Only all-day events are adoption candidates.  A timed event on
        // either endpoint is skipped (its `dateTime` prefix must NOT be
        // matched against the digest date).
        if start_kind != WireTimeKind::AllDay || end_kind != WireTimeKind::AllDay {
            return Ok(None);
        }
        let inclusive_end = shift_date_forward(&end_date, -1)?;
        Ok(Some(EventResponse {
            id: self.id,
            event: Event {
                summary: self.summary,
                description: self.description,
                start: EventDate { date: start_date },
                end: EventDate {
                    date: inclusive_end,
                },
                transparency: if self.transparency.is_empty() {
                    "transparent".to_owned()
                } else {
                    self.transparency
                },
            },
        }))
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
        if name.eq_ignore_ascii_case("retry-after")
            && let Ok(secs) = value.trim().parse::<u64>()
        {
            return secs.saturating_mul(1000);
        }
    }
    DEFAULT_RETRY_AFTER_MS
}

/// Map a bare [`reqwest::Error`] (network failure, JSON parse failure)
/// into [`AppError`].  Network errors surface as
/// [`GcalErrorKind::Transport`] — callers treat that as a transient
/// failure and retry with back-off (MAINT-151(b)).
///
/// #687 — JSON-decode failures on a 2xx body stay on the
/// [`GcalErrorKind`] taxonomy ([`GcalErrorKind::InvalidRequest`])
/// rather than `AppError::Validation`: a non-conforming response echo
/// is a remote-data problem the connector must classify as a per-date
/// skip, not a programmer error that aborts the cycle and permanently
/// re-wedges the dirty set.
fn reqwest_to_gcal_err(err: &reqwest::Error) -> AppError {
    if err.is_decode() {
        AppError::Gcal(GcalErrorKind::InvalidRequest(format!(
            "gcal.api.decode_failed: {err}"
        )))
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

/// Classic token bucket: capacity `burst` tokens, refilled at
/// `sustained_qps` tokens per second.  A full (idle) bucket admits
/// `burst` back-to-back requests; once drained, admissions are spaced
/// at exactly the sustained rate.
///
/// #688 — the previous sliding-window implementation
/// (`VecDeque<Instant>`, admit while `< burst` timestamps in the
/// trailing 1 s window) sustained ~`burst`/s (≈25 QPS) at warm steady
/// state because the whole window's worth of slots freed at once; the
/// `1/sustained_qps` gap only spaced the over-burst sleep path.  The
/// token bucket makes the steady-state rate equal the documented
/// `RATE_LIMIT_QPS`.
#[derive(Debug)]
pub(crate) struct InstantBucket {
    /// Tokens currently available (fractional between refill ticks).
    tokens: f64,
    /// Instant of the last refill accrual.
    last_refill: Instant,
    /// Maximum tokens the bucket holds — the burst ceiling.
    capacity: f64,
    /// Refill rate in tokens per second — the sustained QPS.
    refill_per_sec: f64,
}

impl InstantBucket {
    fn new(burst: usize, sustained_qps: usize) -> Self {
        assert!(sustained_qps > 0, "sustained_qps must be non-zero");
        Self {
            tokens: burst as f64,
            last_refill: Instant::now(),
            capacity: burst as f64,
            refill_per_sec: sustained_qps as f64,
        }
    }

    /// Accrue tokens for the time elapsed since the last refill,
    /// capped at `capacity`.  Caller holds the lock.
    fn refill(&mut self, now: Instant) {
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_per_sec).min(self.capacity);
        self.last_refill = now;
    }

    /// Sleep until a token is available, then consume it.
    ///
    /// Takes the bucket's `Mutex` by reference rather than `&mut self`
    /// so the lock can be released across the internal sleep (L-125):
    /// each iteration refills + either consumes a token and returns,
    /// or computes the deficit-driven wait, drops the guard, sleeps,
    /// and re-checks.  Concurrent callers therefore overlap whenever
    /// the bucket is not saturated, and contention for the shared
    /// token count keeps the aggregate rate at the sustained QPS.
    async fn take(bucket: &Mutex<Self>) {
        loop {
            let sleep_for = {
                let mut guard = bucket.lock().await;
                guard.refill(Instant::now());
                if guard.tokens >= 1.0 {
                    guard.tokens -= 1.0;
                    return;
                }
                let deficit = 1.0 - guard.tokens;
                Duration::from_secs_f64(deficit / guard.refill_per_sec)
            };
            // Lock released before sleeping (L-125).  Another caller
            // may win the refilled token first — the loop re-checks.
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
    use serde_json::{Value, json};
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

    // ── list_calendars (#859) ──────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_calendars_decodes_id_and_summary() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/me/calendarList"))
            .and(header("authorization", "Bearer dummy-access-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    {"id": "cal_work", "summary": "Work", "accessRole": "owner"},
                    {"id": "cal_agenda", "summary": "Agaric Agenda"},
                ]
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let cals = api
            .list_calendars(&make_token())
            .await
            .expect("list must succeed");
        assert_eq!(
            cals,
            vec![
                CalendarListEntry {
                    id: "cal_work".to_owned(),
                    summary: "Work".to_owned(),
                },
                CalendarListEntry {
                    id: "cal_agenda".to_owned(),
                    summary: "Agaric Agenda".to_owned(),
                },
            ],
            "only id + summary are decoded, extra fields ignored",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_calendars_tolerates_missing_summary() {
        // A calendar lacking `summary` (never the dedicated one) decodes
        // as `""` rather than failing the whole list's JSON decode.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/me/calendarList"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{"id": "cal_no_summary"}]
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let cals = api
            .list_calendars(&make_token())
            .await
            .expect("list must succeed");
        assert_eq!(
            cals,
            vec![CalendarListEntry {
                id: "cal_no_summary".to_owned(),
                summary: String::new(),
            }],
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_calendars_empty_items_is_empty_vec() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/me/calendarList"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [] })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let cals = api
            .list_calendars(&make_token())
            .await
            .expect("list must succeed");
        assert!(cals.is_empty(), "empty items must yield an empty Vec");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_calendars_maps_401_to_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/users/me/calendarList"))
            .respond_with(ResponseTemplate::new(401))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api.list_calendars(&make_token()).await;
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

    // ── revoke_token (#690) ────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revoke_token_posts_refresh_token_and_succeeds_on_200() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/revoke"))
            // RFC 7009 form body carries `token=<refresh>`.
            .and(body_string_contains("token=dummy-refresh"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        api.revoke_token(&make_token().refresh)
            .await
            .expect("200 from /revoke must be Ok");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revoke_token_surfaces_err_on_non_2xx() {
        // Google answers an already-revoked / malformed token with 400.
        // `revoke_token` surfaces an Err so the caller can log it; the
        // caller (disconnect) treats it as best-effort and proceeds.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/revoke"))
            .respond_with(ResponseTemplate::new(400))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api.revoke_token(&make_token().refresh).await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("gcal.revoke_failed")),
            "non-2xx must surface gcal.revoke_failed, got {result:?}"
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

    // ── #687 — tolerant 2xx event-response decode ──────────────────

    /// A digest event the user converted to *timed* in the GCal UI
    /// echoes back with `start.dateTime` / `end.dateTime` instead of
    /// `start.date` / `end.date`.  The tolerant decode must accept it
    /// (deriving the calendar-date prefix) rather than failing the
    /// whole response.  A timed end is NOT shifted by the exclusive
    /// all-day −1-day shim.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn patch_event_accepts_timed_datetime_echo() {
        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_EVENT_ID,
                "summary": "now timed",
                "description": "",
                "start": { "dateTime": "2026-04-22T09:00:00+02:00" },
                "end":   { "dateTime": "2026-04-22T10:30:00+02:00" },
                "transparency": "opaque",
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let patch = EventPatch::new().with_summary("now timed");
        let resp = api
            .patch_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID, &patch)
            .await
            .expect("timed dateTime echo must decode tolerantly (#687)");
        assert_eq!(resp.id, TEST_EVENT_ID);
        assert_eq!(
            resp.event.start.date, "2026-04-22",
            "start must derive from the dateTime calendar-date prefix"
        );
        assert_eq!(
            resp.event.end.date, "2026-04-22",
            "timed end keeps its own calendar day (no exclusive-end −1 shim)"
        );
    }

    /// A 2xx body that decodes as JSON but carries no usable dates
    /// must map to `GcalErrorKind::InvalidRequest` — the connector
    /// classifies that as a per-date skip rather than a cycle abort.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn insert_event_2xx_without_dates_maps_to_invalid_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_EVENT_ID,
                "summary": "no dates at all",
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api
            .insert_event(&make_token(), TEST_CAL_ID, &make_event("2026-04-22"))
            .await;
        match result {
            Err(AppError::Gcal(GcalErrorKind::InvalidRequest(msg))) => {
                assert!(
                    msg.contains("gcal.api.nonconforming_event_response"),
                    "error must carry the nonconforming-response key, got {msg}"
                );
            }
            other => panic!("expected Gcal(InvalidRequest), got {other:?}"),
        }
    }

    /// A 2xx body that is not JSON at all (reqwest decode failure)
    /// must also stay on the Gcal taxonomy (`InvalidRequest`) so the
    /// connector can skip the date instead of wedging the dirty set.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn insert_event_2xx_non_json_body_maps_to_invalid_request() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>oops</html>"))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let result = api
            .insert_event(&make_token(), TEST_CAL_ID, &make_event("2026-04-22"))
            .await;
        match result {
            Err(AppError::Gcal(GcalErrorKind::InvalidRequest(msg))) => {
                assert!(
                    msg.contains("gcal.api.decode_failed"),
                    "error must carry the decode_failed key, got {msg}"
                );
            }
            other => panic!("expected Gcal(InvalidRequest) for non-JSON 2xx, got {other:?}"),
        }
    }

    /// Garbage in a `dateTime` field (prefix not a calendar date) must
    /// be rejected as nonconforming, not silently accepted.
    #[test]
    fn wire_event_time_rejects_garbage_datetime_prefix() {
        let t = WireEventTime {
            date: None,
            date_time: Some("not-a-date-at-all".to_owned()),
        };
        let err = t.into_date("start").expect_err("garbage prefix must fail");
        match err {
            AppError::Gcal(GcalErrorKind::InvalidRequest(msg)) => {
                assert!(msg.contains("gcal.api.nonconforming_event_response"));
            }
            other => panic!("expected Gcal(InvalidRequest), got {other:?}"),
        }
    }

    /// The all-day `date` field wins over `dateTime` when both are
    /// present (defensive — GCal sends exactly one of the two).
    #[test]
    fn wire_event_time_prefers_all_day_date_field() {
        let t = WireEventTime {
            date: Some("2026-04-23".to_owned()),
            date_time: Some("2026-04-22T09:00:00Z".to_owned()),
        };
        let (date, kind) = t.into_date("end").expect("date field must decode");
        assert_eq!(date, "2026-04-23");
        assert_eq!(kind, WireTimeKind::AllDay);
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
    /// post-burst admission must wait for one token to accrue at the
    /// sustained rate.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rate_limiter_throttles_beyond_burst() {
        let bucket = Arc::new(Mutex::new(InstantBucket::new(
            RATE_LIMIT_BURST,
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

    /// #688 regression — measure the WARM steady-state rate, not just
    /// a lower bound on a single stall.  Drain the full burst, then
    /// time 20 further admissions: at the documented sustained rate
    /// they must take `20 / RATE_LIMIT_QPS` = 2.0 s.  The pre-fix
    /// sliding-window implementation freed the whole burst's worth of
    /// slots each second (≈25 QPS warm) and completed the same 20
    /// admissions in ≈1.1 s — well under the lower bound asserted
    /// here.  Bounds are derived from the constants: ≥ 90% of the
    /// theoretical elapsed (slack for token accrual during the burst
    /// drain + timer rounding) and ≤ 200% (slack for CI scheduling)
    /// so both "too fast" (the bug) and gross over-throttling fail.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn rate_limiter_warm_steady_state_matches_documented_qps() {
        let bucket = Arc::new(Mutex::new(InstantBucket::new(
            RATE_LIMIT_BURST,
            RATE_LIMIT_QPS,
        )));

        // Warm-up: drain the entire burst allowance.
        for _ in 0..RATE_LIMIT_BURST {
            InstantBucket::take(&bucket).await;
        }

        // Measure: N post-burst admissions over the simulated window.
        let n_post: usize = 20;
        let start = Instant::now();
        for _ in 0..n_post {
            InstantBucket::take(&bucket).await;
        }
        let elapsed = start.elapsed();

        let theoretical_ms = (n_post as u128) * 1_000 / (RATE_LIMIT_QPS as u128);
        let min_ms = theoretical_ms * 9 / 10;
        let max_ms = theoretical_ms * 2;
        let measured_qps = (n_post as f64) / elapsed.as_secs_f64();
        assert!(
            elapsed.as_millis() >= min_ms,
            "warm steady-state must sustain ≈{RATE_LIMIT_QPS} QPS, not faster: \
             {n_post} post-burst admissions took {}ms (≈{measured_qps:.1} QPS), \
             expected ≥ {min_ms}ms",
            elapsed.as_millis()
        );
        assert!(
            elapsed.as_millis() <= max_ms,
            "warm steady-state must not over-throttle: {n_post} post-burst \
             admissions took {}ms (≈{measured_qps:.1} QPS), expected ≤ {max_ms}ms",
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
    /// so paused-time auto-advance and the bucket's refill accounting
    /// disagree and produce a busy loop.  A small bucket keeps the
    /// total wall-clock cost modest.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn instant_bucket_releases_lock_during_sleep() {
        // burst = 1 at 10 QPS — the spawned take must sleep ~100 ms
        // for the next token but the test still finishes promptly.
        let bucket = Arc::new(Mutex::new(InstantBucket::new(1, 10)));

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

    // ── list_events_for_day (#631) ─────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_events_for_day_returns_translated_events_and_day_window_query() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .and(wiremock::matchers::query_param(
                "timeMin",
                "2026-04-22T00:00:00Z",
            ))
            .and(wiremock::matchers::query_param(
                "timeMax",
                "2026-04-23T00:00:00Z",
            ))
            .and(wiremock::matchers::query_param("singleEvents", "true"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{
                    "id": "evt_orphan",
                    "summary": "Agaric Agenda — Wed Apr 22",
                    "description": "stale digest",
                    "start": { "date": "2026-04-22" },
                    "end":   { "date": "2026-04-23" },
                    "transparency": "transparent",
                }],
            })))
            .expect(1)
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let date = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        let events = api
            .list_events_for_day(&make_token(), TEST_CAL_ID, date)
            .await
            .expect("list must succeed");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "evt_orphan");
        // Exclusive-end shim applied on the way back in.
        assert_eq!(events[0].event.end.date, "2026-04-22");
        assert_eq!(events[0].event.start.date, "2026-04-22");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_events_for_day_empty_items_yields_empty_vec() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "items": [] })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let date = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        let events = api
            .list_events_for_day(&make_token(), TEST_CAL_ID, date)
            .await
            .expect("empty list must succeed");
        assert!(events.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_events_for_day_404_is_calendar_gone() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let date = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        let result = api
            .list_events_for_day(&make_token(), TEST_CAL_ID, date)
            .await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::CalendarGone))),
            "404 on the events collection must map to CalendarGone, got {result:?}"
        );
    }

    /// A user-added **timed** event (`start.dateTime`, no `start.date`)
    /// on the dedicated calendar must NOT fail the whole listing's
    /// decode — that error propagated to `DateFailure::Other` and would
    /// abort the entire push cycle (#631 robustness).  Non-all-day items
    /// are silently dropped; the all-day digest event still comes back.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn list_events_for_day_skips_non_all_day_items_without_failing() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [
                    {
                        // User-added timed event — no `start.date`.
                        "id": "evt_timed",
                        "summary": "Stand-up",
                        "start": { "dateTime": "2026-04-22T09:00:00Z" },
                        "end":   { "dateTime": "2026-04-22T09:30:00Z" },
                    },
                    {
                        // The all-day digest orphan we actually care about.
                        "id": "evt_orphan",
                        "summary": "Agaric Agenda — Wed Apr 22",
                        "description": "stale digest",
                        "start": { "date": "2026-04-22" },
                        "end":   { "date": "2026-04-23" },
                    },
                ],
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let date = NaiveDate::from_ymd_opt(2026, 4, 22).unwrap();
        let events = api
            .list_events_for_day(&make_token(), TEST_CAL_ID, date)
            .await
            .expect("a timed event must not fail the listing");
        assert_eq!(
            events.len(),
            1,
            "only the all-day digest event survives; the timed event is dropped"
        );
        assert_eq!(events[0].id, "evt_orphan");
        assert_eq!(events[0].event.start.date, "2026-04-22");
    }

    // ── #632 — span fields must not record event bodies ────────────

    /// Thread-safe buffered writer usable as a `tracing_subscriber::fmt`
    /// writer so the privacy tests can capture emitted span/log output
    /// in-process.  Mirrors the helper in `db.rs::tests`.
    #[derive(Clone, Default)]
    struct LogCapture(Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogCapture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogCapture {
        type Writer = LogCapture;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    impl LogCapture {
        fn contents(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    /// Install a thread-local trace-level subscriber that records every
    /// span (including its captured fields) into the returned buffer.
    /// `set_default` is thread-local, so the tests below run on the
    /// current-thread tokio flavour to keep span creation on this
    /// thread.
    fn capture_trace_logs() -> (LogCapture, tracing::subscriber::DefaultGuard) {
        use tracing_subscriber::layer::SubscriberExt;
        let writer = LogCapture::default();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_subscriber::EnvFilter::new("trace"))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(writer.clone())
                    .with_ansi(false)
                    .with_span_events(tracing_subscriber::fmt::format::FmtSpan::NEW),
            );
        let guard = tracing::subscriber::set_default(subscriber);
        (writer, guard)
    }

    /// #632 — `insert_event`'s instrument macro must skip the `event`
    /// argument: `Event::description` is the rendered agenda digest
    /// (user note content) and recording it as a Debug span field
    /// would leak it into agaric.log.
    #[tokio::test]
    async fn insert_event_span_does_not_record_event_body_632() {
        const MARKER: &str = "PRIVATE-NOTE-CONTENT-632";

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path(format!("/calendars/{TEST_CAL_ID}/events")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": TEST_EVENT_ID,
                "summary": "Agaric Agenda — 2026-04-22",
                "description": MARKER,
                "start": { "date": "2026-04-22" },
                "end":   { "date": "2026-04-23" },
                "transparency": "transparent",
            })))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let mut event = make_event("2026-04-22");
        event.description = format!("· TODO {MARKER}");

        let (writer, _guard) = capture_trace_logs();
        api.insert_event(&make_token(), TEST_CAL_ID, &event)
            .await
            .expect("insert must succeed");

        let logs = writer.contents();
        assert!(
            logs.contains("insert_event"),
            "positive control: the insert_event span must have been captured; got: {logs:?}"
        );
        assert!(
            !logs.contains(MARKER),
            "event.description (user note content) must NOT appear in span fields (#632); \
             got: {logs}"
        );
    }

    /// #632 — `patch_event` must skip the `patch` argument for the same
    /// reason; also covers the error path (`err` on the instrument
    /// records the failure event — which must not carry the body
    /// either).
    #[tokio::test]
    async fn patch_event_span_does_not_record_patch_body_even_on_error_632() {
        const MARKER: &str = "PRIVATE-PATCH-CONTENT-632";

        let server = MockServer::start().await;
        Mock::given(method("PATCH"))
            .and(path(format!(
                "/calendars/{TEST_CAL_ID}/events/{TEST_EVENT_ID}"
            )))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let api = make_api(&server.uri());
        let patch = EventPatch::new()
            .with_summary("Agaric Agenda — Wed Apr 22")
            .with_description(format!("· TODO {MARKER}"));

        let (writer, _guard) = capture_trace_logs();
        let result = api
            .patch_event(&make_token(), TEST_CAL_ID, TEST_EVENT_ID, &patch)
            .await;
        assert!(result.is_err(), "500 must surface as an error");

        let logs = writer.contents();
        assert!(
            logs.contains("patch_event"),
            "positive control: the patch_event span must have been captured; got: {logs:?}"
        );
        assert!(
            !logs.contains(MARKER),
            "patch.description (user note content) must NOT appear in span fields or the \
             err event (#632); got: {logs}"
        );
    }
}
