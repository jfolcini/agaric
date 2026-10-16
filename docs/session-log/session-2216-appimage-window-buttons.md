# Session 2216 — The AppImage's title bar shows the host's window buttons

The maintainer asked why Agaric has no minimize button. Agaric draws no title
bar of its own, so GTK draws one, and on Ubuntu GNOME the AppImage showed only
a close button.

Tauri's AppImage runs linuxdeploy-plugin-gtk's startup hook, which points
GSettings at the schemas bundled inside the AppImage. Those carry upstream
GNOME's `button-layout` default, `appmenu:close`. Ubuntu ships
`:minimize,maximize,close` as a vendor schema override rather than a dconf
value, so the bundled schema hid it. A PyGObject probe under the hook's
environment reproduced it: GTK read `menu:close`. The same key read through
the host's schema dirs gave `:minimize,maximize,close`. A layout the user set
explicitly was always honoured, because the dconf backend is bundled too.

`apply_host_decoration_layout_if_running` runs at boot, inside an AppImage
only, on the same `$APPIMAGE` guard as the desktop self-integration. It chains
a `SettingsSchemaSource` from the `XDG_DATA_DIRS` entries outside `$APPDIR`,
reads `button-layout` through it, and sets `gtk-decoration-layout`. It is
set once, so a layout changed while the app runs applies at the next launch.
A host with no GNOME schemas, such as KDE, logs at info and keeps GTK's
layout. `gtk` becomes a direct dependency at the version Tauri already
resolves, so nothing new is built.

Only the dir selection is unit-tested. Excluding by string prefix and keeping
empty entries each turned a test red. The debug binary ran under Xvfb with the
hook's environment, a private D-Bus session, a sandboxed data dir and moved
XDG dirs. It logged `layout=:minimize,maximize,close`, and a control run
without `$APPIMAGE` logged nothing. The user's running instance and desktop
launcher were left untouched. That run used the host's GTK and GLib, so a
rebuilt AppImage on GNOME Wayland is the final check.
