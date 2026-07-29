//! Fuzz target (#650): `decode_snapshot` over arbitrary bytes.
//!
//! The decode path consumes zstd-compressed CBOR supplied by a *peer* over
//! the sync wire — i.e. fully attacker-controlled bytes. A decompression-bomb
//! guard exists (#428), but no truncated-/garbage-snapshot test does; the
//! function must reject any malformed input with a clean `AppError::Snapshot`
//! and never panic, OOM, or hang. libFuzzer drives exactly that contract.
//!
//! Run: `cargo +nightly fuzz run snapshot_decode`.

#![no_main]

use libfuzzer_sys::fuzz_target;

// Production `decode_snapshot` lives in the `agaric-sync` crate (#2621
// Sync-D). The app-side `agaric_lib::snapshot` module is a `#[cfg(test)]`-only
// test host since #2897 removed the re-export shim, so importing it from there
// no longer compiles in a fuzz (non-test) build — depend on the real crate.
use agaric_sync::snapshot::decode_snapshot;

fuzz_target!(|data: &[u8]| {
    // `decode_snapshot` takes `R: Read`; `&[u8]` is `Read`. We only assert
    // the no-panic / no-hang contract — a returned `Err` is the expected
    // outcome for almost all inputs, and a rare structurally-valid input
    // decoding to `Ok` is equally fine.
    let _ = decode_snapshot(data);
});
