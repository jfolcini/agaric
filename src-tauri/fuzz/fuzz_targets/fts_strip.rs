//! Fuzz target (#2945): `strip_for_fts_with_maps` / `sanitize_fts_query`
//! over arbitrary text.
//!
//! `strip_for_fts_with_maps` converts raw block content — arbitrary note
//! bodies, pasted or synced from any peer — into the plain text stored in
//! the `fts_blocks` FTS5 index; `sanitize_fts_query` turns raw user-typed
//! search-box text into a safe FTS5 MATCH expression. Both sit directly on
//! a raw-input boundary (arbitrary note content on one side, arbitrary
//! query text on the other) with no schema or shape to constrain the
//! input, so they must never panic, hang, or OOM. The structured proptest
//! suites (`fts::tests`, `search::sanitizer` tests) generate VALID-ish
//! markdown/query shapes; libFuzzer's coverage-guided mutation is the
//! right tool for the truncated/garbage boundary — malformed markup
//! delimiters, unbalanced tag/page-link tokens, adversarial FTS5 MATCH
//! syntax.
//!
//! Run: `cargo +nightly fuzz run fts_strip`.

#![no_main]

use std::collections::HashMap;

use libfuzzer_sys::fuzz_target;

// Library target is named `agaric_store` (see
// src-tauri/agaric-store/Cargo.toml `[package] name = "agaric-store"`).
use agaric_store::fts::sanitize_fts_query;
use agaric_store::fts::strip::strip_for_fts_with_maps;

fuzz_target!(|data: &[u8]| {
    // Both functions take `&str`; only valid UTF-8 reaches them, and
    // libFuzzer still explores the full byte space (invalid sequences are a
    // free pass). We assert only the no-panic / no-hang contract — any
    // output (including truncated/degenerate output) is acceptable.
    if let Ok(s) = std::str::from_utf8(data) {
        // Empty ref maps: the fuzzer already covers the map-driven
        // tag/page-link substitution paths via the structured proptest
        // suite; here we stress the regex/normalisation/truncation passes
        // over arbitrary content instead.
        let tag_names: HashMap<String, String> = HashMap::new();
        let page_titles: HashMap<String, String> = HashMap::new();
        let _ = strip_for_fts_with_maps("fuzz-block-id", s, &tag_names, &page_titles);
        let _ = sanitize_fts_query(s);
    }
});
