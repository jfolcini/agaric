# `packaging/flathub/`: a working Flatpak, and a submission Flathub can't accept yet

**Status as of 2026-11-14, checked against [Flathub's requirements](https://docs.flathub.org/docs/for-app-authors/requirements): nothing submitted, and nothing submittable as things stand.** The good news is that the manifest now builds Agaric from source inside the Flatpak sandbox and passes `flatpak-builder-lint`. The bad news is one requirement no amount of editing can work around:

> Flathub manifests must not contain AI-generated or AI-assisted content. Disclosure does not exempt manifests from this restriction.

An AI agent wrote [`io.github.jfolcini.Agaric.yml`](io.github.jfolcini.Agaric.yml). Submitting it — or a copy of it — would mean knowingly breaking that rule ([#6660](https://github.com/jfolcini/agaric/issues/6660)), and that's the maintainer's call to make. The alternative is a manifest written by hand. Whichever way it goes, the same policy adds two more obligations:

- Whoever submits has to disclose AI-generated material "in the application or its Flathub packaging", spelling out which parts and how far it goes. That covers the app's code, the MetaInfo file, and the desktop file here. Reviewers can still turn the app down over it.
- No AI tool opens the submission pull request, and none of its commit messages, description, or replies come from one.

## What's here

| File | State |
|------|-------|
| [`io.github.jfolcini.Agaric.yml`](io.github.jfolcini.Agaric.yml) | Builds the checkout it lives in, from source and offline, on `org.gnome.Platform` 51 — the latest runtime, and the one that ships the WebKitGTK 4.1 the app links against. AI-written (see above). |
| [`io.github.jfolcini.Agaric.metainfo.xml`](io.github.jfolcini.Agaric.metainfo.xml) | AppStream metadata, valid under `appstreamcli validate`. The screenshot is still a placeholder, which Flathub rejects (step 1 replaces it). |
| [`io.github.jfolcini.Agaric.desktop`](io.github.jfolcini.Agaric.desktop) | The desktop file the Flatpak installs. Tauri generates its own, but that one ships an empty `Categories=` and `Icon=agaric`. |
| [`flathub.json`](flathub.json) | Keeps Flathub's build on x86_64 only — the one Linux architecture releases are actually built and tested on. |

The manifest also names `cargo-sources.json` and `node-sources.json`; those get generated from the two lockfiles and are deliberately not committed (step 3 shows how). One naming detail worth knowing: the Flatpak app ID is `io.github.jfolcini.Agaric`, while the Tauri identifier stays `com.agaric.app`.

## Permissions, and why each one is there

| `finish-args` | Used for |
|------|----------|
| `--socket=wayland`, `--socket=fallback-x11`, `--share=ipc`, `--device=dri` | The window and the webview. |
| `--socket=pulseaudio` | Playing audio attachments and recording voice notes. |
| `--share=network` | LAN sync between paired devices (mDNS discovery and QUIC, straight from the app's own sockets), plus link previews. |
| `--filesystem=xdg-download` | Exports. On Linux, saving a page, attachment, or export ZIP goes through the webview's own download, which writes to Downloads (`saveBlob` in `src/lib/attachment-utils.ts`). |
| `--talk-name=org.freedesktop.Notifications` | Due-task notifications talk to the notification service directly (`notify-rust`), not through the portal. |
| `--own-name=com.agaric.app.SingleInstance` | The name `tauri-plugin-single-instance` claims. Without it, a second launch goes unnoticed and you end up with two windows on the same database. |

That's the whole list — nothing else is needed. Files get imported and attached through the webview's file chooser (which is the file portal in a sandbox), links and the data folder open through the sandbox's `xdg-open` (the OpenURI portal), `agaric://` links arrive via the desktop file's `MimeType`, and the database lives under `~/.var/app/io.github.jfolcini.Agaric/data/com.agaric.app/`, a path every Flatpak owns. There's no keyring and no Google Calendar access to ask for, because that integration is gone.

A few things the sandbox does take away — worth checking in step 5 and mentioning in the submission if they still hold:

- **Launch at login** writes its autostart entry inside the sandbox, where your desktop never looks.
- **The QR scanner** used during pairing needs a camera, and the manifest doesn't grant one.
- **Self-update** is off under Flatpak (`running_under_flatpak` in `src-tauri/src/lib.rs`) — which is exactly what Flathub wants.
- **Coming from the `.deb` or the AppImage:** move `~/.local/share/com.agaric.app` to the path above before the first launch. Copying it instead would leave you with two installs sharing one sync identity.

## Submitting

Every step below is the maintainer's to run. And mind the order: a release has to contain these files before anything can be submitted, so the first submittable release is the one after this lands.

1. Before tagging the release, take real screenshots of the app's window on Linux, commit them, and swap the placeholder in the MetaInfo `<screenshots>` for their URLs, pinned to the release tag (`https://raw.githubusercontent.com/jfolcini/agaric/<version>/…`). Add the `<release>` entry while you're in there. If you'd rather try the Flatpak from the checkout first, generate the sources (step 3) and run `flatpak-builder --user --install --force-clean builddir io.github.jfolcini.Agaric.yml`.

   ```bash
   appstreamcli validate packaging/flathub/io.github.jfolcini.Agaric.metainfo.xml
   desktop-file-validate packaging/flathub/io.github.jfolcini.Agaric.desktop
   ```

2. Once the release is out: fork `flathub/flathub` (leave "Copy the master branch only" unchecked), clone it, and branch off `new-pr`. Copy in the manifest and `flathub.json` — just those two; the MetaInfo and desktop files come from the tag. In your copy, the `dir` source that Flathub's sandboxed build refuses becomes the release:

   ```yaml
         - type: git
           url: https://github.com/jfolcini/agaric.git
           tag: <version>
           commit: <output of: git rev-list -n1 <version>>
   ```

3. Next to that manifest, generate the dependency sources from the tagged lockfiles with the generators from [flatpak-builder-tools](https://github.com/flatpak/flatpak-builder-tools). One gotcha: the node generator wants a checkout with no `node_modules` in it:

   ```bash
   python3 <flatpak-builder-tools>/cargo/flatpak-cargo-generator.py <agaric>/src-tauri/Cargo.lock -o cargo-sources.json
   pipx install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
   flatpak-node-generator npm <agaric>/package-lock.json -o node-sources.json
   ```

4. Build and install, the way [Flathub's submission guide](https://docs.flathub.org/docs/for-app-authors/submission) describes:

   ```bash
   flatpak remote-add --if-not-exists --user flathub https://dl.flathub.org/repo/flathub.flatpakrepo
   flatpak install -y flathub org.flatpak.Builder
   flatpak run --command=flathub-build org.flatpak.Builder --install io.github.jfolcini.Agaric.yml
   flatpak run io.github.jfolcini.Agaric
   ```

5. Now actually use the installed Flatpak on a Wayland session and poke at everything: write a block and make sure it's still there after a restart; launch a second time and check the first window gets focused; pair and sync with another device on the LAN; let a due-task notification through; attach a file; export a page and find it in Downloads; play an audio attachment and record a voice note; open an `agaric://` link; run an MCP client with `flatpak run --command=agaric-mcp io.github.jfolcini.Agaric`.
6. Then lint:

   ```bash
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder manifest io.github.jfolcini.Agaric.yml
   flatpak run --command=flatpak-builder-lint org.flatpak.Builder repo repo
   ```

7. Commit the manifest, `flathub.json`, `cargo-sources.json` and `node-sources.json`, push, and open the pull request against `new-pr` from GitHub's web interface, titled "Add io.github.jfolcini.Agaric". In the description, disclose the AI-generated material (top of this file) and walk through the permissions (table above). Drop the PR link into #6660.

## Every release after acceptance

Once the app is in, Flathub creates `flathub/io.github.jfolcini.Agaric`, and all future updates go there — never through a new submission. Each release then needs three things: the `<release>` entry added to the MetaInfo before tagging, the manifest's `tag` and `commit` updated in that repository, and both sources files regenerated (step 3). Every year or so GNOME retires a runtime, and `runtime-version` has to move with it.
