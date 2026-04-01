//! Sync pairing crypto module.
//!
//! Handles passphrase generation (EFF large wordlist), session key derivation
//! (HKDF-SHA256), authenticated encryption (ChaCha20-Poly1305), QR code
//! payload construction, and pairing session management.

use crate::error::AppError;

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hkdf::Hkdf;
use rand::seq::SliceRandom;
use rand::RngCore;
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
    let mut rng = rand::thread_rng();
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
/// - Info context: `b"block-notes-sync-v1"`
///
/// Output is suitable for ChaCha20-Poly1305.
pub fn derive_session_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(Some(salt), passphrase.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"block-notes-sync-v1", &mut okm)
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
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
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

/// Duration after which a pairing session is considered expired.
const PAIRING_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300); // 5 minutes

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

    /// Returns `true` if the session has exceeded the 5-minute timeout.
    pub fn is_expired(&self) -> bool {
        self.created_at.elapsed() >= PAIRING_TIMEOUT
    }

    /// Build a deterministic salt from both device IDs.
    ///
    /// The IDs are sorted before concatenation so that both sides derive the
    /// same key regardless of which is "local" vs "remote".
    fn build_salt(id_a: &str, id_b: &str) -> Vec<u8> {
        let mut ids = [id_a, id_b];
        ids.sort();
        let mut salt = Vec::with_capacity(ids[0].len() + ids[1].len());
        salt.extend_from_slice(ids[0].as_bytes());
        salt.extend_from_slice(ids[1].as_bytes());
        salt
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
}
