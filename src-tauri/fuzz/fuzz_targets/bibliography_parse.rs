//! Fuzz target (#4497): `parse_bibtex` / `parse_csl_json` over arbitrary text.
//!
//! The bibliography importer parses a file the user picked — a `.bib` exported
//! by Zotero, a CSL-JSON blob from a reference manager, or something that only
//! claims to be either. That is a raw-input boundary: it must never panic,
//! hang, or OOM; it either produces entries or returns an `AppError`.
//!
//! `detect_bibliography_format` is driven too, because dispatching on
//! adversarial content is part of the surface — a file that sniffs as BibTeX
//! and then fails to parse as one is exactly the shape worth exploring.
//!
//! The cost, stated so it is not rediscovered as a surprise: this target
//! shares ONE per-target budget across three functions, so each gets roughly a
//! third of the search a dedicated target would give it — and `parse_bibtex` is
//! by far the largest of the three. That is the right trade while the corpus is
//! still growing between runs, since the cross-parser states are only reachable
//! by driving both. If this target's `cmin <before> -> <after>` line stops
//! rising while the others keep climbing, it has saturated what a shared budget
//! can reach and `parse_bibtex` should be split out.
//!
//! Run: `cargo +nightly fuzz run bibliography_parse`.

#![no_main]

use libfuzzer_sys::fuzz_target;

// The parsers live in the `agaric-engine` crate (#2621 wave E4-import), which
// the fuzz crate already depends on for `import_parse`.
use agaric_engine::bibliography::{detect_bibliography_format, parse_bibtex, parse_csl_json};

fuzz_target!(|data: &[u8]| {
    // All three take `&str`; only valid UTF-8 reaches them, and libFuzzer
    // still explores the full byte space (invalid sequences are a free pass).
    // We assert only the no-panic / no-hang contract — `Ok` and `Err` are both
    // acceptable outcomes for arbitrary input.
    if let Ok(s) = std::str::from_utf8(data) {
        let _ = detect_bibliography_format(s);
        // Both parsers are driven on every input rather than only the one the
        // sniffer selects: a CSL-JSON body handed to the BibTeX parser (and
        // vice versa) is a reachable state whenever detection is wrong, and it
        // is the state least likely to be covered by the example tests.
        let _ = parse_bibtex(s);
        let _ = parse_csl_json(s);
    }
});
