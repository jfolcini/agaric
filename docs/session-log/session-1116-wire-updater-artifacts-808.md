# Session 1116 — wire up in-app auto-updater production side (#808)

## Problem

Agaric's in-app auto-updater was half-built. The **consumption** side was fully
wired and shipping: `plugins.updater` endpoint + minisign pubkey in
`tauri.conf.json`, `tauri-plugin-updater` registered in `lib.rs` behind
`#[cfg(not(mobile))]`, the `updater:default` capability, and the frontend
`useUpdateCheck` hook (24h boot check + manual "check now"). But the
**production** side was dead: `bundle.createUpdaterArtifacts` is false, so the
release pipeline never produced `latest.json` or the per-platform `.sig`
signatures the installed app polls for. Every installed app's update check
**404s forever** on `releases/latest/download/latest.json` (verified against the
real 0.4.0 release asset list). The SLSA attestation comment even claimed
updater payloads shipped attested, but its globs matched nothing.

## Approach — sign out-of-band, fan-in a manifest

Per #808 and the existing `release.yml:271-279` note, `createUpdaterArtifacts`
stays **false** so `TAURI_SIGNING_PRIVATE_KEY` never reaches `cargo tauri build`
/ the JS env (#815). Instead the already-built bundles are signed out-of-band in
dedicated steps whose env holds **only** the two `TAURI_SIGNING_*` secrets, via
the lockfile-pinned `npm run tauri -- signer sign`. Each `.sig` is uploaded in a
**separate** step with `GITHUB_TOKEN`-only env, so each secret lives in exactly
one step.

Per-platform updater payloads (Tauri 2 default mode):

- **Linux** `linux-x86_64` — the raw repacked `.AppImage` (signed AFTER the
  existing icon-repack-and-clobber, so the signature matches the shipped file).
- **Windows** `windows-x86_64` — the raw NSIS `-setup.exe`.
- **macOS** `darwin-x86_64` / `darwin-aarch64` — a `.app.tar.gz` built in-step
  (`createUpdaterArtifacts=false` means the bundler doesn't produce one), named
  with an explicit arch token (`Agaric_<ver>_<arch>.app.tar.gz`) so the two
  `macos-15` cells never collide on a single asset.

A new fan-in job **`generate-latest-json`** (`needs` the desktop matrix; before
`finalize-release-notes`) downloads the four `.sig` assets, maps each to its
Tauri platform key by basename, stitches them into `latest.json` (version =
tag stripped of `v`, deterministic URLs from the release), uploads it
`--clobber`, then **smoke-asserts** the draft carries `latest.json` + ≥4 `.sig`
assets, `version == tag`, and all four platform entries have non-empty
signature+url. (The public endpoint only resolves post-publish, so the check
reads the draft assets directly.)

Also fixed the now-accurate SLSA attestation: rewrote the false comment and
dropped the dead `*.AppImage.tar.gz` / `*.msi.zip` / `*.exe.zip` subject-path
globs; the macOS `*.app.tar.gz` glob is now valid (we build that tarball).

## Verification

- Static: `python3 yaml.safe_load` OK; `prek run --files .github/workflows/release.yml`
  passed (incl. `zizmor` Actions security lint).
- End-to-end / runtime are maintainer-gated (require a real tag + signing
  secrets): cut a test tag, confirm the draft carries `latest.json` + 4 `.sig`,
  smoke-assert passes, then install an older build and confirm in-app update +
  Install & restart on each OS — the only way to confirm the hand-built macOS
  `.app.tar.gz` is layout-compatible with the updater's unpack.

## Residual maintainer items (flagged in PR)

1. Confirm real produced filenames match the case/glob arms on first run.
2. Confirm the macOS hand-built `.app.tar.gz` updates correctly at runtime
   (fallback: macOS-only key-isolated `createUpdaterArtifacts` rebuild).
3. Key-match (stored `TAURI_SIGNING_PRIVATE_KEY` vs configured pubkey) —
   maintainer verifies out-of-band.

Closes #808.
