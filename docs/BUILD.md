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

### Faster linker (Linux only)

`mold` cuts the link step on Linux ~3-4×. Activation is one apt install + one copy:

```sh
sudo apt install mold        # Debian/Ubuntu (mold has been in main since 22.04)
cp .cargo/config.toml.example .cargo/config.toml
```

After activation, incremental `cargo build --bin agaric-mcp` after touching a single Rust file lands in ~12 s instead of ~30-40 s on this codebase (228 Rust files, ~200K LOC). Safe to delete `.cargo/config.toml` any time — it only affects the linker pick on Linux.

The `.example` file ships staged so a fresh clone doesn't break on contributors who haven't installed mold yet (an unconditional `[target.…] rustflags` would fail every build with a confusing `cannot find -fuse-ld=mold` error).

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
- **Bench gates**: `interactive_slo` enforces the product SLO of ≤200 ms p95 for interactive commands at 100K blocks. Per-command budgets live in the bench itself.

## Pre-commit & CI

```bash
prek run --all-files     # every hook (slow; the full gate)
prek run                 # only staged-file hooks (pre-commit)
```

The `prek.toml` file is the single source of truth for hooks. CI invokes the same `_validate.yml` reusable workflow that mirrors `prek run --all-files`, so a green local prek implies a green CI validate job.

### Pre-commit vs pre-push split

Pre-commit (every `git commit`): fast hooks only — biome, tsc, cargo fmt/clippy, vitest related-subset, cargo-test related-subset, lychee, sqruff, taplo, typos, zizmor, markdownlint, snapshot redaction, IPC error-path, axe-presence, and so on. Per-commit overhead stays sub-30 s on a warm cache.

Pre-push (every `git push`): one chokepoint hook — `verify-ci-equivalent` — that runs `scripts/verify-ci-equivalent.sh`. The script parallelizes every blocking check that `.github/workflows/_validate.yml` runs in CI:

| Phase | Checks (run in parallel) |
| --- | --- |
| Phase 1 | externalBin placeholder (1 s, prerequisite for Phase 2) |
| Phase 2 (parallel) | vitest (full, ≈70 s) ‖ playwright (full, ≈80 s) ‖ cargo nextest --profile ci + agaric-mcp build + sqlx prepare --check |
| Phase 3 (sequential) | MCP UDS smoke test, full release build of agaric-mcp, externalBin artifact verification |
| Phase 4 (warn-only) | cargo audit, npm audit signatures — surface warnings but never block |

Wall clock on a warm cache: ≈3-4 min (was ≈5-8 min when each hook ran sequentially via prek's per-hook scheduler).

`SKIP_CI_VERIFY=1 git push` short-circuits the script. Reserve it for docs-only typo fixes that obviously cannot affect CI behaviour; anything that touches source code should let the verifier run.

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

## Android signing

The Android release pipeline signs APKs and AABs with a keystore stored in GitHub Secrets. Local builds produce unsigned debug APKs by default.

**Generate a keystore (one-time):**

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore agaric-release.keystore \
  -alias agaric-release -keyalg RSA -keysize 4096 -validity 10000
```

Set four GitHub Secrets:

| Secret | Value |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `base64 -w 0 < agaric-release.keystore` |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | the alias (`agaric-release` above) |
| `ANDROID_KEY_PASSWORD` | the key password (often same as keystore password) |

**Critical:** back up the keystore. Losing it means losing the ability to publish updates for the existing app ID.

Sign a local release APK:

```bash
$ANDROID_HOME/build-tools/<latest>/apksigner sign \
  --ks agaric-release.keystore \
  --ks-key-alias agaric-release \
  --out signed.apk unsigned.apk
```

## Signing posture

- **Updater signing**: enabled. Minisign-signed update manifests via `TAURI_SIGNING_PRIVATE_KEY` (CI secret). The desktop bundles ship with the matching public key. Rotation procedure (cadence, revocation, user notification): see [`../SECURITY.md`](../SECURITY.md#updater-signing-key-rotation) § "Updater signing-key rotation".
- **Desktop code signing**: not enabled. macOS bundles trip Gatekeeper's first-launch warning (right-click → *Open*); Windows bundles trip SmartScreen (*More info* → *Run anyway*). User-facing install steps live in the README install section.
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
