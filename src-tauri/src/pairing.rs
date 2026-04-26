//! Sync pairing crypto module.
//!
//! Handles passphrase generation (EFF large wordlist), session key derivation
//! (HKDF-SHA256), authenticated encryption (ChaCha20-Poly1305), QR code
//! payload construction, and pairing session management.

use crate::error::AppError;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use rand::seq::IndexedRandom;
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
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
// Session Key Derivation (HKDF-SHA256)
// ---------------------------------------------------------------------------

/// Derive a 32-byte session key from a passphrase and salt using HKDF-SHA256.
///
/// - `passphrase`: the 4-word passphrase
/// - `salt`: remote device ID bytes
/// - Info context: `b"agaric-sync-v1"`
///
/// Output is suitable for ChaCha20-Poly1305.
pub fn derive_session_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), passphrase.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"agaric-sync-v1", &mut okm)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

// ---------------------------------------------------------------------------
// Authenticated Encryption (ChaCha20-Poly1305)
// ---------------------------------------------------------------------------

/// Encrypt `plaintext` with ChaCha20-Poly1305.
///
/// Returns `[12-byte random nonce][ciphertext + 16-byte tag]`.
pub fn encrypt_message(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));

    let mut nonce_bytes = [0u8; 12];
    rand::rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| AppError::InvalidOperation(format!("[pairing] encryption failed: {e}")))?;

    let mut out = Vec::with_capacity(12 + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a message produced by [`encrypt_message`].
///
/// Expects input format: `[12-byte nonce][ciphertext + tag]`.
pub fn decrypt_message(key: &[u8; 32], ciphertext: &[u8]) -> Result<Vec<u8>, AppError> {
    // Minimum: 12-byte nonce + 16-byte Poly1305 auth tag = 28 bytes
    if ciphertext.len() < 28 {
        return Err(AppError::InvalidOperation(
            "[pairing] ciphertext too short: need at least 12-byte nonce + 16-byte auth tag".into(),
        ));
    }

    let (nonce_bytes, ct) = ciphertext.split_at(12);
    let cipher = ChaCha20Poly1305::new(Key::from_slice(key));
    let nonce = Nonce::from_slice(nonce_bytes);

    cipher
        .decrypt(nonce, ct)
        .map_err(|e| AppError::InvalidOperation(format!("[pairing] decryption failed: {e}")))
}

// ---------------------------------------------------------------------------
// QR Code Payload & SVG Generation
// ---------------------------------------------------------------------------

/// Build the JSON payload for a pairing QR code.
///
/// Returns: `{"passphrase":"w1 w2 w3 w4","host":"...","port":12345}`
pub fn pairing_qr_payload(passphrase: &str, host: &str, port: u16) -> String {
    serde_json::json!({
        "passphrase": passphrase,
        "host": host,
        "port": port,
    })
    .to_string()
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

/// Short-lived pairing session that holds the passphrase and derived key.
pub struct PairingSession {
    pub passphrase: String,
    pub session_key: [u8; 32],
    pub created_at: std::time::Instant,
}

impl PairingSession {
    /// Create a new pairing session with a freshly generated passphrase.
    ///
    /// The session key is derived from the passphrase using the concatenation
    /// of `local_device_id` and `remote_device_id` as the HKDF salt.
    pub fn new(local_device_id: &str, remote_device_id: &str) -> Self {
        let passphrase = generate_passphrase();
        let salt = Self::build_salt(local_device_id, remote_device_id);
        let session_key = derive_session_key(&passphrase, &salt);
        Self {
            passphrase,
            session_key,
            created_at: std::time::Instant::now(),
        }
    }

    /// Create a pairing session from an existing passphrase (e.g. scanned
    /// from the other device's QR code).
    pub fn from_passphrase(
        passphrase: &str,
        local_device_id: &str,
        remote_device_id: &str,
    ) -> Self {
        let salt = Self::build_salt(local_device_id, remote_device_id);
        let session_key = derive_session_key(passphrase, &salt);
        Self {
            passphrase: passphrase.to_owned(),
            session_key,
            created_at: std::time::Instant::now(),
        }
    }

    /// Build a deterministic salt from both device IDs.
    ///
    /// The IDs are sorted before concatenation so that both sides derive the
    /// same key regardless of which is "local" vs "remote".
    ///
    /// L-60: A `\x00` byte is inserted between the two IDs so that
    /// `build_salt("AB", "CD")` ≠ `build_salt("A", "BCD")` regardless of
    /// future ID format changes. Crockford ULIDs only use the alphabet
    /// `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, so `\x00` cannot appear inside
    /// any well-formed device ID and remains a safe separator.
    fn build_salt(id_a: &str, id_b: &str) -> Vec<u8> {
        let mut ids = [id_a, id_b];
        ids.sort();
        let mut salt = Vec::with_capacity(ids[0].len() + 1 + ids[1].len());
        salt.extend_from_slice(ids[0].as_bytes());
        salt.push(0);
        salt.extend_from_slice(ids[1].as_bytes());
        salt
    }
}

// ---------------------------------------------------------------------------
// Pairing message types for device verification (ADR-pending)
// ---------------------------------------------------------------------------

/// Messages exchanged during the device verification step of pairing.
///
/// After passphrase confirmation, both peers exchange their device ID and
/// TLS certificate hash so that each side can pin the other's identity.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PairingMessage {
    /// Initiator sends their identity.
    DeviceOffer {
        device_id: String,
        cert_hash: String,
    },
    /// Responder confirms with their identity.
    DeviceAccept {
        device_id: String,
        cert_hash: String,
    },
    /// Error during pairing.
    PairingError { message: String },
}

/// Extract and optionally verify the remote device info from a [`PairingMessage`].
///
/// If `expected_peer_id` is `Some`, the extracted `device_id` must match or
/// an `AppError::InvalidOperation` is returned.  Returns `(device_id, cert_hash)`.
pub fn verify_device_exchange(
    msg: &PairingMessage,
    expected_peer_id: Option<&str>,
) -> Result<(String, String), crate::error::AppError> {
    let (device_id, cert_hash) = match msg {
        PairingMessage::DeviceOffer {
            device_id,
            cert_hash,
        }
        | PairingMessage::DeviceAccept {
            device_id,
            cert_hash,
        } => (device_id.clone(), cert_hash.clone()),
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
    fn derive_session_key_deterministic() {
        let key1 = derive_session_key("alpha bravo charlie delta", b"salt123");
        let key2 = derive_session_key("alpha bravo charlie delta", b"salt123");
        assert_eq!(key1, key2, "same inputs must produce the same key");
    }

    #[test]
    fn derive_session_key_different_salts_produce_different_keys() {
        let key1 = derive_session_key("alpha bravo charlie delta", b"salt-a");
        let key2 = derive_session_key("alpha bravo charlie delta", b"salt-b");
        assert_ne!(key1, key2, "different salts must produce different keys");
    }

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let key = derive_session_key("test phrase here now", b"roundtrip");
        let plaintext = b"hello, sync world!";
        let encrypted = encrypt_message(&key, plaintext).expect("encrypt should succeed");
        let decrypted = decrypt_message(&key, &encrypted).expect("decrypt should succeed");
        assert_eq!(
            decrypted, plaintext,
            "decrypted text must match original plaintext"
        );
    }

    #[test]
    fn decrypt_wrong_key_fails() {
        let key1 = derive_session_key("correct phrase", b"salt");
        let key2 = derive_session_key("wrong phrase", b"salt");
        let encrypted = encrypt_message(&key1, b"secret").expect("encrypt should succeed");
        let result = decrypt_message(&key2, &encrypted);
        assert!(
            result.is_err(),
            "decryption with wrong key must return an error"
        );
    }

    #[test]
    fn decrypt_tampered_ciphertext_fails() {
        let key = derive_session_key("tamper test", b"salt");
        let mut encrypted = encrypt_message(&key, b"do not tamper").expect("encrypt");
        // Flip a byte in the ciphertext (after the 12-byte nonce)
        if let Some(byte) = encrypted.get_mut(14) {
            *byte ^= 0xFF;
        }
        let result = decrypt_message(&key, &encrypted);
        assert!(
            result.is_err(),
            "tampered ciphertext must fail authentication"
        );
    }

    #[test]
    fn pairing_qr_payload_valid_json() {
        let payload = pairing_qr_payload("alpha bravo charlie delta", "192.168.1.42", 12345);
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(parsed["passphrase"], "alpha bravo charlie delta");
        assert_eq!(parsed["host"], "192.168.1.42");
        assert_eq!(parsed["port"], 12345);
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

    #[test]
    fn pairing_session_from_passphrase_derives_same_key() {
        let session1 = PairingSession::new("device-local", "device-remote");
        let session2 =
            PairingSession::from_passphrase(&session1.passphrase, "device-local", "device-remote");
        assert_eq!(
            session1.session_key, session2.session_key,
            "sessions with the same passphrase and device IDs must derive the same key"
        );
    }

    /// Verify salt is order-independent: swapping local/remote still yields the same key.
    #[test]
    fn pairing_session_key_is_device_order_independent() {
        let s1 = PairingSession::from_passphrase("alpha bravo charlie delta", "AAA", "BBB");
        let s2 = PairingSession::from_passphrase("alpha bravo charlie delta", "BBB", "AAA");
        assert_eq!(
            s1.session_key, s2.session_key,
            "key derivation must be independent of local/remote ordering"
        );
    }

    /// L-60: With the `\x00` separator, two ID pairs that previously
    /// concatenated to the same byte sequence must now produce distinct
    /// salts and therefore distinct session keys.
    #[test]
    fn build_salt_separator_disambiguates_concatenation_collisions() {
        let salt1 = PairingSession::build_salt("AB", "CD");
        let salt2 = PairingSession::build_salt("A", "BCD");
        assert_ne!(
            salt1, salt2,
            "salts for (\"AB\",\"CD\") and (\"A\",\"BCD\") must differ"
        );
        // And the corresponding session keys must also differ.
        let k1 = derive_session_key("alpha bravo charlie delta", &salt1);
        let k2 = derive_session_key("alpha bravo charlie delta", &salt2);
        assert_ne!(
            k1, k2,
            "session keys derived from those distinct salts must differ"
        );
    }

    // -- Additional coverage: error paths & edge cases -----------------------

    /// Decrypting an empty input should fail with a descriptive error.
    #[test]
    fn decrypt_empty_input_fails() {
        let key = derive_session_key("test", b"salt");
        let result = decrypt_message(&key, &[]);
        assert!(result.is_err(), "empty input must fail");
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("too short"),
            "error should mention 'too short', got: {msg}"
        );
    }

    /// Ciphertext shorter than 28 bytes (nonce + tag) should be caught early.
    #[test]
    fn decrypt_short_ciphertext_under_28_bytes_fails() {
        let key = derive_session_key("test", b"salt");
        // 20 bytes: enough for a nonce (12) but not a tag (16)
        let short = vec![0u8; 20];
        let result = decrypt_message(&key, &short);
        assert!(result.is_err(), "input shorter than 28 must fail");
        let msg = result.unwrap_err().to_string();
        assert!(
            msg.contains("too short"),
            "error should mention 'too short', got: {msg}"
        );
    }

    /// Encrypting and decrypting empty plaintext should round-trip correctly.
    #[test]
    fn encrypt_decrypt_empty_plaintext() {
        let key = derive_session_key("empty test", b"salt");
        let encrypted = encrypt_message(&key, b"").expect("encrypt empty should succeed");
        // 12-byte nonce + 16-byte tag = 28 bytes for empty plaintext
        assert_eq!(
            encrypted.len(),
            28,
            "encrypted empty plaintext should be exactly 28 bytes (nonce + tag)"
        );
        let decrypted = decrypt_message(&key, &encrypted).expect("decrypt should succeed");
        assert!(
            decrypted.is_empty(),
            "decrypted empty plaintext must be empty"
        );
    }

    /// QR payload should correctly escape special characters in passphrase.
    #[test]
    fn qr_payload_special_chars_in_passphrase() {
        let passphrase = r#"hello "world" & <friends>"#;
        let payload = pairing_qr_payload(passphrase, "10.0.0.1", 9999);
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("payload must be valid JSON");
        assert_eq!(
            parsed["passphrase"].as_str().unwrap(),
            passphrase,
            "special characters must survive JSON round-trip"
        );
    }

    #[test]
    fn pairing_message_serialization_roundtrip() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "DEVICE01".to_string(),
            cert_hash: "abc123".to_string(),
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
        };
        let (id, hash) = verify_device_exchange(&msg, Some("DEV123")).unwrap();
        assert_eq!(id, "DEV123");
        assert_eq!(hash, "hash456");
    }

    #[test]
    fn verify_device_exchange_rejects_mismatch() {
        let msg = PairingMessage::DeviceAccept {
            device_id: "WRONG".to_string(),
            cert_hash: "hash".to_string(),
        };
        let err = verify_device_exchange(&msg, Some("EXPECTED")).unwrap_err();
        assert!(err.to_string().contains("device ID mismatch"));
    }

    #[test]
    fn verify_device_exchange_no_expected_always_passes() {
        let msg = PairingMessage::DeviceOffer {
            device_id: "ANY".to_string(),
            cert_hash: "hash".to_string(),
        };
        assert!(verify_device_exchange(&msg, None).is_ok());
    }

    #[test]
    fn verify_device_exchange_returns_error_on_pairing_error() {
        let msg = PairingMessage::PairingError {
            message: "timeout".to_string(),
        };
        let err = verify_device_exchange(&msg, None).unwrap_err();
        assert!(err.to_string().contains("remote pairing error"));
    }

    // ======================================================================
    // #456 — PairingSession concurrent/edge cases
    // ======================================================================

    #[test]
    fn concurrent_pairing_sessions_are_independent() {
        let s1 = PairingSession::new("alice-phone", "bob-laptop");
        let s2 = PairingSession::new("carol-tablet", "dave-desktop");

        // Different device pairs must produce different keys
        assert_ne!(
            s1.session_key, s2.session_key,
            "sessions for different device pairs must have different keys"
        );

        // Both sessions are independently non-expired
        assert!(!s1.is_expired(), "session 1 must not be expired");
        assert!(!s2.is_expired(), "session 2 must not be expired");

        // Cross-session decryption must fail
        let plaintext = b"only for session 1";
        let encrypted = encrypt_message(&s1.session_key, plaintext)
            .expect("encrypt with session 1 key should succeed");
        let result = decrypt_message(&s2.session_key, &encrypted);
        assert!(
            result.is_err(),
            "decrypting session-1 ciphertext with session-2 key must fail"
        );
    }

    #[test]
    fn session_key_works_after_session_expires() {
        let mut session = PairingSession::new("A", "B");
        // Force session past the 300s timeout
        session.created_at = std::time::Instant::now() - std::time::Duration::from_secs(301);
        assert!(session.is_expired(), "session should be expired after 301s");

        let plaintext = b"secret message";
        let encrypted = encrypt_message(&session.session_key, plaintext).unwrap();
        let decrypted = decrypt_message(&session.session_key, &encrypted).unwrap();
        assert_eq!(
            decrypted, plaintext,
            "key should still work for crypto even after session expires"
        );
    }

    // ======================================================================
    // #457 — encrypt/decrypt edge cases
    // ======================================================================

    #[test]
    fn encrypt_decrypt_large_plaintext() {
        let key = [42u8; 32];
        let plaintext = vec![0xAB_u8; 1_048_576]; // 1 MB
        let encrypted = encrypt_message(&key, &plaintext).unwrap();
        let decrypted = decrypt_message(&key, &encrypted).unwrap();
        assert_eq!(
            decrypted, plaintext,
            "1 MB plaintext should roundtrip correctly"
        );
        // Verify ciphertext is larger than plaintext (nonce + tag overhead)
        assert_eq!(
            encrypted.len(),
            plaintext.len() + 12 + 16,
            "ciphertext should be plaintext + 28 bytes overhead"
        );
    }

    #[test]
    fn decrypt_corrupted_nonce_fails() {
        let key = [42u8; 32];
        let plaintext = b"hello world";
        let mut encrypted = encrypt_message(&key, plaintext).unwrap();
        // Corrupt the nonce (first 12 bytes)
        for byte in encrypted.iter_mut().take(12) {
            *byte ^= 0xFF;
        }
        let result = decrypt_message(&key, &encrypted);
        assert!(result.is_err(), "corrupted nonce should fail decryption");
    }

    #[test]
    fn decrypt_truncated_ciphertext_various_lengths() {
        let key = [42u8; 32];
        for len in [1, 12, 15, 27] {
            let garbage = vec![0xAA; len];
            let result = decrypt_message(&key, &garbage);
            assert!(result.is_err(), "ciphertext of {len} bytes should fail");
        }
    }
}
