//! Fuzz target (#4497): `Cursor::decode` over arbitrary text.
//!
//! Pagination cursors round-trip through the client, so the decoder accepts
//! whatever comes back — including a cursor from an older build, a truncated
//! one, or one an adversary edited. It must never panic on any of that; an
//! `AppError` is the correct answer for anything it cannot read.
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
