//! The device's long-lived iroh secret key (#78, plan #3464).
//!
//! # Why this module has to exist at all
//!
//! [`lan_only`](super::endpoint::lan_only) does not set a secret key, so
//! `Endpoint::bind` mints a fresh one on every call. For the slices that built
//! `transport` that was invisible and harmless — every test binds, dials itself and
//! throws both endpoints away.
//!
//! It stops being harmless the moment an `EndpointId` becomes a *stored* identity.
//! `peer_refs.endpoint_id` is the pinned-identity column that replaces `cert_hash`, and
//! the responder's S-1 gate resolves an inbound peer by looking that column up. A key
//! regenerated at boot would mean:
//!
//! * every paired peer becomes unrecognised after a restart — the lookup misses, S-1
//!   rejects, and sync stops until the user re-pairs;
//! * the mDNS record advertises a key that will not exist next launch;
//! * `bind_endpoint_id` would rewrite the column on every boot, so a pin that is
//!   rewritten unconditionally pins nothing.
//!
//! The old stack had the same requirement and met it the same way, one layer down:
//! `sync_cert::get_or_create_sync_cert` persists the TLS keypair precisely so
//! `cert_hash` stays stable across restarts. This is that guarantee, carried across
//! the transport swap to the thing that now carries identity.
//!
//! # Format, and why it is not the cert file
//!
//! 32 raw ed25519 secret bytes, hex-encoded, one line, mode `0o600`. Deliberately its
//! own file rather than another field in the cert PEM: the cert file is deleted by the
//! PR that retires `sync_net`, and an identity that outlives the transport must not
//! live inside the transport it outlives.
//!
//! Hex rather than raw bytes so a truncated or partially-written file is *detectable*
//! (wrong length, or a non-hex byte) instead of silently decoding to a different,
//! valid-looking key. A key that reads back subtly wrong is worse than one that fails
//! to read: it produces a working endpoint with an identity no peer has ever seen.

use std::fs;
use std::io::Write as _;
use std::path::Path;

use iroh::SecretKey;

use agaric_core::error::AppError;

/// Bytes of hex a well-formed key file holds (32 bytes × 2 characters).
const HEX_LEN: usize = 64;

fn identity_err(msg: impl Into<String>) -> AppError {
    AppError::InvalidOperation(format!("[transport::identity] {}", msg.into()))
}

/// Open options that create a new file readable only by its owner.
///
/// `create_new` makes the create path atomic against a concurrent startup: exactly one
/// caller creates the file and every other observes `AlreadyExists` and reads it. Same
/// discipline (and the same reason) as `sync_cert`'s `secure_create_options`.
fn secure_create_options() -> fs::OpenOptions {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    opts
}

/// Decode a stored key file's contents.
///
/// Split out from [`get_or_create_endpoint_secret`] so the corruption cases are
/// testable without a filesystem — they are the cases with no natural way to provoke
/// on disk, and the ones whose failure mode (a *different* working identity) is the
/// one worth failing loudly on.
///
/// # Errors
/// If the trimmed contents are not exactly [`HEX_LEN`] hex characters.
pub fn decode_secret_hex(raw: &str) -> Result<SecretKey, AppError> {
    let trimmed = raw.trim();
    if trimmed.len() != HEX_LEN {
        return Err(identity_err(format!(
            "endpoint key file holds {} characters, expected {HEX_LEN} hex characters",
            trimmed.len()
        )));
    }
    let mut bytes = [0u8; 32];
    for (i, chunk) in trimmed.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(chunk).map_err(|_| identity_err("key file is not UTF-8"))?;
        bytes[i] = u8::from_str_radix(pair, 16)
            .map_err(|_| identity_err(format!("key file byte {i} is not hex")))?;
    }
    Ok(SecretKey::from_bytes(&bytes))
}

/// Render a secret key in the one spelling this module writes.
fn encode_secret_hex(key: &SecretKey) -> String {
    key.to_bytes().iter().map(|b| format!("{b:02x}")).collect()
}

/// Load the device's iroh secret key from `path`, creating it on first run.
///
/// The returned key is stable for the lifetime of the install, which is what makes
/// [`EndpointId`](iroh::EndpointId) usable as a stored identity — see the module docs.
///
/// # Errors
/// If the file cannot be created or read, or if an existing file is not a
/// [`HEX_LEN`]-character hex string. A malformed file is **not** silently replaced: a
/// new key would present this device to every paired peer as a stranger, and the
/// recovery a user wants there is "restore the file", not "re-pair everything".
pub fn get_or_create_endpoint_secret(path: &Path) -> Result<SecretKey, AppError> {
    match secure_create_options().open(path) {
        Ok(mut file) => {
            let key = SecretKey::generate();
            file.write_all(encode_secret_hex(&key).as_bytes())?;
            file.sync_all()?;
            // POSIX only guarantees the directory entry reaches stable storage after
            // the parent directory is fsynced. Without it a power loss can leave the
            // file's *data* durable and its *name* absent, so the next launch mints a
            // second identity and every paired peer stops recognising this device —
            // the exact failure this module exists to prevent. Best-effort, and
            // skipped on Windows where a directory handle has no equivalent flush.
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                match fs::File::open(parent) {
                    Ok(dir) => {
                        if let Err(e) = dir.sync_all() {
                            tracing::warn!(
                                dir = %parent.display(),
                                error = %e,
                                "transport.identity: failed to fsync parent dir"
                            );
                        }
                    }
                    Err(e) => tracing::warn!(
                        dir = %parent.display(),
                        error = %e,
                        "transport.identity: failed to open parent dir for fsync"
                    ),
                }
            }
            tracing::info!(
                endpoint_id = %key.public(),
                "transport.identity: minted this device's iroh identity"
            );
            Ok(key)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let raw = fs::read_to_string(path)?;
            decode_secret_hex(&raw)
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    //! # What these prove, and how each was forced red
    //!
    //! The property the module exists for is *stability across restarts*, and it is
    //! the kind of property a naive test cannot see: one call to
    //! [`get_or_create_endpoint_secret`] returns a working key whether or not
    //! anything was persisted. So the round-trip test calls it **twice** and compares
    //! the public keys — a version that ignored the file and generated every time
    //! passes the single-call shape and fails this one.

    use super::*;

    fn tmp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agaric-identity-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system clock is after the unix epoch")
                .as_nanos()
        ));
        fs::create_dir_all(&dir).expect("temp dir is creatable");
        dir
    }

    /// The whole point: a second load returns the *same* identity.
    ///
    /// Forced red by making the `AlreadyExists` arm mint a fresh key
    /// (`Ok(SecretKey::generate())`) instead of reading the file.
    #[test]
    fn a_second_load_returns_the_same_identity() {
        let dir = tmp_dir();
        let path = dir.join("endpoint.key");

        let first = get_or_create_endpoint_secret(&path).expect("first load creates a key");
        let second = get_or_create_endpoint_secret(&path).expect("second load reads it back");

        assert_eq!(
            first.public(),
            second.public(),
            "a restart must present the same EndpointId, or every paired peer stops \
             recognising this device"
        );
    }

    /// A truncated file is refused rather than replaced.
    ///
    /// Replacing it would hand back a working endpoint under an identity no peer has
    /// pinned, which reads as success everywhere until the first sync fails S-1.
    /// Forced red by having `decode_secret_hex` fall back to `SecretKey::generate()`.
    #[test]
    fn a_truncated_key_file_is_an_error_not_a_new_identity() {
        let dir = tmp_dir();
        let path = dir.join("endpoint.key");
        fs::write(&path, "deadbeef").expect("writing a short file works");

        let err =
            get_or_create_endpoint_secret(&path).expect_err("a 8-character key file must not load");
        let msg = err.to_string();
        assert!(
            msg.contains("expected 64 hex characters"),
            "the error must name the expected length, got {msg}"
        );
    }

    /// Non-hex content is refused for the same reason, and reported as such rather
    /// than as a length problem.
    #[test]
    fn a_non_hex_key_file_names_the_offending_byte() {
        let raw = "z".repeat(HEX_LEN);
        let err = decode_secret_hex(&raw).expect_err("non-hex content must not decode");
        let msg = err.to_string();
        assert!(
            msg.contains("is not hex"),
            "a non-hex file must be reported as non-hex, got {msg}"
        );
    }

    /// The spelling written is the spelling read: 64 lowercase hex characters.
    #[test]
    fn the_written_spelling_round_trips_through_the_decoder() {
        let key = SecretKey::generate();
        let hex = encode_secret_hex(&key);
        assert_eq!(hex.len(), HEX_LEN, "a key is written as 64 hex characters");
        assert!(
            hex.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
            "the written spelling is lowercase hex"
        );
        assert_eq!(
            decode_secret_hex(&hex)
                .expect("our own spelling decodes")
                .public(),
            key.public(),
            "encode and decode must agree, or a restart loads a different key"
        );
    }

    /// Trailing whitespace (an editor, a shell redirect) must not change the identity.
    #[test]
    fn surrounding_whitespace_is_tolerated() {
        let key = SecretKey::generate();
        let padded = format!("\n  {}\n", encode_secret_hex(&key));
        assert_eq!(
            decode_secret_hex(&padded)
                .expect("a padded file decodes")
                .public(),
            key.public(),
        );
    }
}
