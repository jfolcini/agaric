# `packaging/flathub/` — Flathub manifest scaffold

**Status (2026-05-20): scaffold only — not submitted to Flathub yet.**

This directory holds the Flatpak manifest and AppStream MetaInfo for an
eventual [Flathub](https://flathub.org) submission. It is part of the
OpenSSF Best Practices Silver-tier [`installation_common`](https://www.bestpractices.dev/en/criteria/2#2.installation_common)
roadmap (`PEND-49 §5c`). Flathub is the recommended Linux-side
deliverable because it reaches every major desktop without per-distro
maintenance work.

## What's here

| File | Purpose |
|------|---------|
| [`io.github.jfolcini.Agaric.yml`](io.github.jfolcini.Agaric.yml) | The Flatpak module manifest. Mirrors the existing AppImage `.deb` rather than recompiling Rust in the sandbox (a 4x build wall-clock saving with no behavioural difference). |
| [`io.github.jfolcini.Agaric.metainfo.xml`](io.github.jfolcini.Agaric.metainfo.xml) | AppStream MetaInfo for the Flathub presentation page (name, summary, screenshots, releases, categories, keywords). |

## App ID

The Flatpak app ID is `io.github.jfolcini.Agaric` (Flathub's convention
for personal-project apps without a registered domain). The in-bundle
Tauri identifier stays `com.agaric.app` — they're separate addressing
schemes. The Flatpak builder renames the `.desktop` file's
`Icon=` / `Exec=` lines to point at the Flatpak-bundled paths during
the build step.

## Open questions before submission

These block the actual Flathub PR. Captured here so the maintainer can
hit each in order rather than discovering them mid-review.

1. **Migration path from existing AppImage installs.** AppImage
   users currently have their data under
   `~/.local/share/com.agaric.app/`. Flatpak namespaces it under
   `~/.var/app/io.github.jfolcini.Agaric/data/`. The manifest's
   `--filesystem=xdg-data/com.agaric.app:create` line is a
   transitional kludge — the right answer is either an in-app
   "Migrate from AppImage data" first-run prompt, or a documented
   manual `cp -r` step in the README. **Decide before submitting.**
2. **Release-time manifest bumps.** Every Agaric release flips the
   `${VERSION}` and `${DEB_SHA256}` placeholders in the manifest.
   Options: (a) a `scripts/bump-flathub-manifest.sh` step the
   `bump-version.sh` script invokes after a successful release;
   (b) a GitHub Action that opens the Flathub PR automatically once
   the release assets have SHA256s. Either way, the bestpractices
   Silver criterion only flips Met on the FIRST successful Flathub
   submission — automation is a follow-up concern.
3. **Screenshot URL host.** The MetaInfo `<screenshots>` block
   points at `docs/social-preview.png` as a placeholder; Flathub's
   validator requires actual app-screenshot URLs that match the
   product. Either commit screenshot PNGs to the repo (and host
   them via raw.githubusercontent.com) or set up a static-site
   release host. The first option is simpler and matches what most
   Flathub apps do.
4. **Wayland-only test pass.** The `finish-args` block declares
   Wayland-first with X11 fallback. Tauri 2.11.2's WebKit backend
   is known to be quirky under pure Wayland on some compositors;
   verify on at least GNOME 47 + KDE 6.2 before submitting. If
   Wayland is broken, drop the `--socket=wayland` line and submit
   X11-only as a first cut; revisit when upstream Tauri stabilises.

## Submission checklist (when the open questions are resolved)

1. Fork `https://github.com/flathub/flathub` (the requests repo).
2. Open a PR adding a stub for `io.github.jfolcini.Agaric` (per
   <https://docs.flathub.org/docs/for-app-authors/submission>).
3. Once accepted, Flathub spawns `https://github.com/flathub/io.github.jfolcini.Agaric`
   for the long-lived manifest. **The files in THIS directory are the
   source of truth and get copied into that downstream repo on every
   release.** Do NOT edit the downstream repo's manifest in-place —
   maintain the source here and sync.
4. Wire `scripts/bump-version.sh` (or its successor) to update the
   `${VERSION}` and `${DEB_SHA256}` placeholders + open the downstream
   PR automatically (open question 2).
5. On Flathub PR merge: flip the OSSF Best Practices Silver
   [`installation_common`](https://www.bestpractices.dev/en/criteria/2#2.installation_common)
   row to Met, citing the Flathub app page URL.

## Why not winget / Homebrew Cask first?

Per `PEND-49 §5c`'s sequencing recommendation, Flathub covers the
largest non-Play-Store install base AND the Linux maintainer
demographic the README targets. winget and Homebrew Cask come after
Flathub.

## Cross-references

- `pending/REVIEW-LATER.md` `OSSF-1` (lookup) → `pending/PEND-49`
  is the broader Silver roadmap; this directory is §5c's
  deliverable.
- `pending/PEND-36-play-store-publishing.md` is the parallel
  Android-side `installation_common` track.
- `.github/workflows/release.yml` builds the `.deb` this manifest
  unpacks.
