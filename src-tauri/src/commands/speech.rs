//! *Read aloud*'s backend (#5745): which engine this build speaks with.
//!
//! macOS and Windows speak through the webview's `speechSynthesis`, so the
//! backend only reports `Webview` there and speaks nothing itself. Android
//! waits for its `TextToSpeech` plugin, which adds its variant and the speak
//! and stop commands. Linux has no engine until the maintainer decides it. The
//! answer comes from `cfg`, never from sniffing the user agent.
//!
//! Tests run only on Linux, so the `Webview` arm is checked on the macOS and
//! Windows devices, not here.

use serde::Serialize;
use specta::Type;

use agaric_core::error::AppError;

/// Which engine speaks on this build, so the frontend can hide *Read aloud*
/// where there is none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
pub enum SpeechStatus {
    /// No engine: *Read aloud* is hidden.
    Unsupported,
    /// The frontend speaks through the webview's `speechSynthesis`.
    Webview,
}

#[tauri::command]
#[specta::specta]
pub fn speech_status() -> Result<SpeechStatus, AppError> {
    Ok(if cfg!(any(target_os = "macos", target_os = "windows")) {
        SpeechStatus::Webview
    } else {
        SpeechStatus::Unsupported
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn speech_status_is_unsupported_on_linux() {
        assert_eq!(speech_status().unwrap(), SpeechStatus::Unsupported);
    }
}
