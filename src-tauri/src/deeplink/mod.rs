//! Deep-link router.
//!
//! Parses inbound URLs delivered by [`tauri-plugin-deep-link`] and emits
//! typed Tauri events the frontend ([`useDeepLinkRouter`]) consumes:
//!
//! - `…block/<ULID>` → [`EVENT_NAVIGATE_TO_BLOCK`]
//! - `…page/<ULID>` → [`EVENT_NAVIGATE_TO_PAGE`]
//! - `…settings/<tab>` → [`EVENT_OPEN_SETTINGS`]
//!
//! Two URL shapes map onto the same three routes:
//!
//! - the `agaric://<host>/<id>` **custom scheme**, registered desktop-only via
//!   `plugins.deep-link.desktop.schemes` in `tauri.conf.json`; and
//! - the `https://agaric.app/o/<host>/<id>` Android **App Link**, registered
//!   via `plugins.deep-link.mobile` (host [`APP_LINK_HOST`] + path prefix
//!   `/o/`).  Android does not register the custom scheme, so App Links are
//!   the only deep-link transport on mobile — without the `https` arm every
//!   Android deep link silently no-ops (#741).
//!
//! The plugin emits the raw `deep-link://new-url` Tauri event with a JSON
//! payload of URL strings (`Vec<String>`).  Routing happens here so the
//! frontend never has to parse the URLs itself — it just listens to the
//! typed events above.
//!
//! Cross-platform — the plugin is required on desktop AND Android.  No
//! `#[cfg(desktop)]` gate; the parser accepts both shapes on every platform.

use serde::Serialize;
use tauri::{AppHandle, Emitter, Listener, Runtime};

use crate::ulid::BlockId;

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

/// Inbound event from [`tauri-plugin-deep-link`].  Payload is a JSON array
/// of URL strings (`Vec<String>`).  Defined in the plugin's `lib.rs`:
/// `app.emit("deep-link://new-url", vec![url])`.
pub const EVENT_DEEP_LINK_NEW_URL: &str = "deep-link://new-url";

/// Outbound event for `agaric://block/<ULID>`.  Payload: [`BlockNavigatePayload`].
pub const EVENT_NAVIGATE_TO_BLOCK: &str = "deeplink:navigate-to-block";

/// Outbound event for `agaric://page/<ULID>`.  Payload: [`BlockNavigatePayload`].
pub const EVENT_NAVIGATE_TO_PAGE: &str = "deeplink:navigate-to-page";

/// Outbound event for `agaric://settings/<tab>`.  Payload: [`OpenSettingsPayload`].
pub const EVENT_OPEN_SETTINGS: &str = "deeplink:open-settings";

/// The custom-scheme Agaric registers via `tauri.conf.json` (must match the
/// `plugins.deep-link.desktop.schemes` entry in `tauri.conf.json`).
pub const AGARIC_SCHEME: &str = "agaric";

/// The HTTPS authority Agaric registers for Android **App Links** (must match
/// the `plugins.deep-link.mobile[].host` entry in `tauri.conf.json`).  An
/// `https` URL is only treated as a deep link when its host is exactly this,
/// so the router never hijacks ordinary web URLs.
pub const APP_LINK_HOST: &str = "agaric.app";

/// The first path segment of an Android App Link (`https://agaric.app/o/…`),
/// matching the `plugins.deep-link.mobile[].pathPrefix` `"/o/"` entry.  The
/// route host (`block` / `page` / `settings`) and identifier follow it.
pub const APP_LINK_PREFIX: &str = "o";

/// Upper bound on the length (in bytes) of the `settings/<tab>` segment.
///
/// Unlike the `block` / `page` arms — bounded to 26 chars by ULID validation
/// (`BlockId::from_string`) — the settings tab is passed verbatim into
/// [`OpenSettingsPayload`] (the `SettingsTab` union is enforced on the
/// frontend, which falls back to `'general'` for unknown tabs).  Without a
/// bound an attacker-supplied deep link could carry an arbitrarily long first
/// segment.  The longest legitimate tab identifier is `"notifications"` (13
/// chars); 64 leaves generous headroom for new tabs while keeping the segment
/// small and constant-bounded.
pub const MAX_SETTINGS_TAB_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Routes + payloads
// ---------------------------------------------------------------------------

/// Parsed deep-link.  Each variant maps to one outbound Tauri event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkRoute {
    Block(BlockId),
    Page(BlockId),
    Settings(String),
}

/// Reasons a URL was rejected.  Logged at `warn` level; never surfaced to
/// the frontend (the deep-link surface is fire-and-forget — invalid URLs
/// silently drop).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkError {
    /// URL did not parse as a `url::Url`.
    Malformed(String),
    /// Scheme was neither `agaric` (custom scheme) nor `https` (App Link).
    WrongScheme(String),
    /// Authority/host was missing, the `https` authority was not
    /// [`APP_LINK_HOST`], or the route host did not match
    /// `block` / `page` / `settings`.
    UnknownHost(String),
    /// Path did not contain the required identifier (ULID for block/page,
    /// tab name for settings).
    MissingIdentifier,
    /// ULID failed validation (uppercase Crockford base32, 26 chars,
    /// no I/L/O/U).
    InvalidUlid(String),
    /// Settings tab name was empty after trimming.
    EmptySettingsTab,
    /// Settings tab name exceeded [`MAX_SETTINGS_TAB_LEN`] after trimming.
    SettingsTabTooLong(usize),
}

/// Payload emitted on [`EVENT_NAVIGATE_TO_BLOCK`] / [`EVENT_NAVIGATE_TO_PAGE`].
#[derive(Debug, Clone, Serialize)]
pub struct BlockNavigatePayload {
    /// Canonical uppercase ULID.
    pub id: String,
}

/// Payload emitted on [`EVENT_OPEN_SETTINGS`].
#[derive(Debug, Clone, Serialize)]
pub struct OpenSettingsPayload {
    /// Settings tab name (e.g. `"keyboard"`, `"sync"`).  Validation
    /// happens on the frontend against the `SettingsTab` union — the
    /// router only enforces non-empty.
    pub tab: String,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Parse an inbound URL string into a [`DeepLinkRoute`].
///
/// Strict by design: anything outside the documented `agaric://<host>/<id>`
/// custom-scheme shape or the `https://agaric.app/o/<host>/<id>` App-Link
/// shape is rejected.  ULIDs are validated via [`BlockId::from_string`]
/// (the canonical parser used everywhere else in the codebase) — never a
/// regex.  Settings tab names are passed through; the frontend filters
/// them against the `SettingsTab` union so an unknown tab safely falls
/// back to `'general'`.
pub fn parse_deep_link(raw: &str) -> Result<DeepLinkRoute, DeepLinkError> {
    let parsed = url::Url::parse(raw).map_err(|e| DeepLinkError::Malformed(e.to_string()))?;

    // Normalize the two accepted shapes into (route host, identifier):
    //   agaric://<host>/<identifier>              custom scheme (desktop)
    //   https://agaric.app/o/<host>/<identifier>  App Link (Android)
    let (host, identifier) = match parsed.scheme() {
        AGARIC_SCHEME => {
            // Custom (non-special) schemes preserve host case; normalize.
            let host = parsed
                .host_str()
                .ok_or_else(|| DeepLinkError::UnknownHost(String::new()))?
                .to_ascii_lowercase();

            // First non-empty path segment is the identifier (ULID or tab).
            // `agaric://block/X` parses with path `/X` → segments [`"X"`].
            // Empty path (`agaric://block`, `agaric://block/`) yields no
            // non-empty first segment — rejected as missing identifier.
            let identifier = parsed
                .path_segments()
                .and_then(|mut segs| segs.find(|s| !s.is_empty()))
                .ok_or(DeepLinkError::MissingIdentifier)?;

            (host, identifier)
        }
        "https" => {
            // Only `https://agaric.app/o/<host>/<id>` is a deep link; any
            // other https authority is rejected so the router never hijacks
            // ordinary web URLs the OS happens to hand us.
            let authority = parsed
                .host_str()
                .ok_or_else(|| DeepLinkError::UnknownHost(String::new()))?
                .to_ascii_lowercase();
            if authority != APP_LINK_HOST {
                return Err(DeepLinkError::UnknownHost(authority));
            }

            // Path is `/o/<host>/<identifier>`.  Skip empty segments so a
            // trailing slash or doubled `//` doesn't shift the mapping.
            let mut segs = parsed
                .path_segments()
                .ok_or(DeepLinkError::MissingIdentifier)?
                .filter(|s| !s.is_empty());
            match segs.next() {
                Some(APP_LINK_PREFIX) => {}
                // Wrong/missing path prefix → not one of our App Links.
                Some(other) => return Err(DeepLinkError::UnknownHost(other.to_string())),
                None => return Err(DeepLinkError::MissingIdentifier),
            }
            let host = segs
                .next()
                .ok_or(DeepLinkError::MissingIdentifier)?
                .to_ascii_lowercase();
            let identifier = segs.next().ok_or(DeepLinkError::MissingIdentifier)?;

            (host, identifier)
        }
        other => return Err(DeepLinkError::WrongScheme(other.to_string())),
    };

    match host.as_str() {
        "block" => {
            let id = BlockId::from_string(identifier)
                .map_err(|e| DeepLinkError::InvalidUlid(e.to_string()))?;
            Ok(DeepLinkRoute::Block(id))
        }
        "page" => {
            let id = BlockId::from_string(identifier)
                .map_err(|e| DeepLinkError::InvalidUlid(e.to_string()))?;
            Ok(DeepLinkRoute::Page(id))
        }
        "settings" => {
            let tab = identifier.trim();
            if tab.is_empty() {
                return Err(DeepLinkError::EmptySettingsTab);
            }
            // Bound the verbatim tab segment (block/page arms are bounded by
            // ULID validation; settings validation is deferred to the
            // frontend union, so enforce a length cap here).
            if tab.len() > MAX_SETTINGS_TAB_LEN {
                return Err(DeepLinkError::SettingsTabTooLong(tab.len()));
            }
            Ok(DeepLinkRoute::Settings(tab.to_string()))
        }
        other => Err(DeepLinkError::UnknownHost(other.to_string())),
    }
}

// ---------------------------------------------------------------------------
// Listener registration
// ---------------------------------------------------------------------------

/// Register the [`EVENT_DEEP_LINK_NEW_URL`] listener that converts inbound
/// `agaric://…` URLs into typed [`EVENT_NAVIGATE_TO_BLOCK`] /
/// [`EVENT_NAVIGATE_TO_PAGE`] / [`EVENT_OPEN_SETTINGS`] events.  Call once
/// from the Tauri `setup()` hook.
///
/// The listener stays registered for the lifetime of the app — the
/// returned `EventId` is intentionally discarded because there is no
/// teardown path (the listener dies with the `AppHandle`).
pub fn register_deeplink_handlers<R: Runtime>(app: &AppHandle<R>) {
    let app_handle = app.clone();
    let _id = app.listen(EVENT_DEEP_LINK_NEW_URL, move |event| {
        // Plugin payload is a JSON array of URL strings.
        let urls: Vec<String> = match serde_json::from_str(event.payload()) {
            Ok(u) => u,
            Err(e) => {
                tracing::warn!(
                    target: "deeplink",
                    error = %e,
                    payload = event.payload(),
                    "deep-link://new-url payload was not a JSON array of URL strings",
                );
                return;
            }
        };

        for url in urls {
            dispatch_url(&app_handle, &url);
        }
    });
}

/// Parse a single URL and emit the matching outbound event.  Logs at
/// `warn` level on every rejection path so malformed deep links are
/// visible in `agaric.log` without surfacing as user-facing errors.
fn dispatch_url<R: Runtime>(app: &AppHandle<R>, raw: &str) {
    match parse_deep_link(raw) {
        Ok(DeepLinkRoute::Block(id)) => emit_event(
            app,
            EVENT_NAVIGATE_TO_BLOCK,
            &BlockNavigatePayload {
                id: id.into_string(),
            },
        ),
        Ok(DeepLinkRoute::Page(id)) => emit_event(
            app,
            EVENT_NAVIGATE_TO_PAGE,
            &BlockNavigatePayload {
                id: id.into_string(),
            },
        ),
        Ok(DeepLinkRoute::Settings(tab)) => {
            emit_event(app, EVENT_OPEN_SETTINGS, &OpenSettingsPayload { tab })
        }
        Err(e) => {
            tracing::warn!(
                target: "deeplink",
                url = %raw,
                error = ?e,
                "ignoring malformed or unsupported deep link",
            );
        }
    }
}

fn emit_event<R: Runtime, P: Serialize + Clone>(app: &AppHandle<R>, name: &str, payload: &P) {
    if let Err(e) = app.emit(name, payload.clone()) {
        tracing::warn!(
            target: "deeplink",
            event = %name,
            error = %e,
            "failed to emit deep-link routing event",
        );
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// Canonical 26-char Crockford base32 ULID, all uppercase, no I/L/O/U.
    /// `BlockId::new()` yields one; we hard-code so the tests stay
    /// deterministic without pulling in the `ulid` crate.
    const VALID_ULID: &str = "01J0H9YPM4Q9KJG2WGR8ZT3K7E";
    /// Lowercase variant of [`VALID_ULID`].  `BlockId::from_string`
    /// uppercases on the way in, so the parsed route should carry the
    /// canonical form.
    const VALID_ULID_LOWER: &str = "01j0h9ypm4q9kjg2wgr8zt3k7e";

    // ── parse_deep_link: happy paths ───────────────────────────────────

    #[test]
    fn parses_block_url() {
        let url = format!("agaric://block/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("valid block URL");
        match route {
            DeepLinkRoute::Block(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn parses_page_url() {
        let url = format!("agaric://page/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("valid page URL");
        match route {
            DeepLinkRoute::Page(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Page, got {other:?}"),
        }
    }

    #[test]
    fn parses_settings_url() {
        let route = parse_deep_link("agaric://settings/keyboard").expect("valid settings URL");
        assert_eq!(route, DeepLinkRoute::Settings("keyboard".into()));
    }

    #[test]
    fn block_url_uppercases_lowercase_ulid() {
        let url = format!("agaric://block/{VALID_ULID_LOWER}");
        let route = parse_deep_link(&url).expect("lowercase ULID still valid");
        match route {
            DeepLinkRoute::Block(id) => {
                assert_eq!(
                    id.as_str(),
                    VALID_ULID,
                    "BlockId should normalize to canonical uppercase",
                );
            }
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn host_match_is_case_insensitive() {
        let url = format!("agaric://BLOCK/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("uppercase host accepted");
        assert!(matches!(route, DeepLinkRoute::Block(_)));
    }

    #[test]
    fn block_url_with_extra_path_segments_uses_first_segment() {
        // Defensive: extra path segments are tolerated; the first segment
        // is treated as the ULID.  Keeps future "agaric://block/<ULID>/edit"
        // shapes from breaking the listener even if they're never wired.
        let url = format!("agaric://block/{VALID_ULID}/extra/bits");
        let route = parse_deep_link(&url).expect("extra path segments tolerated");
        match route {
            DeepLinkRoute::Block(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn block_url_with_query_string_is_accepted() {
        // Deep links may carry query strings (e.g. a share/automation source
        // tag); verify the parser ignores them on the happy paths.
        let url = format!("agaric://block/{VALID_ULID}?context=quick");
        let route = parse_deep_link(&url).expect("query string ignored");
        match route {
            DeepLinkRoute::Block(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    // ── parse_deep_link: Android App Links (https://agaric.app/o/…) ─────

    #[test]
    fn parses_applink_block_url() {
        let url = format!("https://agaric.app/o/block/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("valid App Link block URL");
        match route {
            DeepLinkRoute::Block(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn parses_applink_page_url() {
        let url = format!("https://agaric.app/o/page/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("valid App Link page URL");
        match route {
            DeepLinkRoute::Page(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Page, got {other:?}"),
        }
    }

    #[test]
    fn parses_applink_settings_url() {
        let route =
            parse_deep_link("https://agaric.app/o/settings/keyboard").expect("valid App Link");
        assert_eq!(route, DeepLinkRoute::Settings("keyboard".into()));
    }

    #[test]
    fn applink_uppercases_lowercase_ulid() {
        let url = format!("https://agaric.app/o/block/{VALID_ULID_LOWER}");
        let route = parse_deep_link(&url).expect("lowercase ULID still valid");
        match route {
            DeepLinkRoute::Block(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn applink_route_host_is_case_insensitive() {
        let url = format!("https://agaric.app/o/BLOCK/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("uppercase route host accepted");
        assert!(matches!(route, DeepLinkRoute::Block(_)));
    }

    #[test]
    fn applink_host_is_case_insensitive() {
        // `https` is a special scheme so `url` already lowercases the host;
        // an uppercased authority must still match `agaric.app`.
        let url = format!("https://AGARIC.APP/o/block/{VALID_ULID}");
        let route = parse_deep_link(&url).expect("uppercase authority accepted");
        assert!(matches!(route, DeepLinkRoute::Block(_)));
    }

    #[test]
    fn applink_tolerates_trailing_and_doubled_slashes() {
        // Empty path segments (trailing `/`, doubled `//`) are skipped so
        // they don't shift the `/o/<host>/<id>` mapping.
        let url = format!("https://agaric.app/o//block//{VALID_ULID}/");
        let route = parse_deep_link(&url).expect("empty segments skipped");
        assert!(matches!(route, DeepLinkRoute::Block(_)));
    }

    #[test]
    fn applink_query_string_is_ignored() {
        let route =
            parse_deep_link("https://agaric.app/o/settings/sync?force=1").expect("query ignored");
        assert_eq!(route, DeepLinkRoute::Settings("sync".into()));
    }

    #[test]
    fn rejects_applink_with_wrong_path_prefix() {
        // Only the `/o/` prefix (matching the registered pathPrefix) routes;
        // any other first segment is rejected.
        let url = format!("https://agaric.app/x/block/{VALID_ULID}");
        let err = parse_deep_link(&url).expect_err("wrong path prefix");
        match err {
            DeepLinkError::UnknownHost(s) => assert_eq!(s, "x"),
            other => panic!("expected UnknownHost, got {other:?}"),
        }
    }

    #[test]
    fn rejects_applink_with_unknown_route_host() {
        let url = format!("https://agaric.app/o/attack/{VALID_ULID}");
        let err = parse_deep_link(&url).expect_err("unknown route host");
        match err {
            DeepLinkError::UnknownHost(s) => assert_eq!(s, "attack"),
            other => panic!("expected UnknownHost, got {other:?}"),
        }
    }

    #[test]
    fn rejects_applink_with_missing_identifier() {
        let err = parse_deep_link("https://agaric.app/o/block").expect_err("no identifier");
        assert!(matches!(err, DeepLinkError::MissingIdentifier));
    }

    #[test]
    fn rejects_applink_with_empty_path() {
        // Bare `/o/` with no route host/identifier.
        let err = parse_deep_link("https://agaric.app/o/").expect_err("empty App Link path");
        assert!(matches!(err, DeepLinkError::MissingIdentifier));
    }

    #[test]
    fn rejects_applink_with_invalid_ulid() {
        let err =
            parse_deep_link("https://agaric.app/o/page/not-a-ulid").expect_err("invalid ULID");
        assert!(matches!(err, DeepLinkError::InvalidUlid(_)));
    }

    // ── parse_deep_link: rejections ────────────────────────────────────

    #[test]
    fn rejects_wrong_scheme() {
        // Neither the `agaric` custom scheme nor `https` → WrongScheme.
        let err = parse_deep_link("ftp://block/X").expect_err("wrong scheme");
        match err {
            DeepLinkError::WrongScheme(s) => assert_eq!(s, "ftp"),
            other => panic!("expected WrongScheme, got {other:?}"),
        }
    }

    #[test]
    fn rejects_https_with_foreign_authority() {
        // An `https` URL whose host is not `agaric.app` must NOT be routed —
        // the OS can hand us arbitrary web URLs and we must ignore them.
        let url = format!("https://example.com/o/block/{VALID_ULID}");
        let err = parse_deep_link(&url).expect_err("foreign https host");
        match err {
            DeepLinkError::UnknownHost(s) => assert_eq!(s, "example.com"),
            other => panic!("expected UnknownHost, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_host() {
        let err = parse_deep_link("agaric://attack/whatever").expect_err("unknown host");
        match err {
            DeepLinkError::UnknownHost(s) => assert_eq!(s, "attack"),
            other => panic!("expected UnknownHost, got {other:?}"),
        }
    }

    #[test]
    fn rejects_invalid_ulid_block() {
        // Right shape (26 chars, A-Z/0-9), but Crockford forbids I/L/O/U,
        // and `Ulid::from_str` enforces that.  Use an `I` to trip it.
        let bad_ulid = "01J0H9YPM4Q9KJG2WGR8ZT3KII";
        let url = format!("agaric://block/{bad_ulid}");
        let err = parse_deep_link(&url).expect_err("invalid ULID");
        assert!(matches!(err, DeepLinkError::InvalidUlid(_)));
    }

    #[test]
    fn rejects_too_short_ulid() {
        let url = "agaric://block/SHORT";
        let err = parse_deep_link(url).expect_err("short ULID");
        assert!(matches!(err, DeepLinkError::InvalidUlid(_)));
    }

    #[test]
    fn rejects_invalid_ulid_page() {
        let url = "agaric://page/not-a-ulid";
        let err = parse_deep_link(url).expect_err("invalid ULID");
        assert!(matches!(err, DeepLinkError::InvalidUlid(_)));
    }

    #[test]
    fn rejects_block_url_with_empty_path() {
        let err = parse_deep_link("agaric://block/").expect_err("empty path");
        assert!(matches!(err, DeepLinkError::MissingIdentifier));
    }

    #[test]
    fn rejects_block_url_with_no_path() {
        let err = parse_deep_link("agaric://block").expect_err("no path");
        assert!(matches!(err, DeepLinkError::MissingIdentifier));
    }

    #[test]
    fn rejects_settings_url_with_empty_tab() {
        let err = parse_deep_link("agaric://settings/").expect_err("empty tab");
        assert!(matches!(err, DeepLinkError::MissingIdentifier));
    }

    #[test]
    fn parses_settings_url_with_longest_real_tab() {
        // `notifications` is the longest legitimate `SettingsTab` (13 chars);
        // it must comfortably parse under the length cap.
        let route = parse_deep_link("agaric://settings/notifications").expect("valid settings tab");
        assert_eq!(route, DeepLinkRoute::Settings("notifications".into()));
    }

    #[test]
    fn parses_settings_url_at_length_bound() {
        // A tab exactly at the cap is still accepted (boundary inclusive).
        let tab = "a".repeat(MAX_SETTINGS_TAB_LEN);
        let url = format!("agaric://settings/{tab}");
        let route = parse_deep_link(&url).expect("tab at the bound is accepted");
        assert_eq!(route, DeepLinkRoute::Settings(tab));
    }

    #[test]
    fn rejects_settings_url_with_overlong_tab() {
        // An attacker-supplied tab longer than the cap is rejected rather
        // than passed verbatim into the payload (block/page arms are bounded
        // by ULID validation; the settings arm is bounded here).
        let tab = "a".repeat(MAX_SETTINGS_TAB_LEN + 1);
        let url = format!("agaric://settings/{tab}");
        let err = parse_deep_link(&url).expect_err("over-long tab rejected");
        match err {
            DeepLinkError::SettingsTabTooLong(len) => {
                assert_eq!(len, MAX_SETTINGS_TAB_LEN + 1);
            }
            other => panic!("expected SettingsTabTooLong, got {other:?}"),
        }
    }

    #[test]
    fn rejects_applink_settings_url_with_overlong_tab() {
        // Same bound applies on the Android App Link shape.
        let tab = "b".repeat(MAX_SETTINGS_TAB_LEN + 50);
        let url = format!("https://agaric.app/o/settings/{tab}");
        let err = parse_deep_link(&url).expect_err("over-long App Link tab rejected");
        assert!(matches!(err, DeepLinkError::SettingsTabTooLong(_)));
    }

    #[test]
    fn rejects_malformed_url() {
        let err = parse_deep_link("not a url").expect_err("malformed");
        assert!(matches!(err, DeepLinkError::Malformed(_)));
    }

    #[test]
    fn rejects_malformed_url_with_unclosed_bracket() {
        // Edge case — input has the `agaric://` shape but trips
        // `url::Url::parse` itself (unclosed `[` is parsed as a malformed
        // IPv6 host).  Must surface as `Malformed`, never panic.
        let err =
            parse_deep_link("agaric://[invalid").expect_err("unclosed bracket should be malformed");
        assert!(
            matches!(err, DeepLinkError::Malformed(_)),
            "expected Malformed, got {err:?}",
        );
    }

    #[test]
    fn rejects_url_without_authority() {
        // `agaric:settings/keyboard` (no `//`) parses as a URL but has no
        // authority component, so `host_str()` returns None.
        let err = parse_deep_link("agaric:settings/keyboard").expect_err("no authority");
        assert!(matches!(err, DeepLinkError::UnknownHost(_)));
    }

    // ── Multi-slash + edge cases ───────────────────────────────────────

    #[test]
    fn parses_settings_url_with_multi_slash_path() {
        // The first non-empty segment wins.  `agaric://settings//keyboard`
        // -> path "/keyboard" -> first segment "keyboard".
        let route = parse_deep_link("agaric://settings//keyboard").expect("multi-slash tolerated");
        assert_eq!(route, DeepLinkRoute::Settings("keyboard".into()));
    }

    #[test]
    fn settings_url_with_query_string_keeps_tab_name() {
        let route = parse_deep_link("agaric://settings/sync?force=1").expect("query ignored");
        assert_eq!(route, DeepLinkRoute::Settings("sync".into()));
    }

    // ── Payload serialization ──────────────────────────────────────────

    #[test]
    fn block_payload_serializes_to_id_field() {
        let payload = BlockNavigatePayload {
            id: VALID_ULID.into(),
        };
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["id"], VALID_ULID);
        assert_eq!(
            json.as_object().expect("object").len(),
            1,
            "BlockNavigatePayload should expose only `id`",
        );
    }

    #[test]
    fn settings_payload_serializes_to_tab_field() {
        let payload = OpenSettingsPayload {
            tab: "keyboard".into(),
        };
        let json = serde_json::to_value(&payload).expect("serialize");
        assert_eq!(json["tab"], "keyboard");
        assert_eq!(
            json.as_object().expect("object").len(),
            1,
            "OpenSettingsPayload should expose only `tab`",
        );
    }

    // ── Event-name constants pinned ────────────────────────────────────

    #[test]
    fn event_name_constants_match_frontend_contract() {
        // Mirror the frontend `useDeepLinkRouter` listener strings so a
        // typo on either side breaks the test.
        assert_eq!(EVENT_DEEP_LINK_NEW_URL, "deep-link://new-url");
        assert_eq!(EVENT_NAVIGATE_TO_BLOCK, "deeplink:navigate-to-block");
        assert_eq!(EVENT_NAVIGATE_TO_PAGE, "deeplink:navigate-to-page");
        assert_eq!(EVENT_OPEN_SETTINGS, "deeplink:open-settings");
        assert_eq!(AGARIC_SCHEME, "agaric");
    }
}
