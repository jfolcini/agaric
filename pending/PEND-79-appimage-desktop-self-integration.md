# PEND-79 — AppImage first-run desktop self-integration (Linux icon fix)

The AppImage's icon shows as the generic `application-x-executable` cog in
Nautilus and the GNOME dash. Root cause is **not** packaging — the embedded
`.DirIcon`, hicolor theme, and `.desktop` are all correct (verified on
`Agaric_0.2.0_amd64.AppImage`). GNOME only renders icons from `.desktop` files
*installed on the host*, and a portable AppImage in `~/Downloads` is never
integrated unless `appimaged`/AppImageLauncher is running. CI cannot fix this —
it can't write into each user's `~/.local/share`. The app must integrate itself
on first run.

Proven manually: installing `~/.local/share/applications/agaric.desktop` +
`~/.local/share/icons/hicolor/<size>/apps/agaric.png` + cache refresh makes both
the dash icon and (via a `metadata::custom-icon` xattr) the Nautilus thumbnail
resolve.

## Scope — only the AppImage is affected

| Format | Icon source | Action |
|--------|-------------|--------|
| **AppImage** | host XDG dirs; nothing writes them | **self-integrate (this plan)** |
| deb / rpm | pkg manager installs `/usr/share/...` at install | none — already works |
| macOS .app/.dmg | `icon.icns` + Info.plist (native) | none |
| Windows .msi/.exe | embedded `.ico` + installer shortcut | none |
| Android .apk | manifest mipmap icons | none |

The guard is a single env check: `std::env::var("APPIMAGE")` is set **only**
inside a running AppImage. That excludes deb/rpm, `cargo tauri dev`, and every
non-Linux build automatically — no platform `cfg` gymnastics, no risk of the
code firing in the wrong context.

## Implementation (lightweight)

On startup, in a Linux-only setup hook:

1. Read `APPIMAGE` (absolute path to the `.AppImage`) and `APPDIR` (the mounted
   bundle root). If `APPIMAGE` is unset → return immediately.
2. Copy icons from `$APPDIR/usr/share/icons/hicolor/<size>/apps/agaric.png` into
   `~/.local/share/icons/hicolor/<size>/apps/agaric.png` (no need to ship icons
   as `bundle.resources` — they're already in the mounted AppDir).
3. Write `~/.local/share/applications/agaric.desktop` (lowercase filename so
   GNOME/Wayland matches the window `app_id` `agaric`):

   ```ini
   [Desktop Entry]
   Type=Application
   Name=Agaric
   Exec=$APPIMAGE %u
   Icon=agaric
   StartupWMClass=agaric
   Terminal=false
   Categories=Office;
   MimeType=x-scheme-handler/agaric;
   ```

4. Best-effort `update-desktop-database` + `gtk-update-icon-cache` (ignore
   failures; GNOME picks the files up on next login regardless).
5. **Idempotent + path-drift safe:** on every launch, if the existing
   `agaric.desktop` `Exec=` differs from the current `$APPIMAGE`, rewrite it.
   This handles the user keeping multiple versions (e.g. 0.1.x and 0.2.0 in
   `~/Downloads` — last-launched wins) and moved/renamed files. Cheap string
   compare; skip the cache refresh when nothing changed.
6. (Optional) Set `metadata::custom-icon` on `$APPIMAGE` via gio so the Nautilus
   *file* thumbnail shows the logo too. Lower priority — the dash/window icon is
   the primary win and the xattr path is more fragile.

## Complications to handle

- **Duplicate/shadowing with deb/rpm** — only a risk if the guard is wrong;
  the `APPIMAGE` check prevents it by construction. Keep that the single source
  of truth; do not also try to integrate from a `cfg(target_os = "linux")` path
  without the env guard.
- **Orphaned files after the AppImage is deleted** — `agaric.desktop` lingers
  pointing at a missing path (a dead launcher entry). Acceptable for v1; a
  follow-up could drop a self-cleaning `TryExec=$APPIMAGE` line so GNOME hides
  the entry when the target is gone.
- **Coexistence with appimaged / AppImageLauncher** — both write the same files;
  last-writer-wins is fine. Don't add a daemon or a watcher.
- **Wayland app_id** — lowercase `agaric.desktop` + `StartupWMClass=agaric`
  covers both Wayland (filename↔app_id) and X11 (WM_CLASS). Verify the running
  app_id is actually `agaric` once (Tauri's own bundler emits
  `StartupWMClass=agaric`, so this should hold).
- Keep `scripts/fix-appimage-icons.sh` — it fixes the in-AppImage `.DirIcon`
  (for thumbnail generators that *do* read it) and dedupes libs; it's complementary, not
  replaced.

## Cost / Impact / Risk

- **Cost:** S (~3-5 h). One Linux-only setup function + a few unit tests
  (Exec-drift rewrite, guard skips when `APPIMAGE` unset).
- **Impact:** Fixes the AppImage icon in Nautilus and the GNOME dash for every
  user with zero manual steps and no extra dependency.
- **Risk:** Low. Env-guarded to AppImage-only; writes only under
  `~/.local/share`; best-effort cache refresh. No effect on deb/rpm/macOS/
  Windows/Android.
