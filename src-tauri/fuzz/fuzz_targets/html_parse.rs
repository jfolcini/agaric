//! Fuzz target (#2945): `html_parser`'s four entry points over arbitrary
//! HTML.
//!
//! `parse_title` / `parse_description` / `parse_favicon` /
//! `detect_auth_required` scan the raw HTML response body fetched from an
//! arbitrary remote URL when Agaric resolves link metadata (page title,
//! description, favicon, login-wall detection) — fully untrusted,
//! attacker-influenced input with no schema. They are pure `&str` -> data
//! functions, so they must never panic, hang, or OOM regardless of how
//! malformed the markup is. The structured tests in `link_metadata/tests.rs`
//! cover well-formed-ish HTML shapes and known-limitation regressions;
//! libFuzzer's coverage-guided mutation is the right tool for the
//! truncated/garbage boundary (unclosed tags, malformed attribute quoting,
//! adversarial entity chains).
//!
//! Run: `cargo +nightly fuzz run html_parse`.

#![no_main]

use libfuzzer_sys::fuzz_target;

// Library target is named `agaric_lib` (see src-tauri/Cargo.toml `[lib]`).
// `link_metadata::mod` re-exports these from the private `html_parser`
// submodule (`pub use html_parser::{detect_auth_required, parse_description,
// parse_favicon, parse_title};`), so they are reachable at this path without
// widening `html_parser`'s own module visibility.
use agaric_lib::link_metadata::{
    detect_auth_required, parse_description, parse_favicon, parse_title,
};

fuzz_target!(|data: &[u8]| {
    // All four take `&str`; only valid UTF-8 reaches them, and libFuzzer
    // still explores the full byte space (invalid sequences are a free
    // pass). We assert only the no-panic / no-hang contract — any parse
    // outcome (`Some`/`None`/`true`/`false`) is acceptable.
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = parse_title(s);
        let _ = parse_description(s);
        let _ = parse_favicon(s, "https://example.com/page");
        // `original_url` and `final_url` must differ (in domain) so
        // `detect_auth_required`'s redirect-to-different-domain branch —
        // which does the bulk of its body_lower.contains(...) scanning for
        // password inputs / login-form actions — is actually reachable by
        // the fuzzer. With equal URLs that whole branch is permanently
        // dead code (original_domain == final_domain short-circuits it),
        // leaving only the meta-refresh and title-keyword checks fuzzed.
        let _ = detect_auth_required(
            200,
            "https://example.com/page",
            "https://login.example.net/signin",
            s,
        );
    }
});
