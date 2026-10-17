# Session 2312 — The zip advisories leave by dropping a feature we never used

Every PR touching Rust started failing `cargo deny`. It reported three new
RustSec advisories against `zip` 4.6.1:
- RUSTSEC-2026-0367: SUID and SGID bits preserved on extraction;
- RUSTSEC-2026-0368: `extract` creating symlinks outside the destination;
- a third: permissions applied through symlinks.

All three are fixed in `zip` 9. The crate arrives only through
`tauri-plugin-updater` 2.13.1.

**No upgrade path.** Every released updater (2.13.2, 2.13.3, 2.14.0,
3.0.0-alpha.3) still requires `zip = "^4"`.

**What the feature does** (`tauri-plugin-updater-2.13.1/src/updater.rs`).
`zip` is used only on Windows, in `extract_zip`, behind the default `zip`
feature, which also enables `tar` and `flate2` for Linux's
`.AppImage.tar.gz` branch. macOS declares its own `tar` and `flate2`, not
behind the feature. `download()` checks the minisign signature before
`install()` sees any bytes. Agaric's release ships raw bundles (`-setup.exe`,
`.msi`, `.AppImage`, `.app.tar.gz`; `createUpdaterArtifacts` stays off), so
the zipped formats and their unpacking were dead code for us.

**Fix.** `tauri-plugin-updater` takes `default-features = false` with
`rustls-tls` and `system-proxy`, the rest of the default set. `zip` leaves
both lockfiles, and `cargo deny` reports `advisories ok`. Putting the old
manifest and lock back reds it on all three advisories. The version floor
moves to 2.11.0, where `system-proxy` first appears; the lock stays on
2.13.1.

**Not compiled for Windows.** PR CI never builds Windows, and a cross
`cargo check` stops at `ring`'s and `aws-lc-sys`'s C builds. Reading the
source shows every Windows use of `zip` (`extract`, `extract_zip`, the
`Extract` error variant) behind `cfg(feature = "zip")`, so the
featureless build is a configuration upstream supports. The first Windows
compile will be the release build.

Gates: `cargo deny check`; `cargo tree -i zip --target all` (none);
`SQLX_OFFLINE=true cargo check --workspace --all-targets`; clippy;
`cargo metadata --locked` for the main and fuzz locks; prek on the changed
files.
