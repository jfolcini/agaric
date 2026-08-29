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
    // the full byte space.
    //
    // Nothing is asserted about WHICH inputs are rejected — a rejection is a
    // correct outcome for arbitrary bytes, and pinning the accept/reject split
    // belongs in the unit tests, where the expected answer is known. What IS
    // asserted, below, is a property of the values that ARE accepted: parsing
    // is a fixed point. So this target can fail the lane two ways, a panic and
    // that assertion, and the header used to claim only the first.
    if let Ok(s) = std::str::from_utf8(data) {
        if let Ok(parsed) = AttachmentFsPath::parse(s) {
            // IDEMPOTENCE, not a round-trip. An earlier version of this target
            // read the value back out through `Display` / `AsRef<str>` and
            // asserted nothing; both impls just hand back the inner `String`,
            // so there was no input for which they could fail. It cost nothing
            // and caught nothing.
            //
            // The property worth fuzzing is that parsing is a FIXED POINT:
            // re-parsing an accepted path must succeed and yield the same
            // value. That is a real assertion over the canonicalisation this
            // parser performs — the trailing dot/space fold, the `\` -> `/`
            // rewrite, the dropped `.` segments — any of which could produce a
            // string the parser then treats differently.
            //
            // It is also load-bearing rather than aspirational:
            // `AttachmentFsPath::for_storage_id` decides whether an id is
            // mintable with `matches!(Self::parse(&candidate), Ok(ref parsed)
            // if parsed.as_str() == candidate)`, so a path that is accepted but
            // not a fixed point routes an id down the digest fallback instead
            // of minting the readable name — silently, and differently on
            // either side of a sync.
            let reparsed = AttachmentFsPath::parse(parsed.as_str())
                .expect("an accepted attachment path must re-parse");
            assert_eq!(
                reparsed, parsed,
                "parse is not a fixed point: {:?} -> {:?} -> {:?}",
                s,
                parsed.as_str(),
                reparsed.as_str()
            );
        }
    }
});
