//! Fuzz target (#650): `parse_deep_link` over arbitrary strings.
//!
//! Deep-link URLs come from the OS (custom-scheme handler), so the parser
//! sees fully external input. It is strict-by-design and must reject every
//! malformed shape with a clean `DeepLinkError` — never panic. The byte-as-
//! char class of bug (#624, in the sibling FTS parser) is exactly what
//! coverage-guided fuzzing surfaces. We fuzz a UTF-8 view of the bytes
//! (`parse_deep_link` takes `&str`); the URL crate's own byte handling is
//! exercised through it.
//!
//! Run: `cargo +nightly fuzz run deeplink_parse`.

#![no_main]

use libfuzzer_sys::fuzz_target;

// Library target is named `agaric_lib` (see src-tauri/Cargo.toml `[lib]`).
use agaric_lib::deeplink::parse_deep_link;

fuzz_target!(|data: &[u8]| {
    // Only valid UTF-8 reaches `&str`; libFuzzer still explores the byte
    // space and we get a free pass on invalid sequences. This keeps the
    // target honest to the real call signature without an `Arbitrary` impl.
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = parse_deep_link(s);
    }
});
