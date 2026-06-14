//! FEAT-5e — Tauri commands backing the Settings "Google Calendar"
//! tab.  Consumed from the frontend in FEAT-5f.
//!
//! Five commands:
//!
//! * `get_gcal_status` — connection + lease snapshot for the Settings
//!   tab.
//! * `force_gcal_resync` — fire-and-forget full-window resync.  Wakes
//!   the connector task via [`crate::gcal_push::connector::GcalConnectorHandle::force_resync`].
//! * `disconnect_gcal { delete_calendar }` — clears OAuth tokens +
//!   emits `gcal:push_disabled`.  Optionally deletes the GCal calendar.
//! * `set_gcal_window_days(n)` — persists the window clamped to
//!   `[7, 90]`.
//! * `set_gcal_privacy_mode(mode)` — persists `"full"` or `"minimal"`.
//!
//! Each command has an `inner_*` function taking `&SqlitePool` + trait
//! objects for testability — the Tauri wrapper is the only part that
//! touches `AppHandle` / `State`.

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use super::sanitize_internal_error;
use crate::error::AppError;
use crate::gcal_push::api::GcalApi;
use crate::gcal_push::connector::GcalConnectorHandle;
use crate::gcal_push::keyring_store::{GcalEvent, GcalEventEmitter, TokenStore};
use crate::gcal_push::lease::{self, LeaseState};
use crate::gcal_push::models::{self, GcalSettingKey};
use crate::gcal_push::oauth::{OAuthClient, persist_oauth_account_email};
use crate::gcal_push::oauth_callback::{CallbackParams, bind_one_shot};
use crate::spaces::bootstrap::SPACE_PERSONAL_ULID;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

/// Holder metadata for the push-lease, surfaced to the Settings tab so
/// users can see which device is currently pushing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LeaseHolder {
    pub held_by_this_device: bool,
    pub device_id: Option<String>,
    pub expires_at: Option<String>,
}

/// Outcome of [`begin_gcal_oauth`] — the connected account's email
/// (when Google returned it in the ID token). The frontend uses this
/// to update its connected-state label without waiting for the next
/// status poll, though it also refetches `get_gcal_status` to land
/// the canonical state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct BeginOauthOutcome {
    pub account_email: Option<String>,
}

/// Full status snapshot for the Settings tab.  `connected` reflects
/// the presence of an OAuth token in the keychain; `calendar_id` is
/// only populated after the first push-cycle has created the
/// dedicated calendar.
///
/// L-45: the previous shape carried both `enabled` and `connected`,
/// populated from the same expression. `connected` is the canonical
/// field consumed by the frontend (`GoogleCalendarSettingsTab.tsx`);
/// `enabled` was unused and has been removed to prevent FE/BE drift on
/// future refactors. If a separate "feature toggle" surface is ever
/// needed it should be a distinct field with its own provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct GcalStatus {
    pub connected: bool,
    pub account_email: Option<String>,
    pub calendar_id: Option<String>,
    pub window_days: i64,
    pub privacy_mode: String,
    pub last_push_at: Option<String>,
    pub last_error: Option<String>,
    /// #630: `true` when the connector is paused waiting for the user
    /// to re-authorize (`gcal_settings.reauth_required`).  Without this
    /// field the pause was invisible after a restart: the one-shot
    /// `gcal:reauth_required` event had already fired in a previous
    /// session, `connected` stays `true` (the token is not cleared by
    /// the terminal-401 path) and `last_error` is untouched — Settings
    /// showed a healthy connection while push was permanently paused.
    pub reauth_required: bool,
    pub push_lease: LeaseHolder,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert a [`LeaseState`] into the frontend-facing [`LeaseHolder`]
/// shape, given this device's id.
fn lease_state_to_holder(state: &LeaseState, this_device: &str) -> LeaseHolder {
    LeaseHolder {
        held_by_this_device: !state.device_id.is_empty() && state.device_id == this_device,
        device_id: if state.device_id.is_empty() {
            None
        } else {
            Some(state.device_id.clone())
        },
        expires_at: state
            .expires_at
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
    }
}

fn optionalize(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

async fn last_push_at(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    // Most-recent `last_pushed_at` across every row in
    // `gcal_agenda_event_map`.  `SELECT MAX(...)` returns `NULL` when
    // the table is empty — mapped to `None`.
    let row = sqlx::query!("SELECT MAX(last_pushed_at) AS ts FROM gcal_agenda_event_map")
        .fetch_one(pool)
        .await?;
    Ok(row.ts.filter(|s| !s.is_empty()))
}

// ---------------------------------------------------------------------------
// get_gcal_status
// ---------------------------------------------------------------------------

/// Pure implementation of [`get_gcal_status`] — the Tauri wrapper just
/// resolves managed state and forwards here.
pub async fn get_gcal_status_inner(
    pool: &SqlitePool,
    token_store: &Arc<dyn TokenStore>,
    this_device: &str,
) -> Result<GcalStatus, AppError> {
    // L-44: a transient keyring failure (e.g. `KeyringBackendError::PlatformUnavailable`,
    // surfaced upstream as `AppError::Validation("keyring.unavailable: ...")`) MUST NOT
    // break the Settings → Google Calendar tab. Degrade to `connected = false` and let
    // the user re-auth, but propagate any other (i.e. genuinely unexpected) error.
    let connected = match token_store.load().await {
        Ok(opt) => opt.is_some(),
        Err(e) if matches!(&e, AppError::Validation(msg) if msg.starts_with("keyring.unavailable")) =>
        {
            tracing::warn!(
                target: "gcal",
                error = %e,
                "keyring unavailable; reporting connected=false",
            );
            false
        }
        Err(e) => return Err(e),
    };
    let account_email = models::get_setting(pool, GcalSettingKey::OauthAccountEmail)
        .await?
        .unwrap_or_default();
    let calendar_id = models::get_setting(pool, GcalSettingKey::CalendarId)
        .await?
        .unwrap_or_default();
    let privacy_mode = models::get_setting(pool, GcalSettingKey::PrivacyMode)
        .await?
        .unwrap_or_else(|| "full".to_owned());
    let window_raw = models::get_setting(pool, GcalSettingKey::WindowDays)
        .await?
        .unwrap_or_default();
    let window_days = crate::gcal_push::connector::parse_window_days(&window_raw);
    let push_lease = lease::read_current_lease(pool).await?;
    let last_push = last_push_at(pool).await?;

    // MAINT-169: surface the most-recent transient per-date `Skipped`
    // reason from the connector to the Settings UI. Reads from the
    // Personal-space row because FEAT-3p9 has not yet branched the
    // connector by space (the connector still writes to
    // `SPACE_PERSONAL_ULID` only). When FEAT-3p9 M2 lands, replace this
    // with a per-space accordion. `optionalize` collapses the canonical
    // "" → `None` (empty == healthy).
    let last_error = models::get_space_config(pool, SPACE_PERSONAL_ULID)
        .await?
        .map(|c| c.last_error)
        .unwrap_or_default();

    // #630: surface the persisted pause flag so the Settings tab (and
    // the app-shell reauth banner, which hydrates from this status on
    // mount) can show the paused state across restarts.
    let reauth_required = models::get_reauth_required(pool).await?;

    Ok(GcalStatus {
        connected,
        account_email: optionalize(account_email),
        calendar_id: optionalize(calendar_id),
        window_days,
        privacy_mode,
        last_push_at: last_push,
        last_error: optionalize(last_error),
        reauth_required,
        push_lease: lease_state_to_holder(&push_lease, this_device),
    })
}

// ---------------------------------------------------------------------------
// force_gcal_resync
// ---------------------------------------------------------------------------

/// Pure implementation of [`force_gcal_resync`].  The handle's
/// `force_resync()` method is infallible; the inner fn returns the
/// assertable result for tests.
pub fn force_gcal_resync_inner(handle: &GcalConnectorHandle) {
    handle.force_resync();
}

// ---------------------------------------------------------------------------
// disconnect_gcal
// ---------------------------------------------------------------------------

/// Pure implementation of [`disconnect_gcal`].  Clears OAuth tokens,
/// emits `gcal:push_disabled`, and optionally deletes the dedicated
/// calendar.  All steps are idempotent — the user may click disconnect
/// multiple times without error.
pub async fn disconnect_gcal_inner(
    pool: &SqlitePool,
    api: &GcalApi,
    token_store: &Arc<dyn TokenStore>,
    emitter: &Arc<dyn GcalEventEmitter>,
    delete_calendar: bool,
) -> Result<(), AppError> {
    // Load a token for the optional calendar-delete call BEFORE we
    // clear the store.  If the token is gone we cannot delete remotely;
    // that is a soft failure (logged, no error surfaced).
    //
    // M-36: a keyring transient error here MUST NOT abort the disconnect.
    // The user clicking disconnect *because* the keyring is misbehaving is
    // exactly the user who needs the local cleanup to succeed; demote the
    // failure to a warn-log and continue with `None` (no remote delete is
    // possible, but that branch already handles missing tokens).
    let token = if delete_calendar {
        match token_store.load().await {
            Ok(tok) => tok,
            Err(e) => {
                tracing::warn!(
                    target: "gcal",
                    error = %e,
                    "keyring unavailable during disconnect; continuing",
                );
                None
            }
        }
    } else {
        None
    };

    // Optional remote delete.  If the token is missing OR the client
    // fails, we log and continue — the local cleanup MUST still happen.
    if delete_calendar {
        let calendar_id = models::get_setting(pool, GcalSettingKey::CalendarId)
            .await?
            .unwrap_or_default();
        match (token, calendar_id.as_str()) {
            (Some(tok), cid) if !cid.is_empty() => {
                if let Err(e) = api.delete_calendar(&tok, cid).await {
                    tracing::warn!(
                        target: "gcal",
                        error = %e,
                        "delete_calendar failed; continuing with local disconnect",
                    );
                }
            }
            _ => {
                tracing::warn!(
                    target: "gcal",
                    "delete_calendar requested but no token or no calendar_id — skipping remote delete",
                );
            }
        }
    }

    // M-37: clear the OAuth tokens BEFORE the SQL transaction below.
    // Keyring `clear()` cannot live inside a SQLite tx, so the two
    // sides cannot be made atomic — ordering picks which half-failure
    // is recoverable.  Doing the keyring clear first means a SQL-tx
    // failure leaves "tokens gone, settings still populated", which a
    // retry of disconnect cleanly resolves (the second attempt's
    // empty-keyring skips the remote delete but the SQL tx still
    // runs).  The reverse ordering would leave tokens stranded in the
    // keyring with the user-visible email blank — the surface bug
    // M-37 fixes.
    //
    // M-36: a keyring failure here is demoted to a warn-log so the
    // SQL-side cleanup proceeds regardless.
    if let Err(e) = token_store.clear().await {
        tracing::warn!(
            target: "gcal",
            error = %e,
            "token_store.clear failed during disconnect",
        );
    }

    // M-37: wrap the three settings/event-map writes in a single
    // BEGIN IMMEDIATE transaction so they succeed-or-fail together.
    // A failure mid-flight cannot leave a half-disconnected state
    // (e.g. calendar_id reset but oauth_account_email still populated
    // → "Connected as alice@example.com — keyring missing tokens" in
    // Settings).  `oauth_account_email` is always cleared, even when
    // `delete_calendar = false`, matching the prior behaviour.
    // allow-raw-tx: writes settings + gcal map, no op_log (#110)
    let mut tx = crate::db::begin_immediate_logged(pool, "gcal_disconnect").await?;
    if delete_calendar {
        models::set_setting_in_tx(&mut *tx, GcalSettingKey::CalendarId.as_str(), "").await?;
        sqlx::query!("DELETE FROM gcal_agenda_event_map")
            .execute(&mut *tx)
            .await?;
    }
    models::set_setting_in_tx(&mut *tx, GcalSettingKey::OauthAccountEmail.as_str(), "").await?;
    tx.commit().await?;

    // Signal the frontend.  MUST happen after the commit so subscribers
    // observing PushDisabled can trust the DB-side state has landed.
    emitter.emit(GcalEvent::PushDisabled);
    Ok(())
}

// ---------------------------------------------------------------------------
// set_gcal_window_days
// ---------------------------------------------------------------------------

/// Pure implementation of [`set_gcal_window_days`].  Input is clamped
/// to `[MIN_WINDOW_DAYS, MAX_WINDOW_DAYS]` before persistence so the
/// connector does not have to re-validate.
pub async fn set_gcal_window_days_inner(pool: &SqlitePool, n: i32) -> Result<i32, AppError> {
    // L-49: the clamp below produces a value in
    // `[MIN_WINDOW_DAYS, MAX_WINDOW_DAYS]` (currently `[7, 90]`), which
    // always fits in i32. Make the impossibility a panic guard rather than
    // a dead `unwrap_or_else` fallback so future refactors that widen the
    // bounds past `i32::MAX` fail loudly instead of silently coercing.
    let clamped: i32 = i64::from(n)
        .clamp(
            crate::gcal_push::connector::MIN_WINDOW_DAYS,
            crate::gcal_push::connector::MAX_WINDOW_DAYS,
        )
        .try_into()
        .expect("clamped to [MIN_WINDOW_DAYS, MAX_WINDOW_DAYS] always fits i32");
    models::set_setting(pool, GcalSettingKey::WindowDays, &clamped.to_string()).await?;
    Ok(clamped)
}

// ---------------------------------------------------------------------------
// set_gcal_privacy_mode
// ---------------------------------------------------------------------------

/// Pure implementation of [`set_gcal_privacy_mode`].  Accepts only
/// `"full"` or `"minimal"`; any other value is rejected as
/// [`AppError::Validation`].
pub async fn set_gcal_privacy_mode_inner(pool: &SqlitePool, mode: &str) -> Result<(), AppError> {
    match mode {
        "full" | "minimal" => {
            models::set_setting(pool, GcalSettingKey::PrivacyMode, mode).await?;
            Ok(())
        }
        other => Err(AppError::Validation(format!(
            "gcal.privacy_mode.invalid: '{other}' (expected 'full' or 'minimal')"
        ))),
    }
}

// ---------------------------------------------------------------------------
// begin_gcal_oauth
// ---------------------------------------------------------------------------

/// Hard timeout for the loopback OAuth callback. Matches the human-paced
/// nature of the consent flow (user has to click through the browser);
/// abandoned flows release the listener and resolve with
/// `AppError::Validation("oauth.timeout")` so the FE can show a typed
/// error toast.
const OAUTH_CALLBACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// Pure implementation of [`begin_gcal_oauth`].  Runs the loopback
/// OAuth dance: bind 127.0.0.1, build the authorize URL with that
/// per-flow redirect_uri, open the URL in the OS browser via the
/// caller-supplied `open_browser` callback, wait for the redirect,
/// exchange the code, persist the token + email.
///
/// Separated from the Tauri wrapper so unit tests can drive the
/// callback path without needing a real `AppHandle` — the test
/// supplies a closure that drives a TcpStream into the listener.
///
/// # Errors
/// * [`AppError::Validation`] keyed `oauth.timeout` — the user didn't
///   complete the consent flow within [`OAUTH_CALLBACK_TIMEOUT`].
/// * [`AppError::Validation`] keyed `oauth.invalid_state` — the
///   returned CSRF state didn't match the one we issued (the
///   verifier-cache miss).
/// * [`AppError::Validation`] keyed `oauth.exchange_failed` — Google
///   rejected the code-for-token exchange.
/// * [`AppError::Validation`] keyed `oauth.client_misconfigured` —
///   the client opens the browser failed (typically a sandboxed dev
///   build with no default browser registered).
pub async fn begin_gcal_oauth_inner<F>(
    pool: &SqlitePool,
    oauth_client: &OAuthClient,
    token_store: &Arc<dyn TokenStore>,
    open_browser: F,
) -> Result<BeginOauthOutcome, AppError>
where
    F: FnOnce(String) -> Result<(), AppError>,
{
    // 1. Bind the loopback listener and capture the chosen port.
    let (port, callback_future) = bind_one_shot(OAUTH_CALLBACK_TIMEOUT).await?;
    let redirect_uri = format!("http://127.0.0.1:{port}/oauth/callback");

    // 2. Build the authorize URL with that exact redirect_uri so
    //    Google's response lands on our listener.
    let authorize = oauth_client.begin_authorize(redirect_uri.clone())?;

    // 3. Open the URL in the OS browser. Failures here are surfaced as
    //    `oauth.client_misconfigured` so the FE can show a dedicated
    //    error toast distinct from network failures.
    open_browser(authorize.url.clone()).map_err(|e| match e {
        AppError::Validation(_) => e,
        other => AppError::Validation(format!(
            "oauth.client_misconfigured: failed to open browser ({other})"
        )),
    })?;

    // 4. Wait for the redirect with code + state.
    let CallbackParams {
        code,
        state: returned_state,
    } = callback_future.await?;

    // 5. Defence in depth: the CSRF state must equal the one we issued.
    //    `exchange_code` ALSO validates this via its PKCE-cache lookup,
    //    but the explicit check here surfaces a typed
    //    `oauth.invalid_state` error before we touch the network.
    if returned_state != authorize.state {
        return Err(AppError::Validation("oauth.invalid_state".to_owned()));
    }

    // 6. Trade the code for a token pair + (optional) account email.
    let (token, email) = oauth_client
        .exchange_code(code, returned_state, Some(redirect_uri))
        .await?;

    // 7. Persist the token to the keychain and the email to the DB.
    token_store.store(&token).await?;

    // #630: clear the connector's pause flag UNCONDITIONALLY once the
    // fresh token is stored.  The clear used to live only inside
    // `persist_oauth_account_email`, which runs solely when Google
    // returned an email claim — if the user unchecked the email grant
    // (or the id_token was missing/unparseable), a fully successful
    // re-auth left the connector paused forever.  A failure to clear is
    // logged but does not fail the connect (matches the best-effort
    // posture inside `persist_oauth_account_email`).
    if let Err(e) = models::set_reauth_required(pool, false).await {
        tracing::warn!(
            target: "gcal",
            error = %e,
            "failed to clear reauth_required after successful token store; \
             connector stays paused until the flag clears",
        );
    }

    if let Some(email_str) = email.as_deref() {
        persist_oauth_account_email(pool, email_str).await?;
    }

    Ok(BeginOauthOutcome {
        account_email: email,
    })
}

// ---------------------------------------------------------------------------
// Tauri wrappers
// ---------------------------------------------------------------------------

/// Tauri command: report the GCal connector's connect/sync status to
/// the Settings tab. Delegates to [`get_gcal_status_inner`].
#[tauri::command]
#[specta::specta]
pub async fn get_gcal_status(
    pool: tauri::State<'_, crate::db::ReadPool>,
    token_store: tauri::State<'_, GcalTokenStoreState>,
    device_id: tauri::State<'_, crate::device::DeviceId>,
) -> Result<GcalStatus, AppError> {
    get_gcal_status_inner(&pool.inner().0, &token_store.inner().0, device_id.as_str())
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: poke the GCal connector to run a resync immediately
/// (rather than waiting for the next scheduled tick). Delegates to
/// [`force_gcal_resync_inner`].
#[tauri::command]
#[specta::specta]
pub async fn force_gcal_resync(
    handle: tauri::State<'_, GcalConnectorHandle>,
) -> Result<(), AppError> {
    force_gcal_resync_inner(handle.inner());
    Ok(())
}

/// Tauri command: disconnect the GCal account (revoke tokens, optionally
/// delete the synced calendar). Delegates to [`disconnect_gcal_inner`].
#[tauri::command]
#[specta::specta]
pub async fn disconnect_gcal(
    pool: tauri::State<'_, crate::db::WritePool>,
    client: tauri::State<'_, GcalClientState>,
    token_store: tauri::State<'_, GcalTokenStoreState>,
    emitter: tauri::State<'_, GcalEventEmitterState>,
    delete_calendar: bool,
) -> Result<(), AppError> {
    disconnect_gcal_inner(
        &pool.inner().0,
        client.inner().0.as_ref(),
        &token_store.inner().0,
        &emitter.inner().0,
        delete_calendar,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: update the GCal sync window (days before/after today
/// that are mirrored to the connected calendar). The value is clamped
/// to `[MIN_WINDOW_DAYS, MAX_WINDOW_DAYS]` in the inner. Delegates to
/// [`set_gcal_window_days_inner`].
#[tauri::command]
#[specta::specta]
pub async fn set_gcal_window_days(
    pool: tauri::State<'_, crate::db::WritePool>,
    n: i32,
) -> Result<i32, AppError> {
    set_gcal_window_days_inner(&pool.inner().0, n)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: update the GCal privacy mode (`"full"` vs.
/// `"minimal"` event-body sharing). Delegates to
/// [`set_gcal_privacy_mode_inner`].
#[tauri::command]
#[specta::specta]
pub async fn set_gcal_privacy_mode(
    pool: tauri::State<'_, crate::db::WritePool>,
    mode: String,
) -> Result<(), AppError> {
    set_gcal_privacy_mode_inner(&pool.inner().0, &mode)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: kick off the desktop OAuth flow. Binds a loopback
/// listener, opens the authorize URL in the OS browser, waits for the
/// redirect, exchanges the code, persists the token + email.
///
/// Returns the unverified account email so the FE can update its
/// connected-state label without waiting for the next status poll.
#[tauri::command]
#[specta::specta]
pub async fn begin_gcal_oauth(
    app: tauri::AppHandle,
    pool: tauri::State<'_, crate::db::WritePool>,
    oauth_client: tauri::State<'_, GcalOAuthClientState>,
    token_store: tauri::State<'_, GcalTokenStoreState>,
) -> Result<BeginOauthOutcome, AppError> {
    let app_for_open = app.clone();
    let outcome = begin_gcal_oauth_inner(
        &pool.inner().0,
        oauth_client.inner().0.as_ref(),
        &token_store.inner().0,
        move |url| {
            use tauri_plugin_opener::OpenerExt;
            app_for_open
                .opener()
                .open_url(url, None::<&str>)
                .map_err(|e| AppError::Validation(format!("oauth.open_browser_failed: {e}")))
        },
    )
    .await
    .map_err(sanitize_internal_error)?;
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// Managed-state wrappers (so tauri::State resolves over trait objects)
// ---------------------------------------------------------------------------

/// Newtype wrapping the `Arc<dyn TokenStore>` so Tauri managed state
/// can hold the trait object without `TokenStore` having to be a
/// concrete type.
pub struct GcalTokenStoreState(pub Arc<dyn TokenStore>);

/// Newtype wrapping the `Arc<dyn GcalEventEmitter>`.
pub struct GcalEventEmitterState(pub Arc<dyn GcalEventEmitter>);

/// Newtype wrapping the `Arc<GcalApi>` — used by
/// [`disconnect_gcal`] to invoke `delete_calendar`.
pub struct GcalClientState(pub Arc<GcalApi>);

/// Newtype wrapping the `Arc<OAuthClient>` — used by [`begin_gcal_oauth`]
/// to share the PKCE verifier cache with the connector's auto-refresh
/// path. A single shared instance is load-bearing: the verifier
/// produced by `begin_authorize` must be recoverable by the matching
/// `exchange_code` call, and both go through the same client.
pub struct GcalOAuthClientState(pub Arc<OAuthClient>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::gcal_push::connector::testing::dummy_token;
    use crate::gcal_push::keyring_store::{
        MockTokenStore, NoopEventEmitter, RecordingEventEmitter,
    };
    use std::path::PathBuf;
    use tempfile::TempDir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const THIS_DEVICE: &str = "device-THIS";
    const OTHER_DEVICE: &str = "device-OTHER";

    /// Calendar id reused across the disconnect tests when a wiremock
    /// path matcher needs to resolve `/calendars/{id}`.
    const TEST_CAL_ID: &str = "cal_XYZ";

    /// Build a [`GcalApi`] for tests that drive `disconnect_gcal_inner`
    /// with `delete_calendar = false` (or with `delete_calendar = true`
    /// but expect the remote-delete branch to be skipped because the
    /// token / calendar id is unavailable).  The base URL is parseable
    /// but unreachable; if a test path accidentally issues an HTTP call
    /// it will surface a transport error rather than silently passing.
    fn make_api_no_remote() -> GcalApi {
        GcalApi::with_base_url("http://127.0.0.1:1").expect("api construction must succeed")
    }

    /// Build a [`GcalApi`] pointed at the given wiremock server.
    fn make_api(server: &MockServer) -> GcalApi {
        GcalApi::with_base_url(&server.uri()).expect("api construction must succeed")
    }

    /// Count requests received by `server` whose method+path-prefix
    /// match the given filter.  Mirrors the helper in `connector.rs`.
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

    async fn test_pool() -> (SqlitePool, TempDir) {
        let dir = TempDir::new().unwrap();
        let db_path: PathBuf = dir.path().join("test.db");
        let pool = init_pool(&db_path).await.unwrap();
        (pool, dir)
    }

    async fn store_with(token: Option<crate::gcal_push::oauth::Token>) -> Arc<dyn TokenStore> {
        let s = MockTokenStore::new();
        if let Some(t) = token {
            s.store(&t).await.unwrap();
        }
        Arc::new(s)
    }

    fn noop_emitter() -> Arc<dyn GcalEventEmitter> {
        Arc::new(NoopEventEmitter)
    }

    /// Test-only [`TokenStore`] that simulates a transient keyring
    /// failure on configurable methods.  Drives the M-36 / L-44
    /// regression tests for the "keyring unavailable" branches without
    /// going through the real `KeyringTokenStore` plumbing.
    struct FailingTokenStore {
        fail_load: bool,
        fail_clear: bool,
    }

    #[async_trait::async_trait]
    impl TokenStore for FailingTokenStore {
        async fn load(&self) -> Result<Option<crate::gcal_push::oauth::Token>, AppError> {
            if self.fail_load {
                Err(AppError::Validation(
                    "keyring.unavailable: simulated transient failure".to_owned(),
                ))
            } else {
                Ok(None)
            }
        }

        async fn store(&self, _token: &crate::gcal_push::oauth::Token) -> Result<(), AppError> {
            Ok(())
        }

        async fn clear(&self) -> Result<(), AppError> {
            if self.fail_clear {
                Err(AppError::Validation(
                    "keyring.unavailable: simulated transient failure".to_owned(),
                ))
            } else {
                Ok(())
            }
        }
    }

    // ── get_gcal_status_inner ──────────────────────────────────────

    #[tokio::test]
    async fn get_status_no_tokens_reports_disconnected() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;
        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();
        assert!(!status.connected, "no tokens → not connected");
        assert_eq!(status.account_email, None);
        assert_eq!(status.calendar_id, None);
        assert_eq!(status.privacy_mode, "full", "default privacy is 'full'");
        assert_eq!(status.window_days, 30, "default window is 30");
        assert!(!status.push_lease.held_by_this_device);
        assert_eq!(status.push_lease.device_id, None);
    }

    #[tokio::test]
    async fn get_status_connected_without_calendar_or_lease() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();
        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();
        assert!(status.connected);
        assert_eq!(status.account_email.as_deref(), Some("me@example.com"));
        assert_eq!(status.calendar_id, None);
        assert!(!status.push_lease.held_by_this_device);
    }

    #[tokio::test]
    async fn get_status_with_calendar_and_lease_held_by_this_device() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_XYZ")
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();
        // Claim the lease as THIS_DEVICE.
        let now = chrono::Utc::now();
        assert!(lease::claim_lease(&pool, THIS_DEVICE, now).await.unwrap());

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();
        assert_eq!(status.calendar_id.as_deref(), Some("cal_XYZ"));
        assert!(status.push_lease.held_by_this_device);
        assert_eq!(status.push_lease.device_id.as_deref(), Some(THIS_DEVICE));
        assert!(
            status.push_lease.expires_at.is_some(),
            "lease expiry must be populated"
        );
    }

    #[tokio::test]
    async fn get_status_reports_lease_held_by_other_device() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        let now = chrono::Utc::now();
        assert!(lease::claim_lease(&pool, OTHER_DEVICE, now).await.unwrap());

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();
        assert!(!status.push_lease.held_by_this_device);
        assert_eq!(status.push_lease.device_id.as_deref(), Some(OTHER_DEVICE),);
    }

    #[tokio::test]
    async fn get_status_degrades_to_disconnected_on_keyring_unavailable() {
        // L-44 regression: a transient keyring failure (PlatformUnavailable,
        // surfaced as `AppError::Validation("keyring.unavailable: ...")`) must
        // NOT abort the Settings tab.  Degrade to connected=false so the user
        // can see the rest of the status and re-auth.
        let (pool, _dir) = test_pool().await;
        let store: Arc<dyn TokenStore> = Arc::new(FailingTokenStore {
            fail_load: true,
            fail_clear: false,
        });

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .expect("status read must NOT propagate a keyring-unavailable error");

        assert!(
            !status.connected,
            "keyring unavailable must degrade to connected=false"
        );
    }

    /// MAINT-169 reader: when the connector has persisted a transient
    /// `Skipped` reason to `gcal_space_config[Personal].last_error`,
    /// `get_gcal_status_inner` must surface it to the Settings UI as
    /// `Some(reason)` (was hard-coded `None` before this fix).
    #[tokio::test]
    async fn get_status_surfaces_persisted_last_error_from_personal_space_row() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;

        // Seed the Personal-space row directly (no need to bootstrap
        // spaces — `get_gcal_status_inner` only reads the row by id).
        let now = chrono::Utc::now();
        let mut cfg = crate::gcal_push::models::default_space_config(SPACE_PERSONAL_ULID, now);
        cfg.last_error = "rate-limited: HTTP 429".to_owned();
        crate::gcal_push::models::upsert_space_config(&pool, &cfg)
            .await
            .unwrap();

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();

        assert_eq!(
            status.last_error.as_deref(),
            Some("rate-limited: HTTP 429"),
            "MAINT-169: persisted last_error must surface to Settings UI",
        );
    }

    /// MAINT-169 reader: empty `last_error` (the canonical "healthy"
    /// state per migration 0041) collapses to `None` via
    /// `optionalize`, matching the pre-fix Settings-UI shape.
    #[tokio::test]
    async fn get_status_collapses_empty_last_error_to_none() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;

        // Seed the Personal-space row with an empty `last_error`
        // (the migration default).
        let now = chrono::Utc::now();
        let cfg = crate::gcal_push::models::default_space_config(SPACE_PERSONAL_ULID, now);
        assert_eq!(
            cfg.last_error, "",
            "default_space_config seeds empty last_error"
        );
        crate::gcal_push::models::upsert_space_config(&pool, &cfg)
            .await
            .unwrap();

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();

        assert_eq!(
            status.last_error, None,
            "MAINT-169: empty last_error must collapse to None (\"\" == healthy)",
        );
    }

    /// MAINT-169 reader: when no per-space row exists yet (fresh
    /// install pre-FEAT-3p9 migration), `last_error` must remain
    /// `None` rather than propagating an error.
    #[tokio::test]
    async fn get_status_returns_none_last_error_when_personal_row_absent() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;

        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();

        assert_eq!(
            status.last_error, None,
            "MAINT-169: missing Personal-space row must yield last_error=None, not an error",
        );
    }

    // ── set_gcal_window_days_inner ─────────────────────────────────

    #[tokio::test]
    async fn set_window_days_happy_path_persists_value() {
        let (pool, _dir) = test_pool().await;
        let got = set_gcal_window_days_inner(&pool, 30).await.unwrap();
        assert_eq!(got, 30);
        let stored = models::get_setting(&pool, GcalSettingKey::WindowDays)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(stored, "30");
    }

    #[tokio::test]
    async fn set_window_days_clamps_below_min() {
        let (pool, _dir) = test_pool().await;
        let got = set_gcal_window_days_inner(&pool, 6).await.unwrap();
        assert_eq!(got, 7, "value below MIN_WINDOW_DAYS must clamp to 7");
        let stored = models::get_setting(&pool, GcalSettingKey::WindowDays)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(stored, "7");
    }

    #[tokio::test]
    async fn set_window_days_clamps_above_max() {
        let (pool, _dir) = test_pool().await;
        let got = set_gcal_window_days_inner(&pool, 91).await.unwrap();
        assert_eq!(got, 90, "value above MAX_WINDOW_DAYS must clamp to 90");
        let stored = models::get_setting(&pool, GcalSettingKey::WindowDays)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(stored, "90");
    }

    // ── set_gcal_privacy_mode_inner ────────────────────────────────

    #[tokio::test]
    async fn set_privacy_mode_accepts_full_and_minimal() {
        let (pool, _dir) = test_pool().await;
        set_gcal_privacy_mode_inner(&pool, "full").await.unwrap();
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::PrivacyMode)
                .await
                .unwrap()
                .as_deref(),
            Some("full"),
        );
        set_gcal_privacy_mode_inner(&pool, "minimal").await.unwrap();
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::PrivacyMode)
                .await
                .unwrap()
                .as_deref(),
            Some("minimal"),
        );
    }

    #[tokio::test]
    async fn set_privacy_mode_rejects_invalid() {
        let (pool, _dir) = test_pool().await;
        let err = set_gcal_privacy_mode_inner(&pool, "snoop")
            .await
            .unwrap_err();
        assert!(
            matches!(err, AppError::Validation(ref msg) if msg.contains("gcal.privacy_mode.invalid")),
            "invalid privacy mode must surface Validation(gcal.privacy_mode.invalid), got {err:?}",
        );
    }

    // ── disconnect_gcal_inner ──────────────────────────────────────

    #[tokio::test]
    async fn disconnect_without_delete_calendar_clears_tokens_only() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        // delete_calendar=false → no HTTP call should ever happen.
        // We point the API at an unreachable base URL so an accidental
        // call would surface as a transport error, not a silent no-op.
        let api = make_api_no_remote();
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        // Seed a calendar_id to verify it survives.
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_KEEP")
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();

        disconnect_gcal_inner(&pool, &api, &store, &emitter, false)
            .await
            .unwrap();

        // Tokens cleared.
        assert!(
            store.load().await.unwrap().is_none(),
            "tokens must be cleared after disconnect"
        );
        // calendar_id preserved.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::CalendarId)
                .await
                .unwrap()
                .as_deref(),
            Some("cal_KEEP"),
            "calendar_id must survive disconnect(delete_calendar=false)",
        );
        // account_email cleared.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
                .await
                .unwrap()
                .unwrap_or_default(),
            "",
        );
        // Event emitted.
        assert!(
            recorder.events().contains(&GcalEvent::PushDisabled),
            "push_disabled must be emitted, got {:?}",
            recorder.events()
        );
    }

    #[tokio::test]
    async fn disconnect_with_delete_calendar_invokes_mock_delete() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        // wiremock asserts the DELETE /calendars/{id} request lands.
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{TEST_CAL_ID}")))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let api = make_api(&server);
        let emitter = noop_emitter();

        models::set_setting(&pool, GcalSettingKey::CalendarId, TEST_CAL_ID)
            .await
            .unwrap();
        // Seed a map row to verify it is wiped.
        let entry = crate::gcal_push::models::GcalAgendaEventMap {
            date: "2026-04-22".to_owned(),
            gcal_event_id: "evt_1".to_owned(),
            last_pushed_hash: "deadbeef".to_owned(),
            last_pushed_at: crate::now_rfc3339(),
        };
        crate::gcal_push::models::upsert_event_map(&pool, &entry)
            .await
            .unwrap();

        disconnect_gcal_inner(&pool, &api, &store, &emitter, true)
            .await
            .unwrap();

        // Server saw exactly one DELETE /calendars/{TEST_CAL_ID}.  The
        // `.expect(1)` mock assertion above is verified on Drop; the
        // explicit count below produces a clearer failure message if
        // the connector ever drifts.
        assert_eq!(
            count_requests(&server, "DELETE", &format!("/calendars/{TEST_CAL_ID}")).await,
            1,
            "delete_calendar must be called exactly once when delete_calendar=true",
        );

        // calendar_id cleared.
        let cal_id = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(cal_id, "", "calendar_id must be cleared");
        // Map rows wiped.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "event map must be wiped");
        // Tokens cleared.
        assert!(store.load().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn disconnect_with_delete_calendar_continues_when_token_load_fails() {
        // M-36 regression: when delete_calendar=true, a keyring transient
        // failure on `token_store.load()` MUST be demoted to a warn-log so
        // local cleanup (calendar_id reset, event-map wipe, account_email
        // clear, PushDisabled emit) still runs. Before the fix, the `?`
        // on the load call short-circuited and left the user in a
        // half-disconnected state.
        let (pool, _dir) = test_pool().await;
        let token_store: Arc<dyn TokenStore> = Arc::new(FailingTokenStore {
            fail_load: true,
            fail_clear: false,
        });
        // The remote-delete branch is unreachable here (token load
        // returns None → the `(Some(tok), cid)` arm fails to match),
        // so we point the API at an unreachable URL — any accidental
        // call would surface as a transport error.
        let api = make_api_no_remote();
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        // Seed a calendar_id and event-map row so we can assert local
        // cleanup ran.
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_FAIL")
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();
        let entry = crate::gcal_push::models::GcalAgendaEventMap {
            date: "2026-04-22".to_owned(),
            gcal_event_id: "evt_1".to_owned(),
            last_pushed_hash: "deadbeef".to_owned(),
            last_pushed_at: crate::now_rfc3339(),
        };
        crate::gcal_push::models::upsert_event_map(&pool, &entry)
            .await
            .unwrap();

        // Disconnect must succeed even though token_store.load() errors.
        disconnect_gcal_inner(&pool, &api, &token_store, &emitter, true)
            .await
            .expect(
                "disconnect must succeed even when keyring is unavailable (M-36 regression guard)",
            );

        // Local cleanup happened: calendar_id cleared.
        let cal_id = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(
            cal_id, "",
            "calendar_id must be cleared even after keyring load failure"
        );

        // Event-map wiped.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count.0, 0,
            "event map must be wiped even after keyring load failure"
        );

        // account_email cleared.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
                .await
                .unwrap()
                .unwrap_or_default(),
            "",
            "account_email must be cleared even after keyring load failure"
        );

        // PushDisabled emitted — UX promise that disconnect "succeeded".
        assert!(
            recorder.events().contains(&GcalEvent::PushDisabled),
            "push_disabled must be emitted even when keyring load fails, got {:?}",
            recorder.events()
        );
    }

    #[tokio::test]
    async fn disconnect_with_delete_calendar_clears_all_state_atomically() {
        // M-37 regression guard: with delete_calendar=true, all four
        // side effects (token cleared, calendar_id reset, event-map
        // wiped, oauth_account_email reset) MUST be observed after a
        // successful disconnect.  The prior implementation issued the
        // four writes as independent calls so a mid-flight failure
        // could leave a half-disconnected state; the fix wraps the
        // three SQL writes in one BEGIN IMMEDIATE tx, with the keyring
        // clear sequenced in front of it.
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path(format!("/calendars/{TEST_CAL_ID}")))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let api = make_api(&server);
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        // Populate every piece of state cleared by disconnect.
        models::set_setting(&pool, GcalSettingKey::CalendarId, TEST_CAL_ID)
            .await
            .unwrap();
        models::set_setting(&pool, GcalSettingKey::OauthAccountEmail, "me@example.com")
            .await
            .unwrap();
        let entry = crate::gcal_push::models::GcalAgendaEventMap {
            date: "2026-04-22".to_owned(),
            gcal_event_id: "evt_1".to_owned(),
            last_pushed_hash: "deadbeef".to_owned(),
            last_pushed_at: crate::now_rfc3339(),
        };
        crate::gcal_push::models::upsert_event_map(&pool, &entry)
            .await
            .unwrap();

        disconnect_gcal_inner(&pool, &api, &store, &emitter, true)
            .await
            .unwrap();

        // Token cleared.
        assert!(
            store.load().await.unwrap().is_none(),
            "token must be cleared",
        );
        // calendar_id is empty.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::CalendarId)
                .await
                .unwrap()
                .unwrap_or_default(),
            "",
            "calendar_id must be cleared",
        );
        // oauth_account_email is empty.
        assert_eq!(
            models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
                .await
                .unwrap()
                .unwrap_or_default(),
            "",
            "oauth_account_email must be cleared",
        );
        // event-map is empty.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count.0, 0, "event-map must be wiped");
        // PushDisabled emitted after the tx committed.
        assert!(
            recorder.events().contains(&GcalEvent::PushDisabled),
            "push_disabled must be emitted, got {:?}",
            recorder.events()
        );
    }

    #[tokio::test]
    async fn disconnect_rolls_back_db_writes_when_in_tx_write_fails() {
        // M-37 regression guard: the three DB writes (calendar_id
        // reset, event-map wipe, oauth_account_email reset) MUST run
        // in a single BEGIN IMMEDIATE tx so a mid-flight failure
        // cannot leave a half-disconnected state.  We engineer a
        // failure on the LAST in-tx write by deleting the seeded
        // `oauth_account_email` row up front — `set_setting_in_tx`
        // returns NotFound when rows_affected == 0, which propagates
        // out via `?` and drops the tx unrolled.  The earlier writes
        // (calendar_id reset, event-map wipe) must therefore be
        // rolled back.
        //
        // Note on what is *not* rolled back: the keyring clear is
        // sequenced before the tx (it cannot live inside one), so the
        // token IS cleared even on tx failure — this is the M-37
        // ordering rationale.  The next disconnect retry observes
        // empty keyring (skips remote delete) and re-runs the tx.
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;
        // The remote DELETE on the calendar happens *before* the SQL
        // tx, so we wire wiremock for it.  The 200 response means the
        // remote-delete branch succeeds and the tx then runs and fails.
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/calendars/cal_KEEP"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let api = make_api(&server);
        let recorder = Arc::new(RecordingEventEmitter::new());
        let emitter: Arc<dyn GcalEventEmitter> = recorder.clone();

        // Seed pre-disconnect state we expect to survive the rollback.
        models::set_setting(&pool, GcalSettingKey::CalendarId, "cal_KEEP")
            .await
            .unwrap();
        let entry = crate::gcal_push::models::GcalAgendaEventMap {
            date: "2026-04-22".to_owned(),
            gcal_event_id: "evt_1".to_owned(),
            last_pushed_hash: "deadbeef".to_owned(),
            last_pushed_at: crate::now_rfc3339(),
        };
        crate::gcal_push::models::upsert_event_map(&pool, &entry)
            .await
            .unwrap();

        // Sabotage: drop the seeded oauth_account_email row so the
        // in-tx UPDATE on it returns NotFound and aborts the tx.
        sqlx::query!("DELETE FROM gcal_settings WHERE key = 'oauth_account_email'")
            .execute(&pool)
            .await
            .unwrap();

        let err = disconnect_gcal_inner(&pool, &api, &store, &emitter, true)
            .await
            .expect_err(
                "disconnect must surface NotFound from the in-tx oauth_account_email update",
            );
        assert!(
            matches!(err, AppError::NotFound(_)),
            "expected NotFound, got {err:?}",
        );

        // Rollback: calendar_id was NOT committed.
        let cal_id = models::get_setting(&pool, GcalSettingKey::CalendarId)
            .await
            .unwrap()
            .unwrap_or_default();
        assert_eq!(
            cal_id, "cal_KEEP",
            "calendar_id reset must be rolled back when the tx aborts",
        );

        // Rollback: event-map row still present.
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM gcal_agenda_event_map")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            count.0, 1,
            "event-map wipe must be rolled back when the tx aborts",
        );

        // Keyring clear happens before the tx and is NOT rolled back.
        assert!(
            store.load().await.unwrap().is_none(),
            "keyring clear runs before the tx — token must be gone even on tx abort",
        );

        // PushDisabled is NOT emitted because disconnect returned Err.
        assert!(
            !recorder.events().contains(&GcalEvent::PushDisabled),
            "push_disabled must only fire after the tx commits, got {:?}",
            recorder.events()
        );
    }

    // ── begin_gcal_oauth_inner ─────────────────────────────────────

    /// Drive a TcpStream into the listener bound at `port` so the
    /// loopback callback resolves. The query string carries
    /// `code` and `state` verbatim, mirroring Google's redirect.
    async fn drive_oauth_callback(port: u16, code: &str, state: &str) {
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpStream;
        let mut sock = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!(
            "GET /oauth/callback?code={}&state={} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
            code, state,
        );
        sock.write_all(request.as_bytes()).await.unwrap();
        let mut buf = Vec::new();
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut sock, &mut buf).await;
    }

    /// Build an `OAuthClient` pointed at the given wiremock server.
    /// Mirrors the helper used in `oauth.rs::tests`.
    async fn build_oauth_client(server: &MockServer) -> Arc<OAuthClient> {
        Arc::new(
            OAuthClient::new(
                "test-client-id".to_owned(),
                format!("{}/o/oauth2/v2/auth", server.uri()),
                format!("{}/token", server.uri()),
                "http://127.0.0.1:54321".to_owned(),
                vec![
                    "https://www.googleapis.com/auth/calendar".to_owned(),
                    crate::gcal_push::oauth::OPENID_EMAIL_SCOPE.to_owned(),
                ],
            )
            .expect("oauth client must build"),
        )
    }

    fn id_token_for_email(email: &str) -> String {
        use base64::Engine as _;
        use base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::json!({ "email": email, "aud": "agaric" })
                .to_string()
                .as_bytes(),
        );
        let signature = URL_SAFE_NO_PAD.encode(b"signature-placeholder");
        format!("{header}.{payload}.{signature}")
    }

    /// Extract `(redirect_port, state)` from a freshly-built authorize
    /// URL — the `open_browser` callbacks in these tests use this to
    /// hand both values to the driver task that synthesises the
    /// loopback callback.
    fn parse_authorize_url(url: &str) -> (u16, String) {
        let parsed = url::Url::parse(url).expect("authorize URL must parse");
        let redirect = parsed
            .query_pairs()
            .find(|(k, _)| k == "redirect_uri")
            .map(|(_, v)| v.into_owned())
            .expect("authorize URL must carry redirect_uri");
        let state = parsed
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.into_owned())
            .expect("authorize URL must carry state");
        let port: u16 = redirect
            .strip_prefix("http://127.0.0.1:")
            .and_then(|rest| rest.split('/').next())
            .and_then(|s| s.parse().ok())
            .expect("redirect_uri must be loopback with a port");
        (port, state)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_oauth_happy_path_persists_token_and_email() {
        // Wiremock for Google's token endpoint.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.access-abc",
                "refresh_token": "1//refresh-xyz",
                "expires_in": 3600,
                "token_type": "Bearer",
                "id_token": id_token_for_email("user@example.com"),
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;
        let client = build_oauth_client(&server).await;

        // Per-flow channel: `open_browser` hands the loopback port +
        // CSRF state to the driver task. `oneshot` is the right shape
        // because each begin_oauth call binds exactly one listener.
        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<(u16, String)>();

        let driver = tokio::spawn(async move {
            let (port, state) = port_rx.await.expect("authorize url forwarded");
            drive_oauth_callback(port, "the-code", &state).await;
        });

        let port_tx_cell = std::sync::Mutex::new(Some(port_tx));
        let outcome = begin_gcal_oauth_inner(&pool, client.as_ref(), &store, |url| {
            let (port, state) = parse_authorize_url(&url);
            if let Some(tx) = port_tx_cell.lock().unwrap().take() {
                let _ = tx.send((port, state));
            }
            Ok(())
        })
        .await
        .expect("begin_gcal_oauth_inner must succeed");

        driver.await.expect("driver task joined");

        assert_eq!(outcome.account_email.as_deref(), Some("user@example.com"));
        // Token landed.
        assert!(store.load().await.unwrap().is_some());
        // Email persisted.
        let stored = models::get_setting(&pool, GcalSettingKey::OauthAccountEmail)
            .await
            .unwrap();
        assert_eq!(stored.as_deref(), Some("user@example.com"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_oauth_open_browser_failure_surfaces_typed_error() {
        let server = MockServer::start().await;
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;
        let client = build_oauth_client(&server).await;

        let result = begin_gcal_oauth_inner(&pool, client.as_ref(), &store, |_url| {
            Err(AppError::Validation("oauth.open_browser_failed: x".into()))
        })
        .await;

        match result {
            Err(AppError::Validation(msg)) => {
                // The inner preserves validation-typed errors verbatim
                // (so callers get the original key), not the
                // misconfigured wrapper.
                assert!(
                    msg.contains("oauth.open_browser_failed"),
                    "expected oauth.open_browser_failed key, got {msg}"
                );
            }
            other => panic!("expected Validation, got {other:?}"),
        }
        // No token landed.
        assert!(store.load().await.unwrap().is_none());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_oauth_invalid_state_rejected_before_exchange() {
        // Echo a mismatched state to the listener — the inner must
        // surface `oauth.invalid_state` without touching the network.
        let server = MockServer::start().await;
        // No mock for /token — if the test reaches the exchange the
        // request will fail with a transport error, which would surface
        // as `oauth.exchange_failed` instead of `oauth.invalid_state`,
        // exposing the bug.
        let (pool, _dir) = test_pool().await;
        let store = store_with(None).await;
        let client = build_oauth_client(&server).await;

        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<u16>();
        let driver = tokio::spawn(async move {
            let port = port_rx.await.expect("port forwarded");
            // Send a bogus state that doesn't match the one in the
            // authorize URL.
            drive_oauth_callback(port, "the-code", "bogus-state").await;
        });

        let port_tx_cell = std::sync::Mutex::new(Some(port_tx));
        let result = begin_gcal_oauth_inner(&pool, client.as_ref(), &store, |url| {
            let (port, _state) = parse_authorize_url(&url);
            if let Some(tx) = port_tx_cell.lock().unwrap().take() {
                let _ = tx.send(port);
            }
            Ok(())
        })
        .await;

        driver.await.expect("driver joined");

        match result {
            Err(AppError::Validation(msg)) => {
                assert_eq!(msg, "oauth.invalid_state");
            }
            other => panic!("expected Validation(oauth.invalid_state), got {other:?}"),
        }
        // No token landed.
        assert!(store.load().await.unwrap().is_none());
    }

    // ── #630 — reauth visibility + unconditional flag clear ────────

    /// The persisted pause flag must surface on the status snapshot so
    /// a restart cannot hide the paused connector behind a
    /// healthy-looking "connected" state.
    #[tokio::test]
    async fn get_status_surfaces_reauth_required_flag_630() {
        let (pool, _dir) = test_pool().await;
        let store = store_with(Some(dummy_token())).await;

        // Default: not paused.
        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();
        assert!(
            !status.reauth_required,
            "fresh install must report reauth_required = false"
        );

        // After a terminal 401 the connector persists the flag — the
        // status must reflect it even though `connected` stays true
        // (the token is NOT cleared by the terminal-401 path).
        models::set_reauth_required(&pool, true).await.unwrap();
        let status = get_gcal_status_inner(&pool, &store, THIS_DEVICE)
            .await
            .unwrap();
        assert!(
            status.reauth_required,
            "persisted pause flag must surface on GcalStatus (#630)"
        );
        assert!(
            status.connected,
            "sanity: the token is still present — exactly the state that made \
             the pause invisible before #630"
        );
    }

    /// A successful re-auth where Google omits the email claim (user
    /// unchecked the email grant; missing/unparseable id_token) must
    /// STILL clear the pause flag — the clear must not be coupled to
    /// `persist_oauth_account_email`.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_oauth_without_email_claim_still_clears_reauth_flag_630() {
        let server = MockServer::start().await;
        // Token response WITHOUT id_token → no email claim extracted.
        Mock::given(method("POST"))
            .and(path("/token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "access_token": "ya29.access-abc",
                "refresh_token": "1//refresh-xyz",
                "expires_in": 3600,
                "token_type": "Bearer",
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (pool, _dir) = test_pool().await;
        // Simulate the paused state left behind by a terminal 401.
        models::set_reauth_required(&pool, true).await.unwrap();
        let store = store_with(None).await;
        let client = build_oauth_client(&server).await;

        let (port_tx, port_rx) = tokio::sync::oneshot::channel::<(u16, String)>();
        let driver = tokio::spawn(async move {
            let (port, state) = port_rx.await.expect("authorize url forwarded");
            drive_oauth_callback(port, "the-code", &state).await;
        });

        let port_tx_cell = std::sync::Mutex::new(Some(port_tx));
        let outcome = begin_gcal_oauth_inner(&pool, client.as_ref(), &store, |url| {
            let (port, state) = parse_authorize_url(&url);
            if let Some(tx) = port_tx_cell.lock().unwrap().take() {
                let _ = tx.send((port, state));
            }
            Ok(())
        })
        .await
        .expect("re-auth without an email claim must still succeed");

        driver.await.expect("driver task joined");

        assert_eq!(
            outcome.account_email, None,
            "no id_token → no email in the outcome"
        );
        assert!(
            store.load().await.unwrap().is_some(),
            "token must be stored"
        );
        assert!(
            !models::get_reauth_required(&pool).await.unwrap(),
            "reauth_required must be cleared by a successful re-auth even \
             without an email claim (#630)"
        );
    }

    /// Error path: a failed OAuth attempt must NOT clear the pause flag
    /// — the connector stays paused until a re-auth actually succeeds.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn begin_oauth_failure_leaves_reauth_flag_set_630() {
        let server = MockServer::start().await;
        let (pool, _dir) = test_pool().await;
        models::set_reauth_required(&pool, true).await.unwrap();
        let store = store_with(None).await;
        let client = build_oauth_client(&server).await;

        let result = begin_gcal_oauth_inner(&pool, client.as_ref(), &store, |_url| {
            Err(AppError::Validation("oauth.open_browser_failed: x".into()))
        })
        .await;
        assert!(result.is_err(), "open-browser failure must surface");

        assert!(
            models::get_reauth_required(&pool).await.unwrap(),
            "a failed OAuth attempt must NOT clear the pause flag"
        );
        assert!(
            store.load().await.unwrap().is_none(),
            "no token may be stored on failure"
        );
    }

    // ── force_gcal_resync_inner ────────────────────────────────────

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn force_gcal_resync_inner_fires_force_sweep_notify() {
        use crate::gcal_push::connector::{DirtyEvent, GcalConnectorHandle};
        use tokio::sync::Notify;

        // Construct a handle by hand — `spawn_connector` wires the
        // same primitives in production.
        let force_sweep = Arc::new(Notify::new());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel::<DirtyEvent>();
        let handle = GcalConnectorHandle::__test_new(tx, force_sweep.clone());

        // Register a waiter before the call so we can observe the
        // wake-up.
        let signal = force_sweep.clone();
        let waiter = tokio::spawn(async move { signal.notified().await });
        tokio::task::yield_now().await;

        force_gcal_resync_inner(&handle);

        tokio::time::timeout(std::time::Duration::from_millis(500), waiter)
            .await
            .expect("force_resync must wake the notify")
            .expect("waiter task joined cleanly");
    }
}
