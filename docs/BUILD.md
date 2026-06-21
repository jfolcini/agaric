<!-- markdownlint-disable MD060 -->
# Build & Release

Everything you need to build, test, and release Agaric. Self-contained.

## TL;DR

```bash
npm ci                                   # frontend deps
cp src-tauri/.env.example src-tauri/.env # sqlx DATABASE_URL
node scripts/prepare-external-bins.mjs --placeholder-only  # sidecar placeholder
cargo tauri dev                          # run the app
prek run --all-files                     # run every CI gate locally
```

First-time setup is automated by `bash scripts/setup.sh` (wraps the steps above).

Tests: `npx vitest run` (frontend), `cd src-tauri && cargo nextest run` (backend), `npx playwright test` (e2e), `cargo bench --bench interactive_slo` (perf SLO).

## After-clone setup

Three steps before `cargo tauri dev` works on a fresh clone:

1. `npm ci` — frontend deps.
2. `cp src-tauri/.env.example src-tauri/.env` — sqlx reads `DATABASE_URL` from here at compile time (offline mode uses `.sqlx/` cache, but the env file must exist).
3. `node scripts/prepare-external-bins.mjs --placeholder-only` — creates a placeholder `agaric-mcp` sidecar binary so the Tauri builder doesn't error on the first build. The real sidecar is produced later by `cargo build --bin agaric-mcp`; this is just for the chicken-and-egg first compile.

## Prerequisites by platform

### Linux

Install what CI installs (`.github/workflows/_validate.yml` is authoritative):

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
  librsvg2-dev libappindicator3-dev patchelf \
  build-essential curl wget file
```

Plus Rust (`rustup default stable`), Node 24 LTS (see `.nvmrc`), and Tauri's CLI: `cargo install tauri-cli --locked`.

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

The [`prek`](https://github.com/j178/prek) hooks shell out to host-installed binaries. Nothing installs them automatically, so a fresh contributor who runs the hooks otherwise hits hook-by-hook `command not found`. Install them up front:

```sh
# Cargo-installable tools (cross-platform)
cargo install --locked prek          # the hook runner itself
cargo install --locked cargo-nextest # backend test runner
cargo install lychee                 # markdown link checker
cargo install --locked typos-cli     # spell checker
cargo install --locked zizmor        # GitHub Actions auditor
cargo install --locked taplo-cli     # TOML lint + format
cargo install sqruff                 # SQLite migration linter
cargo install cargo-deny             # advisories + licenses + bans
cargo install cargo-machete          # unused-dependency detector

# System package (no cargo crate)
sudo apt install shellcheck          # shell-script linter (or `brew install shellcheck`)
```

`prek.toml` is the source of truth — each hook's exact `entry` and any install hint live there, so re-check it if a command above ever drifts. `mold` (see [Speed up Rust builds](#speed-up-rust-builds-linux-only-optional)) is an optional Linux linker, not a hook binary.

These local hooks are **optional**: if you cannot install them, open your PR anyway — CI runs the same gate via `.github/workflows/_validate.yml` (see [`CONTRIBUTING.md`](../CONTRIBUTING.md#bootstrap)).

### Optional: code-review navigation graph

`.mcp.json` wires an optional MCP server, **code-review-graph**, that exposes a symbol/dependency graph for fast, structural code navigation (used in place of ad-hoc `grep`/file-reads when it is available). It is launched on demand via [`uv`](https://docs.astral.sh/uv/)'s `uvx` runner:

```jsonc
// .mcp.json
"code-review-graph": { "command": "uvx", "args": ["code-review-graph", "serve"] }
```

To enable it, install `uv` (which provides `uvx`), then let `uvx` fetch the `code-review-graph` package from PyPI on first run:

```sh
# Install uv (provides the `uvx` runner) — see https://docs.astral.sh/uv/getting-started/installation/
curl -LsSf https://astral.sh/uv/install.sh | sh   # macOS/Linux
# or: brew install uv  /  pipx install uv

# Verify uvx can resolve and launch the server (downloads the package on first run):
uvx code-review-graph --help
```

This is **entirely optional** — it is a navigation aid for contributors using an MCP-capable client, not a build or test prerequisite. If `uvx`/the package is not installed, the MCP server simply does not start and nothing else is affected.

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

### Speed up Rust builds (Linux only, optional)

The link step is the long pole of incremental Rust compiles on this codebase, not codegen. The [`mold`](https://github.com/rui314/mold) linker cuts it dramatically. Activation is one install + one copy:

```sh
sudo apt install mold        # Debian/Ubuntu (mold has been in main since 22.04)
cp .cargo/config.toml.example .cargo/config.toml
```

After activation, an incremental `cargo check` after touching a single Rust file drops from ~20 s to ~7-10 s (~60% faster; measured 2026-05-16 on this project — 200K LOC across 228 files).

`mold` must be installed separately — it is not bundled. Without it, `gcc`/`clang`'s `-fuse-ld=mold` errors with a clear `cannot find -fuse-ld=mold` rather than failing silently.

The active `.cargo/config.toml` is gitignored, so it never leaks into the tree — only the `.example` is tracked. This keeps a fresh clone from breaking on contributors who haven't installed mold yet (an unconditional `[target.…] rustflags` would fail every build). It is **Linux-only**: leave it untouched on macOS/Windows. Safe to delete any time — it only affects the linker pick on Linux.

## Testing

```bash
npx vitest run                                   # frontend
cd src-tauri && cargo nextest run                # backend
npx playwright test                              # e2e (chromium)
cargo bench --bench interactive_slo              # perf SLOs at 100K blocks
```

- **Frontend** tests use Vitest + jsdom + `@testing-library/react`. Every component test must include an `axe(container)` audit (enforced by the `axe-presence` prek hook).
- **Backend** tests use `cargo-nextest` with insta snapshots. Materializer tests use the `test_pool()` + `TempDir` fixture; multi-thread runtime is `#[tokio::test(flavor = "multi_thread", worker_threads = 2)]`. Snapshot updates: `cargo insta review`.
- **E2E** specs cover smoke flows, editor lifecycle, keyboard navigation, sync round-trip, and view dispatches. Specs live in `e2e/`.
- **Bench gates**: `interactive_slo` enforces the product SLO of ≤200 ms p95 for interactive commands at 100K blocks. Per-command budgets live in the bench itself. The scheduled `bench-compile` lane also **smoke-runs every bench once** (`--test`) so a drifted seed/fixture fails CI instead of rotting silently (#978 — validates fixtures, not perf). To reproduce locally before pushing, build once (`cd src-tauri && cargo bench --no-run`) then run each prebuilt `target/release/deps/<bench>-<hash> --test`; the exact loop and the cargo #6313 build-race it dodges are in `src-tauri/benches/AGENTS.md`.

## Pre-commit & CI

```bash
prek run --all-files     # every hook (slow; the full gate)
prek run                 # only staged-file hooks (pre-commit)
```

The `prek.toml` file is the single source of truth for hooks. CI invokes the same `_validate.yml` reusable workflow that mirrors `prek run --all-files`, so a green local prek implies a green CI validate job.

### Pre-commit vs pre-push split

Pre-commit (every `git commit`): fast hooks only — oxlint, oxfmt, tsc, cargo fmt/clippy, vitest related-subset, cargo-test related-subset, lychee, sqruff, taplo, typos, zizmor, markdownlint, snapshot redaction, IPC error-path, axe-presence, and so on. Per-commit overhead stays sub-30 s on a warm cache.

Pre-push (every `git push`): one chokepoint hook — `verify-ci-equivalent` — that runs `scripts/verify-ci-equivalent.sh`. The script parallelizes every blocking check that `.github/workflows/_validate.yml` runs in CI:

| Phase | Checks (run in parallel) |
| --- | --- |
| Phase 1 | externalBin placeholder (1 s, prerequisite for Phase 2) |
| Phase 2 (parallel) | vitest (full, ≈70 s) ‖ playwright (full, ≈80 s) ‖ cargo nextest --profile ci + agaric-mcp build + sqlx prepare --check |
| Phase 3 (sequential) | MCP UDS smoke test, full release build of agaric-mcp, externalBin artifact verification |
| Phase 4 (warn-only) | cargo audit, npm audit signatures — surface warnings but never block |

Wall clock on a warm cache: ≈3-4 min (was ≈5-8 min when each hook ran sequentially via prek's per-hook scheduler).

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
4. The pushed tag triggers `.github/workflows/release.yml`, which builds every platform and **drafts** the GitHub Release.

Then **review the draft on the [Releases page](https://github.com/jfolcini/agaric/releases) and click Publish** — the workflow drafts, it never auto-publishes.

Useful flags (see `scripts/release.sh --help`):

- `--dry-run` — bump + commit + tag locally but don't push (review with `git show <tag>`).
- `--skip-verify-build` — skip the ~5-10 min local bundle build (rely on CI).
- `-y` / `--yes` — skip the confirmation prompt.

> **Why local, and why there's no CI "release" button.** Cutting a release means pushing a bump commit to `main`, which requires bypassing the branch ruleset. The in-workflow `GITHUB_TOKEN` is not a ruleset bypass actor (and its pushes don't trigger workflows anyway), so a CI bump can't land without a long-lived PAT — rejected on security grounds. The maintainer is an admin bypass actor, so the bump is cut locally and only the resulting tag triggers CI. This keeps branch protection intact (1 review + admin bypass) with no PAT. `scripts/bump-version.sh <version> --commit --tag --push` is still available if you want to drive the steps yourself.

### What `release.yml` does on tag push

1. **`verify-version`** — fail-fast if the tag's version doesn't match the manifests (it's the first job; the bump already happened locally).
2. **`validate`** — same gate as CI (`prek run --all-files`).
3. **Build matrix** — Linux + Windows + macOS (x86_64 + aarch64) desktop bundles.
4. **Android** — APK if release-signing secrets are present.
5. **Provenance + SBOMs** — each artifact gets a Sigstore bundle (`*.sigstore.json` — signature) and an in-toto SLSA statement (`*.intoto.jsonl` — provenance, what OpenSSF Scorecard's Signed-Releases provenance probe matches), plus SPDX + CycloneDX SBOMs and a signed OpenVEX document.
6. **Draft GitHub Release** — created with auto-generated notes; never auto-published.

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

- **Updater signing**: not currently active. `bundle.createUpdaterArtifacts` is unset in `tauri.conf.json`, so no updater artifacts (or minisign signatures) are produced, and the `TAURI_SIGNING_PRIVATE_KEY` CI secret is deliberately NOT exposed to the build step ([#815](https://github.com/jfolcini/agaric/issues/815)); enabling updater artifacts + a minimal signing step is tracked in [#808](https://github.com/jfolcini/agaric/issues/808). The key-rotation procedure (cadence, revocation, user notification) still applies once enabled: see [`../SECURITY.md`](../SECURITY.md#updater-signing-key-rotation) § "Updater signing-key rotation".
- **Desktop code signing**: not enabled. macOS bundles trip Gatekeeper's first-launch warning (right-click → *Open*); Windows bundles trip SmartScreen (*More info* → *Run anyway*). User-facing install steps live in the [README § Install](../README.md#install).
- **Linux** `.deb` / `.AppImage`: intentionally not signed.

## sqlx compile-time queries

```bash
cd src-tauri && cargo sqlx prepare -- --tests
```

Run after touching any `sqlx::query!` / `sqlx::query_as!` call. Commit the `.sqlx/` cache changes alongside the Rust changes; CI fails on stale cache (`sqlx-prepare-check` prek hook).

## TypeScript bindings (specta)

```bash
cd src-tauri && cargo test -- specta_tests --ignored
```

Run after touching any `#[tauri::command]` signature or any `specta::Type` derive. Commit the regenerated `src/lib/bindings.ts` alongside the Rust change. CI fails on drift (`tauri-bindings-parity` prek hook).

## Troubleshooting

- **Android: stale database crashes on launch.** Wipe and re-install: `adb shell pm clear com.agaric.app`.
- **Android: release APK won't install.** Likely a signing mismatch — uninstall the previous build first (signatures from different keystores conflict).
- **Rust compilation errors after SQL changes.** Run `cargo sqlx prepare -- --tests` and commit the cache.
- **TypeScript errors after Rust type changes.** Run `cargo test -- specta_tests --ignored` and commit `src/lib/bindings.ts`.
- **WebView not found (Linux).** `libwebkit2gtk-4.1-dev` must be installed; older `4.0` won't work.
- **Slow first build.** Cold compile of the Tauri + sqlx + Loro stack takes minutes. Subsequent incremental builds are seconds.
