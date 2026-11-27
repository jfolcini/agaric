# `packaging/appimagehub/`: the AppImageHub listing

[AppImageHub](https://appimage.github.io/) lists AppImages and links to their authors' downloads; it hosts nothing. The listing is one file in [AppImage/appimage.github.io](https://github.com/AppImage/appimage.github.io) that names this repository, and its bot tests the AppImage of the newest release on every pull request.

## What the test checks

From [its README](https://github.com/AppImage/appimage.github.io#checklist-for-submitting-your-own-appimage):

- **It runs on the oldest Ubuntu LTS in standard support, with no extra packages.** That is 22.04 until June 2027. A binary needs the glibc it was built against or newer, so `release.yml` builds the Linux bundles on `ubuntu-22.04`; a newer runner fails the test with `error-glibc-too-new`.
- **It shows its main window within 30 seconds, offline, on X11.** Agaric needs no network to start.
- **Its desktop file passes `desktop-file-validate`, and the AppDir passes [`appdir-lint.sh`](https://github.com/AppImage/AppImages/blob/master/appdir-lint.sh).** Both pass, though Tauri writes an empty `Categories=`, which leaves the listing uncategorised until `bundle.category` in `tauri.conf.json` fills it.
- **It starts in English and in a light theme by default.** The test runs with the C locale and no dark-mode preference: Agaric falls back to English and follows the system theme.
- **Any AppStream metainfo in `usr/share/metainfo` passes `appstreamcli validate`.** Tauri's AppImage ships none.

## Submitting

The maintainer's step, once a release's AppImage meets the list above:

1. In a fork of `AppImage/appimage.github.io`, add the file `data/Agaric` (the application's name as its desktop file gives it) holding the one line:

   ```text
   https://github.com/jfolcini/agaric
   ```

2. Open a pull request that adds that file and nothing else. The bot picks the x86_64 AppImage of the newest release and answers with a screenshot of the main window (a first start shows the welcome dialog over the journal), or an `error-*` label and a hint.
3. After a fix ships in a new release, comment `/retest`. Once merged, the listing follows new releases by itself; nothing here changes per release.
