//! Sync pairing module — passphrase exchange leg of the device pairing flow.
//!
//! # Place in the pairing flow
//!
//! - **This module (`pairing`)** — pure helpers: EFF wordlist passphrase
//!   generation, QR payload encoding ([`crate::pairing::pairing_qr_payload`];
//!   the TS side parses it, see that function's doc comment), and
//!   [`crate::pairing::pairing_proof`], a domain-separated hash of the
//!   passphrase carried on the wire (#855).
//! - `crate::commands::sync_cmds` — Tauri-IPC orchestration: generates the
//!   QR payload via this module and arms the pending-pairing marker (see
//!   [`agaric_store::peer_refs::set_pending_pairing`]) with
//!   [`crate::pairing::pairing_proof`] of the confirmed passphrase.
//! - [`crate::transport::identity`] — owns the persistent iroh secret key whose
//!   public half is this device's `EndpointId`, the thing a peer pins.
//!
//! There is no application-layer pairing handshake: identity pinning is pure
//! transport-level TOFU. On the first authenticated connection to an unpinned
//! peer, [`agaric_store::peer_refs::bind_endpoint_id`] stores the peer's
//! `EndpointId` — the identity QUIC's own handshake authenticated
//! (`sync_daemon::server` on the responder side,
//! `sync_daemon::session_supervisor` on the initiator side) — and
//! `get_peer_ref_by_endpoint_id` resolves against it on every subsequent
//! connection. A two-device `PairingMessage` exchange
//! existed here previously but was never reachable in production (#3463)
//! and has been removed.
//!
//! Confidentiality and authenticity of the pairing exchange come from the QUIC
//! handshake and the endpoint-id pin, not from a derived session key — there is
//! no application-layer crypto in this module.

use agaric_core::error::AppError;

use rand::seq::IndexedRandom;
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

/// Current pairing QR payload schema version. Increment whenever
/// the JSON shape changes in a way that would confuse older joiners.
pub const PAIRING_QR_VERSION: u32 = 1;

/// Build the JSON payload for a pairing QR code.
///
/// Returns: `{"v":1,"passphrase":"w1 w2 w3 w4"}`.
///
/// The leading `"v"` field tags the schema version so the joining
/// device fails fast on a payload it cannot parse — a stale QR or an
/// unrecognised future shape — rather than silently dropping fields.
///
/// The QR carries only the passphrase. Discovery and address
/// resolution are owned end-to-end by mDNS — there is no scan-bootstrap
/// path, so the QR never embeds host/port.
///
/// This payload is parsed on the TS side
/// (`src/components/dialogs/PairingDialog.tsx`, `JSON.parse(data)`), not
/// in Rust — there is no `parse_pairing_qr` counterpart here. The two
/// were never equivalent: the TS parser also accepts a bare non-JSON
/// string as a plain passphrase and does not check `v`, so do not assume
/// a Rust round-trip of this exact shape exists.
pub fn pairing_qr_payload(passphrase: &str) -> String {
    serde_json::json!({
        "v": PAIRING_QR_VERSION,
        "passphrase": passphrase,
    })
    .to_string()
}

/// Render `data` as a QR code and return the SVG markup.
///
/// The `qrcode` crate prefixes its output with an `<?xml …?>` declaration.
/// That prolog is invalid once the markup is injected into an HTML element
/// via `innerHTML` (the HTML parser treats `<?xml …?>` as a bogus comment),
/// so we strip it and hand the frontend a bare `<svg>…</svg>` fragment.
pub fn generate_qr_svg(data: &str) -> Result<String, AppError> {
    let code = qrcode::QrCode::new(data.as_bytes())
        .map_err(|e| AppError::InvalidOperation(format!("[pairing] QR generation failed: {e}")))?;
    let svg = code.render::<qrcode::render::svg::Color>().build();
    // Keep everything from the opening `<svg` tag onward, dropping the XML
    // declaration the renderer emits before it.
    Ok(match svg.find("<svg") {
        Some(idx) => svg[idx..].to_string(),
        None => svg,
    })
}

// ---------------------------------------------------------------------------
// Pairing Session
// ---------------------------------------------------------------------------

/// Lifetime of a pairing session / the pending-pairing activation marker.
///
/// A pairing session is short-lived: the host shows a QR, the joiner scans
/// The interactive pairing window used by `PairingSession::is_expired`.
///
/// Moved down into the store layer ([`agaric_store::peer_refs`]) so the
/// pending-pairing marker (see [`agaric_store::peer_refs::is_pending_pairing`])
/// can bound itself to the same clock without reaching *up* into this sync
/// module; re-exported here so `crate::pairing::PAIRING_TIMEOUT` and every
/// in-module use resolve unchanged. Once the interactive window has elapsed
/// an abandoned pairing must stop driving the daemon into pairing-mode.
pub use agaric_store::peer_refs::PAIRING_TIMEOUT;

// #3463: `MAX_PASSPHRASE_ATTEMPTS` and `PairingSession::{failed_attempts,
// attempts_exhausted, record_failed_attempt}` were removed here. They bounded
// repeated *local* guesses against the local `pairing_state` slot in
// `confirm_pairing_inner` (#1603). That comparison is gone — it made two-device
// pairing structurally impossible and authenticated nothing — so nothing was
// left for the counter to count, and an unreachable counter that reads like a
// security control is worse than none. The bound that matters is the wire-side
// one: the pending-pairing marker expires after [`PAIRING_TIMEOUT`], so a
// remote guesser has 5 minutes, one connection per try, against ~51.7 bits.

/// Domain-separation tag for [`pairing_proof`] (#855). Bumping it invalidates
/// every proof from an older peer, so keep it stable across compatible releases.
const PAIRING_PROOF_DOMAIN: &[u8] = b"agaric-pairing-proof-v1";

/// Proof that a peer knows the pairing passphrase, carried in
/// [`crate::sync_protocol::SyncMessage::HeadExchange::pairing_proof`] (#855).
///
/// Both devices independently store this value in their pending-pairing marker
/// when they arm (`crate::commands::sync_cmds::start_pairing_armed_inner`) or
/// confirm (`crate::commands::sync_cmds::confirm_pairing_inner`) a pairing;
/// the initiator echoes it in its `HeadExchange`, and the responder compares it
/// to its own stored value before it TOFU-pins an unpaired device
/// ([`crate::sync_daemon::server`]).
///
/// This closes the #855 CN-spoof window: a self-signed `CN=agaric-{victim}`
/// cert can be minted by anyone, but an attacker that does not know the
/// out-of-band passphrase cannot produce this value, so the responder never
/// pins its cert as the victim device. The proof travels only over the
/// confidential mTLS channel; a full man-in-the-middle relay is out of the
/// paired-device threat model (AGENTS.md §"Threat Model").
///
/// It is a domain-separated blake3 of the passphrase (not the raw passphrase),
/// so the value persisted in the pending-pairing marker is not the passphrase
/// itself and is not reusable outside this pairing sub-flow.
pub fn pairing_proof(passphrase: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(PAIRING_PROOF_DOMAIN);
    hasher.update(passphrase.as_bytes());
    hasher.finalize().to_hex().to_string()
}

/// Short-lived pairing session that tracks the generated passphrase.
///
/// Confidentiality and authenticity of the pairing exchange come from the QUIC
/// handshake and the endpoint-id TOFU pin ([`crate::transport`]), not from a
/// derived session key — see the module-level doc comment.
pub struct PairingSession {
    pub passphrase: String,
    pub created_at: std::time::Instant,
}

impl PairingSession {
    /// Create a new pairing session with a freshly generated passphrase.
    ///
    /// `local_device_id` / `remote_device_id` are kept on the signature
    /// for API symmetry with other pairing-related constructors but are
    /// unused — the pairing exchange relies on the underlying mTLS +
    /// cert-pin layer for confidentiality, so no per-session key is
    /// derived.
    pub fn new(_local_device_id: &str, _remote_device_id: &str) -> Self {
        Self {
            passphrase: generate_passphrase(),
            created_at: std::time::Instant::now(),
        }
    }
}

// ---------------------------------------------------------------------------
// Test-only helpers
// ---------------------------------------------------------------------------

#[cfg(test)]
impl PairingSession {
    /// Returns `true` if the session has exceeded [`PAIRING_TIMEOUT`].
    ///
    /// **Not used in production** for the in-memory session — the slot is
    /// cleared on confirm/cancel. The same [`PAIRING_TIMEOUT`] *is* enforced
    /// in production for the persisted pending-pairing marker
    /// ([`agaric_store::peer_refs::is_pending_pairing`]). Retained here for test
    /// coverage of the session-timeout logic.
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
    fn pairing_proof_is_deterministic_and_passphrase_specific() {
        // #855: the proof is a stable, domain-separated blake3 hex of the
        // passphrase — both devices derive the same value from the same
        // passphrase, and a different passphrase yields a different proof.
        let p1 = pairing_proof("correct horse battery staple");
        let p2 = pairing_proof("correct horse battery staple");
        assert_eq!(p1, p2, "same passphrase must yield the same proof");
        assert_eq!(p1.len(), 64, "blake3 hex digest is 64 chars");
        assert!(p1.chars().all(|c| c.is_ascii_hexdigit()), "hex digits only");

        let other = pairing_proof("correct horse battery stapler");
        assert_ne!(
            p1, other,
            "a different passphrase must yield a different proof"
        );

        // It is NOT the passphrase itself, and NOT a bare blake3 of it (domain
        // separation) — so the value stored in the marker is not a reusable
        // secret outside this sub-flow.
        assert_ne!(p1, "correct horse battery staple");
        let bare = blake3::hash("correct horse battery staple".as_bytes())
            .to_hex()
            .to_string();
        assert_ne!(p1, bare, "domain separation must change the digest");
    }

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
        // Payload must declare its schema version explicitly.
        assert_eq!(parsed["v"], 1, "payload must include \"v\":1");
        assert_eq!(parsed["passphrase"], "alpha bravo charlie delta");
        // Host and port are no longer part of the QR payload —
        // mDNS owns discovery + address resolution end-to-end.
        let object = parsed
            .as_object()
            .expect("QR payload must be a JSON object");
        assert_eq!(
            object.len(),
            2,
            "QR payload must contain exactly {{v, passphrase}}, got: {:?}",
            object.keys().collect::<Vec<_>>()
        );
        assert!(
            !object.contains_key("host"),
            "QR payload must not contain 'host'"
        );
        assert!(
            !object.contains_key("port"),
            "QR payload must not contain 'port'"
        );
    }

    /// Encoded payload must always include `"v":1`.
    #[test]
    fn pairing_qr_payload_includes_version_field() {
        let payload = pairing_qr_payload("a b c d");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed["v"], 1, "every QR payload must carry the version");
        assert_eq!(parsed["v"].as_u64(), Some(u64::from(PAIRING_QR_VERSION)));
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
    fn generate_qr_svg_strips_xml_prolog() {
        // The markup is injected into the DOM via innerHTML, where a leading
        // `<?xml …?>` declaration is invalid; it must start at `<svg`.
        let svg = generate_qr_svg("test data").expect("QR generation should succeed");
        assert!(
            svg.starts_with("<svg"),
            "QR output must start with <svg (no XML prolog), got: {svg}"
        );
        assert!(
            !svg.contains("<?xml"),
            "QR output must not contain an XML declaration, got: {svg}"
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

    /// The QR payload carries only `{v, passphrase}` — no `host`
    /// and no `port`. Discovery + address resolution are owned end-to-end
    /// by mDNS; embedding bind-address fields in the QR was the
    /// Drift fixed by.
    #[test]
    fn start_pairing_qr_payload_carries_only_passphrase_m34() {
        let payload = pairing_qr_payload("alpha bravo charlie delta");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        let object = parsed
            .as_object()
            .expect("QR payload must be a JSON object");

        // Exactly two keys: `v` (schema version) and `passphrase`.
        assert_eq!(
            object.len(),
            2,
            "QR payload must contain exactly two keys, got: {:?}",
            object.keys().collect::<Vec<_>>()
        );
        assert!(
            object.contains_key("v"),
            "QR payload must contain 'v' (schema version)"
        );
        assert!(
            object.contains_key("passphrase"),
            "QR payload must contain 'passphrase'"
        );
        assert!(
            !object.contains_key("host"),
            "QR payload must not contain 'host' — mDNS owns discovery"
        );
        assert!(
            !object.contains_key("port"),
            "QR payload must not contain 'port' — mDNS owns address resolution"
        );
    }
}
