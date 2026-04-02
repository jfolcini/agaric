//! Persistent TLS certificate for sync transport.
//!
//! Follows the same generate-once-then-load pattern as [`crate::device`]:
//! on first launch, a self-signed ECDSA P-256 certificate is generated via
//! [`crate::sync_net::generate_self_signed_cert`] and written to disk.
//! On subsequent launches, the existing cert is read back.
//!
//! Files written (relative to the config path stem):
//! - `{stem}.pem` — concatenated certificate + private key in PEM format
//! - `{stem}.hash` — SHA-256 hex hash of the DER-encoded certificate
//!
//! The cert never expires for our purposes — [`crate::sync_net::PinningCertVerifier`]
//! only checks the SHA-256 hash, skipping all X.509 validation.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

use crate::error::AppError;
use crate::sync_net::{generate_self_signed_cert, SyncCert};

/// Wrapper for the persistent TLS certificate in Tauri managed state.
#[derive(Clone, Debug)]
pub struct PersistedCert {
    pub cert: SyncCert,
}

impl PersistedCert {
    pub fn new(cert: SyncCert) -> Self {
        Self { cert }
    }
}

/// Separator line between cert PEM and key PEM inside the combined `.pem` file.
const PEM_SEPARATOR: &str = "\n";

/// Build the error for a corrupt cert file.
#[cfg(not(tarpaulin_include))]
fn corrupt_cert_error(path: &Path, detail: &str) -> AppError {
    AppError::InvalidOperation(format!(
        "Corrupt sync cert file '{}': {}",
        path.display(),
        detail
    ))
}

/// Convert an unexpected `io::Error` from file creation into `AppError`.
#[cfg(not(tarpaulin_include))]
fn unexpected_create_error(e: std::io::Error) -> AppError {
    e.into()
}

/// Read or generate a persistent self-signed TLS certificate.
///
/// `config_path` is the base path — the function appends `.pem` and `.hash`
/// extensions. For example, if `config_path` is `~/.config/app/sync-cert`,
/// the files will be `sync-cert.pem` and `sync-cert.hash`.
///
/// Uses `create_new(true)` for atomic creation, same as
/// [`crate::device::get_or_create_device_id`].
pub fn get_or_create_sync_cert(config_path: &Path, device_id: &str) -> Result<SyncCert, AppError> {
    // Ensure parent directory exists.
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let pem_path = config_path.with_extension("pem");
    let hash_path = config_path.with_extension("hash");

    // Attempt atomic creation — succeeds only if the .pem file does not exist.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pem_path)
    {
        Ok(mut pem_file) => {
            let cert = generate_self_signed_cert(device_id)?;

            // Normalize PEMs: trim whitespace for deterministic round-trips.
            let cert_pem = cert.cert_pem.trim().to_string();
            let key_pem = cert.key_pem.trim().to_string();

            // Write cert PEM + key PEM concatenated.
            pem_file.write_all(cert_pem.as_bytes())?;
            pem_file.write_all(PEM_SEPARATOR.as_bytes())?;
            pem_file.write_all(key_pem.as_bytes())?;
            pem_file.sync_all()?;

            // Write hash to a separate file for quick lookup.
            let mut hash_file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&hash_path)
                .map_err(|e| {
                    // Clean up the .pem file if .hash creation fails.
                    let _ = fs::remove_file(&pem_path);
                    unexpected_create_error(e)
                })?;
            hash_file.write_all(cert.cert_hash.as_bytes())?;
            hash_file.sync_all()?;

            Ok(SyncCert {
                cert_pem,
                key_pem,
                cert_hash: cert.cert_hash,
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            read_existing_cert(&pem_path, &hash_path)
        }
        Err(e) => Err(unexpected_create_error(e)),
    }
}

/// Read and validate an existing cert from disk.
fn read_existing_cert(pem_path: &Path, hash_path: &Path) -> Result<SyncCert, AppError> {
    let pem_content = fs::read_to_string(pem_path)?;

    // Split into cert PEM and key PEM.
    // The cert PEM ends with "-----END CERTIFICATE-----" and the key PEM
    // starts with "-----BEGIN PRIVATE KEY-----".
    let cert_end_marker = "-----END CERTIFICATE-----";
    let cert_end_idx = pem_content
        .find(cert_end_marker)
        .ok_or_else(|| corrupt_cert_error(pem_path, "missing END CERTIFICATE marker"))?;

    let split_pos = cert_end_idx + cert_end_marker.len();
    let cert_pem = pem_content[..split_pos].trim().to_string();
    let key_pem = pem_content[split_pos..].trim().to_string();

    if key_pem.is_empty() || !key_pem.contains("-----BEGIN PRIVATE KEY-----") {
        return Err(corrupt_cert_error(pem_path, "missing private key"));
    }

    // Read and validate hash.
    let cert_hash = fs::read_to_string(hash_path)
        .map_err(|_| corrupt_cert_error(hash_path, "hash file missing or unreadable"))?
        .trim()
        .to_string();

    if cert_hash.len() != 64 || !cert_hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(corrupt_cert_error(hash_path, "invalid SHA-256 hex hash"));
    }

    Ok(SyncCert {
        cert_pem,
        key_pem,
        cert_hash,
    })
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    // ── Creation ─────────────────────────────────────────────────────────

    #[test]
    fn creates_cert_files_on_first_call() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        let cert = get_or_create_sync_cert(&base, "test-device-1").unwrap();

        assert!(
            base.with_extension("pem").exists(),
            "PEM file must be created"
        );
        assert!(
            base.with_extension("hash").exists(),
            "hash file must be created"
        );
        assert!(
            cert.cert_pem.contains("-----BEGIN CERTIFICATE-----"),
            "cert PEM must contain certificate"
        );
        assert!(
            cert.key_pem.contains("-----BEGIN PRIVATE KEY-----"),
            "key PEM must contain private key"
        );
        assert_eq!(cert.cert_hash.len(), 64, "hash must be 64 hex chars");
    }

    #[test]
    fn pem_file_contains_both_cert_and_key() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        get_or_create_sync_cert(&base, "test-device-2").unwrap();

        let content = fs::read_to_string(base.with_extension("pem")).unwrap();
        assert!(
            content.contains("-----BEGIN CERTIFICATE-----"),
            "PEM file must contain certificate"
        );
        assert!(
            content.contains("-----BEGIN PRIVATE KEY-----"),
            "PEM file must contain private key"
        );
    }

    #[test]
    fn hash_file_contains_exact_hash() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        let cert = get_or_create_sync_cert(&base, "test-device-3").unwrap();
        let on_disk = fs::read_to_string(base.with_extension("hash")).unwrap();

        assert_eq!(
            on_disk, cert.cert_hash,
            "hash file content must match returned cert_hash"
        );
    }

    #[test]
    fn creates_nested_parent_directories() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("a").join("b").join("sync-cert");

        let cert = get_or_create_sync_cert(&base, "test-device-4").unwrap();
        assert!(
            !cert.cert_pem.is_empty(),
            "cert should be generated with nested dirs"
        );
        assert!(
            base.with_extension("pem").exists(),
            "PEM file must exist in nested directory"
        );
    }

    // ── Idempotent reads ─────────────────────────────────────────────────

    #[test]
    fn returns_same_cert_on_subsequent_calls() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        let first = get_or_create_sync_cert(&base, "test-device-5").unwrap();
        let second = get_or_create_sync_cert(&base, "test-device-5").unwrap();

        assert_eq!(
            first.cert_hash, second.cert_hash,
            "cert hash must be stable across calls"
        );
        assert_eq!(
            first.cert_pem, second.cert_pem,
            "cert PEM must be stable across calls"
        );
        assert_eq!(
            first.key_pem, second.key_pem,
            "key PEM must be stable across calls"
        );
    }

    // ── Error paths ─────────────────────────────────────────────────────

    #[test]
    fn corrupt_pem_missing_end_cert_marker() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        fs::write(base.with_extension("pem"), "garbage data").unwrap();
        fs::write(base.with_extension("hash"), "a".repeat(64)).unwrap();

        let err = get_or_create_sync_cert(&base, "test-device").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "corrupt PEM should return InvalidOperation, got: {err:?}"
        );
    }

    #[test]
    fn corrupt_pem_missing_private_key() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        fs::write(
            base.with_extension("pem"),
            "-----BEGIN CERTIFICATE-----\ndata\n-----END CERTIFICATE-----\n",
        )
        .unwrap();
        fs::write(base.with_extension("hash"), "a".repeat(64)).unwrap();

        let err = get_or_create_sync_cert(&base, "test-device").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "missing key should return InvalidOperation, got: {err:?}"
        );
    }

    #[test]
    fn missing_hash_file_returns_error() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        // Create PEM file with valid-ish structure but no hash file.
        fs::write(
            base.with_extension("pem"),
            "-----BEGIN CERTIFICATE-----\ndata\n-----END CERTIFICATE-----\n\
             -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        )
        .unwrap();

        let err = get_or_create_sync_cert(&base, "test-device").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "missing hash file should return InvalidOperation, got: {err:?}"
        );
    }

    #[test]
    fn invalid_hash_length_returns_error() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        fs::write(
            base.with_extension("pem"),
            "-----BEGIN CERTIFICATE-----\ndata\n-----END CERTIFICATE-----\n\
             -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        )
        .unwrap();
        fs::write(base.with_extension("hash"), "tooshort").unwrap();

        let err = get_or_create_sync_cert(&base, "test-device").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "short hash should return InvalidOperation, got: {err:?}"
        );
    }

    #[test]
    fn invalid_hash_non_hex_returns_error() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        fs::write(
            base.with_extension("pem"),
            "-----BEGIN CERTIFICATE-----\ndata\n-----END CERTIFICATE-----\n\
             -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        )
        .unwrap();
        // 64 chars but not hex.
        fs::write(
            base.with_extension("hash"),
            "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
        )
        .unwrap();

        let err = get_or_create_sync_cert(&base, "test-device").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "non-hex hash should return InvalidOperation, got: {err:?}"
        );
    }

    // ── PersistedCert wrapper ───────────────────────────────────────────

    #[test]
    fn persisted_cert_wraps_sync_cert() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        let cert = get_or_create_sync_cert(&base, "test-device-wrapper").unwrap();
        let hash = cert.cert_hash.clone();

        let persisted = PersistedCert::new(cert);
        assert_eq!(persisted.cert.cert_hash, hash);
    }

    #[test]
    fn persisted_cert_clone_produces_equal_value() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        let cert = get_or_create_sync_cert(&base, "test-device-clone").unwrap();
        let persisted = PersistedCert::new(cert);
        let cloned = persisted.clone();
        assert_eq!(persisted.cert.cert_hash, cloned.cert.cert_hash);
    }

    #[test]
    fn persisted_cert_debug_includes_hash() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        let cert = get_or_create_sync_cert(&base, "test-device-debug").unwrap();
        let hash = cert.cert_hash.clone();
        let persisted = PersistedCert::new(cert);
        let debug = format!("{persisted:?}");
        assert!(
            debug.contains(&hash),
            "Debug output should include the cert hash, got: {debug}"
        );
    }

    // ── Edge: path is a directory ───────────────────────────────────────

    #[test]
    fn pem_path_is_directory_returns_io_error() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");
        // Create a directory where the .pem file would be.
        fs::create_dir_all(base.with_extension("pem")).unwrap();

        let err = get_or_create_sync_cert(&base, "test-device").unwrap_err();
        // create_new on a directory returns AlreadyExists, then read fails.
        assert!(
            matches!(err, AppError::InvalidOperation(_) | AppError::Io(_)),
            "should fail when pem path is a directory, got: {err:?}"
        );
    }

    // #460 — concurrent creation

    #[test]
    fn concurrent_get_or_create_returns_same_cert() {
        use std::sync::Arc;
        use std::thread;

        let dir = TempDir::new().unwrap();
        let config_path = dir.path().join("sync_cert");
        let config = Arc::new(config_path);

        let mut handles = vec![];
        for _ in 0..8 {
            let p = config.clone();
            handles.push(thread::spawn(move || {
                // Retry to tolerate the window between create_new and write
                // completion — a reader may see an incomplete file briefly.
                for _ in 0..20 {
                    match get_or_create_sync_cert(&p, "DEVICE_RACE") {
                        Ok(cert) => return Ok(cert),
                        Err(_) => thread::sleep(std::time::Duration::from_millis(5)),
                    }
                }
                get_or_create_sync_cert(&p, "DEVICE_RACE")
            }));
        }

        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        // All should succeed
        for (i, r) in results.iter().enumerate() {
            assert!(r.is_ok(), "thread {i} should succeed, got: {:?}", r.as_ref().err());
        }

        // All should return the same cert hash (first writer wins, others read)
        let hashes: Vec<_> = results.iter().map(|r| r.as_ref().unwrap().cert_hash.clone()).collect();
        let first = &hashes[0];
        for (i, h) in hashes.iter().enumerate() {
            assert_eq!(h, first, "thread {i} hash should match first thread's hash");
        }
    }
}
