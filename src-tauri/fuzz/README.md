# Fuzz targets (#650)

Coverage-guided fuzzing for the byte-level parsers that accept **arbitrary**
input. The structured proptest harnesses (`tests/AGENTS.md` Tier-A/B) only
generate *valid* shapes; libFuzzer's coverage-guided mutation is the right
tool for the raw-byte boundary, where the bug class is truncation /
malformed-structure / byte-as-char (#624).

This is a standalone cargo-fuzz crate (its `Cargo.toml` declares its own
`[workspace]`) so the nightly + sanitizer build never contaminates the
pinned-stable (`1.95.0`) main build, and the parent `src-tauri` workspace
never tries to compile it on an ordinary `cargo build`.

## Targets

| Target | Surface | Entry point |
| --- | --- | --- |
| `snapshot_decode` | zstd+CBOR snapshot bytes from a peer (sync wire) | `agaric_lib::snapshot::decode_snapshot` |
| `deeplink_parse`  | OS-supplied custom-scheme URLs                  | `agaric_lib::deeplink::parse_deep_link` |

Both entry points are already `pub` on the `agaric` crate, so the fuzz crate
reaches them through a normal path dependency without touching app source.

## Running

cargo-fuzz needs **nightly** (libFuzzer `-Z sanitizer` instrumentation). The
production toolchain stays pinned; only fuzzing uses nightly.

```sh
rustup toolchain install nightly      # one-time
cargo install cargo-fuzz              # one-time

cd src-tauri/fuzz
cargo +nightly fuzz run snapshot_decode -- -max_total_time=120
cargo +nightly fuzz run deeplink_parse  -- -max_total_time=120
```

Compile-check without nightly (what the per-PR / CI compile guard can do):

```sh
cd src-tauri/fuzz && cargo +nightly fuzz check    # or `cargo build` under nightly
```

The scheduled `scheduled-deep-checks.yml` `fuzz` lane runs both targets at a
smoke-length budget weekly and uploads any crash reproducer + the evolved
corpus.

## Corpora

Seed corpora live under `corpus/<target>/`:

- `deeplink_parse/` — the documented `agaric://{block,page,settings}/…`
  shapes plus a wrong-scheme negative, drawn from the parser's own unit
  tests.
- `snapshot_decode/` — the zstd magic header, an empty input, and a garbage
  string. A *valid* compressed-snapshot seed cannot be checked in as a
  literal (it is produced by `encode_snapshot` at runtime); grow the corpus
  with `cargo fuzz cmin snapshot_decode` after pointing it at a real snapshot
  fixture, or add a tiny generator step. libFuzzer still reaches the happy
  path by mutation from the magic header, but a real seed accelerates it.

## Follow-up — third parser (FTS strip / `sanitize_fts_query`)

Issue #650 names a **third** surface: `fts/strip.rs` + `sanitize_fts_query`
(the regex-driven markup stripper that produced byte-as-char bug #624). Its
entry points (`strip_for_fts_with_maps`, `nfc_normalise`, `sanitize_fts_query`)
are `pub(crate)`, so they are not reachable from this external fuzz crate
without widening their visibility (e.g. a `#[doc(hidden)] pub` shim or a
`pub(crate)` → `pub` change behind a `fuzzing` cfg). The `src-tauri/src/fts/`
module is owned by a separate in-flight branch, so that change is deferred to
avoid a cross-branch conflict. When fts lands, add a `fts_strip` target here
that calls the exposed shim and seed its corpus from the existing
`fts/tests.rs` strip fixtures.
