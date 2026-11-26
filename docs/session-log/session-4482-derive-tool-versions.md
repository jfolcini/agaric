# Session 4482 — CI reads the Rust toolchain and the Node floor from their source files

The maintainer approved deriving the hand-copied tool versions. The Rust toolchain's source is `rust-toolchain.toml`, but `toolchain: 1.100.0` was typed by hand in 13 workflow steps and the `toolchain` composite action. `pins.mjs` therefore refused to bump Rust ("bump it by hand"). The nightly floor lane typed `node-version: 24.22.1`, a copy of `package.json`'s `engines.node` floor.

**Changes.**
- `scripts/pins.sh github-output` also writes `rust=` (the `channel` of `rust-toolchain.toml`) and `node_floor=` (the first version in `engines.node`). It reads both before writing anything. If either cannot be read, it exits 1 naming the file and leaves `$GITHUB_OUTPUT` untouched.
- Every workflow toolchain step uses `${{ steps.pins.outputs.rust }}`, and the floor lane uses `node_floor`.
  - Jobs without a `Read pins.txt` step got one, and jobs whose pins step ran after the toolchain step had it moved up.
  - The `toolchain` composite action runs its own pins step, because it cannot see its caller's step outputs.
  - The nightly fuzz lane keeps the `rust-nightly` pin it already read.
- `pins.mjs`'s rust file pin has a `write`, so `just pin-bump rust <v>` works. It names the one copy left by hand: each crate's `rust-version`, which Cargo reads natively. The "bump it by hand" branches that no file pin reached any more are gone.
- `pins.test.mjs` covers the two new keys and the fail-closed paths. Its hard-coded-version check now also rejects `toolchain:` and `node-version:` literals.
- Prose updated in `rust-toolchain.toml`'s header, `.github/AGENTS.md`, the `rust-toolchain` action's input description, `src-tauri/Cargo.toml` and the `justfile`'s `pin-bump` comment.

**Ran.**
- `node --test scripts/pins.test.mjs`: 26 passed. Seven falsifications each turned their test red:
  - the `rust=` emit;
  - the rust read's fail-closed `die`;
  - the engines-block bound;
  - writing before reading;
  - the rust `write`;
  - the `byHand` note;
  - a literal put back in a workflow.
- `GITHUB_OUTPUT=$(mktemp) bash scripts/pins.sh github-output` writes `rust=1.100.0` and `node_floor=24.22.1`.
- `prek run` at the pre-commit and manual stages on the changed files, including actionlint, zizmor, shellcheck and shfmt.
- An independent review checked every changed job's step order. `release.yml` and `scheduled-deep-checks.yml` matter most, because PR CI never runs them. The review also checked the composite action's five callers, and ran the new awk under mawk and onetrue-awk (macOS's awk) and with CRLF files.
