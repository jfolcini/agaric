//! File bytes that cross IPC as one base64 string.
//!
//! A `Vec<u8>` argument is a JSON array of numbers on the wire: the webview
//! builds one JS number per byte and the backend one `serde_json::Value` per
//! byte, seconds of UI-thread time and hundreds of megabytes for a recording
//! (#6539). A raw invoke body does not replace it, because Tauri sends every
//! Android invoke through `postMessage`, which turns a `Uint8Array` back into
//! that array. A base64 string is one allocation on each side on every
//! platform. The frontend encodes with `blobToBase64` (`src/lib/file-utils.ts`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::de::{Error, Visitor};
use serde::{Deserialize, Deserializer};

/// Upload bytes: a `Vec<u8>` here, standard padded base64 on the wire.
///
/// A newtype, not `#[serde(deserialize_with)]` on a `Vec<u8>` field: specta
/// splits every type holding such a field into `_Serialize` and `_Deserialize`
/// twins in `bindings.ts`.
#[derive(Debug, Clone, specta::Type)]
pub struct Base64Bytes(#[specta(type = String)] pub Vec<u8>);

impl From<Vec<u8>> for Base64Bytes {
    fn from(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }
}

impl std::ops::Deref for Base64Bytes {
    type Target = Vec<u8>;

    fn deref(&self) -> &Vec<u8> {
        &self.0
    }
}

impl<'de> Deserialize<'de> for Base64Bytes {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Base64Visitor;

        impl Visitor<'_> for Base64Visitor {
            type Value = Base64Bytes;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a base64 string")
            }

            // Decodes from the borrowed text, so the string is never copied
            // out of the deserializer first.
            fn visit_str<E: Error>(self, text: &str) -> Result<Base64Bytes, E> {
                STANDARD.decode(text).map(Base64Bytes).map_err(E::custom)
            }
        }

        deserializer.deserialize_str(Base64Visitor)
    }
}

#[cfg(test)]
mod tests {
    use super::Base64Bytes;

    fn parse(json: &str) -> Result<Base64Bytes, serde_json::Error> {
        serde_json::from_str(json)
    }

    #[test]
    fn a_base64_string_deserializes_to_its_bytes() {
        let bytes = parse(r#""AP+AaGk=""#).unwrap();
        assert_eq!(bytes.0, [0x00, 0xFF, 0x80, b'h', b'i']);
    }

    #[test]
    fn an_empty_string_is_no_bytes() {
        assert_eq!(parse(r#""""#).unwrap().0, Vec::<u8>::new());
    }

    #[test]
    fn invalid_base64_is_refused() {
        let err = parse(r#""not base64!""#).unwrap_err();
        assert!(err.to_string().contains("Invalid symbol"), "{err}");
    }

    #[test]
    fn an_array_of_numbers_is_refused() {
        let err = parse("[104,105]").unwrap_err();
        assert!(err.to_string().contains("a base64 string"), "{err}");
    }
}
