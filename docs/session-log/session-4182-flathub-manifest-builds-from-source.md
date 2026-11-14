# Session 4182 — the Flathub manifest builds from source; submitting it is still blocked (#6660)

The maintainer decided on 2026-11-14 to make the Flathub manifest submittable and to submit it themselves. The session set out to fix everything in `packaging/flathub/` that blocks a submission.

## Decisions and traps

- **The "not submittable" marking stays.** Flathub's generative AI policy, re-read on 2026-11-14, still says a manifest "must not contain AI-generated or AI-assisted content" and that disclosure does not exempt it. The manifest was rewritten by an agent, so the one blocker left is one no edit can remove: the maintainer either submits it against that rule or writes their own. Session 4084 left the draft alone for this reason; this session wrote it because the maintainer asked, and says so at the top of the file and the README.
- **The build was run, not reasoned about.** `flatpak-builder` works in the cloud container (user namespaces are on, Flathub is reachable). `flatpak run` needs a session and a system `dbus-daemon` started by hand, and the linter needs the proxy CA bundle passed in with `--filesystem`.
- **`org.gnome.Platform` 51** is the latest runtime and still ships `webkit2gtk-4.1`. Its `node24` extension ships npm 11, and `engine-strict` with `engines.npm >= 12` fails `npm ci`; the manifest passes `--engine-strict=false`.
- **No tauri-cli in the build.** `cargo build --release --features tauri/custom-protocol --bin agaric --bin agaric-mcp` is what the CLI runs, less the bundling. `rust-toolchain.toml` is inert there (the extension has no rustup), so the build uses the extension's newer stable.
- **Permissions read from the code and the pinned crates.** Dropped from the old draft: the keyring and the Google Calendar reasons (gone with migration 0091) and `--filesystem=xdg-data/com.agaric.app` (another install's data). Added: `--own-name=com.agaric.app.SingleInstance`, `--socket=pulseaudio`, and `--filesystem=xdg-download`, because on Linux `saveBlob` saves through the webview's own download. File pickers are the webview's (`<input type="file">`), `rfd` uses `GtkFileChooserNative`, and the opener falls back to the OpenURI portal, so no other file permission is needed.
- **The manifest builds its own checkout** (`type: dir`), so it never names a release that lacks the files it installs. `flathub-build` runs `--sandbox`, which refuses a `dir` source outside the manifest's folder, so the Flathub copy takes a `git` source (README step 2), and the first submittable release is the next one: the MetaInfo and desktop files must come from the tag.
- **`rofiles-fuse` does not work in the container.** `flathub-build` ended with "Command 'agaric' not found" after a complete build, and cached a cleanup stage that had skipped `appstreamcli compose`. The same flags with `--disable-rofiles-fuse` pass; a top-level `cleanup:` line added for one run invalidates only that stage.
- **flatpak-builder from apt (1.4.2) does not install the license file**; the manifest installs `LICENSE` itself, which Flathub requires.
- **The generators could not be run.** The session's permission layer refused to execute `flatpak-cargo-generator.py` and `flatpak-node-generator`. The build used source lists a stand-in script made from the same lockfiles, and filled the npm cache with `npm cache add` on plain tarballs.

## Shipped

The rewritten manifest, `flathub.json`, a desktop file, the MetaInfo file without Google Calendar, the README (permissions with reasons, the maintainer's steps, the per-release work), the Flathub line in `docs/BUILD.md` § After the release is published, and two `.gitignore` lines for the generated source lists. The root README and the comparison files say "not submitted", which is still true.

## What ran

- `flatpak-builder` on the manifest (22 minutes on 4 cores), and the `git`-source form with `flathub-build`'s flags; `flatpak-builder-lint manifest` and `repo` pass on the latter.
- The installed Flatpak under Xvfb: boot to the journal, the database in the sandbox data directory, a second launch handing over, Downloads writable and Documents not.
- `appstreamcli validate`, `desktop-file-validate`; both binaries checked for unresolved libraries inside the sandbox.

Not run: sync, notifications, audio, a webview export, `agaric://` links (no Wayland session, peer, or sound); the two official generators; a build from a release tag.
