use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

/// Wrapper for device UUID in Tauri managed state.
#[derive(Clone, Debug)]
pub struct DeviceId(pub String);

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
            Ok(id)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            // File already exists — read and validate
            let content = fs::read_to_string(config_path)?;
            let id = content.trim().to_string();
            let parsed = Uuid::parse_str(&id).map_err(|e| {
                crate::error::AppError::InvalidOperation(format!(
                    "Corrupt device ID file '{}': {}",
                    config_path.display(),
                    e
                ))
            })?;
            // Return normalized form
            Ok(parsed.to_string())
        }
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_new_uuid_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        let id = get_or_create_device_id(&path).unwrap();
        assert_eq!(id.len(), 36); // UUID v4 format
        assert!(Uuid::parse_str(&id).is_ok());
        assert!(path.exists());
    }

    #[test]
    fn reads_existing_uuid_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        let id1 = get_or_create_device_id(&path).unwrap();
        let id2 = get_or_create_device_id(&path).unwrap();
        assert_eq!(id1, id2); // idempotent
    }

    #[test]
    fn normalizes_uuid_on_read() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        // Write uppercase with no hyphens — valid but non-canonical
        std::fs::write(&path, "550E8400E29B41D4A716446655440000").unwrap();
        let id = get_or_create_device_id(&path).unwrap();
        assert_eq!(id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn rejects_corrupt_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "not-a-uuid").unwrap();
        let err = get_or_create_device_id(&path).unwrap_err();
        assert!(matches!(err, crate::error::AppError::InvalidOperation(_)));
    }

    #[test]
    fn creates_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("nested").join("deep").join("device-id");
        let id = get_or_create_device_id(&path).unwrap();
        assert!(Uuid::parse_str(&id).is_ok());
    }

    #[test]
    fn handles_whitespace_in_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "  550e8400-e29b-41d4-a716-446655440000  \n").unwrap();
        let id = get_or_create_device_id(&path).unwrap();
        assert_eq!(id, "550e8400-e29b-41d4-a716-446655440000");
    }

    #[test]
    fn empty_file_returns_error() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("device-id");
        std::fs::write(&path, "").unwrap();
        assert!(get_or_create_device_id(&path).is_err());
    }
}
