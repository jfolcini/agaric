# Session 2158 — The pinned toolchain ships rust-analyzer

The Claude Code `rust-analyzer-lsp` plugin could not start in this repo:
`rust-toolchain.toml` pins 1.95.0 with only `clippy` and `rustfmt`, and
rust-analyzer is in neither rustup's minimal nor its default profile, so the
rustup proxy answered `Unknown binary 'rust-analyzer' in official toolchain
'1.95.0'`. Editors running rust-analyzer through rustup hit the same wall.

`components` now also lists `rust-analyzer` and `rust-src`, the std sources
rust-analyzer reads. rustup installs listed components whenever the toolchain
file is in effect, so they follow every future bump without a manual step.
Verified locally: the first `rust-analyzer --version` in the repo downloaded
both components and ran.

Cost: every CI job that installs the toolchain now downloads the two extra
components.
