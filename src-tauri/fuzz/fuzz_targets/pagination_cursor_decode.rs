//! Fuzz target (#4497): `Cursor::decode` over arbitrary text.
//!
//! Pagination cursors round-trip through the client, so the decoder accepts
//! whatever comes back — including a cursor from an older build, a truncated
//! one, or one an adversary edited. It must never panic on any of that; an
//! `AppError` is the correct answer for anything it cannot read.
//!
//! # Why no re-encode fixed point
//!
//! The obvious stronger assertion — decode, re-encode, decode again, and expect
//! the same `Cursor` — is **false**, and asserting it would red this lane on its
//! first scheduled run. `serde_json` is not correctly rounded on parse without
//! its `float_roundtrip` feature, which this workspace does not enable: it reads
//! `123456789.12345679` back as the neighbouring double, one ULP away. Probed at
//! 1138 violations across 24,882 decodable cursors, all through the `rank` slot.
//!
//! The drift is real but not currently reachable in production — SQLite bm25
//! ranks are order 1, where one ULP is 2.2e-16, far under the `1e-9` epsilon the
//! FTS keyset compares with. Tracked as #4519; do not add the assertion here
//! until that is fixed.
//!
//! Run: `cargo +nightly fuzz run pagination_cursor_decode`.

#![no_main]

use libfuzzer_sys::fuzz_target;

use agaric_store::pagination::Cursor;

fuzz_target!(|data: &[u8]| {
    // Takes `&str`; only valid UTF-8 reaches it, and libFuzzer still explores
    // the full byte space.
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = Cursor::decode(s);
    }
});
