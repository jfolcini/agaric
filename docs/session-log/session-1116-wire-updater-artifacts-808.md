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
- **macOS** `darwin-x86_64` / `darwin-aarch64` — the bundler's own
  `Agaric_<arch>.app.tar.gz` (arch = `x64` | `aarch64`), signed in place. The
  macOS bundler already emits this tarball even with `createUpdaterArtifacts`
  false (verified against the real 0.6.6 assets); it just never got a `.sig`. We
  sign Tauri's canonical archive rather than re-rolling our own — no duplicate
  asset, and the unpack layout is guaranteed correct.

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

## Verified before merge (the three residual items)

1. **Filenames vs glob/case arms** — checked against the real published 0.6.6
   release: `Agaric_0.6.6_amd64.AppImage`, `Agaric_0.6.6_x64-setup.exe`,
   `Agaric_x64.app.tar.gz`, `Agaric_aarch64.app.tar.gz`. All four sign-globs and
   fan-in `case` arms match. This is what surfaced the macOS correction above
   (Tauri already ships the tarball; we sign it, not rebuild it).
2. **Updater format** — by signing Tauri's own canonical artifacts (raw
   `.AppImage`, raw NSIS `-setup.exe`, bundler `.app.tar.gz`) the archive layout
   is exactly what `tauri-plugin-updater` expects, so the old "hand-built
   tarball compatibility" risk is gone. A true 3-OS install→update run still
   needs real hardware + a published release; only that confirms end-to-end.
3. **Key-match** — the local keypair at `~/.tauri/agaric.key{,.pub}` (created
   2026-05-15, same date the GH secret was created) has a `.pub` whose contents
   are **byte-identical** to `plugins.updater.pubkey` in `tauri.conf.json` (key
   ID `639CE70BB786855A`). The encrypted private key is its generated
   counterpart. Definitive sign+verify needs the key password (a GH secret not
   present locally), so that final step stays maintainer-owned.

Closes #808.
