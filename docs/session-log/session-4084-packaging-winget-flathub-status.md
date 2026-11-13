# Session 4084 — a winget manifest, and why the Flathub draft cannot be submitted (#6660)

The maintainer decided on 2026-11-13 to keep Flathub and add winget. The session set out to bring `packaging/flathub/` up to the 0.23.0 release and add a winget manifest, each with a release-checklist line.

## Decisions and traps

- **Flathub's requirements changed under the scaffold.** Its generative AI policy forbids AI-generated or AI-assisted content in a manifest, disclosure or not, and its build policy requires a source-available app to be built entirely from source. The draft manifest is AI-drafted and unpacks the release `.deb`. An agent rewriting it would hand the maintainer a file they may not submit, so the manifest was left as it was, marked "do not submit", and the README now says what a hand-written one has to account for and the submission steps. Whether Flathub is still worth it is the maintainer's call, put on #6660 with options.
- **Measured rather than remembered.** The draft named `agaric_<v>_amd64.deb` and `agaric.desktop`; the 0.23.0 assets are `Agaric_<v>_amd64.deb` and `Agaric.desktop`. `tauri-plugin-single-instance` claims `com.agaric.app.SingleInstance` on the session bus (read from the pinned crate's source), and on any error but "name taken" it launches normally, so a sandbox that withholds the name loses the double-launch guard.
- **winget points at the NSIS installer**, the per-user bundle the updater already defaults to. The installer registers under the publisher `agaric`, which Tauri derives from the identifier (`tauri-bundler`'s `nsis/mod.rs`), so the manifest declares it in `AppsAndFeaturesEntries`.
- `scripts/gen-winget-manifest.sh` reads the version, URL, SHA-256 and date from the published release, so the manifest is regenerated, not typed. It was shown to restore every field after each was scrambled, and to refuse a release with no digest.

## Shipped

`packaging/winget/` (three manifest files and a README), `scripts/gen-winget-manifest.sh`, `docs/BUILD.md` § After the release is published, the rewritten `packaging/flathub/README.md`, the MetaInfo file's release entry, and the two `COMPARISON-OBSIDIAN.md` cells that described the scaffold.

## What ran

- The winget files against the 1.28.0 JSON schemas (`jsonschema`), with a negative control; the installer downloaded and hashed against the manifest.
- `appstreamcli validate` on the MetaInfo file, with a negative control; `flatpak-builder --show-manifest` on the draft.
- `prek run --all-files`, `prek run --hook-stage manual --all-files`, `npm run lint`.

Not run, and why: `winget validate` and an install (need Windows); a Flatpak build; `flatpak-builder-lint` (not packaged for pip or apt, and installing it from its repository was refused in the session).
