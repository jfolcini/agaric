# Fuzz targets (#650)

Coverage-guided fuzzing for parsers that accept **arbitrary** input. The
structured proptest harnesses (`tests/AGENTS.md` Tier-A/B) only generate *valid*
shapes; libFuzzer's coverage-guided mutation is the right tool for the raw-byte
boundary, where the bug class is truncation / malformed-structure /
byte-as-char (#624).

This is a standalone cargo-fuzz crate (its `Cargo.toml` declares its own
`[workspace]`) so the nightly + sanitizer build never contaminates the
pinned-stable (`1.95.0`) main build, and the parent `src-tauri` workspace never
tries to compile it on an ordinary `cargo build`.

## Targets

**The `[[bin]]` entries in `Cargo.toml` are the list.** There is deliberately no
table of them here.

This file used to carry one, and by #4497 it named two targets against a
manifest of eight, cited an entry point that had moved crates two refactors
earlier, and still described work that had shipped three months before as
upcoming. That is the same failure #2945 caused in the workflow — two targets
added to the manifest and not to the second copy, built but never fuzzed for
three months while the lane reported success — and #4497 removed that copy by
deriving the workflow's list from the manifest. Adding a fourth copy back here,
in prose nothing checks, would undo the point of it.

To see the targets, read `Cargo.toml`, or run:

```sh
cd src-tauri/fuzz
cargo +nightly metadata --format-version 1 --no-deps \
  | jq -r '.packages[] | select(.name == "agaric-fuzz")
           | .targets[] | select(.kind | index("bin")) | .name' \
  | sort
```

That is the same command the weekly lane uses to build its target list, so what
it prints is exactly what gets fuzzed — including the `+nightly`, which is
load-bearing in CI and merely harmless here. A bare `cargo` resolves through the
repo-root `rust-toolchain.toml` to 1.95.0 plus its mandatory clippy and rustfmt
components; the fuzz job installs only nightly, so in the lane that would pull a
whole toolchain over the network to read a manifest. In a dev checkout you
probably have 1.95.0 already and would not notice, which is exactly why the
command is written the same way in both places.

Each target's own file header states the surface it drives, where that input
comes from, and why it is worth fuzzing — which is the part worth writing down,
and it sits next to the code it describes rather than in a document that can
drift from it.

## Adding a target

1. Write `fuzz_targets/<name>.rs`, with a header saying what it drives and why.
2. Add a `[[bin]]` entry with `test = false` / `doc = false` / `bench = false`.
3. Seed `corpus/<name>/` — see **Corpora** below.
4. If it reaches a crate this manifest does not yet depend on, add the path
   dependency **and** the matching entry to `[package.metadata.cargo-machete]
   ignored` (cargo-machete does not trace the non-standard `fuzz_targets/*.rs`
   bin paths, so it false-reports every dependency here as unused), then
   regenerate `Cargo.lock` with `cargo metadata --format-version 1` — never
   `cargo generate-lockfile` or a bare `cargo update`, both of which lift the
   deliberate holds (see AGENTS.md).

   Note this one is spelled **without** `+nightly`, unlike the listing command
   above, and the difference is deliberate. Listing only reads the manifest, so
   the toolchain is irrelevant and `+nightly` is there purely to stop CI pulling
   a second toolchain. Regenerating the lockfile *resolves dependencies*, and
   the committed lock was produced by the pinned stable toolchain — running that
   under nightly risks a resolver or lockfile-format difference landing in the
   diff alongside the entry you meant to add.

Nothing else. The workflow picks the target up from the manifest.

The one thing the workflow still sizes by hand is its **time budget** — the
job's `timeout-minutes`, the cmin step's, and the `BUDGETED_TARGETS` count the
fuzz step warns against. A ninth target does not need a workflow edit to be
fuzzed, but it does mean those numbers should be re-checked; the lane says so
on the run summary when the derived count outgrows them.

## Running

cargo-fuzz needs **nightly** (libFuzzer `-Z sanitizer` instrumentation). The
production toolchain stays pinned; only fuzzing uses nightly.

```sh
rustup toolchain install nightly      # one-time
cargo install cargo-fuzz              # one-time

cd src-tauri/fuzz
cargo +nightly fuzz run <target> -- -max_total_time=120
```

Compile-check without running:

```sh
cd src-tauri/fuzz && cargo +nightly fuzz check
```

A plain `cargo check --bins` also compiles every target under stable, which is
the cheaper way to catch a target that stopped building. It needs
`SQLX_OFFLINE=true` in a checkout where `DATABASE_URL` is set — otherwise the
`sqlx::query!` macros in `agaric-store` try to reach a database the fuzz
workspace cannot open, and fail with errors that look nothing like a database
problem.

The scheduled `scheduled-deep-checks.yml` `fuzz` lane runs every target for
300 seconds weekly, continuing from the corpus the previous run saved, and
uploads any crash reproducer plus the minimised corpus.

## Corpora

Seed corpora live under `corpus/<target>/`, one input per file.

They are the **floor on a cache miss, not the working set**. Since #4496 the
lane restores the accumulated corpus from the previous run, fuzzes, minimises
with `cargo fuzz cmin`, and saves it again — so after the first run the seeds
stop being the whole story. Before that change every weekly run started from
whatever was committed here and discarded the coverage it found.

Two conventions worth knowing before adding seeds:

- **Choose seeds to land on distinct branches, not to be numerous.** Check that
  they do rather than assuming it — running each candidate through the parser
  and reading the outcomes is how #4497 found one seed whose name described a
  branch it never reached.
- **Whitespace in a seed is content.** `corpus/**` is excluded from the
  `trailing-whitespace` and `end-of-file-fixer` hooks and marked `-text` in
  `.gitattributes`, because both had already corrupted a seed whose entire
  intended content was four magic bytes. For several targets the *absence* of a
  trailing newline is load-bearing — a parser that rejects control characters
  before anything else, or base64-decodes the whole string, sees a stray `\n`
  and collapses every such seed onto one uninteresting branch.
