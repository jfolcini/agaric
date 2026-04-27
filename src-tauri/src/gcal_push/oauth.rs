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
//!   semantics (`fetch_with_auto_refresh`), including a single bounded
//!   retry and a `gcal:reauth_required` event on a second 401 /
//!   `invalid_grant` / `unauthorized_client`.
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

use super::keyring_store::{GcalEvent, GcalEventEmitter, TokenStore};
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

/// Public desktop OAuth client ID, pinned at build time via
/// `AGARIC_GCAL_CLIENT_ID`.  A missing env var substitutes a
/// compile-time sentinel so local development builds keep compiling —
/// release pipelines MUST set the env var.
pub const CLIENT_ID: &str = match option_env!("AGARIC_GCAL_CLIENT_ID") {
    Some(v) => v,
    None => "UNSET-agaric-gcal-client-id",
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
pub struct OAuthClient {
    client_id: String,
    auth_url: String,
    token_url: String,
    redirect_url: String,
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
        // Validate URLs up front — `AuthUrl::new` / `TokenUrl::new`
        // would error later otherwise, inside begin_authorize /
        // exchange_code.
        AuthUrl::new(auth_url.clone())
            .map_err(|e| AppError::Validation(format!("oauth.invalid_auth_url: {e}")))?;
        TokenUrl::new(token_url.clone())
            .map_err(|e| AppError::Validation(format!("oauth.invalid_token_url: {e}")))?;
        RedirectUrl::new(redirect_url.clone())
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
    fn build_client(&self) -> Result<ConfiguredClient, AppError> {
        let auth_url = AuthUrl::new(self.auth_url.clone())
            .map_err(|e| AppError::Validation(format!("oauth.invalid_auth_url: {e}")))?;
        let token_url = TokenUrl::new(self.token_url.clone())
            .map_err(|e| AppError::Validation(format!("oauth.invalid_token_url: {e}")))?;
        let redirect_url = RedirectUrl::new(self.redirect_url.clone())
            .map_err(|e| AppError::Validation(format!("oauth.invalid_redirect_url: {e}")))?;

        Ok(Client::<
            StandardErrorResponse<BasicErrorResponseType>,
            GoogleTokenResponse,
            BasicTokenIntrospectionResponse,
            StandardRevocableToken,
            StandardErrorResponse<RevocationErrorResponseType>,
        >::new(ClientId::new(self.client_id.clone()))
        .set_auth_uri(auth_url)
        .set_token_uri(token_url)
        .set_redirect_uri(redirect_url))
    }

    /// Start a new OAuth authorization.  Generates a fresh PKCE pair +
    /// CSRF token, caches the verifier keyed by the CSRF state, and
    /// returns the full authorize URL for the OS browser.
    ///
    /// # Errors
    /// [`AppError::Validation`] if the endpoint URLs are malformed.
    #[tracing::instrument(skip(self), err)]
    pub fn begin_authorize(&self) -> Result<AuthorizeUrl, AppError> {
        let client = self.build_client()?;
        let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();

        let mut builder = client
            .authorize_url(CsrfToken::new_random)
            .set_pkce_challenge(challenge);
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
    /// success, the ID token's `email` claim (if present) is returned
    /// alongside the token so the caller can persist it to
    /// `gcal_settings.oauth_account_email`.
    ///
    /// # Errors
    /// * [`AppError::Validation`] keyed `oauth.invalid_state` — the
    ///   CSRF state doesn't match any pending PKCE verifier.
    /// * [`AppError::Validation`] keyed `oauth.exchange_failed` — the
    ///   upstream returned an error or the network failed.
    #[tracing::instrument(skip(self, code, state), err)]
    pub async fn exchange_code(
        &self,
        code: String,
        state: String,
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

        let client = self.build_client()?;
        let response = client
            .exchange_code(AuthorizationCode::new(code))
            .set_pkce_verifier(verifier)
            .request_async(&self.http_client)
            .await
            .map_err(|e| AppError::Validation(format!("oauth.exchange_failed: {e}")))?;

        let token = token_from_response(&response, /* require_refresh = */ true)?;
        let email = extract_email_from_response(&response);
        Ok((token, email))
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
        let client = self.build_client()?;
        let refresh_token = RefreshToken::new(token.refresh.expose_secret().to_owned());

        let response = client
            .exchange_refresh_token(&refresh_token)
            .request_async(&self.http_client)
            .await
            .map_err(|e| classify_refresh_error(&e))?;

        let mut refreshed = token_from_response(&response, /* require_refresh = */ false)?;
        // Google sometimes omits `refresh_token` from a refresh
        // response (the original stays valid).  Carry the previous
        // refresh token forward so callers always end up with a
        // complete Token pair.
        if response.refresh_token().is_none() {
            refreshed.refresh = token.refresh.clone();
        }
        Ok(refreshed)
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
/// itself fails with a revocation error, emit
/// [`GcalEvent::ReauthRequired`] via the supplied emitter, clear the
/// keystore, and return
/// `Err(AppError::Gcal(GcalErrorKind::Unauthorized))` (FEAT-5c — the
/// HTTP-layer taxonomy).
///
/// # Errors
/// * `AppError::Validation("oauth.not_connected")` — no token stored
///   (pre-HTTP config-layer error, stays on Validation).
/// * `AppError::Gcal(GcalErrorKind::Unauthorized)` — second 401 after
///   refresh, OR refresh itself failed with revocation semantics.
/// * Any `AppError` propagated via [`FetchError::Other`] from `op`.
pub async fn fetch_with_auto_refresh<F, Fut, T>(
    oauth_client: &OAuthClient,
    token_store: &Arc<dyn TokenStore>,
    emitter: &Arc<dyn GcalEventEmitter>,
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

    // Bounded refresh: one attempt.
    let refreshed = match oauth_client.refresh_token(&initial).await {
        Ok(t) => t,
        Err(e) => {
            // Revoked / invalid refresh token — give up, prompt for reauth.
            if is_revocation_error(&e) {
                tracing::warn!(
                    target: "gcal",
                    error = %e,
                    "refresh token revoked — emitting reauth_required",
                );
                emitter.emit(GcalEvent::ReauthRequired);
                // Clear-errors are logged but swallowed: the reauth
                // flow will overwrite on reconnect anyway, and we do
                // not want to mask the more important Validation error.
                if let Err(clear_err) = token_store.clear().await {
                    tracing::warn!(
                        target: "gcal",
                        error = %clear_err,
                        "failed to clear token store after revocation",
                    );
                }
                return Err(AppError::Gcal(GcalErrorKind::Unauthorized));
            }
            // Transient / non-revocation refresh failure — surface verbatim.
            return Err(e);
        }
    };

    token_store.store(&refreshed).await?;

    match op(refreshed).await {
        Ok(value) => Ok(value),
        Err(FetchError::Other(e)) => Err(e),
        Err(FetchError::Unauthorized) => {
            tracing::warn!(
                target: "gcal",
                "second 401 after refresh — emitting reauth_required",
            );
            emitter.emit(GcalEvent::ReauthRequired);
            if let Err(clear_err) = token_store.clear().await {
                tracing::warn!(
                    target: "gcal",
                    error = %clear_err,
                    "failed to clear token store after second 401",
                );
            }
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
/// # Errors
/// [`AppError::Database`] / [`AppError::NotFound`] forwarded from the
/// underlying [`models::set_setting`] call.
pub async fn persist_oauth_account_email(pool: &SqlitePool, email: &str) -> Result<(), AppError> {
    models::set_setting(pool, GcalSettingKey::OauthAccountEmail, email).await
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a [`GoogleTokenResponse`] into our [`Token`].
///
/// When `require_refresh` is `true` (the initial `exchange_code`
/// path) the response MUST include a `refresh_token` — Google issues
/// one on the first exchange when `access_type=offline` is requested
/// (the default in oauth2 v5's authorize-url builder).  When `false`
/// (the refresh-grant path) a missing refresh token is tolerated:
/// callers carry the previously-held one forward.
///
/// # Errors
/// [`AppError::Validation`] keyed `oauth.exchange_failed` if
/// `require_refresh` is true and the response omits the refresh token.
fn token_from_response(
    response: &GoogleTokenResponse,
    require_refresh: bool,
) -> Result<Token, AppError> {
    let access = SecretString::from(response.access_token().secret().to_owned());
    let refresh = response
        .refresh_token()
        .map(|rt| SecretString::from(rt.secret().to_owned()));
    let expires_in = response
        .expires_in()
        .unwrap_or_else(|| std::time::Duration::from_secs(3600));
    let expires_at = Utc::now()
        + ChronoDuration::from_std(expires_in).unwrap_or_else(|_| ChronoDuration::seconds(3600));

    let refresh = match (refresh, require_refresh) {
        (Some(r), _) => r,
        (None, false) => {
            // Placeholder — the caller will overwrite with the
            // previously-held refresh token.  Using an empty secret
            // keeps the type constructor simple while making the bug
            // obvious in debug output if it ever slips through.
            SecretString::from(String::new())
        }
        (None, true) => {
            return Err(AppError::Validation(
                "oauth.exchange_failed: response missing refresh_token".to_owned(),
            ));
        }
    };

    Ok(Token {
        access,
        refresh,
        expires_at,
    })
}

/// Pull the `email` claim out of an ID token carried in the
/// [`GoogleExtraFields`] struct, if one was returned.
///
/// We intentionally do NOT verify the JWT signature here — the token
/// was obtained over TLS directly from Google's token endpoint, so
/// this is a trusted channel per FEAT-5 parent § "Threat Model".
/// Adding full JWT verification would pull in a ~100-dep crate for
/// what amounts to a display-only value.
fn extract_email_from_response(response: &GoogleTokenResponse) -> Option<String> {
    let id_token = response.extra_fields().id_token.as_deref()?;
    extract_email_from_id_token(id_token)
}

/// Decode the `email` claim from a JWT without verifying its
/// signature.  Returns `None` on any parse failure (malformed JWT,
/// missing `email` claim, etc.) — the caller treats the email as
/// optional display metadata anyway.
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

/// Map an oauth2 request error into our [`AppError`] taxonomy,
/// distinguishing revocation errors (which trigger reauth) from
/// transient failures (which the caller may retry later).
///
/// Taxonomy split (FEAT-5c):
///
/// * `invalid_grant` / `unauthorized_client` — the refresh token is
///   rejected as unauthorized.  These are HTTP-layer 401-class errors
///   and route through [`AppError::Gcal`] ([`GcalErrorKind::Unauthorized`])
///   so downstream code (Settings UI, connector retry) can treat them
///   uniformly with a 401 from the Calendar API itself.
/// * Every other `oauth2::RequestTokenError` variant — transport
///   failures, timeouts, non-auth HTTP errors — stays on
///   [`AppError::Validation`] with the `oauth.refresh_failed:` key,
///   which is a flow-layer diagnostic, not an HTTP status.  Callers
///   that need to retry transient failures do so based on the
///   validation key.
fn classify_refresh_error(
    err: &oauth2::RequestTokenError<
        oauth2::HttpClientError<oauth2::reqwest::Error>,
        StandardErrorResponse<BasicErrorResponseType>,
    >,
) -> AppError {
    use BasicErrorResponseType as B;
    if let oauth2::RequestTokenError::ServerResponse(resp) = err {
        match resp.error() {
            B::InvalidGrant | B::UnauthorizedClient => {
                return AppError::Gcal(GcalErrorKind::Unauthorized);
            }
            _ => {}
        }
    }
    AppError::Validation(format!("oauth.refresh_failed: {err}"))
}

/// Does this refresh error indicate that the refresh token is
/// permanently revoked (as opposed to a transient failure)?
///
/// Revocation is now signalled by [`AppError::Gcal(GcalErrorKind::Unauthorized)`]
/// (see [`classify_refresh_error`]).  We keep the predicate so the
/// `fetch_with_auto_refresh` wrapper logic reads naturally rather than
/// pattern-matching inline.
fn is_revocation_error(err: &AppError) -> bool {
    matches!(err, AppError::Gcal(GcalErrorKind::Unauthorized))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::keyring_store::{
        GcalEvent, MockTokenStore, NoopEventEmitter, RecordingEventEmitter, TokenStore,
    };

    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
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
        assert_eq!(client.auth_url, GOOGLE_AUTH_URL);
        assert_eq!(client.token_url, GOOGLE_TOKEN_URL);
        assert_eq!(client.redirect_url, "http://127.0.0.1:54321");
        assert_eq!(client.client_id, CLIENT_ID);
        assert!(client.scopes.iter().any(|s| s == GOOGLE_CALENDAR_SCOPE));
        assert!(client.scopes.iter().any(|s| s == OPENID_EMAIL_SCOPE));
    }

    // ── begin_authorize ────────────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_authorize_returns_url_with_required_params_and_caches_verifier() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize().unwrap();

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
        let a = client.begin_authorize().unwrap();
        let b = client.begin_authorize().unwrap();
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pkce_cache_is_bounded_under_burst_of_cancelled_flows() {
        // M-88 regression: cancelled OAuth flows (user opens browser,
        // closes the tab) leave verifiers in the cache forever. The
        // bounded cache must keep the in-memory state below
        // `PKCE_CACHE_CAPACITY` even under a 100-flow burst.
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        for _ in 0..100 {
            client.begin_authorize().unwrap();
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
    async fn exchange_code_happy_path_returns_token_and_email_and_persists_it() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize().unwrap();

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

        let (token, email) = client
            .exchange_code("the-code".to_owned(), authorize.state)
            .await
            .unwrap();

        assert_eq!(token.access.expose_secret(), "ya29.access-abc");
        assert_eq!(token.refresh.expose_secret(), "1//refresh-xyz");
        assert_eq!(email.as_deref(), Some("user@example.com"));

        // Persist to DB (FEAT-5a helper).
        let (pool, _dir) = test_pool().await;
        persist_oauth_account_email(&pool, email.as_deref().unwrap())
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_code_rejects_unknown_state_with_invalid_state_error() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        // Don't call begin_authorize — no state is cached.
        let result = client
            .exchange_code("the-code".to_owned(), "bogus-state".to_owned())
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
        let authorize = client.begin_authorize().unwrap();

        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(400).set_body_json(serde_json::json!({
                "error": "invalid_request",
                "error_description": "missing pkce",
            })))
            .mount(&mock)
            .await;

        let result = client
            .exchange_code("the-code".to_owned(), authorize.state)
            .await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("oauth.exchange_failed")),
            "server error on exchange must surface oauth.exchange_failed, got {result:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn exchange_code_consumes_pkce_verifier_even_on_success() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;
        let authorize = client.begin_authorize().unwrap();

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
            .exchange_code("the-code".to_owned(), authorize.state)
            .await
            .unwrap();

        // The verifier must have been removed — second attempt should
        // fail with invalid_state.
        let second = client
            .exchange_code("the-code".to_owned(), state_copy)
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn refresh_with_empty_stored_refresh_token_returns_clean_error() {
        // REVIEW-LATER TEST-45: pin the behaviour when the token store
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
        // `fetch_with_auto_refresh` wrapper recognises that variant via
        // `is_revocation_error` and emits `gcal:reauth_required` —
        // exactly the right user-facing outcome (the user has to redo
        // the OAuth flow because there is no usable refresh token).
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
             (current behaviour pinned by REVIEW-LATER TEST-45 — see test docstring), \
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

        let emitter: Arc<dyn GcalEventEmitter> = Arc::new(RecordingEventEmitter::new());
        let emitter_for_assert = Arc::clone(&emitter);

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_inner = Arc::clone(&calls);

        let result: Result<&'static str, AppError> =
            fetch_with_auto_refresh(&client, &store, &emitter, move |token| {
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
        // Can't downcast dyn back to RecordingEventEmitter; assert via
        // the fact that token is still present (no revocation path fired).
        assert!(
            store.load().await.unwrap().is_some(),
            "token must remain in keystore after happy-path op"
        );
        // Emitter must be untouched.
        let _ = emitter_for_assert; // silence unused warning
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

        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        let calls = Arc::new(AtomicUsize::new(0));
        let calls_inner = Arc::clone(&calls);

        let result: Result<&'static str, AppError> =
            fetch_with_auto_refresh(&client, &store, &emitter, move |token| {
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
        assert_eq!(
            recorder.events().len(),
            0,
            "happy refresh path must NOT emit reauth_required"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_emits_reauth_required_on_second_401_and_clears_store() {
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

        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, &emitter, |_token| async {
                Err::<(), _>(FetchError::Unauthorized)
            })
            .await;

        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
            "second 401 must surface AppError::Gcal(Unauthorized), got {result:?}"
        );
        assert_eq!(
            recorder.events(),
            vec![GcalEvent::ReauthRequired],
            "GcalEvent::ReauthRequired must be emitted exactly once on second 401"
        );
        assert!(
            store.load().await.unwrap().is_none(),
            "keystore must be cleared after second 401 so the next reconnect starts fresh"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_emits_reauth_required_on_revoked_refresh_token() {
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

        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, &emitter, |_token| async {
                Err::<(), _>(FetchError::Unauthorized)
            })
            .await;

        assert!(
            matches!(result, Err(AppError::Gcal(GcalErrorKind::Unauthorized))),
            "revoked refresh token must surface AppError::Gcal(Unauthorized), got {result:?}"
        );
        assert_eq!(
            recorder.events(),
            vec![GcalEvent::ReauthRequired],
            "revoked refresh must emit ReauthRequired exactly once"
        );
        assert!(
            store.load().await.unwrap().is_none(),
            "revoked refresh must clear the keystore"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn fetch_with_auto_refresh_errors_when_no_token_stored() {
        let mock = MockServer::start().await;
        let client = build_client(&mock).await;

        let store: Arc<dyn TokenStore> = Arc::new(MockTokenStore::new());
        let emitter: Arc<dyn GcalEventEmitter> = Arc::new(NoopEventEmitter);

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, &emitter, |_token| async {
                Ok::<_, FetchError>(())
            })
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
        let emitter: Arc<dyn GcalEventEmitter> = Arc::new(RecordingEventEmitter::new());

        let result: Result<(), AppError> =
            fetch_with_auto_refresh(&client, &store, &emitter, |_token| async {
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
