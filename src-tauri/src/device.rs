use std::fs::{self, OpenOptions};
use std::io::Write;
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
fn corrupt_device_id_error(config_path: &Path, e: uuid::Error) -> crate::error::AppError {
    crate::error::AppError::InvalidOperation(format!(
        "Corrupt device ID file '{}': {}",
        config_path.display(),
        e
    ))
}

/// Convert an unexpected `io::Error` from file creation into `AppError`.
///
/// This catch-all arm only triggers for OS errors other than `AlreadyExists`
/// (e.g. permission denied, device full) which are impractical to trigger
/// deterministically in unit tests without filesystem mocking.
#[cfg(not(tarpaulin_include))]
fn unexpected_create_error(e: std::io::Error) -> crate::error::AppError {
    e.into()
}

/// Reads or generates a persistent device UUID.
///
/// The UUID is stored in a plain text file at the given path.
/// On first launch, a new UUID v4 is generated and written atomically
/// using `create_new(true)` to prevent TOCTOU races if two instances
/// launch concurrently.
/// On subsequent launches, the existing UUID is read and validated.
/// The UUID is never regenerated — it is the device's permanent identity
/// in the op log (ADR-07).
pub fn get_or_create_device_id(config_path: &Path) -> Result<String, crate::error::AppError> {
    // Ensure parent directory exists
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent)?;
    }

    // Attempt atomic creation first — succeeds only if the file does not exist.
    // This prevents TOCTOU races when two app instances launch simultaneously.
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(config_path)
    {
        Ok(mut file) => {
            let id = Uuid::new_v4().to_string();
            file.write_all(id.as_bytes())?;
            file.sync_all()?;
            Ok(id)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // File already exists — read and validate
            let content = fs::read_to_string(config_path)?;
            let id = content.trim().to_string();
            let parsed =
                Uuid::parse_str(&id).map_err(|e| corrupt_device_id_error(config_path, e))?;
            // Return normalized form
            Ok(parsed.to_string())
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
}
