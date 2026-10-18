# Session 2567 — `just --list` shows only recipes that earn a line, and the Rust commands people get wrong have recipes (#5858)

**Gap:** `just --list` carried eleven recipes that only renamed an npm
script, three descriptions that were cut off mid-sentence (`install-hooks`,
`gen-sqlx`, `push`: `just` shows only the last comment line above a recipe),
and no recipe for the commands most often run in the wrong form: clippy
(`--lib` skips test code, `-p` skips other crates), doc-tests (nextest never
runs them), and Rust formatting (`just fmt` skipped it).

**Deleted (premise re-checked with `git grep "just <name>"`, session logs
excluded; the only hit was the `preview` comment naming `just build`, which
goes with it):** `web`, `preview`, `build`, `build-app`, `android-build`,
`test-watch`, `coverage`, `test-e2e`, `lint-fix`, `fmt-all`, `gen-emoji`. Each
ran exactly one npm script. Kept `android`: `scripts/setup-android.sh` prints
`just android` as the next step. `fmt`'s "See fmt-all" pointer went with
`fmt-all`. No doc named a deleted recipe.

**Descriptions:** the one-line summary is now the last comment line for
`install-hooks`, `gen-sqlx` and `push`; the long rationale stays above it.

**Added or changed:**
- `clippy`: `cd src-tauri && cargo clippy --workspace --all-targets -- -D warnings`.
- `test-be *ARGS` and `test-fe *ARGS` forward their arguments with
  `[positional-arguments]` and `"$@"`. Plain `{{ARGS}}` would re-split the
  words `just` already unquoted, so `-E 'test(a) & test(b)'` would reach the
  shell as separate words and break; `"$@"` keeps each argument whole, and an
  empty list expands to nothing. `--workspace` stays fixed in `test-be`.
- `test-doc`: `cd src-tauri && cargo test --doc --workspace`, and `test`
  depends on it. A separate recipe rather than a line in `test-be`, so
  `test-be -E 'test(name)'` stays a pure nextest filter (`cargo test --doc`
  does not take nextest arguments) and `just test` really is the full suite.
- `fmt` also runs `cd src-tauri && cargo fmt --all`.

**Not done:** the optional mutation recipes. Each is a one-line wrapper over
a command AGENTS.md already spells out in full, and nothing has been
mistyped there.

**Docs:** `docs/BUILD.md` § Testing lists the new recipes; `README.md` and
`CONTRIBUTING.md` say `just test` includes the doc-tests and `just fmt`
formats Rust. Root `AGENTS.md` names none of the deleted recipes; it does not
mention `just clippy`, `test-doc` or the argument forms, which needs
maintainer approval to add.

**Tests:** none apply to a justfile. Checked with `just --list`,
`just --dry-run <recipe>` for every touched recipe, and a stub `cargo` / `npm`
on `PATH` that printed `argv`: `just test-be -E 'test(a) & test(two words)'`
reached cargo as `nextest run --workspace -E "test(a) & test(two words)"`
(five arguments), and `just test-fe src/a.test.ts -t 'two words'` reached npm
with `two words` as one argument. With no arguments neither passes anything
extra. No guard parses the justfile.
