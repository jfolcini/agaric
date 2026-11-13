# `packaging/flathub/`: a Flathub submission the maintainer still has to write

**Status, checked against Flathub's requirements on 2026-11-13 with release 0.23.0: not submitted, and the files here cannot be submitted as they stand.** Two of [Flathub's requirements](https://docs.flathub.org/docs/for-app-authors/requirements) rule the manifest out:

1. **Generative AI policy.** "Flathub manifests must not contain AI-generated or AI-assisted content. Disclosure does not exempt manifests from this restriction." The manifest in this directory was drafted by an AI agent. The same policy forbids an AI tool from opening the submission pull request or writing its commit messages, description, or replies, and it requires the submitter to disclose AI-generated code in the application itself, which reviewers may weigh against the submission.
2. **Building from source.** "All source available submissions must be built entirely from source code." The manifest here unpacks the release `.deb`.

So a submission means the maintainer writes a from-source manifest by hand. What follows is what was measured on 0.23.0 that such a manifest has to account for, then the submission steps. The decision whether to go on is tracked in [#6660](https://github.com/jfolcini/agaric/issues/6660).

## What is here

| File | State |
|------|-------|
| [`io.github.jfolcini.Agaric.yml`](io.github.jfolcini.Agaric.yml) | The May 2026 draft. Do not submit it (both rules above). It is also stale against 0.23.0: the asset is `Agaric_<version>_amd64.deb`, the desktop file inside it is `Agaric.desktop`, `archive-type: deb` is not a flatpak-builder archive type, and `org.freedesktop.Platform` carries no WebKitGTK. |
| [`io.github.jfolcini.Agaric.metainfo.xml`](io.github.jfolcini.Agaric.metainfo.xml) | AppStream metadata, valid under `appstreamcli validate`. AI-drafted, so it is either disclosed in the submission or rewritten. Its screenshot is a placeholder (step 5). |

The app ID is `io.github.jfolcini.Agaric`; the Tauri identifier stays `com.agaric.app`.

## What a manifest has to account for

Measured on the 0.23.0 `.deb` and the source at that tag.

- **Runtime.** `agaric` links `libwebkit2gtk-4.1` and `libsoup-3.0`, which `org.gnome.Platform` ships and `org.freedesktop.Platform` does not.
- **Offline build.** Flathub builds have no network: the Cargo workspace under `src-tauri/` and the npm tree need vendored sources (the cargo and node generators in [flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools)), and sqlx resolves its compile-time queries from `src-tauri/.sqlx` under `SQLX_OFFLINE=true`.
- **Two binaries.** `agaric` and the `agaric-mcp` sidecar, installed next to each other.
- **Architecture.** Releases are built and tested on x86_64 only, so the submission carries a [`flathub.json`](https://docs.flathub.org/docs/for-app-authors/requirements#flathubjson) restricting it, unless aarch64 is built and tested too.
- **Desktop file and icons.** Tauri's desktop file has an empty `Categories=`, `Icon=agaric` and `MimeType=x-scheme-handler/agaric`; the file and the icons are renamed to the app ID.
- **Permissions the app uses.** Wayland with X11 fallback, IPC and DRI for the webview; the network, for LAN sync (mDNS and QUIC) and the opt-in Google Calendar push; `--talk-name=org.freedesktop.Notifications`, because Linux notifications go to the notification service directly; `--own-name=com.agaric.app.SingleInstance`, the name `tauri-plugin-single-instance` claims, without which a second launch is not detected and opens a second pool on the same database.
- **Data directory.** Under Flatpak it is `~/.var/app/io.github.jfolcini.Agaric/data/com.agaric.app/`. Someone coming from the `.deb` or the AppImage moves `~/.local/share/com.agaric.app` there before the first launch; a copy would leave two installs with one sync identity.
- **Self-update.** Already off under Flatpak (`running_under_flatpak` in `src-tauri/src/lib.rs`), as Flathub requires.

## Submitting

Every step is the maintainer's, by hand.

1. Write the manifest and `flathub.json`.
2. Build and install it, as [Flathub's submission guide](https://docs.flathub.org/docs/for-app-authors/submission) describes:

   ```bash
   flatpak install -y flathub org.flatpak.Builder
   flatpak run --command=flathub-build org.flatpak.Builder --install io.github.jfolcini.Agaric.yml
   flatpak run io.github.jfolcini.Agaric
   ```

3. In the running Flatpak, on a Wayland session: write a block and find it after a restart; launch a second time and see the first window focused; pair and sync with another device on the LAN; receive a due-task notification; attach a file and export a page; open an `agaric://` link; run an MCP client through `flatpak run --command=agaric-mcp io.github.jfolcini.Agaric`.
4. Lint:

   ```bash
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest io.github.jfolcini.Agaric.yml
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
   ```

5. Replace the placeholder in the MetaInfo `<screenshots>` with screenshots of the app's window, committed to this repository and linked by a URL pinned to a tag, and set `<releases>` to the release being submitted.
6. Fork `flathub/flathub` with "Copy the master branch only" unchecked, branch from `new-pr`, add the manifest and `flathub.json`, and open a pull request against `new-pr` titled "Add io.github.jfolcini.Agaric". Disclose the AI-generated code in the application and any AI-drafted MetaInfo, and explain each permission. Put the pull request's link in #6660.
7. Once Flathub has created `flathub/io.github.jfolcini.Agaric`, updates go there and never through a new submission ([docs/BUILD.md § After the release is published](../../docs/BUILD.md#after-the-release-is-published)).

## Not validated

No Flatpak build has been run, and `flatpak-builder-lint` has not been run on anything here. `appstreamcli validate` passes on the MetaInfo file; `flatpak-builder --show-manifest` parses the draft manifest, which says only that it is well-formed.
