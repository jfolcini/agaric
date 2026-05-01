//! Sync pairing module — passphrase exchange leg of the device pairing flow.
//!
//! # Place in the pairing flow
//!
//! Pairing is split across three modules with distinct responsibilities:
//!
//! - [`crate::commands::sync_cmds`] — Tauri-IPC orchestration: generates
//!   the QR payload via this module, opens the pairing WebSocket via
//!   [`crate::sync_net`], drives the peer through `DeviceOffer` /
//!   `DeviceAccept`, and on success calls
//!   [`crate::peer_refs::upsert_peer_ref_with_cert`] to persist the
//!   peer's TOFU-pinned cert hash.
//! - **This module (`pairing`)** — pure helpers + message types: EFF
//!   wordlist passphrase generation, QR payload encoding/parsing
//!   ([`pairing_qr_payload`] / [`parse_pairing_qr`]), the
//!   [`PairingMessage`] wire type, and [`verify_device_exchange`] which
//!   matches the inbound `DeviceOffer`/`DeviceAccept`'s passphrase and
//!   `device_id` against the local `PairingSession`'s expectations.
//! - [`crate::sync_cert`] — owns the persistent self-signed TLS
//!   certificate and its hash; the hash that `verify_device_exchange`
//!   returns is the value [`crate::peer_refs`] stores for the peer's
//!   subsequent TOFU pin.
//!
//! Pairing messages travel as plaintext JSON over the WebSocket
//! established by [`crate::sync_net::connection`], which is already
//! mTLS-secured and TOFU-cert-pinned. Confidentiality and authenticity
//! of the pairing exchange come from that rustls + cert-pin layer, not
//! from a derived session key — there is no application-layer crypto
//! in this module. Once `verify_device_exchange` returns
//! `(device_id, cert_hash)`, the orchestration layer hands the hash to
//! [`peer_refs`](crate::peer_refs) so the next reconnection can pin the
//! peer cert (TOFU model — see `sync_net::tls::PinningCertVerifier`).

use crate::error::AppError;

use rand::seq::IndexedRandom;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

// ---------------------------------------------------------------------------
// EFF Large Wordlist (7,776 words for ~12.9 bits per word)
// ---------------------------------------------------------------------------

/// EFF large wordlist parsed once from the embedded text file.
/// Contains exactly 7,776 words sorted alphabetically.
static WORDLIST: LazyLock<Vec<&'static str>> = LazyLock::new(|| {
    let raw = include_str!("eff_wordlist.txt");
    let words: Vec<&str> = raw.lines().filter(|l| !l.is_empty()).collect();
    assert_eq!(
        words.len(),
        7776,
        "EFF wordlist must contain exactly 7776 words"
    );
    words
});

/// Return a reference to the parsed EFF wordlist (7,776 entries).
pub fn wordlist() -> &'static [&'static str] {
    &WORDLIST
}

// ---------------------------------------------------------------------------
// Passphrase Generation
// ---------------------------------------------------------------------------

/// Generate a 4-word passphrase from the EFF large wordlist.
///
/// Entropy: log2(7776^4) ~= 51.7 bits.
pub fn generate_passphrase() -> String {
    let wl = wordlist();
    let mut rng = rand::rng();
    let words: Vec<&str> = (0..4)
        .map(|_| *wl.choose(&mut rng).expect("wordlist is non-empty"))
        .collect();
    words.join(" ")
}

// ---------------------------------------------------------------------------
// QR Code Payload & SVG Generation
// ---------------------------------------------------------------------------

/// L-59: current pairing QR payload schema version. Increment whenever
/// the JSON shape changes in a way that would confuse older joiners.
pub const PAIRING_QR_VERSION: u32 = 1;

/// Build the JSON payload for a pairing QR code.
///
/// Returns: `{"v":1,"passphrase":"w1 w2 w3 w4"}`.
///
/// L-59: the leading `"v"` field tags the schema version so the joining
/// device fails fast on a payload it cannot parse — a stale QR or an
/// unrecognised future shape — rather than silently dropping fields.
///
/// M-34: the QR carries only the passphrase. Discovery and address
/// resolution are owned end-to-end by mDNS — there is no scan-bootstrap
/// path, so the QR never embeds host/port.
pub fn pairing_qr_payload(passphrase: &str) -> String {
    serde_json::json!({
        "v": PAIRING_QR_VERSION,
        "passphrase": passphrase,
    })
    .to_string()
}

/// Decoded payload extracted from a pairing QR code.
///
/// M-34: only the passphrase travels in the QR — mDNS owns discovery and
/// address resolution end-to-end, so no host/port fields exist here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairingQrPayload {
    pub passphrase: String,
}

/// L-59: parse a pairing QR JSON payload, validating its schema version.
///
/// Returns [`AppError::InvalidOperation`] tagged with
/// `pairing_qr.unsupported_version` when `v` is missing or not equal to
/// [`PAIRING_QR_VERSION`], so the joining device can surface a
/// "regenerate the QR on the host device" message rather than silently
/// dropping fields the parser does not understand.
pub fn parse_pairing_qr(json: &str) -> Result<PairingQrPayload, AppError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| {
        AppError::InvalidOperation(format!("[pairing] invalid pairing QR JSON: {e}"))
    })?;

    let object = value.as_object().ok_or_else(|| {
        AppError::InvalidOperation("[pairing] pairing QR payload must be a JSON object".into())
    })?;

    // Version gate: missing or unrecognised `v` is a fatal error so we
    // never half-parse a future schema.
    let version = object
        .get("v")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| AppError::InvalidOperation("pairing_qr.unsupported_version".into()))?;
    if version != u64::from(PAIRING_QR_VERSION) {
        return Err(AppError::InvalidOperation(
            "pairing_qr.unsupported_version".into(),
        ));
    }

    let passphrase = object
        .get("passphrase")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            AppError::InvalidOperation("[pairing] pairing QR missing 'passphrase' field".into())
        })?
        .to_string();

    Ok(PairingQrPayload { passphrase })
}

/// Render `data` as a QR code and return the SVG markup.
pub fn generate_qr_svg(data: &str) -> Result<String, AppError> {
    let code = qrcode::QrCode::new(data.as_bytes())
        .map_err(|e| AppError::InvalidOperation(format!("[pairing] QR generation failed: {e}")))?;
    Ok(code.render::<qrcode::render::svg::Color>().build())
}

// ---------------------------------------------------------------------------
// Pairing Session
// ---------------------------------------------------------------------------

/// Short-lived pairing session that tracks the generated passphrase.
///
/// Confidentiality and authenticity of the pairing exchange come from
/// the mTLS + TOFU-cert-pin layer in [`crate::sync_net::connection`],
/// not from a derived session key — see the module-level doc comment.
pub struct PairingSession {
    pub passphrase: String,
    pub created_at: std::time::Instant,
}

impl PairingSession {
    /// Create a new pairing session with a freshly generated passphrase.
    ///
    /// `local_device_id` / `remote_device_id` are kept on the signature
    /// for API symmetry with [`Self::from_passphrase`] but are unused —
    /// the pairing exchange relies on the underlying mTLS + cert-pin
    /// layer for confidentiality, so no per-session key is derived.
    pub fn new(_local_device_id: &str, _remote_device_id: &str) -> Self {
        Self {
            passphrase: generate_passphrase(),
            created_at: std::time::Instant::now(),
        }
    }

    /// Create a pairing session from an existing passphrase (e.g. scanned
    /// from the other device's QR code).
    ///
    /// `local_device_id` / `remote_device_id` are kept on the signature
    /// for API symmetry with [`Self::new`] but are unused — see that
    /// constructor's doc comment.
    pub fn from_passphrase(
        passphrase: &str,
        _local_device_id: &str,
        _remote_device_id: &str,
    ) -> Self {
        Self {
            passphrase: passphrase.to_owned(),
            created_at: std::time::Instant::now(),
        }
    }
}

// ---------------------------------------------------------------------------
// Pairing message types for device verification (ADR-pending)
// ---------------------------------------------------------------------------

/// Messages exchanged during the device verification step of pairing.
///
/// After passphrase confirmation, both peers exchange their device ID and
/// TLS certificate hash so that each side can pin the other's identity.
///
/// H-1: each device-bearing variant also carries the supplied
/// `passphrase` so [`verify_device_exchange`] can confirm the joining
/// device typed the same passphrase that was generated on the host
/// device. Before H-1 the passphrase was never compared and any string
/// passed `confirm_pairing_inner`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PairingMessage {
    /// Initiator sends their identity + the passphrase they typed from
    /// the QR display on the responder device.
    DeviceOffer {
        device_id: String,
        cert_hash: String,
        passphrase: String,
    },
    /// Responder confirms with their identity + the passphrase they
    /// generated and showed in the QR.
    DeviceAccept {
        device_id: String,
        cert_hash: String,
        passphrase: String,
    },
    /// Error during pairing.
    PairingError { message: String },
}

/// Extract and verify the remote device info from a [`PairingMessage`].
///
/// Verification is layered:
///
/// - `expected_peer_id` (when `Some`): the message's `device_id` must
///   match or `AppError::InvalidOperation` is returned.
/// - `expected_passphrase` (when `Some`): H-1 — the message's
///   `passphrase` must match the passphrase stored in the active
///   `pairing_state` slot. A mismatch returns
///   `AppError::Validation("pairing.passphrase.mismatch")`. This is
///   the one place inside the local trust boundary where input from
///   outside (the user typing what they read off the QR display) is
///   checked, so the error is surfaced with a stable, machine-readable
///   tag the frontend can match on.
///
/// Returns `(device_id, cert_hash)` on success.
pub fn verify_device_exchange(
    msg: &PairingMessage,
    expected_peer_id: Option<&str>,
    expected_passphrase: Option<&str>,
) -> Result<(String, String), crate::error::AppError> {
    let (device_id, cert_hash, msg_passphrase) = match msg {
        PairingMessage::DeviceOffer {
            device_id,
            cert_hash,
            passphrase,
        }
        | PairingMessage::DeviceAccept {
            device_id,
            cert_hash,
            passphrase,
        } => (device_id.clone(), cert_hash.clone(), passphrase.clone()),
        PairingMessage::PairingError { message } => {
            return Err(crate::error::AppError::InvalidOperation(format!(
                "remote pairing error: {message}"
            )));
        }
    };

    if let Some(expected) = expected_peer_id {
        if device_id != expected {
            return Err(crate::error::AppError::InvalidOperation(format!(
                "device ID mismatch: expected {expected}, got {device_id}"
            )));
        }
    }

    // H-1: passphrase comparison. AGENTS.md threat model treats sync
    // peers as the user's own devices, so a constant-time compare is
    // not required — a wrong passphrase is the user mistyping or
    // scanning the wrong QR, not an adversary probing timing.
    if let Some(expected_pass) = expected_passphrase {
        if msg_passphrase != expected_pass {
            return Err(crate::error::AppError::Validation(
                "pairing.passphrase.mismatch".into(),
            ));
        }
    }

    Ok((device_id, cert_hash))
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

/// Duration after which a pairing session is considered expired.
#[cfg(test)]
const PAIRING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300); // 5 minutes

#[cfg(test)]
impl PairingSession {
    /// Returns `true` if the session has exceeded the 5-minute timeout.
    ///
    /// **Not used in production** — pairings are permanent by design.
    /// Retained for test coverage of timeout logic in case time-limited
    /// sessions are needed in the future.
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() >= PAIRING_TIMEOUT
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_passphrase_returns_four_words() {
        let phrase = generate_passphrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        assert_eq!(words.len(), 4, "passphrase should contain exactly 4 words");
    }

    #[test]
    fn generate_passphrase_words_are_from_wordlist() {
        let wl = wordlist();
        let phrase = generate_passphrase();
        for word in phrase.split(' ') {
            assert!(
                wl.contains(&word),
                "word '{word}' should be in the EFF wordlist"
            );
        }
    }

    #[test]
    fn pairing_qr_payload_valid_json() {
        let payload = pairing_qr_payload("alpha bravo charlie delta");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        // L-59: payload must declare its schema version explicitly.
        assert_eq!(parsed["v"], 1, "L-59: payload must include \"v\":1");
        assert_eq!(parsed["passphrase"], "alpha bravo charlie delta");
        // M-34: host and port are no longer part of the QR payload —
        // mDNS owns discovery + address resolution end-to-end.
        let object = parsed
            .as_object()
            .expect("M-34: QR payload must be a JSON object");
        assert_eq!(
            object.len(),
            2,
            "M-34: QR payload must contain exactly {{v, passphrase}}, got: {:?}",
            object.keys().collect::<Vec<_>>()
        );
        assert!(
            !object.contains_key("host"),
            "M-34: QR payload must not contain 'host'"
        );
        assert!(
            !object.contains_key("port"),
            "M-34: QR payload must not contain 'port'"
        );
    }

    /// L-59: encoded payload must always include `"v":1`.
    #[test]
    fn pairing_qr_payload_includes_version_field() {
        let payload = pairing_qr_payload("a b c d");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(
            parsed["v"], 1,
            "L-59: every QR payload must carry the version"
        );
        assert_eq!(parsed["v"].as_u64(), Some(u64::from(PAIRING_QR_VERSION)));
    }

    /// L-59: `parse_pairing_qr` must accept the encoder's own output —
    /// round-trip safety is the primary contract.
    #[test]
    fn parse_pairing_qr_round_trips_encoded_payload() {
        let payload = pairing_qr_payload("alpha bravo charlie delta");
        let decoded =
            parse_pairing_qr(&payload).expect("encoded payload must round-trip through parser");
        assert_eq!(decoded.passphrase, "alpha bravo charlie delta");
    }

    /// L-59: a payload missing `v` must be rejected with the
    /// `pairing_qr.unsupported_version` tag so the joiner can show a
    /// version-mismatch message instead of silently parsing unknown
    /// fields.
    #[test]
    fn parse_pairing_qr_rejects_missing_version() {
        let payload = serde_json::json!({
            "passphrase": "a b c d",
        })
        .to_string();
        let err =
            parse_pairing_qr(&payload).expect_err("missing 'v' must surface as version error");
        match err {
            AppError::InvalidOperation(msg) => {
                assert_eq!(
                    msg, "pairing_qr.unsupported_version",
                    "L-59: error tag must be pairing_qr.unsupported_version, got {msg}"
                );
            }
            other => panic!("expected InvalidOperation, got {other:?}"),
        }
    }

    /// L-59: an unknown future `"v":2` must be rejected with the same
    /// `pairing_qr.unsupported_version` tag, matching the missing-version
    /// case above.
    #[test]
    fn parse_pairing_qr_rejects_unknown_version() {
        let payload = serde_json::json!({
            "v": 2,
            "passphrase": "a b c d",
        })
        .to_string();
        let err =
            parse_pairing_qr(&payload).expect_err("unknown 'v':2 must surface as version error");
        match err {
            AppError::InvalidOperation(msg) => {
                assert_eq!(
                    msg, "pairing_qr.unsupported_version",
                    "L-59: error tag must be pairing_qr.unsupported_version, got {msg}"
                );
            }
            other => panic!("expected InvalidOperation, got {other:?}"),
        }
    }

    #[test]
    fn generate_qr_svg_contains_svg_tag() {
        let svg = generate_qr_svg("test data").expect("QR generation should succeed");
        assert!(
            svg.contains("<svg"),
            "QR output must contain an <svg tag, got: {svg}"
        );
    }

    #[test]
    fn pairing_session_expires_after_timeout() {
        let mut session = PairingSession::new("device-a", "device-b");
        assert!(
            !session.is_expired(),
            "freshly created session must not be expired"
        );
        // Simulate passage of time by back-dating created_at
        session.created_at = std::time::Instant::now() - std::time::Duration::from_secs(301);
        assert!(session.is_expired(), "session must be expired after 5+ min");
    }

    /// QR payload should correctly escape special characters in passphrase.
    #[test]
    fn qr_payload_special_chars_in_passphrase() {
        let passphrase = r#"hello "world" & <friends>"#;
        let payload = pairing_qr_payload(passphrase);
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(
            parsed["passphrase"].as_str().unwrap(),
            passphrase,
            "special characters must survive JSON round-trip"
        );
    }

    /// M-34: the QR payload carries only `{v, passphrase}` — no `host`
    /// and no `port`. Discovery + address resolution are owned end-to-end
    /// by mDNS; embedding bind-address fields in the QR was the
    /// drift fixed by M-34.
    #[test]
    fn start_pairing_qr_payload_carries_only_passphrase_m34() {
        let payload = pairing_qr_payload("alpha bravo charlie delta");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        let object = parsed
            .as_object()
            .expect("M-34: QR payload must be a JSON object");

        // Exactly two keys: `v` (schema version) and `passphrase`.
        assert_eq!(
            object.len(),
            2,
            "M-34: QR payload must contain exactly two keys, got: {:?}",
            object.keys().collect::<Vec<_>>()
        );
        assert!(
            object.contains_key("v"),
            "M-34: QR payload must contain 'v' (schema version)"
        );
        assert!(
            object.contains_key("passphrase"),
            "M-34: QR payload must contain 'passphrase'"
        );
        assert!(
            !object.contains_key("host"),
            "M-34: QR payload must not contain 'host' — mDNS owns discovery"
        );
        assert!(
            !object.contains_key("port"),
            "M-34: QR payload must not contain 'port' — mDNS owns address resolution"
        );
    }

    #[test]
    fn pairing_message_serialization_roundtrip() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "DEVICE01".to_string(),
            cert_hash: "abc123".to_string(),
            passphrase: "alpha bravo charlie delta".to_string(),
        };
        let json = serde_json::to_string(&msg).unwrap();
        let parsed: PairingMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(msg, parsed);
        assert!(json.contains("\"type\":\"device_offer\""));
    }

    #[test]
    fn verify_device_exchange_accepts_matching_id() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "DEV123".to_string(),
            cert_hash: "hash456".to_string(),
            passphrase: "any phrase will do".to_string(),
        };
        let (id, hash) = verify_device_exchange(&msg, Some("DEV123"), None).unwrap();
        assert_eq!(id, "DEV123");
        assert_eq!(hash, "hash456");
    }

    #[test]
    fn verify_device_exchange_rejects_mismatch() {
        let msg = PairingMessage::DeviceAccept {
            device_id: "WRONG".to_string(),
            cert_hash: "hash".to_string(),
            passphrase: "any phrase will do".to_string(),
        };
        let err = verify_device_exchange(&msg, Some("EXPECTED"), None).unwrap_err();
        assert!(err.to_string().contains("device ID mismatch"));
    }

    #[test]
    fn verify_device_exchange_no_expected_always_passes() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "ANY".to_string(),
            cert_hash: "hash".to_string(),
            passphrase: "any phrase will do".to_string(),
        };
        assert!(verify_device_exchange(&msg, None, None).is_ok());
    }

    #[test]
    fn verify_device_exchange_returns_error_on_pairing_error() {
        let msg = PairingMessage::PairingError {
            message: "timeout".to_string(),
        };
        let err = verify_device_exchange(&msg, None, None).unwrap_err();
        assert!(err.to_string().contains("remote pairing error"));
    }

    /// H-1: when `expected_passphrase` matches the message passphrase,
    /// verification succeeds and returns the (device_id, cert_hash) pair.
    #[test]
    fn verify_device_exchange_accepts_matching_passphrase() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "DEV1".to_string(),
            cert_hash: "h".to_string(),
            passphrase: "alpha bravo charlie delta".to_string(),
        };
        let (id, hash) = verify_device_exchange(&msg, None, Some("alpha bravo charlie delta"))
            .expect("matching passphrase must succeed");
        assert_eq!(id, "DEV1");
        assert_eq!(hash, "h");
    }

    /// H-1: a passphrase mismatch must surface as
    /// `AppError::Validation("pairing.passphrase.mismatch")` so the
    /// frontend can match on the tag without parsing free-text.
    #[test]
    fn verify_device_exchange_rejects_passphrase_mismatch() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "DEV1".to_string(),
            cert_hash: "h".to_string(),
            passphrase: "wrong wrong wrong wrong".to_string(),
        };
        let err = verify_device_exchange(&msg, None, Some("alpha bravo charlie delta"))
            .expect_err("mismatched passphrase must fail");
        match err {
            AppError::Validation(msg) => assert_eq!(
                msg, "pairing.passphrase.mismatch",
                "H-1 error tag must be pairing.passphrase.mismatch"
            ),
            other => panic!("expected Validation, got {other:?}"),
        }
    }

    /// H-1: when `expected_passphrase` is `None`, the function must
    /// not look at the message's passphrase at all — preserves the
    /// pre-H-1 behaviour for callers that only need device_id checks.
    #[test]
    fn verify_device_exchange_skips_passphrase_check_when_none() {
        let msg = PairingMessage::DeviceAccept {
            device_id: "DEV1".to_string(),
            cert_hash: "h".to_string(),
            passphrase: "wrong wrong wrong wrong".to_string(),
        };
        verify_device_exchange(&msg, None, None)
            .expect("no expected_passphrase => no passphrase check");
    }
}
