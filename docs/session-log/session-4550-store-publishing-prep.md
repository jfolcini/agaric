# Session 4550 — store publishing: packaged builds don't self-update, macOS ad-hoc signature, privacy policy, Snap/AUR/Store automation

The maintainer wants Agaric on the Microsoft Store, Snap, Flathub, the AUR and AppImageHub. Publishing should be automated wherever a channel allows it, and otherwise the channel's prerequisites should be ready. Their earlier signing decisions stand: no paid certificates, no SignPath (#147), no Apple Developer Program. Five subagents built the parts in separate worktrees; this session combined them into one PR (#7171).

**Decisions.**

- **Self-update off in every package-manager copy.** The one predicate is `self_update_disabled` in `src-tauri/src/lib.rs`, which replaces `running_under_flatpak`; the command `is_flatpak` is renamed to match. It is true for:
  - Flatpak;
  - `SNAP` set;
  - the marker `/usr/share/agaric/no-self-update`, which the AUR `agaric-bin` installs;
  - an executable under `WindowsApps` (the Store's MSIX).

  The Help tab then says updates come from the store or package manager, instead of offering a check that could only fail.
- **`bundle.publisher` stays unset.** Tauri's NSIS template keeps a custom install folder under `HKCU\Software\<publisher>\Agaric`. A new publisher would make an in-app update of such an install land a second copy in the default folder, and the MSIX takes its publisher from Partner Center anyway. The maintainer had picked "Javier Folcini"; the commit was reverted, and `packaging/winget/README.md` says why. `bundle.category` is `Productivity`.
- **macOS: an ad-hoc signature** (`signingIdentity: "-"`) with `hardenedRuntime: false`. Without entitlements, the hardened runtime would deny the microphone and camera, and it only matters for notarization. Unchecked on a Mac (#6514).
- **Store publishing.** The MSIX comes from the release `.msi` (administrative extract, MakeAppx), so the Store signs it. The Snap wraps the release `.deb`. The AUR package repackages the `.deb`.
  - Each publish workflow runs on `workflow_run` of `Release`, because `release: published` from `GITHUB_TOKEN` starts no workflow.
  - Each skips with a notice until its secrets exist.
  - The Store refuses a 0.x package version, so the MSIX waits for 1.0.0 or a decision on a version offset.
- **Linux bundles build on Ubuntu 22.04**, for AppImageHub's glibc baseline. Jammy has every package; `dbus-daemon` becomes `dbus`; the AppImage repack sets `APPIMAGE_EXTRACT_AND_RUN`.
- **Flathub.** The maintainer hand-wrote `packaging/flathub/README.md` during the session, and no agent edited it, except the one function name the updater change renamed. Agents wrote no manifest content. `bump-version.sh` now adds the MetaInfo `<release>` entry and pins the screenshots to the tag. The four Playwright screenshots of the browser mock lack native window decoration, which Flathub's quality guidelines ask for; they may need retaking from the Flatpak.

**Traps.**

- The updater builder ran only the test files it changed. `SettingsView.test.tsx`, which renders the Help tab, broke on the unstubbed `self_update_disabled`, and the pre-push verify caught it.
- The PR touches `tauri.conf.json`, which pulls in the real-binary lane. That lane showed two specs #7162 left stale on `main`: the Day header's Delete page moved into *Page actions*, and Overdue became a tab in the day's task panel. The other UI PRs had skipped the lane. This PR updates both specs; the week view's own Delete page button is unchanged.
- Some runner images list `packages.microsoft.com`, which answers 403 ("no longer signed"), so every `apt-get update` on them fails. Two Playwright shards died in `install-deps` before any test ran. `prepare-apt` now drops that source; no job installs from it.

**Checks.** Each part's builder ran its own:
- clippy, targeted nextest and the specta regeneration;
- vitest with falsification;
- actionlint and zizmor, and `pins.test.mjs`;
- `makepkg` and `namcap` in an Arch container;
- snapcraft schema validation and MSIX manifest schema validation;
- a 22.04 container build that booted offline;
- the two fixed real-binary specs on the real binary, each shown red by a broken selector.

The pre-push verify passed on the combined branch: vitest related, related Playwright, nextest related, doc-tests and the sqlx check. The `prepare-apt` loop was checked in a scratch directory, as written and with its pattern broken.
