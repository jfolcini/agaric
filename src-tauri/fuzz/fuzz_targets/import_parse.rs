//! Fuzz target (#2590): the three outline parsers over arbitrary text.
//!
//! The Markdown/Obsidian importer parses fully arbitrary user files — a picked
//! vault folder, an Obsidian export, or ENEX/JEX notes composed into Markdown
//! by the frontend importers (#1282). `parse_logseq_markdown` is therefore a
//! raw-input boundary: it must never panic, hang, or OOM on any input; it
//! either produces blocks or records a soft warning. So are the other two
//! readings of the same grammar (#5160): `parse_source_outline` runs on every
//! Edit as Markdown save and `parse_pasted_text` on every plain-text paste,
//! each on raw user text through its own paths. The structured proptest in
//! `import.rs` generates VALID-ish Markdown shapes; libFuzzer's coverage-guided
//! mutation is the right tool for the truncated/garbage boundary.
//!
//! Run: `cargo +nightly fuzz run import_parse`.

#![no_main]

use libfuzzer_sys::fuzz_target;

// The parsers live in the `agaric-engine` crate (#2621 wave E4-import). The
// app-side `agaric_lib::import` module kept only the Tauri-integration
// `ImportProgressSink` seam once #2897 removed the re-export shim, so the
// parsers are no longer reachable through it.
use agaric_engine::import::{parse_logseq_markdown, parse_pasted_text, parse_source_outline};

fuzz_target!(|data: &[u8]| {
    // The parsers take `&str`; only valid UTF-8 reaches them, and
    // libFuzzer still explores the full byte space (invalid sequences are a
    // free pass). We assert only the no-panic / no-hang contract — any parse
    // outcome (blocks and/or warnings) is acceptable.
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = parse_logseq_markdown(s);
        let _ = parse_source_outline(s);
        let _ = parse_pasted_text(s);
    }
});
