# `packaging/winget/`: the winget manifest

The three files are the [multi-file manifest](https://github.com/microsoft/winget-pkgs/blob/master/doc/manifest/README.md) for `jfolcini.Agaric`, pointing at the NSIS installer (`Agaric_<version>_x64-setup.exe`) the release workflow already publishes. That installer is per-user and needs no elevation, and it is the bundle the in-app updater uses by default, so a winget install and a self-update never mix installer kinds.

`scripts/gen-winget-manifest.sh <version>` rewrites the version, installer URL, SHA-256 and release date from the published GitHub Release. Everything else is edited here by hand.

The installer registers itself in *Apps & features* as `Agaric` by the publisher `agaric` (Tauri derives it from the bundle identifier), which is why the installer file carries `ProductCode` and `AppsAndFeaturesEntries`. Setting `bundle.publisher` in `tauri.conf.json` would change that and these two with it.

## Submitting

The maintainer's step, on Windows, following the [first-contribution checklist](https://github.com/microsoft/winget-pkgs/blob/master/doc/FirstContribution.md):

1. Copy the three files to `manifests/j/jfolcini/Agaric/<version>/` in a fork of `microsoft/winget-pkgs`.
2. `winget validate --manifest <that directory>`.
3. `winget settings --enable LocalManifestFiles`, then `winget install --manifest <that directory>`: the install must finish with no prompt, and `winget list jfolcini.Agaric` must then show the package under that identifier with the right version.
4. Open a pull request with those three files only, titled `New package: jfolcini.Agaric version <version>` (`Update: jfolcini.Agaric to <version>` for later releases), and sign the CLA the bot asks for. For the first one, put the link in [#6660](https://github.com/jfolcini/agaric/issues/6660).

The installer is not code-signed ([docs/BUILD.md § Signing posture](../../docs/BUILD.md#signing-posture)). winget accepts unsigned installers, but its validation runs security scans and can reject one that a scanner flags.

## Not validated

The files pass the 1.28.0 JSON schemas they name, and the SHA-256 matches the downloaded installer. `winget validate`, a real install, and whether *Apps & features* shows the names above need Windows and have not been run; the names come from reading Tauri's NSIS template.
