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

/// M-54: minimum age of an orphaned `.pem` (no matching `.hash`) before it
/// is treated as a real torn write rather than a concurrent-startup race.
///
/// The genuine torn-write case follows a process crash and a subsequent
/// app restart — at minimum on the order of seconds and typically much
/// longer. The benign concurrent-startup case (#460) sees the orphan only
/// during the sub-millisecond gap between the winner thread's two
/// `sync_all` calls. 500 ms is comfortably between the two regimes.
const M54_TORN_WRITE_STALENESS: std::time::Duration = std::time::Duration::from_millis(500);

/// Returns `true` when `pem_path` was last modified at least
/// [`M54_TORN_WRITE_STALENESS`] ago — i.e. the orphan is old enough to be
/// a real torn-write artefact and not a concurrent writer mid-creation.
///
/// On any error (missing metadata, missing modified time, mtime in the
/// future due to clock skew) returns `false` — i.e. errs on the side of
/// *not* recovering, since deleting a fresh `.pem` mid-write would
/// corrupt a sibling thread's state.
fn pem_orphan_is_stale(pem_path: &Path) -> bool {
    fs::metadata(pem_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| std::time::SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age >= M54_TORN_WRITE_STALENESS)
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

    // M-54: torn-write recovery.
    //
    // The create path below writes `.pem` and `.hash` in two separate
    // `sync_all` phases. If the process crashes / power-fails between
    // them, `.pem` survives but `.hash` does not. Without recovery,
    // [`read_existing_cert`] returns "hash file missing or unreadable"
    // forever — sync would never start until the user manually deleted
    // the orphaned `.pem`.
    //
    // Detect the orphan by `.pem` existing without `.hash` AND being at
    // least [`M54_TORN_WRITE_STALENESS`] old. The age check
    // disambiguates the genuine torn-write case (post-crash, the `.pem`
    // is at minimum seconds old) from the concurrent-startup race
    // covered by #460, where a sibling thread is mid-write between the
    // two `sync_all` calls and the gap is sub-millisecond.
    //
    // The orphaned `.pem` MUST be removed before falling through to the
    // create path below — otherwise `create_new(true)` returns
    // `AlreadyExists` and we would loop straight back into
    // [`read_existing_cert`].
    if pem_path.exists() && !hash_path.exists() && pem_orphan_is_stale(&pem_path) {
        tracing::warn!(
            "sync_cert: M-54 torn write detected — '{}' exists without '{}'; \
             deleting orphaned PEM so a fresh cert can be regenerated",
            pem_path.display(),
            hash_path.display()
        );
        fs::remove_file(&pem_path)?;
    }

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

            // M-55: POSIX only guarantees directory entries reach stable
            // storage after `fsync(parent_dir_fd)`. Without this, a power
            // loss could leave the `.pem` / `.hash` data persisted but the
            // directory entries absent, causing the app to regenerate a
            // fresh cert (new hash) on next launch and forcing all peers
            // to re-pin via TOFU. Best-effort: log a warning on failure.
            // Skipped on Windows — NTFS journals directory entries
            // differently and `FlushFileBuffers` on a directory handle is
            // not the equivalent operation.
            #[cfg(unix)]
            {
                if let Some(parent) = pem_path.parent() {
                    match std::fs::File::open(parent) {
                        Ok(dir) => {
                            if let Err(e) = dir.sync_all() {
                                tracing::warn!(
                                    "sync_cert: failed to fsync parent dir {}: {e}",
                                    parent.display()
                                );
                            }
                        }
                        Err(e) => {
                            tracing::warn!(
                                "sync_cert: failed to open parent dir {} for fsync: {e}",
                                parent.display()
                            );
                        }
                    }
                }
            }

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

    // ── M-54: torn-write recovery ───────────────────────────────────────

    /// Regression for M-54: a previous launch crashed between the two
    /// `sync_all` calls in the create path, leaving `.pem` on disk
    /// without a matching `.hash`. The next call to
    /// [`get_or_create_sync_cert`] must NOT error with "hash file
    /// missing or unreadable" — it must detect the orphan, delete the
    /// stale `.pem`, regenerate a fresh cert, and write a new
    /// matching `.hash`.
    #[test]
    fn get_or_create_sync_cert_recovers_from_torn_write_m54() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        // Step 1: normal create — both files exist with valid content.
        let initial = get_or_create_sync_cert(&base, "m54-torn-write").unwrap();

        let pem_path = base.with_extension("pem");
        let hash_path = base.with_extension("hash");
        assert!(pem_path.exists());
        assert!(hash_path.exists());

        // Step 2: simulate the crash between the two `sync_all`s by
        // deleting `.hash` while keeping `.pem`.
        fs::remove_file(&hash_path).unwrap();
        assert!(pem_path.exists(), "PEM must remain after simulated crash");
        assert!(
            !hash_path.exists(),
            "hash must be missing after simulated crash"
        );

        // Step 3: wait long enough for the `.pem` mtime to age past the
        // M-54 staleness threshold so the recovery path treats the
        // orphan as a real torn write rather than a concurrent-startup
        // race (#460). The threshold is 500 ms; sleep a bit longer.
        std::thread::sleep(std::time::Duration::from_millis(600));

        // Step 4: the next call must succeed without manual cleanup and
        // produce a fresh `.pem` + `.hash` pair.
        let recovered = get_or_create_sync_cert(&base, "m54-torn-write").unwrap();

        assert!(
            pem_path.exists(),
            "PEM must be re-created after M-54 recovery"
        );
        assert!(
            hash_path.exists(),
            "hash must be re-created after M-54 recovery"
        );

        // Step 5: the new hash file content must match the new returned
        // cert hash (i.e. the regen wrote a consistent pair, not just
        // re-read the orphan).
        let on_disk_hash = fs::read_to_string(&hash_path).unwrap();
        assert_eq!(
            on_disk_hash.trim(),
            recovered.cert_hash,
            "hash file content must match returned cert_hash after M-54 recovery"
        );
        assert_eq!(
            recovered.cert_hash.len(),
            64,
            "recovered hash must be 64 hex chars"
        );
        assert!(
            recovered.cert_hash.chars().all(|c| c.is_ascii_hexdigit()),
            "recovered hash must be valid hex"
        );

        // The recovered cert is freshly generated — different from the
        // original orphaned one (since the create path generates a new
        // ECDSA key per call).
        assert_ne!(
            initial.cert_hash, recovered.cert_hash,
            "M-54 recovery must regenerate a fresh cert, not resurrect the orphan"
        );

        // Step 6: a subsequent call must now hit the read-existing path
        // and return the SAME hash as the recovered cert — i.e. the
        // recovered state is stable.
        let again = get_or_create_sync_cert(&base, "m54-torn-write").unwrap();
        assert_eq!(
            again.cert_hash, recovered.cert_hash,
            "post-recovery state must be stable across subsequent calls"
        );
    }

    /// A fresh orphaned `.pem` (created moments ago) must NOT be
    /// recovered — it is most likely a concurrent writer mid-creation
    /// (#460), and deleting it would corrupt the sibling thread's
    /// state. The function must instead return the original
    /// "hash file missing" error so the caller's retry loop can wait
    /// for the sibling to finish.
    #[test]
    fn get_or_create_sync_cert_does_not_recover_fresh_orphan_m54() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        // Synthesize a fresh `.pem` without a `.hash`. Because the file
        // is just-written, its mtime is well within the 500 ms
        // staleness window — the M-54 detector must NOT fire.
        fs::write(
            base.with_extension("pem"),
            "-----BEGIN CERTIFICATE-----\ndata\n-----END CERTIFICATE-----\n\
             -----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
        )
        .unwrap();

        let err = get_or_create_sync_cert(&base, "m54-fresh-orphan").unwrap_err();
        assert!(
            matches!(err, AppError::InvalidOperation(_)),
            "fresh orphan must NOT be auto-recovered, got: {err:?}"
        );
        assert!(
            base.with_extension("pem").exists(),
            "fresh `.pem` must NOT be deleted by M-54 recovery"
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
                // Budget: 100 × 10 ms = 1 s. The winner thread does crypto
                // work in `generate_self_signed_cert` plus two `sync_all`
                // calls, which can exceed 100 ms on slow CI; readers need
                // a budget that comfortably covers the worst case so the
                // test is not flaky under load. The `M54_TORN_WRITE_STALENESS`
                // threshold (500 ms) is still longer than any individual
                // sleep so the M-54 path will not delete a fresh PEM
                // mid-write.
                for _ in 0..100 {
                    match get_or_create_sync_cert(&p, "DEVICE_RACE") {
                        Ok(cert) => return Ok(cert),
                        Err(_) => thread::sleep(std::time::Duration::from_millis(10)),
                    }
                }
                get_or_create_sync_cert(&p, "DEVICE_RACE")
            }));
        }

        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        // All should succeed
        for (i, r) in results.iter().enumerate() {
            assert!(
                r.is_ok(),
                "thread {i} should succeed, got: {:?}",
                r.as_ref().err()
            );
        }

        // All should return the same cert hash (first writer wins, others read)
        let hashes: Vec<_> = results
            .iter()
            .map(|r| r.as_ref().unwrap().cert_hash.clone())
            .collect();
        let first = &hashes[0];
        for (i, h) in hashes.iter().enumerate() {
            assert_eq!(h, first, "thread {i} hash should match first thread's hash");
        }
    }
}

// ===========================================================================
// M-55: parent directory fsync after cert + hash file creation
// ===========================================================================

#[cfg(test)]
mod tests_m55 {
    use super::*;
    use tempfile::TempDir;

    /// Sanity: happy path — both `.pem` and `.hash` exist after creation.
    /// (Mirrors `tests::creates_cert_files_on_first_call` so M-55 has its
    /// own minimal regression check at the bottom of the file.)
    #[test]
    fn get_or_create_sync_cert_creates_pem_and_hash() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        let cert = get_or_create_sync_cert(&base, "m55-device-happy").unwrap();

        assert!(
            base.with_extension("pem").exists(),
            "PEM file must exist after get_or_create_sync_cert"
        );
        assert!(
            base.with_extension("hash").exists(),
            "hash file must exist after get_or_create_sync_cert"
        );
        assert_eq!(cert.cert_hash.len(), 64, "hash must be 64 hex chars");
    }

    /// On Unix, the parent-dir fsync added for M-55 must not break the
    /// happy path: the function still returns Ok and both files are
    /// visible from a freshly-opened handle (i.e. through the filesystem,
    /// not via the writer's own file descriptor).
    ///
    /// On Windows the fsync block is `#[cfg(unix)]`-gated out, so this
    /// test simply asserts the function still works (regression check for
    /// the cfg-gating itself).
    ///
    /// We cannot deterministically test the actual fsync semantics
    /// without a fault-injection layer; this test exists to guarantee the
    /// new code path does not regress the function on either platform.
    #[test]
    fn m55_directory_fsync_unix_only() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("sync-cert");

        let result = get_or_create_sync_cert(&base, "m55-device-fsync");
        assert!(
            result.is_ok(),
            "get_or_create_sync_cert must return Ok on this platform after M-55, got: {:?}",
            result.as_ref().err()
        );

        let pem_path = base.with_extension("pem");
        let hash_path = base.with_extension("hash");

        // Open via fresh handles — exercises the directory entry lookup,
        // which is what the parent-dir fsync is meant to make durable.
        let pem_bytes = fs::read(&pem_path).expect("PEM must be readable via a fresh handle");
        let hash_bytes = fs::read(&hash_path).expect("hash must be readable via a fresh handle");

        assert!(!pem_bytes.is_empty(), "PEM file must not be empty");
        assert_eq!(hash_bytes.len(), 64, "hash file must contain 64 hex chars");

        // Sanity: subsequent call (which goes down the read_existing_cert
        // path) must see the same files we just fsynced.
        let again = get_or_create_sync_cert(&base, "m55-device-fsync").unwrap();
        assert_eq!(
            again.cert_hash,
            String::from_utf8(hash_bytes).unwrap(),
            "second call must read back the hash that was fsynced to disk"
        );
    }

    /// The parent-dir fsync is best-effort: even when the parent
    /// directory is somehow not openable for fsync (e.g. unusual perms),
    /// the function as a whole must still return Ok because the file
    /// data has already been fsynced. This test exercises the normal
    /// path; the warn-and-continue branch is only reached on rare
    /// platform-specific failures and is covered by inspection.
    #[test]
    fn m55_returns_ok_on_normal_filesystem() {
        let dir = TempDir::new().unwrap();
        let base = dir.path().join("nested").join("sync-cert");

        // Nested parent must be created and then fsynced without error.
        let cert = get_or_create_sync_cert(&base, "m55-device-nested").unwrap();
        assert!(!cert.cert_pem.is_empty());
        assert!(base.with_extension("pem").exists());
        assert!(base.with_extension("hash").exists());
    }
}
