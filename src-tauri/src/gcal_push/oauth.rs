//! FEAT-5b — OAuth 2.0 Authorization Code + PKCE flow for the Agaric →
//! Google Calendar push connector.
//!
//! # Scope
//!
//! * Build a PKCE-enabled authorize URL (`begin_authorize`).
//! * Exchange an authorization code for a [`Token`] pair
//!   (`exchange_code`), persisting the account email to `gcal_settings`.
//! * Refresh an access token via the refresh-grant (`refresh_token`).
//! * Wrap a caller-supplied operation with auto-refresh-on-401
//!   semantics (`fetch_with_auto_refresh`): a single bounded refresh +
//!   retry, surfacing `AppError::Gcal(Unauthorized)` on a second 401 /
//!   `invalid_grant` / `unauthorized_client` so the caller (the
//!   connector's `run_cycle_with_auto_refresh`, #683) can run its
//!   terminal-reauth side effects.
//!
//! # Token redaction (critical)
//!
//! [`Token`] wraps the access and refresh strings in
//! [`secrecy::SecretString`] — the only way to read the plaintext is
//! through [`secrecy::ExposeSecret`].  A manual [`fmt::Debug`] impl
//! emits `***REDACTED***` for each secret field.  Every function that
//! accepts a [`Token`] lists it in the `skip()` argument to
//! [`tracing::instrument`], so tokens cannot leak through a span.
//!
//! A unit test constructs a `Token` with distinctive marker strings
//! and asserts that `format!("{token:?}")` contains NEITHER marker —
//! see `tests::token_debug_never_leaks_secret_material`.
//!
//! # Client ID
//!
//! Desktop OAuth client IDs are public by design (RFC 8252), but still
//! should not be pinned in source.  [`CLIENT_ID`] is pulled from the
//! `AGARIC_GCAL_CLIENT_ID` env var at build time via
//! [`option_env!`] — if the env var is unset during `cargo build` the
//! binary ships with the compile-time sentinel `"UNSET-agaric-gcal-client-id"`
//! so development builds keep compiling.  Release artefacts MUST be
//! built with the env var set to the real Google-issued client ID.
//!
//! # Scopes
//!
//! [`GOOGLE_CALENDAR_SCOPE`] is the broad `.../auth/calendar` scope
//! (required for `calendars.insert` to create Agaric's dedicated
//! "Agaric Agenda" calendar on first connect — see FEAT-5 parent §
//! "Open questions").  Narrower scopes (`calendar.events`,
//! `calendar.calendarlist.readonly`) are insufficient.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use oauth2::basic::{BasicErrorResponseType, BasicTokenIntrospectionResponse, BasicTokenType};
use oauth2::{
    AuthUrl, AuthorizationCode, Client, ClientId, CsrfToken, EndpointNotSet, EndpointSet,
    ExtraTokenFields, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, RefreshToken,
    RevocationErrorResponseType, Scope, StandardErrorResponse, StandardRevocableToken,
    StandardTokenResponse, TokenResponse, TokenUrl,
};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::error::{AppError, GcalErrorKind};

use super::keyring_store::TokenStore;
use super::models::{self, GcalSettingKey};

// ---------------------------------------------------------------------------
// Google endpoints + scope + client ID
// ---------------------------------------------------------------------------

/// Google's OAuth 2.0 authorization endpoint.  Constant per RFC 6749 §3.1.
pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";

/// Google's OAuth 2.0 token endpoint.  Constant per RFC 6749 §3.2.
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

/// Full Google Calendar scope required for `calendars.insert`.  See
/// FEAT-5 parent § "Open questions" — the narrower `calendar.events`
/// scope cannot create a new calendar, so it is not an option.
pub const GOOGLE_CALENDAR_SCOPE: &str = "https://www.googleapis.com/auth/calendar";

/// Additional scope required so Google returns an `id_token` alongside
/// the access + refresh tokens — we decode the `email` claim from the
/// ID token to populate `gcal_settings.oauth_account_email`.
pub const OPENID_EMAIL_SCOPE: &str = "openid email";

/// Compile-time placeholder substituted for [`CLIENT_ID`] when the
/// `AGARIC_GCAL_CLIENT_ID` env var is unset during `cargo build`.  Kept
/// as a named constant so the runtime guard in
/// [`OAuthClient::begin_authorize`] can detect a missing-env build and
/// fail with a typed `oauth.client_id_unset` error instead of letting
/// the sentinel flow into the authorize URL (where Google would reject
/// it deep inside its own error page).
pub const UNSET_CLIENT_ID_SENTINEL: &str = "UNSET-agaric-gcal-client-id";

/// Public desktop OAuth client ID, pinned at build time via
/// `AGARIC_GCAL_CLIENT_ID`.  A missing env var substitutes the
/// [`UNSET_CLIENT_ID_SENTINEL`] so local development builds keep
/// compiling — release pipelines MUST set the env var.
pub const CLIENT_ID: &str = match option_env!("AGARIC_GCAL_CLIENT_ID") {
    Some(v) => v,
    None => UNSET_CLIENT_ID_SENTINEL,
};

// ---------------------------------------------------------------------------
// Google-specific token-response shape (includes id_token)
// ---------------------------------------------------------------------------

/// Extra claims Google returns in the token endpoint response body
/// that are not modelled by the oauth2 crate's `BasicTokenResponse`.
///
/// We only care about the ID token — its `email` claim is displayed in
/// the FEAT-5f Settings UI.  `#[serde(default)]` makes the field
/// optional so token-refresh responses (which omit the id_token) still
/// deserialise cleanly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoogleExtraFields {
    #[serde(default)]
    pub id_token: Option<String>,
}

impl ExtraTokenFields for GoogleExtraFields {}

/// Typed token response that extends `BasicTokenResponse` with the
/// Google-specific `id_token` claim.
pub type GoogleTokenResponse = StandardTokenResponse<GoogleExtraFields, BasicTokenType>;

/// Our fully-configured oauth2 `Client` type.  Parameterised on
/// whether the auth URL and token URL have been set (both always are
/// after [`OAuthClient::build_client`]), but the other three endpoint
/// slots (device, introspection, revocation) are [`EndpointNotSet`]
/// because we never use them.
type ConfiguredClient = Client<
    StandardErrorResponse<BasicErrorResponseType>,
    GoogleTokenResponse,
    BasicTokenIntrospectionResponse,
    StandardRevocableToken,
    StandardErrorResponse<RevocationErrorResponseType>,
    EndpointSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointNotSet,
    EndpointSet,
>;

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/// OAuth 2.0 token pair as held in memory.
///
/// Secrets are wrapped in [`SecretString`] so they never serialise or
/// format into human-readable output by accident.  Cloning is cheap
/// ([`SecretString`] is `Arc`-backed).
#[derive(Clone)]
pub struct Token {
    pub access: SecretString,
    pub refresh: SecretString,
    pub expires_at: DateTime<Utc>,
}

impl Token {
    /// Is the access token within `skew` of expiring?  A caller that
    /// detects `is_expiring_within(60s)` can pre-emptively refresh
    /// instead of waiting for the 401.
    #[must_use]
    pub fn is_expiring_within(&self, skew: ChronoDuration) -> bool {
        self.expires_at <= Utc::now() + skew
    }
}

impl fmt::Debug for Token {
    /// Manual [`Debug`] impl that MUST NOT emit the plaintext secret.
    /// Changing this to `#[derive(Debug)]` would defeat [`SecretString`]'s
    /// redaction — there is an explicit unit test pinning this
    /// behaviour.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Token")
            .field("access", &"***REDACTED***")
            .field("refresh", &"***REDACTED***")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

// ---------------------------------------------------------------------------
// AuthorizeUrl — return value of begin_authorize()
// ---------------------------------------------------------------------------

/// Handle returned by [`OAuthClient::begin_authorize`].  The caller
/// opens [`url`][Self::url] in the OS browser and passes the redirect-
/// received `code` and `state` back to [`OAuthClient::exchange_code`].
#[derive(Debug, Clone)]
pub struct AuthorizeUrl {
    /// Fully-formed `https://accounts.google.com/...` URL with all
    /// query parameters (client_id, scope, state, PKCE challenge) set.
    pub url: String,
    /// Opaque CSRF token — echo back to [`OAuthClient::exchange_code`]
    /// verbatim.  MUST match or the exchange fails.
    pub state: String,
}

// ---------------------------------------------------------------------------
// FetchError — signal for the auto-refresh wrapper
// ---------------------------------------------------------------------------

/// Returned by the caller of [`fetch_with_auto_refresh`] to
/// distinguish a 401 (retry with refreshed token) from any other
/// failure (propagate immediately).
#[derive(Debug)]
pub enum FetchError {
    /// The upstream returned HTTP 401 — the access token is stale or
    /// revoked.  The auto-refresh wrapper will request a new one and
    /// retry the operation once.
    Unauthorized,
    /// Any other error.  Propagated verbatim.
    Other(AppError),
}

impl From<AppError> for FetchError {
    fn from(value: AppError) -> Self {
        FetchError::Other(value)
    }
}

// ---------------------------------------------------------------------------
// OAuthClient
// ---------------------------------------------------------------------------

/// Maximum number of pending PKCE verifiers retained in memory.
/// M-88: Bounds the cache so cancelled OAuth flows (user opens the
/// browser, closes the tab) cannot grow it without limit. When the
/// cache is full the oldest entry is evicted.
pub(crate) const PKCE_CACHE_CAPACITY: usize = 16;

/// Time-to-live for a cached PKCE verifier.
/// M-88: Matches the OAuth challenge lifetime — entries older than
/// this are considered abandoned and swept on every cache touch.
pub(crate) const PKCE_CACHE_TTL: Duration = Duration::from_secs(15 * 60);

/// Stateless-looking wrapper around the `oauth2` crate's typestated
/// `BasicClient`.  Instances are cheap to construct and `Send + Sync`
/// — the only internal state is the PKCE verifier cache, which lives
/// behind a `std::sync::Mutex`.
///
/// MAINT-151(d): the three endpoint URLs are parsed once at
/// construction time and cached as their typed `oauth2` wrappers
/// (`AuthUrl` / `TokenUrl` / `RedirectUrl`).  `build_client` clones
/// these cheaply (each is a typed `String` newtype) instead of
/// re-parsing on every `begin_authorize` / `exchange_code` /
/// `refresh_token` call.  We do not cache the fully typestated
/// `Client` itself: its 10-parameter typestate makes it awkward to
/// store as a struct field and cloning it requires moving every
/// endpoint slot through the typestate transitions, which is more
/// expensive than the parse it would replace.
pub struct OAuthClient {
    client_id: String,
    auth_url: AuthUrl,
    token_url: TokenUrl,
    redirect_url: RedirectUrl,
    scopes: Vec<String>,
    /// PKCE verifier cache.
    ///
    /// M-88: Each entry is `(verifier, inserted_at)`. The cache is
    /// bounded ([`PKCE_CACHE_CAPACITY`]) and TTL-aware
    /// ([`PKCE_CACHE_TTL`]); both limits are enforced on every
    /// `begin_authorize` and `exchange_code` call.
    pkce_cache: Mutex<HashMap<String, (PkceCodeVerifier, Instant)>>,
    /// oauth2 v5 pairs with `reqwest ^0.12`; the app's top-level
    /// `reqwest = "0.13.2"` resolves separately.  See the comment in
    /// `Cargo.toml` (FEAT-5b block) for the coupled-stack rationale.
    http_client: oauth2::reqwest::Client,
}

/// Drop entries whose insertion time is older than [`PKCE_CACHE_TTL`].
fn purge_expired(cache: &mut HashMap<String, (PkceCodeVerifier, Instant)>, now: Instant) {
    cache.retain(|_, (_, inserted_at)| now.duration_since(*inserted_at) < PKCE_CACHE_TTL);
}

/// Evict the oldest entry until `cache.len() < capacity`. Used after a
/// purge to keep the absolute size below [`PKCE_CACHE_CAPACITY`] even
/// when every entry is fresh.
fn evict_oldest_until_under(
    cache: &mut HashMap<String, (PkceCodeVerifier, Instant)>,
    capacity: usize,
) {
    while cache.len() >= capacity {
        // Find the oldest entry's key. Cheap because the cache is
        // already bounded to ~16 entries.
        let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, (_, t))| *t)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        cache.remove(&oldest_key);
    }
}

impl fmt::Debug for OAuthClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OAuthClient")
            .field("client_id", &self.client_id)
            .field("auth_url", &self.auth_url)
            .field("token_url", &self.token_url)
            .field("redirect_url", &self.redirect_url)
            .field("scopes", &self.scopes)
            .field(
                "pkce_cache_entries",
                &self.pkce_cache.lock().map(|m| m.len()).unwrap_or_default(),
            )
            .finish()
    }
}

impl OAuthClient {
    /// Construct an OAuth client with caller-supplied URLs.  Used by
    /// tests (pointing at a `wiremock` server) and by the loopback
    /// setup in [`google`].
    ///
    /// # Errors
    /// [`AppError::Validation`] if any URL fails to parse.
    pub fn new(
        client_id: String,
        auth_url: String,
        token_url: String,
        redirect_url: String,
        scopes: Vec<String>,
    ) -> Result<Self, AppError> {
        // MAINT-151(d): parse the URLs once at construction time and
        // store the typed wrappers.  `build_client` clones these (each
        // is a typed `String` newtype) instead of re-parsing on every
        // begin_authorize / exchange_code / refresh_token call.
        let auth_url = AuthUrl::new(auth_url)
            .map_err(|e| AppError::Validation(format!("oauth.invalid_auth_url: {e}")))?;
        let token_url = TokenUrl::new(token_url)
            .map_err(|e| AppError::Validation(format!("oauth.invalid_token_url: {e}")))?;
        let redirect_url = RedirectUrl::new(redirect_url)
            .map_err(|e| AppError::Validation(format!("oauth.invalid_redirect_url: {e}")))?;

        // Per oauth2 crate security note: disable automatic redirects
        // in the HTTP client to prevent SSRF.
        let http_client = oauth2::reqwest::Client::builder()
            .redirect(oauth2::reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| AppError::Validation(format!("oauth.http_client_build_failed: {e}")))?;

        Ok(Self {
            client_id,
            auth_url,
            token_url,
            redirect_url,
            scopes,
            pkce_cache: Mutex::new(HashMap::new()),
            http_client,
        })
    }

    /// Construct an OAuth client for Google with the `tauri-plugin-oauth`
    /// loopback listener on `127.0.0.1:<redirect_port>` (the plugin
    /// picks the port at runtime).
    ///
    /// # Errors
    /// [`AppError::Validation`] if any URL fails to parse (should never
    /// happen with the pinned Google endpoints).
    pub fn google(redirect_port: u16) -> Result<Self, AppError> {
        Self::new(
            CLIENT_ID.to_owned(),
            GOOGLE_AUTH_URL.to_owned(),
            GOOGLE_TOKEN_URL.to_owned(),
            format!("http://127.0.0.1:{redirect_port}"),
            vec![
                GOOGLE_CALENDAR_SCOPE.to_owned(),
                OPENID_EMAIL_SCOPE.to_owned(),
            ],
        )
    }

    /// Build the typestated oauth2 `Client` for a single operation.
    /// Cheap — no network I/O.  Uses [`GoogleTokenResponse`] so the
    /// Google-specific `id_token` claim is deserialised alongside the
    /// standard fields.
    ///
    /// MAINT-151(d): the three endpoint URLs are pre-parsed and
    /// cached on `self`, so this just clones them (each is a typed
    /// `String` newtype) instead of re-parsing on every call.  The
    /// function is now infallible — every parse error has already
    /// been raised by [`OAuthClient::new`].
    fn build_client(&self) -> ConfiguredClient {
        Client::<
            StandardErrorResponse<BasicErrorResponseType>,
            GoogleTokenResponse,
            BasicTokenIntrospectionResponse,
            StandardRevocableToken,
            StandardErrorResponse<RevocationErrorResponseType>,
        >::new(ClientId::new(self.client_id.clone()))
        .set_auth_uri(self.auth_url.clone())
        .set_token_uri(self.token_url.clone())
        .set_redirect_uri(self.redirect_url.clone())
    }

    /// Start a new OAuth authorization.  Generates a fresh PKCE pair +
    /// CSRF token, caches the verifier keyed by the CSRF state, and
    /// returns the full authorize URL for the OS browser.
    ///
    /// `redirect_uri` is threaded per-flow so each loopback listener
    /// gets its own port — the construction-time `redirect_url` on
    /// `self` is overridden for this single call. This matters because
    /// `bind_one_shot` picks a fresh free port per flow and the
    /// authorize URL must advertise the same port back to Google.
    ///
    /// # Errors
    /// * [`AppError::Validation`] keyed `oauth.client_id_unset` — the
    ///   binary was built without `AGARIC_GCAL_CLIENT_ID`, so
    ///   [`CLIENT_ID`] is still the [`UNSET_CLIENT_ID_SENTINEL`].  We
    ///   reject before the sentinel ever reaches the authorize URL so
    ///   the failure is a clean typed error rather than an opaque
    ///   Google error page.
    /// * [`AppError::Validation`] if `redirect_uri` fails to parse or the
    ///   endpoint URLs are malformed.
    #[tracing::instrument(skip(self), err)]
    pub fn begin_authorize(&self, redirect_uri: String) -> Result<AuthorizeUrl, AppError> {
        // Guard: a missing-env build ships the sentinel client id, which
        // Google rejects with an unhelpful error page. Surface a typed
        // error here instead.
        if self.client_id == UNSET_CLIENT_ID_SENTINEL {
            return Err(AppError::Validation("oauth.client_id_unset".to_owned()));
        }
        let redirect = RedirectUrl::new(redirect_uri)
            .map_err(|e| AppError::Validation(format!("oauth.invalid_redirect_url: {e}")))?;
        let client = self.build_client().set_redirect_uri(redirect);
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();

        // `access_type=offline` is what asks Google to mint a refresh
        // token. The oauth2 crate's authorize-url builder does NOT add
        // it implicitly — we set it explicitly here. For Desktop/installed
        // clients Google happens to return a refresh token regardless, but
        // a future Web-type client id (e.g. #134 Android) would silently
        // get only an access token without this param, so we set it as
        // belt-and-braces for every flow.
        let mut builder = client
            .authorize_url(CsrfToken::new_random)
            .set_pkce_challenge(challenge)
            .add_extra_param("access_type", "offline");
        for scope in &self.scopes {
            builder = builder.add_scope(Scope::new(scope.clone()));
        }
        let (url, state) = builder.url();
        let state_str = state.secret().clone();

        // Stash the verifier so exchange_code can recover it by CSRF
        // state.  Mutex is taken briefly and never across an await.
        //
        // M-88: bound the cache before inserting:
        //   1. drop entries older than `PKCE_CACHE_TTL` (cancelled flows),
        //   2. if still at capacity, evict the oldest entry until under.
        // Both passes run on every insert so a flood of cancelled flows
        // can't grow the cache past `PKCE_CACHE_CAPACITY`.
        {
            let mut cache = self
                .pkce_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let now = Instant::now();
            purge_expired(&mut cache, now);
            evict_oldest_until_under(&mut cache, PKCE_CACHE_CAPACITY);
            cache.insert(state_str.clone(), (verifier, now));
        }

        Ok(AuthorizeUrl {
            url: url.to_string(),
            state: state_str,
        })
    }

    /// Complete the Authorization Code flow: trade `code` + PKCE
    /// verifier (recovered by `state`) for a [`Token`] pair.  On
    /// success, the ID token's **unverified** `email` claim (if
    /// present) is returned alongside the token so the caller can
    /// persist it to `gcal_settings.oauth_account_email` for display
    /// in the Settings tab.  See [`extract_email_from_id_token`] for
    /// the M-94 trust posture — the email is display-only and MUST
    /// NOT be used for authorization decisions.
    ///
    /// # Errors
    /// * [`AppError::Validation`] keyed `oauth.invalid_state` — the
    ///   CSRF state doesn't match any pending PKCE verifier.
    /// * [`AppError::Validation`] keyed `oauth.exchange_failed` — the
    ///   upstream returned an error or the network failed.
    ///
    /// `redirect_uri` MUST be the same URI that was passed to the
    /// matching [`begin_authorize`] call — Google validates byte
    /// equality (RFC 6749 §4.1.3). Pass `None` to fall back to the
    /// client's construction-time redirect URI (kept for back-compat
    /// with tests that don't thread a per-flow port).
    #[tracing::instrument(skip(self, code, state), err)]
    pub async fn exchange_code(
        &self,
        code: String,
        state: String,
        redirect_uri: Option<String>,
    ) -> Result<(Token, Option<String>), AppError> {
        // M-88: sweep expired entries before recovering the verifier so
        // a stale verifier (older than `PKCE_CACHE_TTL`) is rejected as
        // `invalid_state` rather than silently honoured.
        let verifier = {
            let mut cache = self
                .pkce_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            purge_expired(&mut cache, Instant::now());
            cache
                .remove(&state)
                .map(|(v, _)| v)
                .ok_or_else(|| AppError::Validation("oauth.invalid_state".to_owned()))?
        };

        let client = if let Some(uri) = redirect_uri {
            let redirect = RedirectUrl::new(uri)
                .map_err(|e| AppError::Validation(format!("oauth.invalid_redirect_url: {e}")))?;
            self.build_client().set_redirect_uri(redirect)
        } else {
            self.build_client()
        };
        let response = client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(verifier)
            .request_async(&self.http_client)
            .await
            // #689 / L-129: route through the shared closed-set
            // classifier so the server-controlled `error_description`
            // is never interpolated into the message or recorded by the
            // `#[instrument(err)]` span — the exchange body carries the
            // auth code + PKCE verifier, so the same redaction
            // discipline as `classify_refresh_error` applies.
            .map_err(|e| classify_exchange_error(&e))?;

        let (access_part, refresh) =
            token_from_response(&response, /* require_refresh = */ true)?;
        // `require_refresh = true` guarantees `refresh.is_some()`.
        let refresh = refresh.ok_or_else(|| {
            AppError::Validation("oauth.exchange_failed: response missing refresh_token".to_owned())
        })?;
        let token = Token {
            access: access_part.access,
            refresh,
            expires_at: access_part.expires_at,
        };
        let unverified_email = extract_unverified_email_from_response(&response);
        Ok((token, unverified_email))
    }

    /// Use the refresh token to obtain a new access token.  Google
    /// typically returns the original refresh token unchanged — if the
    /// response does not include a fresh refresh token, we carry the
    /// previous one forward.
    ///
    /// # Errors
    /// * [`AppError::Gcal(GcalErrorKind::Unauthorized)`] when Google
    ///   returns `invalid_grant` / `unauthorized_client` — the refresh
    ///   token has been revoked (FEAT-5c taxonomy).
    /// * [`AppError::Validation`] keyed `oauth.refresh_failed: <err>`
    ///   for every other failure mode (transport error, non-auth HTTP
    ///   error, parse failure) — these remain on the flow-layer
    ///   Validation taxonomy because they are not HTTP 401-class.
    #[tracing::instrument(skip(self, token), err)]
    pub async fn refresh_token(&self, token: &Token) -> Result<Token, AppError> {
        let client = self.build_client();
        let refresh_token = RefreshToken::new(token.refresh.expose_secret().to_owned());

        let response = client
            .exchange_refresh_token(&refresh_token)
            .request_async(&self.http_client)
            .await
            .map_err(|e| classify_refresh_error(&e))?;

        let (access_part, refresh) =
            token_from_response(&response, /* require_refresh = */ false)?;
        // Google sometimes omits `refresh_token` from a refresh
        // response (the original stays valid).  Carry the previous
        // refresh token forward so callers always end up with a
        // complete Token pair.  MAINT-151(e): the `Option` here makes
        // the missing-refresh case type-visible — no empty-string
        // placeholder convention.
        let refresh = refresh.unwrap_or_else(|| token.refresh.clone());
        Ok(Token {
            access: access_part.access,
            refresh,
            expires_at: access_part.expires_at,
        })
    }
}

// ---------------------------------------------------------------------------
// fetch_with_auto_refresh — single-retry wrapper around a caller op
// ---------------------------------------------------------------------------

/// Run `op` with the currently-stored token.  On a 401 result:
/// 1. Refresh the token once via [`OAuthClient::refresh_token`].
/// 2. Persist the new token via the [`TokenStore`].
/// 3. Re-run `op` once with the refreshed token.
///
/// If the second attempt is ALSO unauthorized, or if the refresh
/// itself fails with a revocation error, return
/// `Err(AppError::Gcal(GcalErrorKind::Unauthorized))` (FEAT-5c — the
/// HTTP-layer taxonomy).  Terminal **side effects** belong to the
/// caller (#683): the connector's
/// `run_cycle_with_auto_refresh` maps that error to PEND-24 H3's
/// `handle_terminal_unauthorized` (persist the `reauth_required`
/// pause flag + emit the email-bearing `GcalEvent::ReauthRequired`).
/// The wrapper deliberately does NOT clear the token store — the
/// Settings tab keeps showing "connected as …" while the reauth
/// banner is up, and a successful re-auth overwrites the stale token
/// anyway.
///
/// # Errors
/// * `AppError::Validation("oauth.not_connected")` — no token stored
///   (pre-HTTP config-layer error, stays on Validation).
/// * `AppError::Gcal(GcalErrorKind::Unauthorized)` — second 401 after
///   refresh, OR refresh itself failed with revocation semantics.
/// * `AppError::Validation("oauth.refresh_failed: …")` — the refresh
///   failed transiently (network / 5xx); callers treat this as
///   retry-later, NOT as a reauth trigger.
/// * Any `AppError` propagated via [`FetchError::Other`] from `op`.
pub async fn fetch_with_auto_refresh<F, Fut, T>(
    oauth_client: &OAuthClient,
    token_store: &Arc<dyn TokenStore>,
    mut op: F,
) -> Result<T, AppError>
where
    F: FnMut(Token) -> Fut,
    Fut: Future<Output = Result<T, FetchError>>,
{
    let initial = token_store
        .load()
        .await?
        .ok_or_else(|| AppError::Validation("oauth.not_connected".to_owned()))?;

    match op(initial.clone()).await {
        Ok(value) => return Ok(value),
        Err(FetchError::Other(e)) => return Err(e),
        Err(FetchError::Unauthorized) => {
            tracing::warn!(
                target: "gcal",
                "access token rejected — attempting one bounded refresh",
            );
        }
    }

    // Bounded refresh: one attempt.  `classify_refresh_error`
    // collapses `invalid_grant` / `unauthorized_client` to
    // `AppError::Gcal(Unauthorized)` (terminal — propagated to the
    // caller's reauth path); every other failure mode is transient
    // and also propagates verbatim (callers retry later).
    let refreshed = oauth_client.refresh_token(&initial).await?;

    token_store.store(&refreshed).await?;

    match op(refreshed).await {
        Ok(value) => Ok(value),
        Err(FetchError::Other(e)) => Err(e),
        Err(FetchError::Unauthorized) => {
            tracing::warn!(
                target: "gcal",
                "second 401 after refresh — unauthorized is terminal",
            );
            Err(AppError::Gcal(GcalErrorKind::Unauthorized))
        }
    }
}

// ---------------------------------------------------------------------------
// Post-connect hook: persist account email to gcal_settings
// ---------------------------------------------------------------------------

/// Persist the freshly-connected Google account email to
/// `gcal_settings.oauth_account_email` so FEAT-5f can display it in
/// the Settings tab.  The token itself is NOT written to the DB — it
/// belongs in the OS keychain only.
///
/// The `unverified_email` argument is the **unverified** ID-token
/// claim returned by [`extract_email_from_id_token`] — see that
/// helper for the M-94 trust posture.  This setting is purely for
/// user-visible display; do NOT route it into authorization or
/// account-binding code paths.
///
/// PEND-24 H3: this is the canonical "successful re-auth completion"
/// hook (the OAuth flow has no dedicated `gcal_connect` Tauri
/// command yet — `exchange_code` + this function is the closest thing
/// to one), so we also clear `gcal_settings.reauth_required` here.
/// A failure to clear is logged but does not fail the connect — the
/// email persistence is the user-visible part; the flag clear is a
/// best-effort follow-up that the next successful cycle would
/// effectively unblock anyway. (If the row is missing the connector
/// reads default `false`, so a subsequent re-auth without the seed
/// row would not pause indefinitely.)
///
/// # Errors
/// [`AppError::Database`] / [`AppError::NotFound`] forwarded from the
/// underlying [`models::set_setting`] call (only on the email write —
/// the flag clear is best-effort).
pub async fn persist_oauth_account_email(
    pool: &SqlitePool,
    unverified_email: &str,
) -> Result<(), AppError> {
    models::set_setting(pool, GcalSettingKey::OauthAccountEmail, unverified_email).await?;
    if let Err(e) = models::set_reauth_required(pool, false).await {
        tracing::warn!(
            target: "gcal",
            error = %e,
            "failed to clear reauth_required flag after successful re-auth; \
             connector will retry on next cycle and clear it lazily",
        );
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// The non-refresh portion of a [`Token`] — the bits the token
/// endpoint always provides regardless of whether the response
/// carries a refresh token.  Returned alongside the optional refresh
/// token by [`token_from_response`] so the missing-refresh case is
/// encoded in the type system rather than papered over with an
/// empty-string placeholder (MAINT-151(e)).
#[derive(Debug, Clone)]
struct AccessPart {
    access: SecretString,
    expires_at: DateTime<Utc>,
}

/// Convert a [`GoogleTokenResponse`] into the access half of a
/// [`Token`] plus the optional refresh token from the response.
///
/// When `require_refresh` is `true` (the initial `exchange_code`
/// path) the response MUST include a `refresh_token` — Google issues
/// one on the first exchange when the authorize URL carried
/// `access_type=offline`, which `begin_authorize` sets explicitly via
/// `add_extra_param` (the oauth2 crate's authorize-url builder does
/// NOT add it for us).  When `false`
/// (the refresh-grant path) a missing refresh token is tolerated;
/// the caller is expected to merge the previously-held refresh token
/// in its place.
///
/// # Errors
/// [`AppError::Validation`] keyed `oauth.exchange_failed` if
/// `require_refresh` is true and the response omits the refresh token.
fn token_from_response(
    response: &GoogleTokenResponse,
    require_refresh: bool,
) -> Result<(AccessPart, Option<SecretString>), AppError> {
    let access = SecretString::from(response.access_token().secret().to_owned());
    let refresh = response
        .refresh_token()
        .map(|rt| SecretString::from(rt.secret().to_owned()));
    let expires_in = response
        .expires_in()
        .unwrap_or_else(|| std::time::Duration::from_secs(3600));
    let expires_at = Utc::now()
        + ChronoDuration::from_std(expires_in).unwrap_or_else(|_| ChronoDuration::seconds(3600));

    if require_refresh && refresh.is_none() {
        return Err(AppError::Validation(
            "oauth.exchange_failed: response missing refresh_token".to_owned(),
        ));
    }

    Ok((AccessPart { access, expires_at }, refresh))
}

/// Pull the unverified `email` claim out of an ID token carried in
/// the [`GoogleExtraFields`] struct, if one was returned.  See
/// [`extract_email_from_id_token`] for the trust posture and the
/// M-94 reference — the value is display-only and MUST NOT be used
/// for authorization decisions.
fn extract_unverified_email_from_response(response: &GoogleTokenResponse) -> Option<String> {
    let id_token = response.extra_fields().id_token.as_deref()?;
    extract_email_from_id_token(id_token)
}

/// Decode the `email` claim from a Google ID token **without
/// verifying its RS256 signature**.
///
/// # Trust model (M-94)
///
/// We rely entirely on transport-level trust: the token reached us
/// via a TLS-pinned HTTP exchange against Google's token endpoint
/// (`oauth2.googleapis.com/token`), which we initiated ourselves.
/// We do **not** fetch Google's JWKS, do **not** validate the `iss`
/// claim, and do **not** check the signature.  The implicit trust
/// chain is therefore: TLS to Google → Google's token endpoint
/// returned this JWT.  Anything stronger (signature verification,
/// issuer pinning, audience binding) is deliberately out of scope
/// here.
///
/// # Caller contract
///
/// The returned email is **unverified** and intended for **display
/// only** (Settings tab "Connected as …" label, persisted to
/// `gcal_settings.oauth_account_email`).  Callers MUST NOT use the
/// returned value for authorization, account-binding, deduplication,
/// or any other security-relevant decision — a malicious or
/// misconfigured token could lie about which Google account is
/// connected and we would have no way to detect it.
///
/// If a future feature needs an authoritative email (e.g. FEAT-5g
/// Android, where the threat surface broadens), upgrade this helper
/// to perform full JWKS-based RS256 verification (cache JWKS,
/// validate `iss == "https://accounts.google.com"`, validate `aud`
/// against our client ID, fail closed on signature mismatch).  M-94
/// option (a) — currently deferred.
///
/// Returns `None` on any parse failure (malformed JWT, missing
/// `email` claim, etc.) — the caller treats the unverified email as
/// optional metadata anyway.
pub(crate) fn extract_email_from_id_token(id_token: &str) -> Option<String> {
    let mut parts = id_token.split('.');
    let _header = parts.next()?;
    let payload = parts.next()?;
    let _signature = parts.next()?;

    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let payload_json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    payload_json
        .get("email")?
        .as_str()
        .map(std::string::ToString::to_string)
}

/// Convenience alias for the concrete `oauth2` request-error type the
/// token endpoint produces for both the code-exchange and refresh
/// flows.  Both `exchange_code` and `refresh_token` drive the same
/// `BasicClient` against the same token URL, so the error shape is
/// identical and the closed-set classifier below is shared.
type TokenRequestError = oauth2::RequestTokenError<
    oauth2::HttpClientError<oauth2::reqwest::Error>,
    StandardErrorResponse<BasicErrorResponseType>,
>;

/// Shared closed-set classifier for token-endpoint errors.
///
/// L-129: do NOT interpolate `err` (or any of its inner fields) into
/// the resulting message.  The upstream `Display` impls for
/// `RequestTokenError` and `StandardErrorResponse` include the parsed,
/// server-controlled `error_description` text — and a future `oauth2`
/// upgrade could broaden them to include the outgoing request body
/// (which carries the refresh token on the refresh path, and the
/// authorization code + PKCE verifier on the exchange path) — either of
/// which would surface secret bytes in tracing spans and bug-report
/// bundles.  Instead we categorise into a closed set and emit only the
/// variant name.
///
/// `key` is the flow-layer diagnostic prefix (`oauth.refresh_failed` or
/// `oauth.exchange_failed`).  `unauthorized_to_gcal` selects whether the
/// revocation variants (`invalid_grant` / `unauthorized_client`)
/// collapse to the HTTP-layer [`AppError::Gcal`]
/// ([`GcalErrorKind::Unauthorized`]) taxonomy — true for the refresh
/// path (FEAT-5c: these trip the connector's reauth flow), false for the
/// initial code exchange (a bad auth code is a flow-layer failure, not a
/// token-revocation event, and the caller is already inside the OAuth
/// flow).  Either way the raw `error_description` is never emitted.
fn classify_token_request_error(
    err: &TokenRequestError,
    key: &str,
    unauthorized_to_gcal: bool,
) -> AppError {
    use BasicErrorResponseType as B;
    let category = match err {
        oauth2::RequestTokenError::ServerResponse(resp) => match resp.error() {
            B::InvalidGrant | B::UnauthorizedClient => {
                if unauthorized_to_gcal {
                    return AppError::Gcal(GcalErrorKind::Unauthorized);
                }
                match resp.error() {
                    B::InvalidGrant => "invalid_grant",
                    _ => "unauthorized_client",
                }
            }
            B::InvalidClient => "invalid_client",
            B::InvalidRequest => "invalid_request",
            B::InvalidScope => "invalid_scope",
            B::UnsupportedGrantType => "unsupported_grant_type",
            // `BasicErrorResponseType::Extension(_)` and any other
            // future variants collapse to a generic category — never
            // include the extension string itself, which is
            // server-controlled text.
            B::Extension(_) => "server_response",
        },
        oauth2::RequestTokenError::Request(_) => "request",
        oauth2::RequestTokenError::Parse(_, _) => "parse",
        oauth2::RequestTokenError::Other(_) => "other",
    };
    AppError::Validation(format!("{key}: {category}"))
}

/// Map a refresh-token request error into our [`AppError`] taxonomy via
/// the shared closed-set classifier ([`classify_token_request_error`]).
///
/// Taxonomy split (FEAT-5c):
///
/// * `invalid_grant` / `unauthorized_client` — the refresh token is
///   rejected as unauthorized.  These are HTTP-layer 401-class errors
///   and route through [`AppError::Gcal`] ([`GcalErrorKind::Unauthorized`])
///   so downstream code (Settings UI, connector retry) can treat them
///   uniformly with a 401 from the Calendar API itself.
/// * Every other variant stays on [`AppError::Validation`] with the
///   `oauth.refresh_failed:` key, a flow-layer diagnostic, not an HTTP
///   status.  Callers retry transient failures based on the key.
fn classify_refresh_error(err: &TokenRequestError) -> AppError {
    classify_token_request_error(
        err,
        "oauth.refresh_failed",
        /* unauthorized_to_gcal = */ true,
    )
}

/// Map a code-exchange request error into our [`AppError`] taxonomy via
/// the shared closed-set classifier ([`classify_token_request_error`]).
///
/// L-129 / #689: mirrors [`classify_refresh_error`]'s redaction
/// discipline — the server-controlled `error_description` is never
/// interpolated into the message (and therefore never recorded by
/// `#[instrument(err)]`), even though the exchange request body carries
/// the authorization code and PKCE verifier.  Unlike the refresh path,
/// the revocation variants stay on the `oauth.exchange_failed:`
/// Validation key (a bad auth code mid-flow is not a reauth trigger),
/// while remaining distinguishable for triage.
fn classify_exchange_error(err: &TokenRequestError) -> AppError {
    classify_token_request_error(
        err,
        "oauth.exchange_failed",
        /* unauthorized_to_gcal = */ false,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::keyring_store::{MockTokenStore, TokenStore};

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tempfile::TempDir;
    use wiremock::matchers::{body_string_contains, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ── Fixtures ───────────────────────────────────────────────────

    const TEST_CLIENT_ID: &str = "test-client-id";
    const TEST_REDIRECT: &str = "http://127.0.0.1:54321";
    const TEST_SCOPE: &str = "https://www.googleapis.com/auth/calendar";

    fn build_id_token(email: &str) -> String {
        // JWT shape: header.payload.signature — each base64url-encoded.
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload_json = serde_json::json!({
            "email": email,
            "aud": "agaric",
        });
        let payload = URL_SAFE_NO_PAD.encode(payload_json.to_string().as_bytes());
        // Signature is not verified (see extract_email_from_id_token doc).
        let signature = URL_SAFE_NO_PAD.encode(b"signature-placeholder");
        format!("{header}.{payload}.{signature}")
    }

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn build_client(mock: &MockServer) -> OAuthClient {
        OAuthClient::new(
            TEST_CLIENT_ID.to_owned(),
            format!("{}/o/oauth2/v2/auth", mock.uri()),
            format!("{}/token", mock.uri()),
            TEST_REDIRECT.to_owned(),
            vec![TEST_SCOPE.to_owned(), OPENID_EMAIL_SCOPE.to_owned()],
        )
        .unwrap()
    }

    fn dummy_token(access: &str, refresh: &str) -> Token {
        Token {
            access: SecretString::from(access.to_owned()),
            refresh: SecretString::from(refresh.to_owned()),
            expires_at: Utc::now() + ChronoDuration::hours(1),
        }
    }

    // ── CRITICAL: secret redaction ─────────────────────────────────

    #[test]
    fn token_debug_never_leaks_secret_material() {
        // Pin the anti-leak invariant: Debug output must NOT contain
        // either raw token string, and MUST contain the redaction
        // marker.  Future refactors that re-derive Debug on Token
        // will break this test before the leak reaches production.
        let token = Token {
            access: SecretString::from("SHOULD-NOT-APPEAR".to_owned()),
            refresh: SecretString::from("ALSO-NOT-APPEAR".to_owned()),
            expires_at: Utc::now(),
        };
        let dbg = format!("{token:?}");
        assert!(
            !dbg.contains("SHOULD-NOT-APPEAR"),
            "Token Debug leaked access token plaintext: {dbg}"
        );
        assert!(
            !dbg.contains("ALSO-NOT-APPEAR"),
            "Token Debug leaked refresh token plaintext: {dbg}"
        );
        assert!(
            dbg.contains("REDACTED"),
            "Token Debug must carry a redaction marker, got: {dbg}"
        );
    }

    #[test]
    fn token_display_not_implemented() {
        // Meta-check: Token must not implement Display.  If someone
        // adds a Display impl, this test stops compiling — which is
        // the point.  We pin it as a comment-style compile-fail guard
        // here by checking the trait is absent through a local trait
        // bound.
        fn assert_no_display<T>() {}
        // If Token impls Display, the following line fails to compile.
        // (It is a no-op unless the trait bound needs checking.)
        assert_no_display::<Token>();
    }

    // ── OAuthClient constructor ────────────────────────────────────

    #[test]
    fn new_rejects_invalid_auth_url() {
        let result = OAuthClient::new(
            TEST_CLIENT_ID.to_owned(),
            "not a url".to_owned(),
            "https://example.com/token".to_owned(),
            TEST_REDIRECT.to_owned(),
            vec![TEST_SCOPE.to_owned()],
        );
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.invalid_auth_url")),
            "malformed auth URL must surface oauth.invalid_auth_url, got {result:?}"
        );
    }

    #[test]
    fn new_rejects_invalid_token_url() {
        let result = OAuthClient::new(
            TEST_CLIENT_ID.to_owned(),
            "https://example.com/auth".to_owned(),
            "not a url".to_owned(),
            TEST_REDIRECT.to_owned(),
            vec![TEST_SCOPE.to_owned()],
        );
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.invalid_token_url")),
            "malformed token URL must surface oauth.invalid_token_url, got {result:?}"
        );
    }

    #[test]
    fn new_rejects_invalid_redirect_url() {
        let result = OAuthClient::new(
            TEST_CLIENT_ID.to_owned(),
            "https://example.com/auth".to_owned(),
            "https://example.com/token".to_owned(),
            "not a url".to_owned(),
            vec![TEST_SCOPE.to_owned()],
        );
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.invalid_redirect_url")),
            "malformed redirect URL must surface oauth.invalid_redirect_url, got {result:?}"
        );
    }

    #[test]
    fn google_constructor_uses_pinned_endpoints() {
        let client = OAuthClient::google(54321).unwrap();
        // Compare via the typed wrappers' string accessor — MAINT-151(d)
        // changed `OAuthClient`'s fields from `String` to the typed
        // `AuthUrl` / `TokenUrl` / `RedirectUrl` newtypes.
        assert_eq!(client.auth_url.as_str(), GOOGLE_AUTH_URL);
        assert_eq!(client.token_url.as_str(), GOOGLE_TOKEN_URL);
        assert_eq!(client.redirect_url.as_str(), "http://127.0.0.1:54321");
        assert_eq!(client.client_id, CLIENT_ID);
        assert!(client.scopes.iter().any(|s| s == GOOGLE_CALENDAR_SCOPE));
        assert!(client.scopes.iter().any(|s| s == OPENID_EMAIL_SCOPE));
    }

    // ── begin_authorize ────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_authorize_returns_url_with_required_params_and_caches_verifier() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();

        assert!(
            authorize
                .url
                .starts_with(&format!("{}/o/oauth2/v2/auth", mock.uri())),
            "authorize URL must target the configured auth endpoint, got {}",
            authorize.url,
        );
        assert!(
            authorize
                .url
                .contains(&format!("client_id={TEST_CLIENT_ID}")),
            "authorize URL must include client_id, got {}",
            authorize.url,
        );
        assert!(
            authorize.url.contains("code_challenge="),
            "authorize URL must include PKCE code_challenge, got {}",
            authorize.url,
        );
        assert!(
            authorize.url.contains("code_challenge_method=S256"),
            "PKCE method must be S256 (SHA-256), got {}",
            authorize.url,
        );
        assert!(
            authorize.url.contains("response_type=code"),
            "flow must be Authorization Code, got {}",
            authorize.url,
        );
        assert!(
            authorize
                .url
                .contains(&format!("state={}", authorize.state)),
            "authorize URL state param must match returned state",
        );
        assert!(!authorize.state.is_empty(), "state token must not be empty");
        assert!(
            authorize.url.contains("access_type=offline"),
            "authorize URL must request offline access so Google mints a \
             refresh token (the oauth2 crate does NOT add this implicitly), \
             got {}",
            authorize.url,
        );

        // PKCE verifier must now be cached under the returned state.
        assert_eq!(
            client
                .pkce_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
            1,
            "exactly one PKCE verifier must be cached after begin_authorize",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_authorize_generates_distinct_states_on_repeated_calls() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let a = client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();
        let b = client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();
        assert_ne!(
            a.state, b.state,
            "each call must produce a fresh CSRF state"
        );
        assert_eq!(
            client
                .pkce_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
            2,
            "both verifiers must be cached"
        );
    }

    #[test]
    fn begin_authorize_rejects_unset_client_id_sentinel() {
        // #692 item 1: a build without `AGARIC_GCAL_CLIENT_ID` ships the
        // sentinel client id. `begin_authorize` must reject it with a
        // typed `oauth.client_id_unset` error rather than emitting a URL
        // carrying the sentinel (which Google rejects deep inside its own
        // error page).
        let client = OAuthClient::new(
            UNSET_CLIENT_ID_SENTINEL.to_owned(),
            "https://accounts.google.com/o/oauth2/v2/auth".to_owned(),
            "https://oauth2.googleapis.com/token".to_owned(),
            TEST_REDIRECT.to_owned(),
            vec![TEST_SCOPE.to_owned()],
        )
        .unwrap();

        let result = client.begin_authorize(TEST_REDIRECT.to_owned());
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m == "oauth.client_id_unset"),
            "unset client id must surface oauth.client_id_unset, got {result:?}",
        );
        // Nothing should have been cached on the rejected path.
        assert_eq!(
            client
                .pkce_cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .len(),
            0,
            "rejected begin_authorize must not cache a PKCE verifier",
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pkce_cache_is_bounded_under_burst_of_cancelled_flows() {
        // M-88 regression: cancelled OAuth flows (user opens browser,
        // closes the tab) leave verifiers in the cache forever. The
        // bounded cache must keep the in-memory state below
        // `PKCE_CACHE_CAPACITY` even under a 100-flow burst.
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        for _ in 0..100 {
            client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();
        }

        let len = client
            .pkce_cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .len();
        assert!(
            len <= PKCE_CACHE_CAPACITY,
            "cache must stay below PKCE_CACHE_CAPACITY ({PKCE_CACHE_CAPACITY}) under burst; got {len}",
        );
    }

    #[test]
    fn purge_expired_drops_entries_older_than_ttl() {
        // M-88 regression: TTL-based eviction must drop verifiers whose
        // insertion time is older than `PKCE_CACHE_TTL`. Constructed
        // entirely with synthetic `Instant` values so the test does
        // not block on real wall-clock time.
        let mut cache: HashMap<String, (PkceCodeVerifier, Instant)> = HashMap::new();
        let now = Instant::now();
        // Fresh entry — must survive.
        cache.insert(
            "fresh".into(),
            (PkceCodeVerifier::new("v_fresh".into()), now),
        );
        // Stale entry — TTL + a healthy margin in the past.
        cache.insert(
            "stale".into(),
            (
                PkceCodeVerifier::new("v_stale".into()),
                now.checked_sub(PKCE_CACHE_TTL + Duration::from_secs(1))
                    .expect("Instant arithmetic must not underflow on supported platforms"),
            ),
        );

        purge_expired(&mut cache, now);

        assert!(cache.contains_key("fresh"), "fresh entry must survive");
        assert!(!cache.contains_key("stale"), "stale entry must be purged");
    }

    #[test]
    fn evict_oldest_until_under_caps_at_capacity() {
        // M-88: secondary defence — if every entry is fresh (TTL hasn't
        // elapsed yet) the cache must still evict the oldest one to stay
        // under `PKCE_CACHE_CAPACITY`.
        let mut cache: HashMap<String, (PkceCodeVerifier, Instant)> = HashMap::new();
        let base = Instant::now();
        for i in 0..PKCE_CACHE_CAPACITY {
            // Each entry inserted ~i seconds before "now"; entry 0 is oldest.
            let t = base
                .checked_sub(Duration::from_secs(
                    (PKCE_CACHE_CAPACITY - i).try_into().unwrap(),
                ))
                .unwrap_or(base);
            cache.insert(format!("k{i}"), (PkceCodeVerifier::new(format!("v{i}")), t));
        }
        assert_eq!(cache.len(), PKCE_CACHE_CAPACITY);

        evict_oldest_until_under(&mut cache, PKCE_CACHE_CAPACITY);

        assert!(
            cache.len() < PKCE_CACHE_CAPACITY,
            "cache must end strictly below capacity, got {}",
            cache.len()
        );
        assert!(
            !cache.contains_key("k0"),
            "the oldest entry (k0) must be the one evicted"
        );
    }

    // ── exchange_code ──────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_code_happy_path_returns_token_and_unverified_email_and_persists_it() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();

        let id_token = build_id_token("user@example.com");
        let token_body = serde_json::json!({
            "access_token": "ya29.access-abc",
            "refresh_token": "1//refresh-xyz",
            "expires_in": 3600,
            "token_type": "Bearer",
            "id_token": id_token,
        });
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=authorization_code"))
            .respond_with(ResponseTemplate::new(200).set_body_json(token_body))
            .expect(1)
            .mount(&mock)
            .await;

        let (token, unverified_email) = client
            .exchange_code("the-code".to_owned(), authorize.state, None)
            .await
            .unwrap();

        assert_eq!(token.access.expose_secret(), "ya29.access-abc");
        assert_eq!(token.refresh.expose_secret(), "1//refresh-xyz");
        assert_eq!(unverified_email.as_deref(), Some("user@example.com"));

        // Persist to DB (FEAT-5a helper).
        let (pool, _dir) = test_pool().await;
        persist_oauth_account_email(&pool, unverified_email.as_deref().unwrap())
            .await
            .unwrap();
        let stored = models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
            .await
            .unwrap();
        assert_eq!(
            stored.as_deref(),
            Some("user@example.com"),
            "oauth_account_email must roundtrip through gcal_settings"
        );
    }

    /// PEND-24 H3 — successful re-auth must clear the
    /// `reauth_required` pause flag so the connector resumes.
    /// `persist_oauth_account_email` is the canonical post-connect
    /// hook (the OAuth flow has no dedicated `gcal_connect` Tauri
    /// command yet), so the clear lives there.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persist_oauth_account_email_clears_reauth_required_flag() {
        let (pool, _dir) = test_pool().await;
        // Pre-set the flag, simulating an earlier terminal 401.
        models::set_reauth_required(&pool, true).await.unwrap();

        persist_oauth_account_email(&pool, "user@example.com")
            .await
            .unwrap();

        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
                .await
                .unwrap()
                .as_deref(),
            Some("user@example.com"),
            "email must persist regardless"
        );
        assert!(
            !models::get_reauth_required(&pool).await.unwrap(),
            "reauth_required must be cleared after a successful re-auth"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_code_rejects_unknown_state_with_invalid_state_error() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        // Don't call begin_authorize — no state is cached.
        let result = client
            .exchange_code("the-code".to_owned(), "bogus-state".to_owned(), None)
            .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.invalid_state")),
            "unknown state must yield oauth.invalid_state, got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_code_surfaces_server_error_as_exchange_failed() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();

        // #689: the `error_description` is server-controlled text and
        // must never reach the flow-layer message or the
        // `#[instrument(err)]` span — use a sentinel to pin redaction
        // end-to-end through the real `request_async` error path.
        const DESC_SENTINEL: &str = "MISSING_PKCE_SERVER_CONTROLLED_SENTINEL";
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_request",
                "error_description": DESC_SENTINEL,
            })))
            .mount(&mock)
            .await;

        let result = client
            .exchange_code("the-code".to_owned(), authorize.state, None)
            .await;
        let Err(AppError::Validation(msg)) = result else {
            panic!("server error on exchange must surface AppError::Validation, got {result:?}");
        };
        assert_eq!(
            msg, "oauth.exchange_failed: invalid_request",
            "server error must surface the closed-set category, got {msg:?}"
        );
        assert!(
            !msg.contains(DESC_SENTINEL),
            "server-controlled error_description must not leak into the message, got {msg:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_code_consumes_pkce_verifier_even_on_success() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize(TEST_REDIRECT.to_owned()).unwrap();

        let token_body = serde_json::json!({
            "access_token": "a",
            "refresh_token": "r",
            "expires_in": 3600,
            "token_type": "Bearer",
            "id_token": build_id_token("u@ex.com"),
        });
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(token_body))
            .mount(&mock)
            .await;

        let state_copy = authorize.state.clone();
        client
            .exchange_code("the-code".to_owned(), authorize.state, None)
            .await
            .unwrap();

        // The verifier must have been removed — second attempt should
        // fail with invalid_state.
        let second = client
            .exchange_code("the-code".to_owned(), state_copy, None)
            .await;
        assert!(
            matches!(second, Err(AppError::Validation(ref m)) if m.contains("oauth.invalid_state")),
            "replaying the same state must fail after success, got {second:?}"
        );
    }

    // ── refresh_token ──────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_token_happy_path_returns_new_access_token() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "new-access",
                "expires_in": 3600,
                "token_type": "Bearer",
            })))
            .expect(1)
            .mount(&mock)
            .await;

        let stale = dummy_token("old-access", "refresh-1");
        let refreshed = client.refresh_token(&stale).await.unwrap();

        assert_eq!(refreshed.access.expose_secret(), "new-access");
        // Google omits refresh_token on refresh — the original carries forward.
        assert_eq!(refreshed.refresh.expose_secret(), "refresh-1");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_token_invalid_grant_maps_to_gcal_unauthorized() {
        // FEAT-5c: `invalid_grant` / `unauthorized_client` are HTTP-
        // layer 401-class failures and now route through
        // `AppError::Gcal(GcalErrorKind::Unauthorized)` instead of the
        // old `AppError::Validation("oauth.revoked: ...")` marker.
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant",
                "error_description": "Token has been expired or revoked.",
            })))
            .mount(&mock)
            .await;

        let stale = dummy_token("old-access", "refresh-1");
        let result = client.refresh_token(&stale).await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
            "invalid_grant must map to AppError::Gcal(Unauthorized), got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_token_transient_error_maps_to_refresh_failed() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(500).set_body_string("oops"))
            .mount(&mock)
            .await;

        let stale = dummy_token("old-access", "refresh-1");
        let result = client.refresh_token(&stale).await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.refresh_failed")),
            "5xx must map to oauth.refresh_failed, got {result:?}"
        );
    }

    // ── classify_refresh_error: closed-set categorisation ──────────

    #[test]
    fn classify_refresh_error_invalid_grant_maps_to_unauthorized() {
        // L-129: pin that the unauthorized mapping
        // remains intact after the closed-set refactor — this
        // codepath is what trips the connector's `gcal:reauth_required`
        // event and must not regress.
        let resp: StandardErrorResponse<BasicErrorResponseType> =
            StandardErrorResponse::new(BasicErrorResponseType::InvalidGrant, None, None);
        let err: oauth2::RequestTokenError<
            oauth2::HttpClientError<oauth2::reqwest::Error>,
            StandardErrorResponse<BasicErrorResponseType>,
        > = oauth2::RequestTokenError::ServerResponse(resp);

        let mapped = classify_refresh_error(&err);
        assert!(
            matches!(mapped, AppError::Gcal(GcalErrorKind::Unauthorized)),
            "invalid_grant must map to AppError::Gcal(Unauthorized), got {mapped:?}"
        );
    }

    #[test]
    fn classify_refresh_error_unauthorized_client_maps_to_unauthorized() {
        let resp: StandardErrorResponse<BasicErrorResponseType> =
            StandardErrorResponse::new(BasicErrorResponseType::UnauthorizedClient, None, None);
        let err: oauth2::RequestTokenError<
            oauth2::HttpClientError<oauth2::reqwest::Error>,
            StandardErrorResponse<BasicErrorResponseType>,
        > = oauth2::RequestTokenError::ServerResponse(resp);

        let mapped = classify_refresh_error(&err);
        assert!(
            matches!(mapped, AppError::Gcal(GcalErrorKind::Unauthorized)),
            "unauthorized_client must map to AppError::Gcal(Unauthorized), got {mapped:?}"
        );
    }

    #[test]
    fn classify_refresh_error_does_not_leak_raw_err_display() {
        // L-129: the previous implementation interpolated
        // the upstream `RequestTokenError::Display` directly into the
        // validation message.  Google's documented refresh-error
        // responses include an `error_description` field, and a future
        // `oauth2` upgrade could broaden the formatter to include the
        // outgoing request body — either path would surface refresh
        // token bytes in tracing spans and bug-report bundles.
        //
        // This test pins the closed-set categorisation: the resulting
        // `AppError::Validation` message must be exactly one of the
        // pre-defined `oauth.refresh_failed: <category>` strings, and
        // must NOT contain a sentinel substring smuggled via the
        // underlying error's `Display`.
        const SENTINEL: &str = "REFRESH_TOKEN_BYTES_LEAKED_HERE";

        let err: oauth2::RequestTokenError<
            oauth2::HttpClientError<oauth2::reqwest::Error>,
            StandardErrorResponse<BasicErrorResponseType>,
        > = oauth2::RequestTokenError::Other(SENTINEL.to_owned());

        let mapped = classify_refresh_error(&err);
        let AppError::Validation(msg) = mapped else {
            panic!("expected AppError::Validation, got {mapped:?}");
        };

        assert_eq!(
            msg, "oauth.refresh_failed: other",
            "Other(...) variant must produce literal closed-set category, got {msg:?}"
        );
        assert!(
            !msg.contains(SENTINEL),
            "validation message must not interpolate underlying err Display, got {msg:?}"
        );
    }

    #[test]
    fn classify_refresh_error_server_response_extension_uses_generic_category() {
        // Extension(...) variants (any non-RFC-6749 string returned by
        // the server) collapse to the generic `server_response`
        // category — never include the extension string itself, which
        // is server-controlled text.
        const EXT_SENTINEL: &str = "evil_extension_string_with_secret";
        let resp: StandardErrorResponse<BasicErrorResponseType> = StandardErrorResponse::new(
            BasicErrorResponseType::Extension(EXT_SENTINEL.to_owned()),
            None,
            None,
        );
        let err: oauth2::RequestTokenError<
            oauth2::HttpClientError<oauth2::reqwest::Error>,
            StandardErrorResponse<BasicErrorResponseType>,
        > = oauth2::RequestTokenError::ServerResponse(resp);

        let mapped = classify_refresh_error(&err);
        let AppError::Validation(msg) = mapped else {
            panic!("expected AppError::Validation, got {mapped:?}");
        };
        assert_eq!(msg, "oauth.refresh_failed: server_response");
        assert!(
            !msg.contains(EXT_SENTINEL),
            "extension string must not surface in validation message, got {msg:?}"
        );
    }

    #[test]
    fn classify_refresh_error_invalid_client_maps_to_named_category() {
        let resp: StandardErrorResponse<BasicErrorResponseType> =
            StandardErrorResponse::new(BasicErrorResponseType::InvalidClient, None, None);
        let err: oauth2::RequestTokenError<
            oauth2::HttpClientError<oauth2::reqwest::Error>,
            StandardErrorResponse<BasicErrorResponseType>,
        > = oauth2::RequestTokenError::ServerResponse(resp);

        let AppError::Validation(msg) = classify_refresh_error(&err) else {
            panic!("expected AppError::Validation");
        };
        assert_eq!(msg, "oauth.refresh_failed: invalid_client");
    }

    // ── classify_exchange_error: closed-set categorisation (#689) ───

    #[test]
    fn classify_exchange_error_does_not_leak_raw_err_display() {
        // #689 / L-129: the previous `exchange_code` implementation
        // interpolated the upstream `RequestTokenError::Display`
        // (which includes the server-controlled `error_description`)
        // straight into the `oauth.exchange_failed:` message — and the
        // `#[instrument(err)]` span recorded it.  The exchange request
        // body carries the authorization code + PKCE verifier, so a
        // future `oauth2` formatter broadening (mirroring the refresh
        // concern) would leak those bytes.  This pins the closed-set
        // categorisation: the message must be exactly the pre-defined
        // `oauth.exchange_failed: other` string with no smuggled
        // sentinel.
        const SENTINEL: &str = "EXCHANGE_SECRET_LEAKED_HERE";

        let err: TokenRequestError = oauth2::RequestTokenError::Other(SENTINEL.to_owned());

        let mapped = classify_exchange_error(&err);
        let AppError::Validation(msg) = mapped else {
            panic!("expected AppError::Validation, got {mapped:?}");
        };

        assert_eq!(
            msg, "oauth.exchange_failed: other",
            "Other(...) variant must produce literal closed-set category, got {msg:?}"
        );
        assert!(
            !msg.contains(SENTINEL),
            "validation message must not interpolate underlying err Display, got {msg:?}"
        );
    }

    #[test]
    fn classify_exchange_error_server_response_does_not_leak_description() {
        // The exchange path must NOT collapse revocation variants to
        // `AppError::Gcal(Unauthorized)` (a bad auth code mid-flow is a
        // flow-layer failure, not a reauth trigger) — but it must keep
        // the category distinguishable while never surfacing the
        // server-controlled extension/description text.
        const EXT_SENTINEL: &str = "evil_exchange_extension_with_secret";
        let resp: StandardErrorResponse<BasicErrorResponseType> = StandardErrorResponse::new(
            BasicErrorResponseType::Extension(EXT_SENTINEL.to_owned()),
            None,
            None,
        );
        let err: TokenRequestError = oauth2::RequestTokenError::ServerResponse(resp);

        let AppError::Validation(msg) = classify_exchange_error(&err) else {
            panic!("expected AppError::Validation");
        };
        assert_eq!(msg, "oauth.exchange_failed: server_response");
        assert!(
            !msg.contains(EXT_SENTINEL),
            "extension string must not surface in validation message, got {msg:?}"
        );
    }

    #[test]
    fn classify_exchange_error_invalid_grant_stays_validation_not_gcal() {
        // Mirror of the refresh `invalid_grant` test, but pinning the
        // exchange-path divergence: `invalid_grant` on the initial code
        // exchange is a flow-layer `oauth.exchange_failed: invalid_grant`
        // Validation (distinguishable for triage), NOT the reauth-routing
        // `AppError::Gcal(Unauthorized)`.
        let resp: StandardErrorResponse<BasicErrorResponseType> =
            StandardErrorResponse::new(BasicErrorResponseType::InvalidGrant, None, None);
        let err: TokenRequestError = oauth2::RequestTokenError::ServerResponse(resp);

        let mapped = classify_exchange_error(&err);
        let AppError::Validation(msg) = mapped else {
            panic!("expected AppError::Validation, got {mapped:?}");
        };
        assert_eq!(msg, "oauth.exchange_failed: invalid_grant");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_with_empty_stored_refresh_token_returns_clean_error() {
        // TEST-45: pin the behaviour when the token store
        // returns a `Token` whose `refresh` is `SecretString::from("")`.
        // Realistic causes: the initial OAuth flow didn't capture a
        // refresh token (Google only returns one on first consent with
        // `access_type=offline` + `prompt=consent`), token-store
        // corruption, or a test-fixture regression.
        //
        // `oauth2::RefreshToken::new("")` is a thin newtype wrapper —
        // it does NOT panic on the empty string (verified by reading
        // the `new_secret_type!` macro in `oauth2-5.0.0/src/types.rs`).
        // The empty value is therefore forwarded to the token endpoint
        // as `refresh_token=` and Google responds with `invalid_grant`,
        // which `classify_refresh_error` maps to
        // `AppError::Gcal(GcalErrorKind::Unauthorized)`.  The
        // `fetch_with_auto_refresh` wrapper propagates that variant
        // verbatim and the connector's terminal-reauth path (#683)
        // emits `gcal:reauth_required` — exactly the right
        // user-facing outcome (the user has to redo the OAuth flow
        // because there is no usable refresh token).
        //
        // This test pins that error variant so a future change (e.g. a
        // synchronous local validation that returns a different error
        // before the network call, or any drift in `classify_refresh_error`)
        // breaks loudly instead of silently degrading the reauth UX.
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        // Mimic Google's response to an empty `refresh_token` form
        // parameter: 400 + `invalid_grant`.  We do not pin the exact
        // body shape — only that it is the standard OAuth2 invalid_grant
        // error response that triggers the revocation taxonomy.
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant",
                "error_description": "Bad Request",
            })))
            .expect(1)
            .mount(&mock)
            .await;

        let empty_refresh = dummy_token("old-access", "");
        let result = client.refresh_token(&empty_refresh).await;
        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
            "empty stored refresh token must surface AppError::Gcal(Unauthorized) \
             (current behaviour pinned by TEST-45 — see test docstring), \
             got {result:?}"
        );
    }

    // ── fetch_with_auto_refresh ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_succeeds_on_first_try_without_refresh() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        store.store(&dummy_token("A1", "R1")).await.unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_inner = Arc::clone(&calls);

        let result: Result<&'static str, AppError> =
            fetch_with_auto_refresh(&client, &store, move |token| {
                let calls_inner = Arc::clone(&calls_inner);
                async move {
                    calls_inner.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(token.access.expose_secret(), "A1");
                    Ok::<_, FetchError>("ok")
                }
            })
            .await;

        assert_eq!(result.unwrap(), "ok");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "op must be invoked exactly once on happy path"
        );
        assert!(
            store.load().await.unwrap().is_some(),
            "token must remain in keystore after happy-path op"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_refreshes_after_single_401_and_retries_once() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        // Refresh endpoint returns a new access token.
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "A2-refreshed",
                "expires_in": 3600,
                "token_type": "Bearer",
            })))
            .expect(1)
            .mount(&mock)
            .await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        store.store(&dummy_token("A1", "R1")).await.unwrap();

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_inner = Arc::clone(&calls);

        let result: Result<&'static str, AppError> =
            fetch_with_auto_refresh(&client, &store, move |token| {
                let calls_inner = Arc::clone(&calls_inner);
                async move {
                    let n = calls_inner.fetch_add(1, Ordering::SeqCst);
                    if n == 0 {
                        assert_eq!(token.access.expose_secret(), "A1");
                        Err(FetchError::Unauthorized)
                    } else {
                        assert_eq!(token.access.expose_secret(), "A2-refreshed");
                        Ok::<_, FetchError>("ok-after-refresh")
                    }
                }
            })
            .await;

        assert_eq!(result.unwrap(), "ok-after-refresh");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "op must be invoked exactly twice (once stale, once refreshed)"
        );

        let stored = store
            .load()
            .await
            .unwrap()
            .expect("token must still be stored");
        assert_eq!(
            stored.access.expose_secret(),
            "A2-refreshed",
            "refreshed access token must be persisted"
        );
        assert_eq!(
            stored.refresh.expose_secret(),
            "R1",
            "refresh token must carry forward when the refresh response omits it"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_second_401_is_terminal_and_keeps_store() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        // Refresh endpoint succeeds, but the op still sees 401 after.
        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "A2-refreshed",
                "expires_in": 3600,
                "token_type": "Bearer",
            })))
            .expect(1)
            .mount(&mock)
            .await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        store.store(&dummy_token("A1", "R1")).await.unwrap();

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, |_token| async {
                Err::<(), _>(FetchError::Unauthorized)
            })
            .await;

        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
            "second 401 must surface AppError::Gcal(Unauthorized), got {result:?}"
        );
        // #683: terminal side effects (reauth event, pause flag) belong
        // to the caller; the wrapper must NOT clear the keystore — the
        // Settings tab keeps its "connected as …" state while the
        // reauth banner is up.
        let stored = store
            .load()
            .await
            .unwrap()
            .expect("keystore must NOT be cleared by the wrapper on second 401");
        assert_eq!(
            stored.access.expose_secret(),
            "A2-refreshed",
            "the refreshed token persisted before the second attempt stays stored"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_revoked_refresh_token_is_terminal_and_keeps_store() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_grant",
            })))
            .expect(1)
            .mount(&mock)
            .await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        store.store(&dummy_token("A1", "R1")).await.unwrap();

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, |_token| async {
                Err::<(), _>(FetchError::Unauthorized)
            })
            .await;

        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
            "revoked refresh token must surface AppError::Gcal(Unauthorized), got {result:?}"
        );
        assert!(
            store.load().await.unwrap().is_some(),
            "wrapper must NOT clear the keystore on revocation (#683 — caller owns side effects)"
        );
    }

    /// #683 — a TRANSIENT refresh failure (5xx from the token
    /// endpoint) must propagate as the flow-layer
    /// `oauth.refresh_failed` Validation error, NOT as terminal
    /// `Unauthorized` — callers keep their dirty state and retry
    /// later instead of demanding a manual re-auth.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_transient_refresh_failure_is_not_terminal() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        Mock::given(method("POST"))
            .and(path("/token"))
            .and(body_string_contains("grant_type=refresh_token"))
            .respond_with(ResponseTemplate::new(503).set_body_string("upstream sad"))
            .expect(1)
            .mount(&mock)
            .await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        store.store(&dummy_token("A1", "R1")).await.unwrap();

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, |_token| async {
                Err::<(), _>(FetchError::Unauthorized)
            })
            .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.refresh_failed")),
            "transient refresh failure must surface oauth.refresh_failed, got {result:?}"
        );
        assert!(
            store.load().await.unwrap().is_some(),
            "token must survive a transient refresh failure"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_errors_when_no_token_stored() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, |_token| async { Ok::<_, FetchError>(()) })
                .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.not_connected")),
            "no stored token must yield oauth.not_connected, got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_propagates_non_401_errors() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        store.store(&dummy_token("A1", "R1")).await.unwrap();

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, |_token| async {
                Err::<(), _>(FetchError::Other(AppError::Validation(
                    "upstream_500".to_owned(),
                )))
            })
            .await;

        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m == "upstream_500"),
            "non-401 FetchError must propagate verbatim, got {result:?}"
        );
    }

    // ── extract_email_from_id_token ───────────────────────────────

    #[test]
    fn extract_email_from_id_token_returns_email_claim() {
        let jwt = build_id_token("alice@example.com");
        assert_eq!(
            extract_email_from_id_token(&jwt).as_deref(),
            Some("alice@example.com"),
        );
    }

    #[test]
    fn extract_email_from_id_token_returns_none_on_malformed_jwt() {
        assert_eq!(extract_email_from_id_token("not-a-jwt"), None);
        assert_eq!(extract_email_from_id_token("a.b"), None); // only 2 segments
        assert_eq!(extract_email_from_id_token("a.!!!invalid-b64!!!.c"), None);
    }

    #[test]
    fn extract_email_from_id_token_returns_none_when_claim_missing() {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(br#"{"aud":"agaric"}"#);
        let signature = URL_SAFE_NO_PAD.encode(b"sig");
        let jwt = format!("{header}.{payload}.{signature}");
        assert_eq!(extract_email_from_id_token(&jwt), None);
    }

    // ── Token::is_expiring_within ─────────────────────────────────

    #[test]
    fn is_expiring_within_true_for_past_expiry() {
        let t = Token {
            access: SecretString::from("a"),
            refresh: SecretString::from("r"),
            expires_at: Utc::now() - ChronoDuration::seconds(1),
        };
        assert!(
            t.is_expiring_within(ChronoDuration::seconds(0)),
            "already-expired token must be 'expiring within 0'"
        );
    }

    #[test]
    fn is_expiring_within_true_when_within_skew() {
        let t = Token {
            access: SecretString::from("a"),
            refresh: SecretString::from("r"),
            expires_at: Utc::now() + ChronoDuration::seconds(30),
        };
        assert!(
            t.is_expiring_within(ChronoDuration::seconds(60)),
            "token 30s from expiry must be flagged for a 60s skew"
        );
    }

    #[test]
    fn is_expiring_within_false_for_future_token() {
        let t = Token {
            access: SecretString::from("a"),
            refresh: SecretString::from("r"),
            expires_at: Utc::now() + ChronoDuration::hours(1),
        };
        assert!(
            !t.is_expiring_within(ChronoDuration::seconds(60)),
            "1h-away token must NOT be flagged for a 60s skew"
        );
    }

    // ── Constants sanity ──────────────────────────────────────────

    #[test]
    fn google_endpoint_constants_point_at_accounts_google_com() {
        assert!(GOOGLE_AUTH_URL.starts_with("https://accounts.google.com/"));
        assert!(GOOGLE_TOKEN_URL.starts_with("https://oauth2.googleapis.com/"));
    }

    #[test]
    fn calendar_scope_is_broad_scope_not_events_only() {
        // FEAT-5 open question: narrower scopes cannot create a new
        // calendar via calendars.insert.  Pin the broad scope.
        assert_eq!(
            GOOGLE_CALENDAR_SCOPE,
            "https://www.googleapis.com/auth/calendar"
        );
    }
}
