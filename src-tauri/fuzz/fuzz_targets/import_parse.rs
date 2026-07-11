//! Fuzz target (#2590): `parse_logseq_markdown` over arbitrary text.
//!
//! The Markdown/Obsidian importer parses fully arbitrary user files — a picked
//! vault folder, an Obsidian export, or ENEX/JEX notes composed into Markdown
//! by the frontend importers (#1282). `parse_logseq_markdown` is therefore a
//! raw-input boundary: it must never panic, hang, or OOM on any input; it
//! either produces blocks or records a soft warning. The structured proptest in
//! `import.rs` generates VALID-ish Markdown shapes; libFuzzer's coverage-guided
//! mutation is the right tool for the truncated/garbage boundary.
//!
//! Run: `cargo +nightly fuzz run import_parse`.

#![no_main]

use libfuzzer_sys::fuzz_target;

// Library target is named `agaric_lib` (see src-tauri/Cargo.toml `[lib]`).
use agaric_lib::import::parse_logseq_markdown;

fuzz_target!(|data: &[u8]| {
    // `parse_logseq_markdown` takes `&str`; only valid UTF-8 reaches it, and
    // libFuzzer still explores the full byte space (invalid sequences are a
    // free pass). We assert only the no-panic / no-hang contract — any parse
    // outcome (blocks and/or warnings) is acceptable.
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = parse_logseq_markdown(s);
    }
});
