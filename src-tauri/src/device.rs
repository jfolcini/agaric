use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;
use uuid::Uuid;

/// Wrapper for device UUID in Tauri managed state.
#[derive(Clone, Debug)]
pub struct DeviceId(String);

impl DeviceId {
    /// Create a DeviceId from a UUID string. No validation — called once
    /// at startup from a trusted file.
    pub fn new(id: String) -> Self {
        Self(id)
    }

    /// Returns the inner UUID string.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for DeviceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

/// Build the error for a corrupt device-id file.
///
/// Extracted from a `map_err` closure so the formatting code is attributable
/// by tarpaulin (closures inside `map_err` are unreliable for coverage).
#[cfg(not(tarpaulin_include))]
fn corrupt_device_id_error(config_path: &Path, e: &uuid::Error) -> crate::error::AppError {
    crate::error::AppError::InvalidOperation(format!(
        "Corrupt device ID file '{}': {}",
        config_path.display(),
        e
    ))
}

/// Convert an unexpected `io::Error` (from reading the device-id file or
/// creating its sibling tempfile) into `AppError`.
///
/// This catch-all arm only triggers for OS errors other than `NotFound`
/// (e.g. permission denied, device full, `IsADirectory`) which are impractical
/// to trigger deterministically in unit tests without filesystem mocking.
#[cfg(not(tarpaulin_include))]
fn unexpected_create_error(e: std::io::Error) -> crate::error::AppError {
    e.into()
}

/// Reads or generates a persistent device UUID.
///
/// On first launch, a new UUID v4 is generated and materialized **atomically**
/// via a tempfile-then-rename dance:
///   1. Generate the new UUID.
///   2. Create a sibling tempfile (`<path>.tmp.<new_uuid>`) with
///      `create_new(true)` — the fresh UUID suffix avoids collisions with
///      stale tempfiles from prior crashed boots, and `create_new` keeps the
///      TOCTOU guarantee on the temp side (we refuse to silently overwrite
///      a stale tempfile that happens to share the suffix).
///   3. `write_all` the UUID + `sync_all` to flush the file's data and
///      metadata to disk.
///   4. `fs::rename(tempfile, final_path)` — atomic on POSIX same-filesystem;
///      the final entry is either whole or absent.
///   5. `fs::File::open(parent_dir).sync_all()` to durably commit the rename
///      itself across crash recovery (the directory entry update is not
///      flushed without an explicit fsync of the directory).
///
/// **I-Core-3:** the previous shape (`OpenOptions::create_new`, then
/// `write_all` and `sync_all` directly to the final path) had a window where
/// the file existed but was empty/short. A crash between successful
/// `create_new` and successful `write_all` produced
/// `AppError::InvalidOperation: Corrupt device ID file` on the next boot
/// with no automatic recovery — the user had to manually delete the file
/// before the app would start. Writing to a sibling and renaming guarantees
/// the final file is never partially-written.
///
/// On subsequent launches, the existing UUID is read from disk, validated,
/// and returned in canonical (lowercase-hyphenated) form. The UUID is never
/// regenerated — it is the device's permanent identity in the op log.
pub fn get_or_create_device_id(config_path: &Path) -> Result<String, crate::error::AppError> {
    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Read first — `NotFound` is the signal to create a new ID. Other read
    // errors (PermissionDenied, IsADirectory, …) propagate as `AppError::Io`.
    match fs::read_to_string(config_path) {
        Ok(content) => {
            // Existing file — parse and return canonical form. Behavior here
            // is unchanged from the pre-I-Core-3 implementation.
            let id = content.trim().to_string();
            let parsed =
                Uuid::parse_str(&id).map_err(|e| corrupt_device_id_error(config_path, &e))?;
            Ok(parsed.to_string())
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // I-Core-3: atomic create via sibling tempfile + rename.
            let new_id = Uuid::new_v4().to_string();
            // Sibling tempfile in the same directory — same filesystem is a
            // prerequisite for atomic `rename`. The fresh UUID suffix means
            // a stale tempfile from a prior crashed boot won't collide.
            let temp_path = config_path.with_extension(format!("tmp.{new_id}"));
            {
                // `create_new(true)` keeps the TOCTOU guarantee on the temp
                // side: if a stale tempfile with the same suffix somehow
                // exists, we error out rather than silently overwrite it.
                let mut f = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp_path)?;
                f.write_all(new_id.as_bytes())?;
                f.sync_all()?;
            } // file closed before rename
              // POSIX `rename` is atomic on the same filesystem: the final
              // entry either points at the fully-written tempfile or doesn't
              // exist. There is no intermediate state where it points at an
              // empty/short file.
            fs::rename(&temp_path, config_path)?;
            // Sync the parent directory so the rename's directory-entry
            // update is durable across crash recovery. Best-effort: on
            // platforms where directory fsync is not supported (notably
            // Windows), we silently ignore the failure — the rename itself
            // was already kernel-atomic and the data is on disk.
            if let Some(parent) = config_path.parent() {
                if let Ok(dir) = fs::File::open(parent) {
                    let _ = dir.sync_all();
                }
            }
            Ok(new_id)
        }
        Err(e) => Err(unexpected_create_error(e)),
    }
}

/// Tests for `DeviceId` wrapper and `get_or_create_device_id`: creation,
/// idempotent reads, UUID normalization, whitespace trimming, corruption
/// handling, parent-directory creation, and file-content verification.
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// A known valid UUID v4 in canonical lowercase-hyphenated form.
    const FIXTURE_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";
    /// Same UUID in compact uppercase (no hyphens) — valid but non-canonical.
    const FIXTURE_UUID_COMPACT: &str = "550E8400E29B41D4A716446655440000";

    // --- get_or_create_device_id: creation ---

    #[test]
    fn creates_new_valid_uuid_file_on_first_call() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");

        let id = get_or_create_device_id(&path).expect("should create a new device ID");

        assert_eq!(id.len(), 36, "UUID v4 hyphenated form is 36 characters");
        assert!(
            Uuid::parse_str(&id).is_ok(),
            "returned value must be a valid UUID"
        );
        assert!(path.exists(), "device-id file should be created on disk");
    }

    #[test]
    fn created_file_contains_exact_returned_uuid() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");

        let id = get_or_create_device_id(&path).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();

        assert_eq!(
            on_disk, id,
            "file content should exactly match the returned UUID"
        );
    }

    #[test]
    fn creates_nested_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("c").join("device-id");

        let id = get_or_create_device_id(&path).expect("should create parent dirs and device ID");
        assert!(
            Uuid::parse_str(&id).is_ok(),
            "returned value must be a valid UUID"
        );
        assert!(path.exists(), "file should exist in nested directory");
    }

    // --- get_or_create_device_id: idempotent reads ---

    #[test]
    fn returns_same_uuid_on_subsequent_calls() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");

        let first = get_or_create_device_id(&path).unwrap();
        let second = get_or_create_device_id(&path).unwrap();

        assert_eq!(first, second, "device ID must be stable across calls");
    }

    // --- get_or_create_device_id: normalization ---

    #[test]
    fn normalizes_compact_uppercase_uuid_to_canonical_form() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, FIXTURE_UUID_COMPACT).unwrap();

        let id = get_or_create_device_id(&path).expect("compact UUID should be accepted");
        assert_eq!(
            id, FIXTURE_UUID,
            "should normalize to lowercase hyphenated form"
        );
    }

    #[test]
    fn trims_whitespace_around_uuid_in_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, format!("  {FIXTURE_UUID}  \n")).unwrap();

        let id = get_or_create_device_id(&path).expect("whitespace-padded UUID should be accepted");
        assert_eq!(
            id, FIXTURE_UUID,
            "should trim whitespace and return canonical UUID"
        );
    }

    // --- get_or_create_device_id: error paths ---

    #[test]
    fn rejects_corrupt_file_with_invalid_operation_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "not-a-uuid").unwrap();

        let err = get_or_create_device_id(&path).expect_err("corrupt content should fail");
        assert!(
            matches!(err, crate::error::AppError::InvalidOperation(_)),
            "should return InvalidOperation variant, got: {err:?}"
        );
    }

    #[test]
    fn corrupt_file_error_message_includes_file_path() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "garbage").unwrap();

        let err = get_or_create_device_id(&path).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains(&path.display().to_string()),
            "error message should include the file path, got: {msg}"
        );
    }

    #[test]
    fn empty_file_returns_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "").unwrap();

        assert!(
            get_or_create_device_id(&path).is_err(),
            "empty file should produce an error"
        );
    }

    #[test]
    fn unicode_content_returns_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "\u{1F4A9}").unwrap();

        let err = get_or_create_device_id(&path).expect_err("unicode content should be rejected");
        assert!(
            matches!(err, crate::error::AppError::InvalidOperation(_)),
            "should return InvalidOperation variant"
        );
    }

    #[test]
    fn path_is_directory_returns_io_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        // Create a directory where the file would be — OpenOptions::create_new
        // returns AlreadyExists, then read_to_string fails because the path
        // is a directory, not a regular file.
        std::fs::create_dir(&path).unwrap();

        let err = get_or_create_device_id(&path).expect_err("should fail when path is a directory");
        assert!(
            matches!(err, crate::error::AppError::Io(_)),
            "should return Io variant, got: {err:?}"
        );
    }

    // --- DeviceId newtype ---

    #[cfg(unix)]
    #[test]
    fn readonly_parent_triggers_catch_all_error_path() {
        use std::os::unix::fs::PermissionsExt;

        let dir = TempDir::new().unwrap();
        let parent = dir.path().join("readonly");
        std::fs::create_dir(&parent).unwrap();

        // Make parent read-only — file creation returns PermissionDenied,
        // which is NOT AlreadyExists, so it enters the catch-all match arm.
        let mut perms = std::fs::metadata(&parent).unwrap().permissions();
        perms.set_mode(0o444);
        std::fs::set_permissions(&parent, perms).unwrap();

        let path = parent.join("device-id");
        let result = get_or_create_device_id(&path);

        // Restore permissions before assertions so cleanup succeeds.
        let mut perms2 = std::fs::metadata(&parent).unwrap().permissions();
        perms2.set_mode(0o755);
        std::fs::set_permissions(&parent, perms2).unwrap();

        // Skip assertion if running as root (root bypasses permissions).
        if result.is_ok() {
            return;
        }

        assert!(
            matches!(result, Err(crate::error::AppError::Io(_))),
            "should return Io variant for permission denied, got: {result:?}"
        );
    }

    // --- DeviceId newtype ---

    #[test]
    fn device_id_stores_and_exposes_inner_string() {
        let device = DeviceId::new(FIXTURE_UUID.to_string());
        assert_eq!(
            device.as_str(),
            FIXTURE_UUID,
            "DeviceId inner field should hold the UUID string"
        );
    }

    #[test]
    fn device_id_clone_produces_equal_value() {
        let device = DeviceId::new(FIXTURE_UUID.to_string());
        let cloned = device.clone();
        assert_eq!(
            device.as_str(),
            cloned.as_str(),
            "cloned DeviceId should be equal"
        );
    }

    #[test]
    fn device_id_debug_includes_uuid() {
        let device = DeviceId::new(FIXTURE_UUID.to_string());
        let debug = format!("{device:?}");
        assert!(
            debug.contains(FIXTURE_UUID),
            "Debug output should include the UUID, got: {debug}"
        );
    }

    #[test]
    fn device_id_as_str_returns_inner() {
        let device = DeviceId::new(FIXTURE_UUID.to_string());
        assert_eq!(
            device.as_str(),
            FIXTURE_UUID,
            "as_str should return the inner UUID string"
        );
    }

    #[test]
    fn device_id_display_returns_uuid() {
        let device = DeviceId::new(FIXTURE_UUID.to_string());
        assert_eq!(
            format!("{device}"),
            FIXTURE_UUID,
            "Display should return the UUID string"
        );
    }

    // --- I-Core-3: atomic creation via tempfile + rename ---

    /// Happy-path verification of the I-Core-3 fix: after a successful call,
    /// the final device-id file exists with valid UUID content AND no
    /// `<path>.tmp.*` sibling tempfile is left behind in the parent directory
    /// (the atomic `rename` consumed the tempfile).
    #[test]
    fn creates_device_id_atomically_via_tempfile_rename_i_core_3() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");

        let id = get_or_create_device_id(&path)
            .expect("first-launch creation should succeed via tempfile + rename");

        assert!(
            Uuid::parse_str(&id).is_ok(),
            "returned value must be a valid UUID, got: {id}"
        );
        assert!(path.exists(), "final device-id file should exist on disk");

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            on_disk, id,
            "final file must contain exactly the returned UUID"
        );

        // I-Core-3: the rename must have consumed the tempfile, leaving no
        // `device-id.tmp.*` sibling behind. Anything matching that pattern is
        // a regression — the rename either didn't happen or the tempfile was
        // re-created after rename.
        for entry in std::fs::read_dir(dir.path()).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            assert!(
                !name_str.starts_with("device-id.tmp."),
                "no leftover tempfile should remain after successful rename, found: {name_str}"
            );
        }
    }

    /// I-Core-3: a stale tempfile from a hypothetical prior crashed boot
    /// (whose suffix won't collide with the freshly-generated UUID this call
    /// produces) must not block successful creation. The fresh UUID-suffixed
    /// tempfile path is distinct, so `create_new` succeeds, the rename
    /// completes, and the stale file is left untouched (we deliberately do
    /// NOT silently overwrite stale temp content — a deterministic temp path
    /// would be a regression).
    #[test]
    fn cleanup_stale_temp_file_or_distinct_temp_path_i_core_3() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");

        // Pre-create a stale tempfile from a prior crashed boot. Its suffix
        // is intentionally non-UUID so the freshly-generated UUID-suffixed
        // tempfile this call uses cannot collide with it.
        let stale = dir.path().join("device-id.tmp.stale-from-prior-boot");
        let stale_content = "garbage from a prior crashed boot";
        std::fs::write(&stale, stale_content).unwrap();

        let id = get_or_create_device_id(&path)
            .expect("a stale tempfile with a distinct suffix must not block creation");

        assert!(
            Uuid::parse_str(&id).is_ok(),
            "returned value must be a valid UUID, got: {id}"
        );
        assert!(path.exists(), "final device-id file should exist on disk");

        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            on_disk, id,
            "final device-id must be the freshly-generated UUID, not the stale garbage"
        );

        // The stale tempfile is left untouched: the implementation chose a
        // fresh UUID-suffixed temp path that doesn't collide, and (correctly)
        // does not silently overwrite arbitrary `*.tmp.*` siblings.
        assert!(
            stale.exists(),
            "stale tempfile with a non-colliding suffix should be untouched"
        );
        assert_eq!(
            std::fs::read_to_string(&stale).unwrap(),
            stale_content,
            "stale tempfile content should be untouched"
        );
    }
}
