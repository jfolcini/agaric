use std::fs;
use std::path::Path;
use uuid::Uuid;

/// Wrapper for device UUID in Tauri managed state.
#[derive(Clone, Debug)]
pub struct DeviceId(pub String);

/// Reads or generates a persistent device UUID.
///
/// The UUID is stored in a plain text file at the given path.
/// On first launch, a new UUID v4 is generated and written.
/// On subsequent launches, the existing UUID is read.
/// The UUID is never regenerated — it is the device's permanent identity
/// in the op log (ADR-07).
pub fn get_or_create_device_id(config_path: &Path) -> Result<String, crate::error::AppError> {
    if config_path.exists() {
        let content = fs::read_to_string(config_path)?;
        let id = content.trim().to_string();
        // Validate it's a proper UUID
        Uuid::parse_str(&id).map_err(|e| {
            crate::error::AppError::InvalidOperation(format!(
                "Corrupt device ID file '{}': {}",
                config_path.display(),
                e
            ))
        })?;
        Ok(id)
    } else {
        // Ensure parent directory exists
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)?;
        }
        let id = Uuid::new_v4().to_string();
        fs::write(config_path, &id)?;
        Ok(id)
    }
}
