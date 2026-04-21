//! FEAT-5b — OS-keychain-backed token storage for the Agaric → Google
//! Calendar push connector.
//!
//! Tokens are stored in the operating system's native credential vault
//! (macOS Keychain, Windows Credential Manager, Linux Secret Service
//! via `dbus-secret-service`) under a fixed service+account pair.  The
//! access and refresh tokens are kept inside [`secrecy::SecretString`]
//! so they never land in tracing spans, `Debug` output, or serde logs
//! — see `format!("{token:?}")` tests in [`oauth`].
//!
//! # Fallback policy
//!
//! When the keyring subsystem is unavailable (headless Linux without a
//! running Secret Service, revoked entitlement on macOS, locked Credential
//! Manager on Windows), operations return [`AppError::Validation`] with
//! the key `keyring.unavailable` **and** emit the [`GcalEvent::KeyringUnavailable`]
//! runtime event (if an emitter is supplied).  We never fall back to
//! plaintext storage — see FEAT-5 parent § "Open questions" for the
//! accepted default.
//!
//! # Threat-model note
//!
//! Agaric is a local-first single-user app with no adversarial peers
//! (AGENTS.md § "Threat Model").  The keyring is used for defence in
//! depth: it prevents accidental exposure through filesystem backups,
//! cloud-synced home directories, or the `notes.db` travelling between
//! devices.  It is not a hedge against on-device malware.
//!
//! [`oauth`]: super::oauth

use std::fmt;
use std::sync::Arc;

use async_trait::async_trait;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

use super::oauth::Token;

// ---------------------------------------------------------------------------
// Service + account constants
// ---------------------------------------------------------------------------

/// Stable service identifier written into the OS keychain.  Matches
/// the reverse-DNS app identifier already used by `notes.db` on macOS
/// and Linux (Tauri identifier `com.agaric.app`) with a `.gcal` suffix
/// so that a future feature needing a different credential does not
/// collide.
pub const KEYRING_SERVICE: &str = "com.agaric.app.gcal";

/// Account name for the single Google Calendar OAuth credential.
/// The credential is a JSON blob ([`TokenBlob`]) containing both the
/// access token and refresh token plus the expiry deadline.
pub const KEYRING_ACCOUNT: &str = "oauth_tokens";

// ---------------------------------------------------------------------------
// Wire format (JSON in the keyring)
// ---------------------------------------------------------------------------

/// On-disk shape of the credential written into the OS keychain.
///
/// Serialised as JSON.  `access` / `refresh` are plain strings on the
/// wire (the keyring itself is the encrypted envelope); they are
/// immediately wrapped in [`SecretString`] on deserialise so nothing
/// downstream of this module ever holds a bare [`String`] token.
#[derive(Serialize, Deserialize)]
struct TokenBlob {
    access: String,
    refresh: String,
    /// RFC 3339 UTC deadline at which the access token expires.
    expires_at: String,
}

impl TokenBlob {
    fn from_token(token: &Token) -> Self {
        Self {
            access: token.access.expose_secret().to_owned(),
            refresh: token.refresh.expose_secret().to_owned(),
            expires_at: token.expires_at.to_rfc3339(),
        }
    }

    fn into_token(self) -> Result<Token, AppError> {
        let expires_at = chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .map_err(|e| AppError::Validation(format!("keyring.malformed_expires_at: {e}")))?
            .with_timezone(&chrono::Utc);
        Ok(Token {
            access: SecretString::from(self.access),
            refresh: SecretString::from(self.refresh),
            expires_at,
        })
    }
}

// ---------------------------------------------------------------------------
// Event emitter seam
// ---------------------------------------------------------------------------

/// Runtime events emitted by the GCal push subsystem to the Tauri
/// frontend.  FEAT-5f (Settings tab) subscribes to surface them as UI
/// state.  Kept deliberately small — only the events FEAT-5b / 5e
/// actually raise are listed here; later sub-items can extend the
/// variant set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcalEvent {
    /// The OS keyring is unreachable — GCal push cannot persist or
    /// read tokens.  Frontend should show the keyring-unavailable
    /// banner and disable the "Connect Google Calendar" button.
    KeyringUnavailable,
    /// The refresh token has been rejected by Google (401 twice in a
    /// row, or the `invalid_grant` / `unauthorized_client` OAuth
    /// error).  Frontend should clear the connected-account UI and
    /// prompt the user to re-authorize.
    ReauthRequired,
    /// The dedicated "Agaric Agenda" calendar was externally deleted
    /// by the user; the connector has cleared every
    /// `gcal_agenda_event_map` row and reset `calendar_id` so the
    /// next cycle re-creates the calendar (FEAT-5e recovery path).
    /// Frontend shows an informational toast.
    CalendarRecreated,
    /// The user disconnected the GCal push (or the connector
    /// auto-disabled it after a hard failure that cannot be retried).
    /// Frontend refreshes the Settings tab to reflect the new state
    /// (FEAT-5e disconnect + 403 / Forbidden flow).
    PushDisabled,
}

impl GcalEvent {
    /// Tauri event name used on `AppHandle::emit(event, payload)`.
    /// Namespaced `gcal:` to match the rest of the feature family.
    #[must_use]
    pub const fn event_name(self) -> &'static str {
        match self {
            GcalEvent::KeyringUnavailable => "gcal:keyring_unavailable",
            GcalEvent::ReauthRequired => "gcal:reauth_required",
            GcalEvent::CalendarRecreated => "gcal:calendar_recreated",
            GcalEvent::PushDisabled => "gcal:push_disabled",
        }
    }
}

/// Trait-object seam between this module and the Tauri event bus.
///
/// Mirrors the established `ActivityEmitter` pattern from
/// `mcp::activity` — production wires an `AppHandle`-backed impl,
/// tests use [`RecordingEventEmitter`].  Implementations MUST be
/// infallible from the caller's perspective: a missing listener, a
/// shutting-down bus, or a serialisation error is logged via
/// `tracing::warn!` and swallowed.
pub trait GcalEventEmitter: Send + Sync {
    fn emit(&self, event: GcalEvent);
}

/// Blanket impl so `Arc<dyn GcalEventEmitter>` and `Arc<T>` both
/// satisfy the trait.
impl<T: GcalEventEmitter + ?Sized> GcalEventEmitter for Arc<T> {
    fn emit(&self, event: GcalEvent) {
        (**self).emit(event);
    }
}

/// Drop-in emitter that discards every event.  Useful for tests that
/// are not exercising the event seam and for the sidecar binary.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopEventEmitter;

impl GcalEventEmitter for NoopEventEmitter {
    fn emit(&self, _event: GcalEvent) {}
}

/// Production emitter — forwards every [`GcalEvent`] onto the Tauri
/// event bus on its namespaced event name (e.g. `gcal:reauth_required`).
/// Emission errors are logged at `warn` but never propagated — the
/// connector must not stall because a listener is gone.
pub struct TauriGcalEventEmitter<R: tauri::Runtime> {
    handle: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> TauriGcalEventEmitter<R> {
    /// Wrap a cloned `AppHandle` so the connector can emit without
    /// taking a generic on its public API.
    pub fn new(handle: tauri::AppHandle<R>) -> Self {
        Self { handle }
    }
}

impl<R: tauri::Runtime> std::fmt::Debug for TauriGcalEventEmitter<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TauriGcalEventEmitter").finish()
    }
}

impl<R: tauri::Runtime> GcalEventEmitter for TauriGcalEventEmitter<R> {
    fn emit(&self, event: GcalEvent) {
        use tauri::Emitter;
        if let Err(e) = self.handle.emit(event.event_name(), ()) {
            tracing::warn!(
                target: "gcal",
                event = event.event_name(),
                error = %e,
                "failed to emit gcal event on Tauri bus",
            );
        }
    }
}

/// Test-only recorder that captures every emitted event.  Kept behind
/// `#[cfg(test)]` so production builds cannot accidentally depend on
/// its shape.
#[cfg(test)]
pub struct RecordingEventEmitter {
    events: std::sync::Mutex<Vec<GcalEvent>>,
}

#[cfg(test)]
impl RecordingEventEmitter {
    pub fn new() -> Self {
        Self {
            events: std::sync::Mutex::new(Vec::new()),
        }
    }

    pub fn events(&self) -> Vec<GcalEvent> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[cfg(test)]
impl Default for RecordingEventEmitter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
impl GcalEventEmitter for RecordingEventEmitter {
    fn emit(&self, event: GcalEvent) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(event);
    }
}

// ---------------------------------------------------------------------------
// TokenStore trait
// ---------------------------------------------------------------------------

/// Persistence backend for the OAuth [`Token`] pair.  The production
/// implementation is [`KeyringTokenStore`]; tests use [`MockTokenStore`].
///
/// All methods are `async` so keyring backends that block on IPC (macOS
/// Keychain) can be awaited without starving the tokio runtime.
#[async_trait]
pub trait TokenStore: Send + Sync {
    /// Return the currently-stored [`Token`] or `Ok(None)` if no
    /// credential has been written yet.
    async fn load(&self) -> Result<Option<Token>, AppError>;

    /// Store the [`Token`], overwriting any previous credential for
    /// this service/account pair.
    async fn store(&self, token: &Token) -> Result<(), AppError>;

    /// Remove the credential.  No-op if no credential exists — callers
    /// can invoke this from disconnect flows without pre-checking.
    async fn clear(&self) -> Result<(), AppError>;
}

// ---------------------------------------------------------------------------
// Keyring backend abstraction
// ---------------------------------------------------------------------------

/// Thin wrapper over the operations we need from a secret-store
/// backend.  In production this is satisfied by `keyring::Entry`; the
/// test suite injects a stub via [`KeyringTokenStore::with_backend`]
/// to exercise the "keyring unavailable" branch without actually
/// taking the user's machine offline.
pub trait KeyringBackend: Send + Sync {
    /// Return the stored secret, or `Ok(None)` if no entry exists.
    fn get(&self) -> Result<Option<String>, KeyringBackendError>;

    /// Write the secret, creating the entry if necessary.
    fn set(&self, value: &str) -> Result<(), KeyringBackendError>;

    /// Delete the entry, silent on "not found".
    fn delete(&self) -> Result<(), KeyringBackendError>;
}

/// Errors returned by a [`KeyringBackend`].  Distinguishes the
/// "platform unavailable" case — which FEAT-5b policy forbids falling
/// back to plaintext for — from recoverable I/O hiccups.
#[derive(Debug)]
pub enum KeyringBackendError {
    /// The platform backend itself is not reachable (no Secret
    /// Service daemon, missing entitlement, locked credential store).
    /// Maps 1:1 to [`GcalEvent::KeyringUnavailable`].
    PlatformUnavailable(String),
    /// Any other error (serde, IPC, per-entry).  Surfaced as the
    /// generic [`AppError::Validation`] keyed by `keyring.io`.
    Io(String),
}

impl fmt::Display for KeyringBackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyringBackendError::PlatformUnavailable(m) => {
                write!(f, "keyring platform unavailable: {m}")
            }
            KeyringBackendError::Io(m) => write!(f, "keyring io error: {m}"),
        }
    }
}

impl std::error::Error for KeyringBackendError {}

// Production adapter: wrap `keyring::Entry`.
struct OsKeyringBackend {
    entry: keyring::Entry,
}

impl OsKeyringBackend {
    fn new() -> Result<Self, KeyringBackendError> {
        let entry =
            keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(map_keyring_err)?;
        Ok(Self { entry })
    }
}

impl KeyringBackend for OsKeyringBackend {
    fn get(&self) -> Result<Option<String>, KeyringBackendError> {
        match self.entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_keyring_err(e)),
        }
    }

    fn set(&self, value: &str) -> Result<(), KeyringBackendError> {
        self.entry.set_password(value).map_err(map_keyring_err)
    }

    fn delete(&self) -> Result<(), KeyringBackendError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_keyring_err(e)),
        }
    }
}

/// Map the keyring crate's error taxonomy onto ours.  Anything that
/// indicates "the platform backend itself is not usable" becomes
/// [`KeyringBackendError::PlatformUnavailable`]; everything else
/// becomes [`KeyringBackendError::Io`].
fn map_keyring_err(err: keyring::Error) -> KeyringBackendError {
    match err {
        keyring::Error::PlatformFailure(e) => {
            KeyringBackendError::PlatformUnavailable(format!("platform failure: {e}"))
        }
        keyring::Error::NoStorageAccess(e) => {
            KeyringBackendError::PlatformUnavailable(format!("no storage access: {e}"))
        }
        other => KeyringBackendError::Io(other.to_string()),
    }
}

// ---------------------------------------------------------------------------
// KeyringTokenStore
// ---------------------------------------------------------------------------

/// Production [`TokenStore`] implementation backed by the OS keychain.
///
/// `KeyringTokenStore` holds an `Arc<dyn KeyringBackend>` so that tests
/// can swap in a stub backend to force the "keyring unavailable" path
/// without having to unplug the developer's Secret Service daemon.
pub struct KeyringTokenStore {
    backend: Arc<dyn KeyringBackend>,
    emitter: Arc<dyn GcalEventEmitter>,
}

impl KeyringTokenStore {
    /// Construct a store backed by the real OS keychain.
    ///
    /// # Errors
    /// Returns [`AppError::Validation`] keyed `keyring.unavailable` if
    /// even *constructing* the keyring entry fails — in that case the
    /// backend itself is not reachable, and the corresponding event is
    /// emitted so the UI can disable the GCal push toggle immediately.
    pub fn new(emitter: Arc<dyn GcalEventEmitter>) -> Result<Self, AppError> {
        match OsKeyringBackend::new() {
            Ok(backend) => Ok(Self {
                backend: Arc::new(backend),
                emitter,
            }),
            Err(KeyringBackendError::PlatformUnavailable(m)) => {
                tracing::warn!(target: "gcal", error = %m, "OS keyring unavailable on construct");
                emitter.emit(GcalEvent::KeyringUnavailable);
                Err(AppError::Validation(format!("keyring.unavailable: {m}")))
            }
            Err(KeyringBackendError::Io(m)) => {
                Err(AppError::Validation(format!("keyring.io: {m}")))
            }
        }
    }

    /// Construct a store with a caller-supplied backend.  Used by
    /// tests to inject a stub and by any future non-OS credential
    /// store (e.g. a Flatpak portal wrapper).
    pub fn with_backend(
        backend: Arc<dyn KeyringBackend>,
        emitter: Arc<dyn GcalEventEmitter>,
    ) -> Self {
        Self { backend, emitter }
    }

    fn map_platform_unavailable<T>(
        &self,
        result: Result<T, KeyringBackendError>,
        op: &str,
    ) -> Result<T, AppError> {
        match result {
            Ok(v) => Ok(v),
            Err(KeyringBackendError::PlatformUnavailable(m)) => {
                tracing::warn!(
                    target: "gcal",
                    op = op,
                    error = %m,
                    "OS keyring unavailable",
                );
                self.emitter.emit(GcalEvent::KeyringUnavailable);
                Err(AppError::Validation(format!("keyring.unavailable: {m}")))
            }
            Err(KeyringBackendError::Io(m)) => {
                Err(AppError::Validation(format!("keyring.io: {op}: {m}")))
            }
        }
    }
}

#[async_trait]
impl TokenStore for KeyringTokenStore {
    async fn load(&self) -> Result<Option<Token>, AppError> {
        let raw = self.map_platform_unavailable(self.backend.get(), "load")?;
        let Some(json) = raw else {
            return Ok(None);
        };
        let blob: TokenBlob = serde_json::from_str(&json)?;
        let token = blob.into_token()?;
        Ok(Some(token))
    }

    async fn store(&self, token: &Token) -> Result<(), AppError> {
        let blob = TokenBlob::from_token(token);
        let json = serde_json::to_string(&blob)?;
        self.map_platform_unavailable(self.backend.set(&json), "store")
    }

    async fn clear(&self) -> Result<(), AppError> {
        self.map_platform_unavailable(self.backend.delete(), "clear")
    }
}

// ---------------------------------------------------------------------------
// MockTokenStore (test-only)
// ---------------------------------------------------------------------------

/// In-memory [`TokenStore`] for unit tests.
#[cfg(test)]
pub struct MockTokenStore {
    inner: std::sync::Mutex<Option<Token>>,
}

#[cfg(test)]
impl MockTokenStore {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(None),
        }
    }
}

#[cfg(test)]
impl Default for MockTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
#[async_trait]
impl TokenStore for MockTokenStore {
    async fn load(&self) -> Result<Option<Token>, AppError> {
        Ok(self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone())
    }

    async fn store(&self, token: &Token) -> Result<(), AppError> {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(token.clone());
        Ok(())
    }

    async fn clear(&self) -> Result<(), AppError> {
        *self
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    use chrono::{TimeZone, Utc};

    // ── Stub backends ──────────────────────────────────────────────

    /// Happy-path backend: stores the value in a Mutex<Option<String>>.
    struct MemBackend(Mutex<Option<String>>);

    impl MemBackend {
        fn new() -> Self {
            Self(Mutex::new(None))
        }
    }

    impl KeyringBackend for MemBackend {
        fn get(&self) -> Result<Option<String>, KeyringBackendError> {
            Ok(self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone())
        }

        fn set(&self, value: &str) -> Result<(), KeyringBackendError> {
            *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(value.to_owned());
            Ok(())
        }

        fn delete(&self) -> Result<(), KeyringBackendError> {
            *self
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
            Ok(())
        }
    }

    /// Failing backend: every call returns PlatformUnavailable.
    struct UnavailableBackend;

    impl KeyringBackend for UnavailableBackend {
        fn get(&self) -> Result<Option<String>, KeyringBackendError> {
            Err(KeyringBackendError::PlatformUnavailable(
                "no secrets daemon".to_owned(),
            ))
        }

        fn set(&self, _value: &str) -> Result<(), KeyringBackendError> {
            Err(KeyringBackendError::PlatformUnavailable(
                "no secrets daemon".to_owned(),
            ))
        }

        fn delete(&self) -> Result<(), KeyringBackendError> {
            Err(KeyringBackendError::PlatformUnavailable(
                "no secrets daemon".to_owned(),
            ))
        }
    }

    /// Generic-io-failure backend: exercises the `keyring.io` branch.
    struct IoBackend;

    impl KeyringBackend for IoBackend {
        fn get(&self) -> Result<Option<String>, KeyringBackendError> {
            Err(KeyringBackendError::Io("bad bus reply".to_owned()))
        }

        fn set(&self, _value: &str) -> Result<(), KeyringBackendError> {
            Err(KeyringBackendError::Io("bad bus reply".to_owned()))
        }

        fn delete(&self) -> Result<(), KeyringBackendError> {
            Err(KeyringBackendError::Io("bad bus reply".to_owned()))
        }
    }

    // ── Fixtures ───────────────────────────────────────────────────

    fn fixed_token() -> Token {
        Token {
            access: SecretString::from("ACCESS-TOKEN-ABC"),
            refresh: SecretString::from("REFRESH-TOKEN-XYZ"),
            expires_at: Utc.with_ymd_and_hms(2026, 4, 22, 10, 30, 0).unwrap(),
        }
    }

    fn store_with(
        backend: Arc<dyn KeyringBackend>,
    ) -> (KeyringTokenStore, Arc<RecordingEventEmitter>) {
        let emitter = Arc::new(RecordingEventEmitter::new());
        let store_emitter: Arc<dyn GcalEventEmitter> = emitter.clone();
        let store = KeyringTokenStore::with_backend(backend, store_emitter);
        (store, emitter)
    }

    // ── TokenBlob roundtrip ────────────────────────────────────────

    #[test]
    fn token_blob_roundtrip_preserves_every_field() {
        let original = fixed_token();
        let blob = TokenBlob::from_token(&original);
        let round = blob.into_token().unwrap();

        assert_eq!(
            round.access.expose_secret(),
            original.access.expose_secret(),
            "access token must survive JSON roundtrip"
        );
        assert_eq!(
            round.refresh.expose_secret(),
            original.refresh.expose_secret(),
            "refresh token must survive JSON roundtrip"
        );
        assert_eq!(
            round.expires_at, original.expires_at,
            "expires_at must survive JSON roundtrip"
        );
    }

    #[test]
    fn token_blob_into_token_rejects_malformed_expires_at() {
        let blob = TokenBlob {
            access: "a".into(),
            refresh: "r".into(),
            expires_at: "not-a-date".into(),
        };
        let result = blob.into_token();
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("keyring.malformed_expires_at")),
            "malformed expires_at must yield keyring.malformed_expires_at Validation error, got {result:?}"
        );
    }

    // ── GcalEvent ──────────────────────────────────────────────────

    #[test]
    fn gcal_event_name_matches_tauri_namespace() {
        assert_eq!(
            GcalEvent::KeyringUnavailable.event_name(),
            "gcal:keyring_unavailable"
        );
        assert_eq!(
            GcalEvent::ReauthRequired.event_name(),
            "gcal:reauth_required"
        );
        assert_eq!(
            GcalEvent::CalendarRecreated.event_name(),
            "gcal:calendar_recreated"
        );
        assert_eq!(
            GcalEvent::PushDisabled.event_name(),
            "gcal:push_disabled"
        );
    }

    #[test]
    fn noop_event_emitter_does_not_record() {
        let emitter = NoopEventEmitter;
        emitter.emit(GcalEvent::KeyringUnavailable);
        emitter.emit(GcalEvent::ReauthRequired);
        // If we got here without panicking, the noop worked.
    }

    #[test]
    fn recording_event_emitter_captures_in_order() {
        let rec = RecordingEventEmitter::new();
        rec.emit(GcalEvent::KeyringUnavailable);
        rec.emit(GcalEvent::ReauthRequired);
        rec.emit(GcalEvent::ReauthRequired);
        assert_eq!(
            rec.events(),
            vec![
                GcalEvent::KeyringUnavailable,
                GcalEvent::ReauthRequired,
                GcalEvent::ReauthRequired,
            ],
            "emitter must preserve call order"
        );
    }

    // ── MockTokenStore ─────────────────────────────────────────────

    #[tokio::test]
    async fn mock_token_store_load_returns_none_initially() {
        let store = MockTokenStore::new();
        assert!(
            store.load().await.unwrap().is_none(),
            "fresh MockTokenStore must load None"
        );
    }

    #[tokio::test]
    async fn mock_token_store_store_then_load_roundtrips() {
        let store = MockTokenStore::new();
        let token = fixed_token();
        store.store(&token).await.unwrap();

        let loaded = store.load().await.unwrap().expect("token should roundtrip");
        assert_eq!(loaded.access.expose_secret(), token.access.expose_secret());
        assert_eq!(
            loaded.refresh.expose_secret(),
            token.refresh.expose_secret()
        );
        assert_eq!(loaded.expires_at, token.expires_at);
    }

    #[tokio::test]
    async fn mock_token_store_clear_removes_token() {
        let store = MockTokenStore::new();
        store.store(&fixed_token()).await.unwrap();
        store.clear().await.unwrap();
        assert!(
            store.load().await.unwrap().is_none(),
            "clear() must drop the stored credential"
        );
    }

    #[tokio::test]
    async fn mock_token_store_store_overwrites_prior_token() {
        let store = MockTokenStore::new();
        store.store(&fixed_token()).await.unwrap();

        let new_token = Token {
            access: SecretString::from("NEW-ACCESS"),
            refresh: SecretString::from("NEW-REFRESH"),
            expires_at: Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap(),
        };
        store.store(&new_token).await.unwrap();

        let loaded = store.load().await.unwrap().unwrap();
        assert_eq!(
            loaded.access.expose_secret(),
            "NEW-ACCESS",
            "second store() must overwrite first"
        );
    }

    // ── KeyringTokenStore happy path ───────────────────────────────

    #[tokio::test]
    async fn keyring_store_store_then_load_roundtrips_via_backend() {
        let backend = Arc::new(MemBackend::new());
        let backend_dyn: Arc<dyn KeyringBackend> = backend.clone();
        let (store, emitter) = store_with(backend_dyn);

        let token = fixed_token();
        store.store(&token).await.unwrap();

        let loaded = store.load().await.unwrap().expect("token must load");
        assert_eq!(loaded.access.expose_secret(), token.access.expose_secret());
        assert_eq!(
            loaded.refresh.expose_secret(),
            token.refresh.expose_secret()
        );
        assert_eq!(loaded.expires_at, token.expires_at);

        assert_eq!(
            emitter.events().len(),
            0,
            "happy-path roundtrip must not emit any runtime event"
        );
    }

    #[tokio::test]
    async fn keyring_store_load_returns_none_when_backend_is_empty() {
        let backend: Arc<dyn KeyringBackend> = Arc::new(MemBackend::new());
        let (store, emitter) = store_with(backend);
        assert!(
            store.load().await.unwrap().is_none(),
            "empty backend must load None"
        );
        assert_eq!(emitter.events().len(), 0);
    }

    #[tokio::test]
    async fn keyring_store_clear_removes_token() {
        let backend: Arc<dyn KeyringBackend> = Arc::new(MemBackend::new());
        let (store, _emitter) = store_with(backend);
        store.store(&fixed_token()).await.unwrap();
        store.clear().await.unwrap();
        assert!(store.load().await.unwrap().is_none());
    }

    // ── KeyringTokenStore unavailable branch ───────────────────────

    #[tokio::test]
    async fn keyring_store_load_on_unavailable_emits_event_and_errors() {
        let backend: Arc<dyn KeyringBackend> = Arc::new(UnavailableBackend);
        let (store, emitter) = store_with(backend);

        let result = store.load().await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("keyring.unavailable")),
            "unavailable keyring must surface Validation(keyring.unavailable), got {result:?}"
        );
        assert_eq!(
            emitter.events(),
            vec![GcalEvent::KeyringUnavailable],
            "KeyringUnavailable event must be emitted exactly once"
        );
    }

    #[tokio::test]
    async fn keyring_store_store_on_unavailable_emits_event_and_errors() {
        let backend: Arc<dyn KeyringBackend> = Arc::new(UnavailableBackend);
        let (store, emitter) = store_with(backend);

        let result = store.store(&fixed_token()).await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("keyring.unavailable")),
            "unavailable keyring must surface Validation(keyring.unavailable) on store, got {result:?}"
        );
        assert_eq!(emitter.events(), vec![GcalEvent::KeyringUnavailable]);
    }

    #[tokio::test]
    async fn keyring_store_clear_on_unavailable_emits_event_and_errors() {
        let backend: Arc<dyn KeyringBackend> = Arc::new(UnavailableBackend);
        let (store, emitter) = store_with(backend);

        let result = store.clear().await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("keyring.unavailable")),
            "unavailable keyring must surface Validation(keyring.unavailable) on clear, got {result:?}"
        );
        assert_eq!(emitter.events(), vec![GcalEvent::KeyringUnavailable]);
    }

    #[tokio::test]
    async fn keyring_store_never_falls_back_to_plaintext_on_unavailable() {
        // Explicit regression guard for the FEAT-5 parent § "Open questions"
        // policy: on keyring unavailable we error out, we do NOT persist
        // the token anywhere else.
        let backend = Arc::new(MemBackend::new());
        let wrapped: Arc<dyn KeyringBackend> = Arc::new(UnavailableBackend);
        let (store, _emitter) = store_with(wrapped);

        let _ = store.store(&fixed_token()).await;

        // The sibling memory backend must still be empty.
        assert!(
            backend.get().unwrap().is_none(),
            "unavailable-path must NOT write plaintext anywhere"
        );
    }

    // ── KeyringTokenStore io-error branch ──────────────────────────

    #[tokio::test]
    async fn keyring_store_io_error_does_not_emit_unavailable_event() {
        let backend: Arc<dyn KeyringBackend> = Arc::new(IoBackend);
        let (store, emitter) = store_with(backend);

        let result = store.load().await;
        assert!(
            matches!(result, Err(AppError::Validation(ref m)) if m.contains("keyring.io")),
            "io error must surface Validation(keyring.io), got {result:?}"
        );
        assert_eq!(
            emitter.events().len(),
            0,
            "io error must NOT trigger a keyring-unavailable event"
        );
    }

    // ── Malformed payload ──────────────────────────────────────────

    #[tokio::test]
    async fn keyring_store_load_returns_error_for_malformed_json() {
        let backend = Arc::new(MemBackend::new());
        backend.set("not-json").unwrap();
        let backend_dyn: Arc<dyn KeyringBackend> = backend;
        let (store, _emitter) = store_with(backend_dyn);

        let result = store.load().await;
        assert!(
            matches!(result, Err(AppError::Json(_))),
            "malformed JSON in keyring must surface AppError::Json, got {result:?}"
        );
    }

    // ── Service + account constants ────────────────────────────────

    #[test]
    fn keyring_service_constant_matches_app_identifier_prefix() {
        assert_eq!(KEYRING_SERVICE, "com.agaric.app.gcal");
    }

    #[test]
    fn keyring_account_constant_is_stable() {
        assert_eq!(KEYRING_ACCOUNT, "oauth_tokens");
    }
}
