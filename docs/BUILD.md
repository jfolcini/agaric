<!-- markdownlint-disable MD060 -->
# Build & Release

Everything you need to build, test, and release Agaric. Self-contained.

## TL;DR

```bash
bash scripts/setup.sh                    # ONE command: Node + deps + .env + dev DB + prek hook toolchain
cargo tauri dev                          # run the app
prek run --all-files                     # run every CI gate locally (or: just check)
```

**`scripts/setup.sh` is the single canonical dev-environment setup — run it and it handles the repository-managed toolchain.** `npm run setup` and `just setup` are exact aliases for it (use whichever you have; `just` is optional). It is idempotent, so re-run it any time. It provisions the Node version pinned in [`.nvmrc`](../.nvmrc) via `nvm` when your active `node` does not satisfy the `engines.node` range, runs `npm ci`, copies `src-tauri/.env.example` to the gitignored `.env` beside it (sqlx reads `DATABASE_URL` at compile time), seeds the sidecar placeholder, provisions the local dev DB via `scripts/setup-dev-db.sh`, and installs the prek hook toolchain via `scripts/setup-hooks.sh` (see [Hook toolchain](#hook-toolchain) below). System package installation stays opt-in so normal local setup never invokes a privileged package manager; Claude's remote hook supplies `--install-system-deps` on its disposable Linux VM. The sidecar placeholder is also re-run automatically by `beforeDevCommand`, so `cargo tauri dev` needs no manual prep step after the platform prerequisites are present. On Claude's cloud VMs setup runs automatically — see [Claude Code on the web](#claude-code-on-the-web).

Tests: `npx vitest run` (frontend), `cd src-tauri && cargo nextest run --workspace` (backend — bare form omits `agaric-core`/`store`/`engine`/`sync`/`observability`/`diagnostics`, #3212), `npx playwright test` (e2e), `cargo bench --bench interactive_slo` (warm latency mean-budget gate).

## After-clone setup

Run `bash scripts/setup.sh` (or its aliases `npm run setup` / `just setup`) to provision the Node/npm/`.env`/dev-DB/hook-toolchain side of a fresh clone. It does **not** install a Rust toolchain, the `cargo-tauri` binary, or privileged system packages by default — those are separate prerequisites (see the platform sections below, and [Hook toolchain](#hook-toolchain) for `cargo-tauri` specifically). `--install-system-deps` is reserved for an explicitly disposable Debian/Ubuntu environment; the committed remote SessionStart hook uses it, while local setup remains warn-only. The steps that actually gate a fresh clone are:

0. **Node** — `engines.node` is `^22.22.2 || ^24.15.0 || >=26.0.0`; a mismatched `node` makes `npm ci` abort with `EBADENGINE` (`.npmrc` sets `engine-strict=true`). That range is **derived**, not chosen: it is the intersection of the `engines.node` declared by every installed dependency, where `jsdom` is the binding constraint at each boundary and `@babel/*` 8.x excludes the whole Node 23 line — so re-derive it when those move rather than widening it by hand. `.nvmrc` pins Node 24 as the *development default*, which is a stricter choice than the floor. The script provisions the pinned version via `nvm` (Node from `nodejs.org`, both it and `raw.githubusercontent.com` for `nvm.sh` reachable over plain HTTPS — never `git clone`, so it works inside repo-scoped sandboxes too) when your active `node` doesn't satisfy the range, and leaves it as the `nvm` default. Already on a satisfying Node? It's a no-op.
1. `npm ci` — frontend deps.
2. `cp src-tauri/.env.example src-tauri/.env` — sqlx reads `DATABASE_URL` from here at compile time (offline mode uses `.sqlx/` cache, but the env file must exist). Skipping this is the classic fresh-clone compile failure.

`scripts/setup.sh` does all of the above, then provisions the dev DB (`scripts/setup-dev-db.sh`) so pre-push Rust checks pass, and installs the hook toolchain (`scripts/setup-hooks.sh`, below). Playwright's chromium is fetched best-effort (e2e isn't needed to build or commit, and the step is skipped when `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, as on the cloud VMs). It also seeds the `agaric-mcp` sidecar placeholder — but you do not need to run `node scripts/prepare-external-bins.mjs --placeholder-only` by hand, because `beforeDevCommand` in `src-tauri/tauri.conf.json` re-runs it on every `cargo tauri dev`. The real sidecar is produced later by `cargo build --bin agaric-mcp`; the placeholder just unblocks the chicken-and-egg first compile.

### Claude Code on the web

On [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) the dev environment bootstraps **automatically**: the repo ships a `SessionStart` hook ([`.claude/hooks/session-start.sh`](../.claude/hooks/session-start.sh)) that runs `scripts/setup.sh --install-system-deps` whenever `CLAUDE_CODE_REMOTE=true`, so a fresh Debian/Ubuntu cloud session installs the native WebKit/GTK build libraries and lands build-, test-, and commit-ready with no manual step. The privileged step is noninteractive and best-effort: it runs only when packages are missing, uses root or passwordless `sudo -n`, and leaves an actionable `Ready except` summary rather than hiding a privilege/network failure. Nothing to configure — it's part of the clone.

A few specifics for that environment:

- **Node.** The cloud VMs ship Node 20/21/22 (via `nvm`) by default; 20/21 and pre-22.22.2 don't satisfy `engines.node` — `scripts/setup.sh` provisions the `.nvmrc` Node on startup, so you don't have to.
- **Linux system packages.** The remote-only opt-in installs the six native packages used by CI's Rust compile/test lane in [`_validate.yml`](../.github/workflows/_validate.yml) — `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libssl-dev`, `librsvg2-dev`, `libsoup-3.0-dev`, `pkg-config` — plus `patchelf`, which is bundle-time only but cheap and keeps `cargo tauri build` working in the same sandbox. It deliberately excludes `libappindicator3-dev` (AppImage tray bundling) and `mold` (an optional linker speed-up that `ensure_fast_linker` degrades cleanly without). An already-provisioned VM performs no apt or network call.
- **Faster startup (optional).** `SessionStart` hooks run on every session and aren't filesystem-cached. For the quickest starts you can *also* paste `bash scripts/setup.sh --install-system-deps` into your environment's **Setup script** field in the web UI: setup scripts run once and Anthropic snapshots the result, so the system and heavy cargo-tool installs land in the cache instead of re-running each session. The committed hook still guarantees bootstrap even if you skip this.
- **Network.** `npm ci`, `nvm install` (`nodejs.org`), and `nvm.sh` (`raw.githubusercontent.com`) all use hosts on the default **Trusted** allowlist, so bootstrap works at every network-access level. Only `git clone` of third-party repos is blocked — the GitHub git proxy scopes the credential to this repo, independent of the network level.
- **prek's git-cloned hooks.** Because of that git scoping, prek's three hooks built from upstream repos — `gitleaks`, `actionlint`, and `conventional-pre-commit` — can't be provisioned in a sandboxed session, so `scripts/setup-hooks.sh` leaves the git hooks **unwired** there (commits keep working; those three still run in CI). Every `language = "system"` hook works once its host binary is installed. Locally, with normal git access, all hooks wire up.

### Hook toolchain

Nearly every hook in `prek.toml` is `language = "system"` — it shells out to a binary that must already be on PATH, or your first `git commit` aborts. `scripts/setup-hooks.sh` (run by `npm run setup` / `just install-hooks`) installs that toolchain, mirroring CI's install set in `.github/workflows/_validate.yml` so the local gate matches CI:

- **Cargo tools** (via `cargo-binstall` when present — prebuilt, fast — else `cargo install --locked`): `prek`, `cargo-deny`, `cargo-machete`, `cargo-audit`, `sqruff`, `typos-cli`, `zizmor`, `taplo-cli`, `cargo-nextest`, `just`, `lychee`, and `sqlx-cli` (with `--no-default-features --features rustls,sqlite`).
- **Platform package manager** (`brew` on macOS, `apt`/`dnf`/`pacman` on Linux): `shellcheck`, plus `go` and `python3` — prek *builds* three hooks from pinned upstream repos rather than calling a host binary (`gitleaks` and `actionlint` via its Go backend, `conventional-pre-commit` via its Python backend).
- **npm devDependencies** (already installed by `npm ci`): `oxlint`, `oxfmt`, `knip`, `markdownlint-cli2`.

The script is best-effort and idempotent: tools already on PATH are skipped, and anything it can't auto-install on your platform prints a manual hint instead of failing (a partial toolchain still builds and runs the app — you just can't commit until the gap is filled). It finishes with `prek install` to wire the git hooks. Re-run it any time to fill gaps.

## Prerequisites by platform

### Linux

Install what CI installs (the apt lists in `.github/workflows/ci.yml` and `release.yml` are authoritative — `libappindicator3-dev` and `patchelf` are needed only for AppImage bundling):

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  librsvg2-dev libssl-dev pkg-config \
  libappindicator3-dev patchelf
```

Plus Node 24 (see `.nvmrc`) and the Rust toolchain pinned in [`rust-toolchain.toml`](../rust-toolchain.toml) — `rustup` picks the pin up automatically inside the repo; that same version is the MSRV recorded as `rust-version` in `src-tauri/Cargo.toml`.

The canonical quickstart used throughout this repo — `scripts/setup.sh`, the `justfile`, and CI — invokes `cargo tauri dev` / `cargo tauri build`. That dispatches to a `cargo-tauri` binary, which `npm ci` does **not** provide, so install it with `cargo install tauri-cli --locked` (what `ci.yml` does for its bundle build). Keep it in step with the pinned `@tauri-apps/cli` devDependency (see `package.json` for the current pin) so the Rust and JS CLIs stay on the same Tauri stack ([AGENTS.md § coupled dependency stacks](../AGENTS.md)). The `npm ci`-installed `@tauri-apps/cli` also exposes an equivalent `npx tauri …` if you prefer to avoid the extra cargo install.

### Windows

WebView2 runtime ships with Windows 11. On older builds, install it from Microsoft. Visual Studio Build Tools provide the MSVC toolchain. See [Tauri's Windows prereqs](https://v2.tauri.app/start/prerequisites/) for the canonical list.

### macOS

Xcode Command Line Tools (`xcode-select --install`). The rest installs via `brew install rustup node`. WebView is system-provided.

### Android

- Android SDK (cmdline-tools, platform-tools, build-tools).
- Android NDK r27 (any 27.x patch; CI pins a specific build but local can float).
- JDK 17.
- Rust targets: `rustup target add aarch64-linux-android x86_64-linux-android` (32-bit ABIs are intentionally not supported).

Set `ANDROID_HOME` / `ANDROID_NDK_HOME` per Tauri's [Android setup](https://v2.tauri.app/start/prerequisites/#android).

### Developer tools (prek hook host-binaries)

The [`prek`](https://github.com/j178/prek) hooks shell out to host-installed binaries, so a fresh contributor who runs them without the toolchain hits hook-by-hook `command not found`. `bash scripts/setup-hooks.sh` installs the whole set — see [Hook toolchain](#hook-toolchain) above for what it covers and how to fill gaps by hand. `prek.toml` is the source of truth: each hook's exact `entry` and any install hint live there.

These local hooks are **optional**: if you cannot install them, open your PR anyway — CI runs the same gate via `.github/workflows/_validate.yml` (see [`CONTRIBUTING.md`](../CONTRIBUTING.md#bootstrap)).

### Optional: code-review navigation graph

`.mcp.json` wires an optional MCP server, **code-review-graph**, that exposes a symbol/dependency graph for fast, structural code navigation (used in place of ad-hoc `grep`/file-reads when available). It is launched on demand by [`uv`](https://docs.astral.sh/uv/)'s `uvx` runner, which fetches the package from PyPI on first run — so enabling it means installing `uv` and nothing else. It is a navigation aid for MCP-capable clients, not a build or test prerequisite; if `uvx` is absent the server simply does not start.

## Development

```bash
cargo tauri dev              # full app with hot reload
npm run dev                  # browser-only fallback (uses tauri-mock for IPC)
cargo tauri android dev --target x86_64   # Android emulator
```

### When to use which loop

| Loop | Wall time / edit | Use it for |
| --- | --- | --- |
| `npm run dev` (Vite HMR) | ~50 ms | Pure UI work: component layout, styles, copy, interactions wired through `tauri-mock`. |
| `cargo tauri dev` | ~10-20 s (Rust edit), ~50 ms (frontend edit) | Anything that hits real backend behaviour: sync, search, materializer, command handlers, sqlx queries, capability permissions. |
| `cargo tauri android dev --target x86_64` | minutes (cold), ~20 s (incremental) | Mobile-specific layout, touch gestures, Android-only IPC paths, keystore-signed builds. |

The browser fallback covers most frontend work — every Tauri IPC is mocked via `src/lib/tauri-mock/`. Some space-scoping and live sync flows are stubbed there; for those, run the full app. The Rust loop on every UI tweak is otherwise the long pole of the dev cycle and worth avoiding.

### Backend iteration with `bacon`

For Rust-only edits, a continuously-running `cargo check` tightens the loop further than ad-hoc invocations:

```sh
cargo install bacon --locked
bacon                       # default: cargo check, re-runs on save
```

Keep a `bacon` window open next to the editor. Defaults are sensible; optional `bacon.toml` wires up custom jobs (clippy, nextest, …). No project-side config needed.

### Speed up Rust builds (Linux)

The link step is the long pole of incremental Rust compiles on this codebase, not codegen. Two things address that, and **`scripts/setup.sh` now wires both automatically** — you no longer copy anything by hand:

1. **A faster linker.** `setup.sh` writes `.cargo/config.toml` on a Linux host when a fast linker is on PATH, preferring [`mold`](https://github.com/rui314/mold) and falling back to `lld`. Install one for the win:

   ```sh
   sudo apt install mold        # Debian/Ubuntu (mold has been in main since 22.04)
   # then re-run: bash scripts/setup.sh   (or: cp .cargo/config.toml.example .cargo/config.toml)
   ```

   `lld` already ships on most CI/dev images, so on many machines the fast linker is wired with no extra install. Neither is bundled; without either, gcc/clang's `-fuse-ld=<ld>` errors clearly (`cannot find -fuse-ld=…`) rather than failing silently.

2. **`split-debuginfo = "unpacked"`** (committed in `[profile.dev]`, `src-tauri/Cargo.toml`). Leaves DWARF beside the object files instead of packing it into the linked artifact, so the linker copies far fewer bytes — complementary to the fast linker. First-party debuggability and runtime are unchanged; the dev profile never ships.

Measured on this project (2026-05-16): with **mold**, an incremental `cargo check` after touching a single Rust file dropped from ~20 s to ~7-10 s. With **lld** (the fallback) plus `unpacked` split-debuginfo, a steady-state incremental **relink** of the app crate went ~21 s → ~18 s — smaller, because that relink is dominated by recompiling the app crate itself rather than by linking. Incremental `cargo check` is unaffected by the linker choice, as expected (check doesn't link).

The active `.cargo/config.toml` is gitignored, so it never leaks into the tree — only the `.example` is tracked, and `setup.sh` never overwrites an existing file (a manual override wins). An unconditional `[target.…] rustflags` would break a fresh clone that hasn't installed the linker, which is why it's generated rather than committed. **Linux-only**: `setup.sh` only wires the Linux host triple, so macOS/Windows and Android cross-builds are untouched. Safe to delete any time.

## Testing

```bash
npx vitest run                                   # frontend
cd src-tauri && cargo nextest run --workspace    # backend (bare form is package-scoped only, #3212)
npx playwright test                              # e2e (chromium)
cargo bench --bench interactive_slo              # warm latency mean budgets at 100K blocks
```

- **Frontend** tests use Vitest + jsdom + `@testing-library/react`. Every component test must include an `axe(container)` audit (enforced by the `axe-presence` prek hook).
- **Backend** tests use `cargo-nextest` with insta snapshots. Materializer tests use the `test_pool()` + `TempDir` fixture; multi-thread runtime is `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Snapshot updates: `cargo insta review`.
- **E2E** specs cover smoke flows, editor lifecycle, keyboard navigation, sync round-trip, and view dispatches. Specs live in `e2e/`.
- **Bench gates**: the product target is ≤200 ms p95 for interactive commands at 100K blocks; `interactive_slo` supports it by enforcing an accumulated mean against the per-command budgets defined in that bench, not by measuring per-call p95. It runs warm in the scheduled `bench-slo` lane. The sharded `bench-smoke` lane **smoke-runs every non-SLO bench once** (`--test`) so a drifted seed/fixture fails CI instead of rotting silently (#978 — validates fixtures, not perf); `interactive_slo` is deliberately excluded because cold `--test` timings can trip its budgets falsely. To reproduce the smoke lane, build once (`cd src-tauri && cargo bench --no-run`) and run the non-SLO prebuilt `target/release/deps/<bench>-<hash> --test` binaries; run `cargo bench --bench interactive_slo` warm for its budget verdict. The exact loop and the cargo #6313 build-race it dodges are in `src-tauri/benches/AGENTS.md`.

### Mutation testing (nightly)

```bash
npm run mutation                             # every module
npm run mutation -- tokenize filters-model   # only named modules
```

`#886` — [StrykerJS](https://stryker-mutator.io/) mutation testing, scoped to a handful of pure/deterministic frontend libs (see `stryker.modules.mjs` for the exact list) — never components or Tauri IPC. It mutates each source line (flip a `&&` to `||`, drop a branch, swap a string literal, …) and checks whether the test suite actually notices; a "survived" mutant is a gap in assertion *strength*, not line coverage — coverage can be high while the tests never distinguish the mutated behaviour from the original.

Each module runs in its own Stryker invocation, scoped to run ONLY that module's own test file(s) — `stryker.modules.mjs` holds the mapping, and `stryker.config.mjs` / `stryker.vitest.config.mjs` explain why (vitest's default "related" test-selection resolves through barrel re-exports like `search-query/index.ts` and drags in a large set of unrelated component tests otherwise). Reports land in `reports/mutation/<module>/mutation.html` (gitignored).

`#3350` — the module set is chosen by RISK, not by convenience: code that reorders or renumbers the user's blocks, parses untrusted input, or rewrites text. A survivor in `page-blocks-move` means the tests would not notice the outline being silently scrambled; a survivor in a presentational helper means very little, which is why presentational code is not enrolled. Every candidate is MEASURED before enrolment (mutant count from `npx stryker run --dryRunOnly`, wall-clock and survivor count from a real single-module run) and the modules that were measured and *rejected* are listed, with their numbers and the reason, at the bottom of `stryker.modules.mjs`. Read that list before adding one more.

A module may set `setup: true` to load `src/test-setup.ts` (needed by anything tested through the global Tauri IPC mock). It is per-module and not the default: it roughly quadruples the per-mutant test-run cost, which is most of what the rejected list is about.

`#3350` also adds a **diff-scoped per-PR lane** (`.github/workflows/mutation-pr.yml`). `scripts/select-mutation-modules.mjs` maps the PR's diff onto the enrolled modules, the lane mutates only those (capped, so a repo-wide rename cannot turn it into the full sweep), and posts one sticky, non-blocking PR comment. It is not a required check and must never become one: equivalent mutants are undecidable in general and can never be killed, so a mutation gate carries permanent unactionable red. Its purpose is attribution — a survivor reported on the PR that caused it, while the author is still in context — not enforcement. Most PRs select nothing and the lane does nothing.

This is a **nightly-only, non-gating** lane (`mutants-frontend` job in `.github/workflows/scheduled-deep-checks.yml`) — surviving mutants are triage signal for occasional audits, not a merge gate. See issue #886 for the full evaluation and rationale.

Non-gating on *score* is not the same as unable to fail. `#3330` — the lane runs `npm run mutation || true`, so a total Stryker crash or a module that silently dropped out used to be indistinguishable from a perfect run. The `Lane-liveness guard` step (`scripts/check-mutation-reports.mjs`, deliberately outside the `|| true`, mirroring the Rust lane's `Zero-coverage guard`) now fails the job when the reports directory is missing, when any module in `stryker.modules.mjs` produced no/invalid `mutation.json`, or when the total mutant count is zero. Complementing it, `scripts/check-stryker-modules.mjs` (pre-commit hook `stryker-modules-paths`, plus `src/__tests__/check-stryker-modules.test.ts` in the gating suite) fails when a path declared in `stryker.modules.mjs` no longer exists — a moved source file used to quietly turn a module into a `_no report_` row, and a test file that was never wired into `tests[]` made the lane re-report already-killed mutants as survivors (#3142: 78 reported, 22 real). Since `#3350` the same guard also rejects an unrecognised key in a module entry (a misspelled `setup` fails open, so the module quietly runs without its setup file) and asserts that every enrolled path is matched by the per-PR lane's `on.pull_request.paths` filter — a module enrolled under a tree that filter does not name would make the diff-scoped lane silently never fire, with no failing job and no run to inspect.

## Pre-commit & CI

```bash
prek run --all-files     # every hook (slow; the full gate)
prek run                 # only staged-file hooks (pre-commit)
```

The `prek.toml` file is the single source of truth for hooks. CI invokes the same `_validate.yml` reusable workflow, but a green local prek run does **not** imply a green CI `validate-all`: local checks are range-scoped to the commits you're pushing (see below), while CI's `vitest`, `playwright`, and `cargo-tests` jobs run the *full* (non-range-scoped) vitest, Playwright, and `cargo nextest` suites over the whole tree, and the `lint` job runs `cargo clippy --workspace --all-targets -- -D warnings` on any backend change (staged `pre-push` locally, so it never runs on a local `git commit` at all). Treat a green local push as "no local regression in what I touched," not as a CI guarantee.

### Pre-commit vs pre-push split

Pre-commit (every `git commit`): fast hooks only, staged-file-scoped — oxlint, oxfmt, tsc, cargo fmt (auto-fix), markdownlint, md-link-targets, doc-vs-code-paths, zizmor, sqruff, taplo, typos, snapshot redaction, IPC error-path, axe-presence, and so on. Per-commit overhead stays sub-30 s on a warm cache.

**`vitest`, `cargo-test` (nextest), `cargo-clippy`, `cargo-fmt --check`, `knip`, `npm-audit`, and `lychee` are staged `pre-push` in `prek.toml`, not pre-commit** — they're either too slow (clippy compiles the whole workspace + all targets; nextest falls back to the full suite on a foundational-module touch), too whole-repo (knip is a whole-repo dead-code scan), or too network-dependent (lychee, npm-audit hit external endpoints) for the commit path. `cargo-fmt --check` is the odd one out: it's a read-only backstop re-verification for the case where the pre-commit `cargo-fmt` auto-fixer was bypassed (`--no-verify`, or hooks not yet installed). All of these run once at push time, inside the chokepoint hook below.

Pre-push (every `git push`): one chokepoint hook — `verify-ci-equivalent` — that runs [`scripts/verify-ci-equivalent.sh`](../scripts/verify-ci-equivalent.sh). Unlike CI, it is **range-scoped** to the commits being pushed (`@{upstream}..HEAD`, override with `PRE_PUSH_RANGE`) and runs its phases sequentially, not in parallel:

| Phase | What runs | Scope |
| --- | --- | --- |
| A | `prek run --all-files --hook-stage pre-commit`, category-aware `SKIP` | Whole tree, but only the categories (frontend/backend/CI/docs) present in the push range |
| — | `check-migrations-immutable.sh --range` backstop | Push range |
| B | externalBin placeholder | Only if Rust changed |
| C | `vitest related` (`test-related-ts.sh --range`) | Push range |
| D | `cargo nextest related` (`test-related-rust.sh --range`) | Push range; only if Rust changed |
| D2 | `cargo test --doc --workspace` | Only if Rust changed |
| E | `cargo sqlx prepare --check`, all 4 lanes (root + `agaric-store`/`agaric-engine`/`agaric-sync`) | Only if Rust changed |
| F | `agaric-mcp` release build + MCP UDS smoke + externalBin verify | Only if MCP paths changed |
| G | `cargo audit` + `npm audit signatures` (warn-only, never blocks) | Always |

**Playwright is deliberately skipped locally** — CI still runs the full e2e suite on every PR; run `npx playwright test` by hand first if you've touched anything interaction-heavy. The full (non-range-scoped) `vitest run` / `cargo nextest run --workspace --profile ci`, and the desktop bundle build, are likewise CI/manual-only — see [Release pre-flight](#release-pre-flight) for the bundle build.

**Push with `just push` (or [`scripts/push.sh`](../scripts/push.sh)), not raw `git push`, for anything that changes `.rs`.** Because the verify runs *inside* the pre-push hook — which fires only after `git push` has already opened and is holding the SSH connection — a several-minute verify leaves that connection idle long enough for GitHub to close it, and the pack upload then fails (`Connection to github.com closed by remote host` / `failed to push some refs`) even though the gate passed in full. `just push` / `scripts/push.sh` runs the verifier *first*, then invokes `git push` with the hook short-circuited, so the freshly opened connection uploads immediately. It forwards all `git push` args (`just push -- -u origin my-branch`, `just push -- --force-with-lease`).

`SKIP_CI_VERIFY='<reason>' git push` short-circuits the script. The value must be a real reason (≥8 chars), NOT a truthy flag — a bare `SKIP_CI_VERIFY=1` (or `true`/`yes`/`on`/…) is hard-rejected. Use e.g. `SKIP_CI_VERIFY='docs typo, no source change' git push`. Reserve it for docs-only typo fixes that obviously cannot affect CI behaviour; anything that touches source code should let the verifier run.

### Release pre-flight

Pre-push does NOT run `cargo tauri build` (5-10 min wall clock per push is too slow for daily cadence). `scripts/release.sh` (see [Releasing](#releasing) below) runs this check for you, but you can also run it standalone:

```bash
scripts/verify-release-build.sh                   # local-OS bundle build + path probes
```

The script does what release.yml does that `_validate.yml` does not: full Tauri bundle build for the current OS, with per-OS artifact path probes (AppImage + .deb on Linux, .dmg + .app on macOS, .msi + .exe on Windows). Cross-OS bundles are inherently un-buildable locally — only the matching CI matrix slot can verify them, but most release-blocker bugs surface in the LOCAL bundle build first.

## Production builds

```bash
cargo tauri build                              # current platform
cargo tauri build --target x86_64-apple-darwin # explicit target
cargo tauri android build                      # Android APK/AAB
```

Bundles land under `src-tauri/target/release/bundle/`. The exact filenames carry the current version from `tauri.conf.json`; cross-check there if you need to script asset upload.

**No cross-compilation.** Each platform builds natively because of the native webview. Linux artifacts produced on Linux, macOS on macOS, etc.

**AppImage icon fix (Linux):** the AppImage bundle's icon mapping is brittle. After `cargo tauri build`, run `scripts/fix-appimage-icons.sh` to repair `.DirIcon` so file managers display the icon. Set `FIX_APPIMAGE_STRICT=1` to fail the build on a missing icon (CI does this).

## Releasing

One command, from a clean `main`:

```bash
scripts/release.sh <new-version>          # e.g. scripts/release.sh 0.2.1
```

`scripts/release.sh` is the single canonical entry point. It:

1. **Preflight** — refuses unless the tree is clean, `HEAD` is on `main`, local `main` is in sync with `origin/main`, the required tools are present, and the tag doesn't already exist (locally or on origin).
2. **Local build check** — runs `scripts/verify-release-build.sh` (full `cargo tauri build` + bundle-path probes for your OS) so release-only failures surface before a CI run is spent. Skip with `--skip-verify-build`.
3. **Bump + tag + push** — runs `scripts/bump-version.sh` to bump all 5 manifests in lockstep (`package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json`), GPG-sign the commit + annotated tag, and push `main` + the tag.
4. The pushed tag triggers `.github/workflows/release.yml`, which builds every platform, attaches the artifacts to a **draft** GitHub Release, and — only if every terminal job succeeded — publishes it in a final `publish-release` job. A partial or failed release stays a draft for you to inspect on the [Releases page](https://github.com/jfolcini/agaric/releases).

Useful flags (see `scripts/release.sh --help`):

- `--dry-run` — bump + commit + tag locally but don't push (review with `git show <tag>`).
- `--skip-verify-build` — skip the ~5-10 min local bundle build (rely on CI).
- `-y` / `--yes` — skip the confirmation prompt.

> **Why local, and why there's no CI "release" button.** Cutting a release means pushing a bump commit to `main`, which requires bypassing the branch ruleset. The in-workflow `GITHUB_TOKEN` is not a ruleset bypass actor (and its pushes don't trigger workflows anyway), so a CI bump can't land without a long-lived PAT — rejected on security grounds. The maintainer is an admin bypass actor, so the bump is cut locally and only the resulting tag triggers CI. This keeps branch protection intact (1 review + admin bypass) with no PAT. `scripts/bump-version.sh <version> --commit --tag --push` is still available if you want to drive the steps yourself.

### What `release.yml` does on tag push

1. **`verify-version`** — fail-fast if the tag's version doesn't match the manifests (it's the first job; the bump already happened locally).
2. **`validate`** — same gate as CI (`prek run --all-files`).
3. **`build-and-release`** — Linux + Windows + macOS (x86_64 + aarch64) desktop bundles, uploaded to a draft Release created up front. Per-platform steps also `cargo tauri signer sign` the updater payloads, in isolated steps whose env holds only the signing secret.
4. **`android-build-and-release`** — APK if release-signing secrets are present.
5. **Provenance + SBOMs** — each artifact gets a Sigstore bundle (`*.sigstore.json` — signature) and an in-toto SLSA statement (`*.intoto.jsonl` — provenance, what OpenSSF Scorecard's Signed-Releases provenance probe matches), plus SPDX + CycloneDX SBOMs and a signed OpenVEX document (`generate-vex`).
6. **`generate-latest-json`** — re-verifies every updater `.sig` with `minisign` against the pubkey pinned in `tauri.conf.json` (#2971), then stitches the `latest.json` the in-app updater fetches.
7. **`publish-release`** — flips the draft to published and marks it Latest, gated on *every* terminal job above reporting success.

### If a release tag fails at `verify-version`

The manifests are out of sync with the tag. To recover:

```bash
git tag -d <bad-tag>                          # local
git push --delete origin <bad-tag>            # remote
scripts/release.sh <correct-version>          # re-cut cleanly
```

## Android release signing

The `android-build-and-release` job in `.github/workflows/release.yml` builds the aarch64 release APK and signs it with a keystore stored in GitHub Secrets. Local builds produce unsigned APKs by default; if the secrets are absent in CI, the job stages the APK as `agaric-<tag>-android-aarch64-unsigned.apk` so the pipeline keeps working before a keystore is provisioned.

### Generate the keystore (one-time)

The signing keystore is **not** stored in the repo — it lives only in GitHub Secrets (base64-encoded) and in the maintainer's offline backup. Generate it once with `keytool`:

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore agaric-release.keystore \
  -alias agaric-release -keyalg RSA -keysize 4096 -validity 10000
```

**Critical:** back up the keystore offline. Losing it means losing the ability to publish updates for the existing app ID.

### Required CI secrets

Four secrets must be set under repo Settings → Secrets and variables → Actions. The `Sign Android APK` step reads all four:

| Secret | Holds |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | the PKCS12 keystore, base64-encoded (`base64 -w 0 < agaric-release.keystore`); CI decodes it with `base64 -d` into a temp `release.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password (passed as `--ks-pass env:…`) |
| `ANDROID_KEY_ALIAS` | the key alias (`agaric-release` above) |
| `ANDROID_KEY_PASSWORD` | the key password, often the same as the keystore password (passed as `--key-pass env:…`) |

When `ANDROID_KEYSTORE_BASE64` is present, CI decodes the keystore, runs `zipalign -p -f 4`, then `apksigner sign` (APK signing scheme v2/v3 + v4 idsig), verifies with `apksigner verify`, and `shred`s the decoded `.jks`. When it is absent, the APK ships unsigned (see above).

### Sign an APK locally for testing

Mirror the CI flow with the build-tools binaries:

```bash
BUILD_TOOLS="$ANDROID_HOME/build-tools/<latest>"
"$BUILD_TOOLS/zipalign" -p -f 4 app-universal-release-unsigned.apk aligned.apk
"$BUILD_TOOLS/apksigner" sign \
  --ks agaric-release.keystore \
  --ks-key-alias agaric-release \
  --out signed.apk aligned.apk
"$BUILD_TOOLS/apksigner" verify --verbose signed.apk
```

### Distribution / Play Store

There is **no Play Store upload step** in the release pipeline. The `android-build-and-release` job attaches the signed APK (plus its SBOMs and SLSA provenance) to the GitHub Release via `gh release upload` — that is the only automated distribution. Publishing to the Play Store, if and when wired, is a manual/follow-up step; see `.github/workflows/release.yml`.

## Signing posture

- **Updater signing**: active. `bundle.createUpdaterArtifacts` stays unset in `tauri.conf.json`; instead `release.yml` signs each platform's updater payload with `cargo tauri signer sign` in a dedicated step whose env holds only the `TAURI_SIGNING_PRIVATE_KEY` secret, then re-verifies every `.sig` with `minisign` against the `plugins.updater.pubkey` pinned in `tauri.conf.json` before stitching `latest.json` (#2971) — so a rotated-but-unsynced key reddens the release instead of silently breaking auto-update on installed clients. Key-rotation procedure (cadence, revocation, user notification): [`../SECURITY.md`](../SECURITY.md#updater-signing-key-rotation) § "Updater signing-key rotation".
- **Desktop code signing**: not enabled. macOS bundles trip Gatekeeper's first-launch warning (right-click → *Open*); Windows bundles trip SmartScreen (*More info* → *Run anyway*). User-facing install steps live in the [README § Install](../README.md#install).
- **Linux** `.deb` / `.AppImage`: intentionally not signed.

## sqlx compile-time queries

```bash
just gen-sqlx
```

Run after touching any `sqlx::query!` / `sqlx::query_as!` call. Commit the regenerated `.sqlx/` caches alongside the Rust changes; a stale cache is caught by pre-push Phase E and by CI's `sqlx-offline-check` lanes (root plus each member crate that holds query macros). `just gen-sqlx` regenerates all of them: first the workspace-wide `cargo sqlx prepare --workspace -- --workspace --tests` at the root (the second `--workspace`, passed to *cargo* after the `--`, is what captures leaf crates nothing depends on — a bare `cargo sqlx prepare` silently drops them and reddens CI's offline `clippy --workspace`), then one crate-local pass per member crate against a throwaway migrated DB.

## TypeScript bindings (specta)

```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

Run after touching any `#[tauri::command]` signature or any `specta::Type` derive. Commit the regenerated `src/lib/bindings.ts` alongside the Rust change. CI fails on drift via the `ts_bindings_up_to_date` Rust test, part of the `cargo nextest run` suite (not a standalone prek hook).

## Troubleshooting

- **Android: stale database crashes on launch.** Wipe and re-install: `adb shell pm clear com.agaric.app`.
- **Android: release APK won't install.** Likely a signing mismatch — uninstall the previous build first (signatures from different keystores conflict).
- **Rust compilation errors after SQL changes.** Run `just gen-sqlx` and commit the cache.
- **TypeScript errors after Rust type changes.** Run `cargo test -- specta_tests --ignored` and commit `src/lib/bindings.ts`.
- **WebView not found (Linux).** `libwebkit2gtk-4.1-dev` must be installed; older `4.0` won't work. Missing WebKit/GTK development headers block compiling and testing the Rust workspace, not only launching the Tauri app. On a disposable Debian/Ubuntu VM, run `bash scripts/setup.sh --install-system-deps`; local setup intentionally leaves privileged package installation to you.
- **Slow first build.** Cold compile of the Tauri + sqlx + Loro stack takes minutes. Subsequent incremental builds are seconds.
