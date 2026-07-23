# Session 1214 — Fuzz targets for FTS strip/sanitizer and HTML parser (#2945)

## Issue
#2945 — Only three fuzz targets existed (`snapshot_decode`, `deeplink_parse`,
`import_parse`). Two raw-input boundaries named as fuzz candidates in #650 were never
followed up after FTS landed in agaric-store: the FTS strip/sanitizer
(`strip_for_fts_with_maps`, `sanitize_fts_query` — left `pub(crate)`) and the 454-line
hand-rolled `link_metadata/html_parser.rs` scanning arbitrary remote HTML.

## What shipped
Two new libFuzzer harnesses mirroring `import_parse.rs`, plus the minimal visibility
widening needed to reach the FTS functions from the separate `fuzz` crate.

## Implementation
- `src-tauri/fuzz/fuzz_targets/fts_strip.rs` — UTF-8-gates the input, then drives
  `strip_for_fts_with_maps("fuzz-block-id", s, &empty, &empty)` and `sanitize_fts_query(s)`
  (the fuzz `&str` is the `content`/`query` attack surface). No-panic/no-hang contract only.
- `src-tauri/fuzz/fuzz_targets/html_parse.rs` — UTF-8-gates, then drives all four
  html_parser entry points (`parse_title`, `parse_description`, `parse_favicon`,
  `detect_auth_required`) on the same `&str`.
- `src-tauri/fuzz/Cargo.toml` — two `[[bin]]` entries (`fts_strip`, `html_parse`,
  `test/doc/bench = false`); added `agaric-store` (`path = "../agaric-store"`) as a direct
  dep + to the `cargo-machete` ignore list.
- Visibility (agaric-store only — html_parser was already reachable at
  `agaric_lib::link_metadata::…`): `strip_for_fts_with_maps` and the
  `sanitize_fts_query` re-export chain (`fts/mod.rs` `mod strip`→`pub mod strip` and the
  two `pub(crate) use`→`pub use`, plus the `sanitizer.rs` fn) widened `pub(crate)`→`pub`.
  No unrelated item exposed.

## Verification
Adversarial review caught a real coverage defect: `detect_auth_required` was called with
two IDENTICAL URLs, which gates its cross-domain body-scanning branch (the
`<input type="password">` / login-form-`action` detection — the bulk of the interesting
logic) as permanently dead code under the fuzzer. Fixed to use two different-domain URLs so
that branch is reachable. `cargo check -p agaric --lib -p agaric-store` clean;
`SQLX_OFFLINE=true cargo build --manifest-path fuzz/Cargo.toml --bin fts_strip --bin
html_parse` builds green. Nightly/`cargo-fuzz` are not installed in the dev env, so no
instrumented run was performed locally (the CI deep-check fuzz lane runs the corpus); a
stable build of both bins + a direct uninstrumented libFuzzer smoke run (20k iters each, no
crashes) confirmed the harness logic end-to-end. Only the intended files changed; no
Serena-edit leakage into the main checkout.

## Note
The fuzz crate's `Cargo.lock` picked up the already-landed 0.9.0 version bump + an existing
`rfd` dep when rebuilt (stale lockfile catching up) — verified not scope creep.
