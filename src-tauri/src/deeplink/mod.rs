//! Deep-link router (FEAT-10).
//!
//! Parses inbound URLs delivered by [`tauri-plugin-deep-link`] and emits
//! typed Tauri events the frontend ([`useDeepLinkRouter`]) consumes:
//!
//! - `agaric://block/<ULID>` → [`EVENT_NAVIGATE_TO_BLOCK`]
//! - `agaric://page/<ULID>` → [`EVENT_NAVIGATE_TO_PAGE`]
//! - `agaric://settings/<tab>` → [`EVENT_OPEN_SETTINGS`]
//!
//! The plugin emits the raw `deep-link://new-url` Tauri event with a JSON
//! payload of URL strings (`Vec<String>`).  Routing happens here so the
//! frontend never has to parse `agaric://…` URLs itself — it just listens
//! to the typed events above.
//!
//! Cross-platform — the plugin is required on desktop AND Android (the
//! whole point of the plugin on Android is to enable the Custom-Tabs +
//! PKCE + App-Link OAuth flow that desktop loopback HTTP cannot serve).
//! No `#[cfg(desktop)]` gate.

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
    /// Scheme was not `agaric`.
    WrongScheme(String),
    /// Authority/host was missing or did not match `block` / `page` / `settings`.
    UnknownHost(String),
    /// Path did not contain the required identifier (ULID for block/page,
    /// tab name for settings).
    MissingIdentifier,
    /// ULID failed validation (uppercase Crockford base32, 26 chars,
    /// no I/L/O/U).
    InvalidUlid(String),
    /// Settings tab name was empty after trimming.
    EmptySettingsTab,
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
/// shapes is rejected.  ULIDs are validated via [`BlockId::from_string`]
/// (the canonical parser used everywhere else in the codebase) — never a
/// regex.  Settings tab names are passed through; the frontend filters
/// them against the `SettingsTab` union so an unknown tab safely falls
/// back to `'general'`.
pub fn parse_deep_link(raw: &str) -> Result<DeepLinkRoute, DeepLinkError> {
    let parsed = url::Url::parse(raw).map_err(|e| DeepLinkError::Malformed(e.to_string()))?;

    if parsed.scheme() != AGARIC_SCHEME {
        return Err(DeepLinkError::WrongScheme(parsed.scheme().to_string()));
    }

    // Custom (non-special) schemes preserve host case; normalize for matching.
    let host = parsed
        .host_str()
        .ok_or_else(|| DeepLinkError::UnknownHost(String::new()))?
        .to_ascii_lowercase();

    // First non-empty path segment is the identifier (ULID or tab name).
    // `agaric://block/X` parses with path `/X` → segments [`"X"`].
    // Empty path (`agaric://block`, `agaric://block/`) yields empty / empty
    // first segment respectively — both rejected as missing identifier.
    let identifier = parsed
        .path_segments()
        .and_then(|mut segs| segs.find(|s| !s.is_empty()))
        .ok_or(DeepLinkError::MissingIdentifier)?;

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
        // OAuth-style callbacks (`agaric://oauth/callback?code=…`) carry
        // query strings; verify the parser doesn't reject them on the
        // happy paths either.
        let url = format!("agaric://block/{VALID_ULID}?context=quick");
        let route = parse_deep_link(&url).expect("query string ignored");
        match route {
            DeepLinkRoute::Block(id) => assert_eq!(id.as_str(), VALID_ULID),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    // ── parse_deep_link: rejections ────────────────────────────────────

    #[test]
    fn rejects_wrong_scheme() {
        let err = parse_deep_link("https://example.com/block/X").expect_err("wrong scheme");
        match err {
            DeepLinkError::WrongScheme(s) => assert_eq!(s, "https"),
            other => panic!("expected WrongScheme, got {other:?}"),
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
    fn rejects_malformed_url() {
        let err = parse_deep_link("not a url").expect_err("malformed");
        assert!(matches!(err, DeepLinkError::Malformed(_)));
    }

    #[test]
    fn rejects_malformed_url_with_unclosed_bracket() {
        // TEST-50: edge case — input has the `agaric://` shape but trips
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
