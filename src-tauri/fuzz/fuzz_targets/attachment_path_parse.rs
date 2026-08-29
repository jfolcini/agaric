//! Fuzz target (#4497): `AttachmentFsPath::parse` over arbitrary text.
//!
//! This is the validation boundary for attachment paths, and the one with a
//! security argument rather than only a robustness one: #2989 was a
//! path-traversal filename reaching `rename_attachment` because validation did
//! not reject it. The parser is what stands between user-supplied path text and
//! the filesystem, so "never panics, and rejects anything it should not accept"
//! is the contract worth stressing with adversarial bytes — `..` segments,
//! absolute paths, NUL bytes, Windows separators, overlong sequences.
//!
//! Run: `cargo +nightly fuzz run attachment_path_parse`.

#![no_main]

use libfuzzer_sys::fuzz_target;

use agaric_core::attachment_path::AttachmentFsPath;

fuzz_target!(|data: &[u8]| {
    // Takes `&str`; only valid UTF-8 reaches it, and libFuzzer still explores
    // the full byte space. We assert the no-panic contract only — a rejection
    // is a correct outcome, and asserting anything about WHICH inputs are
    // rejected belongs in the unit tests, where the expected answer is known.
    if let Ok(s) = std::str::from_utf8(data) {
        if let Ok(parsed) = AttachmentFsPath::parse(s) {
            // Round-trip whatever was accepted: `Display`/`AsRef<str>` are how
            // callers get the value back out, so a parse that succeeds and then
            // panics on read would be a live defect this target should catch.
            let rendered = parsed.to_string();
            let _ = rendered.as_str();
            let _: &str = parsed.as_ref();
        }
    }
});
