# `packaging/flathub/`: a Flatpak that builds, and a Flathub submission that is still blocked

**Status, checked against [Flathub's requirements](https://docs.flathub.org/docs/for-app-authors/requirements) on 2026-11-14: not submitted, and not submittable as it stands.** The manifest here now builds Agaric from source in the Flatpak sandbox, and it passes `flatpak-builder-lint`. One requirement still rules it out, and no edit to the file can lift it:

> Flathub manifests must not contain AI-generated or AI-assisted content. Disclosure does not exempt manifests from this restriction.

An AI agent wrote [`io.github.jfolcini.Agaric.yml`](io.github.jfolcini.Agaric.yml). Submitting it, or a copy of it, is the maintainer's decision to take against that rule ([#6660](https://github.com/jfolcini/agaric/issues/6660)); the alternative is a manifest the maintainer writes by hand. The same policy has two more duties whichever manifest is used:

- The submitter discloses AI-generated material "in the application or its Flathub packaging", with the affected parts and their extent. That covers the application's code, the MetaInfo file and the desktop file here. Reviewers may reject on it.
- No AI tool opens the submission pull request or writes its commit messages, description, or replies.

## What is here

| File | State |
|------|-------|
| [`io.github.jfolcini.Agaric.yml`](io.github.jfolcini.Agaric.yml) | Builds the checkout it sits in, from source and offline, on `org.gnome.Platform` 51 (the latest; it ships the WebKitGTK 4.1 the app links). AI-written: see above. |
| [`io.github.jfolcini.Agaric.metainfo.xml`](io.github.jfolcini.Agaric.metainfo.xml) | AppStream metadata, valid under `appstreamcli validate`. Its screenshot is a placeholder, which Flathub rejects (step 1). |
| [`io.github.jfolcini.Agaric.desktop`](io.github.jfolcini.Agaric.desktop) | The desktop file the Flatpak installs. Tauri's own has an empty `Categories=` and `Icon=agaric`. |
| [`flathub.json`](flathub.json) | Restricts Flathub's build to x86_64, the one Linux architecture a release is built and tested on. |

`cargo-sources.json` and `node-sources.json`, which the manifest names, are generated from the two lockfiles and not committed (step 3). The app ID is `io.github.jfolcini.Agaric`; the Tauri identifier stays `com.agaric.app`.

## Permissions, and why each

| `finish-args` | Used for |
|------|----------|
| `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc`, `--device=dri` | The window and the webview. |
| `--socket=pulseaudio` | Playing audio attachments and recording voice notes. |
| `--share=network` | LAN sync between paired devices (mDNS discovery and QUIC, from the app's own sockets) and link previews. |
| `--filesystem=xdg-download` | Exports. On Linux a page, attachment or export ZIP is saved by the webview's own download, which writes to the Downloads folder (`saveBlob` in `src/lib/attachment-utils.ts`). |
| `--talk-name=org.freedesktop.Notifications` | Due-task notifications go to the notification service directly (`notify-rust`), not through the portal. |
| `--own-name=com.agaric.app.SingleInstance` | The name `tauri-plugin-single-instance` claims. Without it a second launch is not detected and opens a second pool on the same database. |

Nothing else is needed: files are imported and attached through the webview's file chooser, which is the file portal in a sandbox; links and the data folder open through the sandbox's `xdg-open`, which is the OpenURI portal; `agaric://` links arrive through the desktop file's `MimeType`; the database is under `~/.var/app/io.github.jfolcini.Agaric/data/com.agaric.app/`, which every Flatpak owns. There is no keyring and no Google Calendar access to ask for: that integration is gone.

What the sandbox takes away, to check in step 5 and say in the submission if it holds:

- **Launch at login** writes an autostart entry inside the sandbox, where the desktop does not look.
- **The QR scanner** in pairing needs a camera, which the manifest does not grant.
- **Self-update** is off under Flatpak (`running_under_flatpak` in `src-tauri/src/lib.rs`), as Flathub requires.
- **Moving from the `.deb` or the AppImage:** move `~/.local/share/com.agaric.app` to the path above before the first launch. A copy would leave two installs with one sync identity.

## Submitting

Every step is the maintainer's. A release has to contain these files before it can be submitted, so the first submittable release is the one after they merge.

1. Before tagging the release: take screenshots of the app's window on Linux, commit them, replace the placeholder in the MetaInfo `<screenshots>` with their URLs pinned to the release's tag (`https://raw.githubusercontent.com/jfolcini/agaric/<version>/…`), and add the `<release>` entry. To try the Flatpak from the checkout first, generate the sources (step 3) and run `flatpak-builder --user --install --force-clean builddir io.github.jfolcini.Agaric.yml`.

   ```bash
   appstreamcli validate packaging/flathub/io.github.jfolcini.Agaric.metainfo.xml
   desktop-file-validate packaging/flathub/io.github.jfolcini.Agaric.desktop
   ```

2. After the release: fork `flathub/flathub` with "Copy the master branch only" unchecked, clone it, and branch from `new-pr`. Copy in the manifest and `flathub.json`, and nothing else from here: the MetaInfo and desktop files come from the tag. In the copied manifest the `dir` source, which Flathub's sandboxed build refuses, becomes the release:

   ```yaml
         - type: git
           url: https://github.com/jfolcini/agaric.git
           tag: <version>
           commit: <output of: git rev-list -n1 <version>>
   ```

3. Next to that manifest, generate the dependency sources from the tagged lockfiles with the generators in [flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools) (the node one needs a checkout with no `node_modules`):

   ```bash
   python3 <flatpak-builder-tools>/cargo/flatpak-cargo-generator.py <agaric>/src-tauri/Cargo.lock -o cargo-sources.json
   pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
   flatpak-node-generator npm <agaric>/package-lock.json -o node-sources.json
   ```

4. Build and install, as [Flathub's submission guide](https://docs.flathub.org/docs/for-app-authors/submission) describes:

   ```bash
   flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
   flatpak install -y flathub org.flatpak.Builder
   flatpak run --command=flathub-build org.flatpak.Builder --install io.github.jfolcini.Agaric.yml
   flatpak run io.github.jfolcini.Agaric
   ```

5. In the running Flatpak, on a Wayland session: write a block and find it after a restart; launch a second time and see the first window focused; pair and sync with another device on the LAN; receive a due-task notification; attach a file; export a page and find it in Downloads; play an audio attachment and record a voice note; open an `agaric://` link; run an MCP client through `flatpak run --command=agaric-mcp io.github.jfolcini.Agaric`.
6. Lint:

   ```bash
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest io.github.jfolcini.Agaric.yml
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
   ```

7. Commit the manifest, `flathub.json`, `cargo-sources.json` and `node-sources.json`, push, and open a pull request against `new-pr` titled "Add io.github.jfolcini.Agaric", from the GitHub web interface. Disclose the AI-generated material (top of this file) and explain each permission (the table above). Put the pull request's link in #6660.

## Every release after acceptance

Flathub creates `flathub/io.github.jfolcini.Agaric`; updates go there and never through a new submission. Per release: the `<release>` entry in the MetaInfo file before tagging, then in that repository the manifest's `tag` and `commit`, and both sources files regenerated (step 3). `runtime-version` moves when GNOME retires the runtime, about once a year.

## What was run, and what was not

Run on 2026-11-14, in a container, on the tree this file was committed with:

- `flatpak-builder` built the manifest from source with no network in the build, against `org.gnome.Platform` 51 with the `rust-stable` and `node24` extensions, and exported it to a repo.
- `flatpak-builder-lint manifest` and `flatpak-builder-lint repo`; `appstreamcli validate`; `desktop-file-validate`.

Not run:

- **The app's window.** The container has no display, so nothing in step 4 was exercised, and the limits listed under the permissions table come from reading the code.
- **The two generators in step 2.** The session could not run them; the build above used source lists made from the same lockfiles by a stand-in script, with the npm cache filled from plain tarballs.
- **A build from a release tag.** No release contains these files yet.
