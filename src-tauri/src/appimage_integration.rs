//! AppImage first-run desktop self-integration (Linux only).
//!
//! A portable AppImage sitting in `~/Downloads` is never integrated into the
//! host's XDG desktop database unless `appimaged`/AppImageLauncher is running,
//! so GNOME/Nautilus show the generic executable cog instead of the app icon
//! (the embedded `.desktop`/icon are correct — CI simply can't write into each
//! user's `~/.local/share`). On startup we install an `agaric.desktop` launcher
//! plus the hicolor icons copied from the mounted AppDir and refresh the
//! caches.
//!
//! Guarded by `$APPIMAGE`, which is set *only* inside a running AppImage — that
//! single check excludes deb/rpm (already integrated by the package manager),
//! `cargo tauri dev`, and every non-Linux build. PEND-79.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Self-integrate the running AppImage into the host's XDG desktop dirs.
///
/// No-op unless `$APPIMAGE` and `$APPDIR` are both set (i.e. running from an
/// AppImage). Best-effort: every failure is logged, never fatal.
pub fn integrate_appimage_if_running() {
    run_integration(
        std::env::var_os("APPIMAGE"),
        std::env::var_os("APPDIR"),
        xdg_data_home(),
    );
}

/// Dependency-injected core so tests can exercise the guard and the file
/// writes without mutating the process environment.
fn run_integration(
    appimage: Option<OsString>,
    appdir: Option<OsString>,
    data_home: Option<PathBuf>,
) {
    let (Some(appimage), Some(appdir), Some(data_home)) = (appimage, appdir, data_home) else {
        return;
    };
    if appimage.is_empty() {
        return;
    }
    let appimage = appimage.to_string_lossy().into_owned();
    let appdir = PathBuf::from(appdir);

    match integrate(&appimage, &appdir, &data_home) {
        Ok(changed) if changed => {
            // The `.desktop`/icon files are already written above; the cache
            // refresh only re-reads those paths, so it is safe to detach.
            // `update-desktop-database`/`gtk-update-icon-cache` can be slow on
            // some desktops, and on first run / Exec-path drift this runs inside
            // the Tauri setup closure before pool init and recovery — so spawn
            // it off the boot critical path instead of blocking window setup.
            std::thread::spawn(move || refresh_caches(&data_home));
            tracing::info!("AppImage desktop integration installed/updated");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!(error = %e, "AppImage desktop integration failed"),
    }
}

/// Resolve `$XDG_DATA_HOME`, falling back to `$HOME/.local/share`.
fn xdg_data_home() -> Option<PathBuf> {
    match std::env::var_os("XDG_DATA_HOME") {
        Some(x) if !x.is_empty() => Some(PathBuf::from(x)),
        _ => std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")),
    }
}

/// Install/update the `.desktop` launcher and copy the hicolor icons.
/// Returns `true` if anything was written (so the caller refreshes caches);
/// `false` when everything was already current (idempotent re-run).
fn integrate(appimage: &str, appdir: &Path, data_home: &Path) -> std::io::Result<bool> {
    let mut changed = copy_icons(appdir, data_home)?;

    let apps_dir = data_home.join("applications");
    let desktop_path = apps_dir.join("agaric.desktop");
    let want = desktop_entry_contents(appimage);

    // Rewrite when missing or drifted (e.g. the user kept a newer AppImage at
    // a different path — last-launched wins). A byte compare keeps the common
    // re-launch path a cheap no-op.
    let needs_write = std::fs::read_to_string(&desktop_path)
        .map(|cur| cur != want)
        .unwrap_or(true);
    if needs_write {
        std::fs::create_dir_all(&apps_dir)?;
        std::fs::write(&desktop_path, &want)?;
        changed = true;
    }
    Ok(changed)
}

/// Escape an AppImage path for use in a freedesktop `Exec=` line.
///
/// Per the Desktop Entry Specification, the program path must be
/// double-quoted when it contains spaces or reserved characters.
/// Inside the quotes: `\`, `"`, `$`, and backtick are backslash-escaped;
/// a literal `%` becomes `%%` (field-code prefix in Exec values).
fn escape_exec_path(path: &str) -> String {
    let inner = path
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('$', "\\$")
        .replace('`', "\\`")
        .replace('%', "%%");
    format!("\"{inner}\"")
}

/// The freedesktop `.desktop` entry. Lowercase `agaric` `Icon`/`StartupWMClass`
/// so both Wayland (filename ↔ `app_id`) and X11 (`WM_CLASS`) resolve the icon.
fn desktop_entry_contents(appimage: &str) -> String {
    let exec = escape_exec_path(appimage);
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Agaric\n\
         Exec={exec} %u\n\
         Icon=agaric\n\
         StartupWMClass=agaric\n\
         Terminal=false\n\
         Categories=Office;\n\
         MimeType=x-scheme-handler/agaric;\n"
    )
}

/// Copy `agaric.png` for every hicolor size present in the mounted AppDir into
/// the user's icon theme. Returns `true` if any icon was added/updated.
fn copy_icons(appdir: &Path, data_home: &Path) -> std::io::Result<bool> {
    let src_hicolor = appdir.join("usr/share/icons/hicolor");
    let dst_hicolor = data_home.join("icons/hicolor");
    let mut changed = false;

    let Ok(entries) = std::fs::read_dir(&src_hicolor) else {
        return Ok(false);
    };
    for entry in entries.flatten() {
        let src_icon = entry.path().join("apps/agaric.png");
        if !src_icon.is_file() {
            continue;
        }
        let dst_dir = dst_hicolor.join(entry.file_name()).join("apps");
        let dst_icon = dst_dir.join("agaric.png");
        if files_equal(&src_icon, &dst_icon) {
            continue;
        }
        std::fs::create_dir_all(&dst_dir)?;
        std::fs::copy(&src_icon, &dst_icon)?;
        changed = true;
    }
    Ok(changed)
}

/// Byte-compare two files; `false` if either is unreadable (treat as differing
/// so the copy proceeds).
fn files_equal(a: &Path, b: &Path) -> bool {
    match (std::fs::read(a), std::fs::read(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}

/// Best-effort cache refresh so the new launcher/icon appear without a
/// re-login. Missing tools (minimal desktops) are ignored.
fn refresh_caches(data_home: &Path) {
    let _ = std::process::Command::new("update-desktop-database")
        .arg(data_home.join("applications"))
        .status();
    let _ = std::process::Command::new("gtk-update-icon-cache")
        .arg("-f")
        .arg("-t")
        .arg(data_home.join("icons/hicolor"))
        .status();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn seed_appdir(appdir: &Path, sizes: &[&str]) {
        for size in sizes {
            let dir = appdir
                .join("usr/share/icons/hicolor")
                .join(size)
                .join("apps");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("agaric.png"), format!("png-{size}")).unwrap();
        }
    }

    #[test]
    fn desktop_entry_has_expected_keys() {
        let c = desktop_entry_contents("/home/u/Downloads/Agaric.AppImage");
        assert!(c.contains("Exec=\"/home/u/Downloads/Agaric.AppImage\" %u"));
        assert!(c.contains("Icon=agaric"));
        assert!(c.contains("StartupWMClass=agaric"));
        assert!(c.contains("MimeType=x-scheme-handler/agaric;"));
    }

    #[test]
    fn escape_exec_path_handles_spaces_and_percent() {
        // Path with space: must be double-quoted so the launcher sees one arg.
        let escaped = escape_exec_path("/home/u/My Apps/Agaric.AppImage");
        assert_eq!(escaped, r#""/home/u/My Apps/Agaric.AppImage""#);

        // Path with %: must be doubled so the Exec parser treats it as literal.
        let escaped = escape_exec_path("/opt/100%/Agaric.AppImage");
        assert_eq!(escaped, r#""/opt/100%%/Agaric.AppImage""#);

        // Path with double-quote: must be backslash-escaped inside the quotes.
        let escaped = escape_exec_path("/opt/\"quoted\"/Agaric.AppImage");
        assert_eq!(escaped, r#""/opt/\"quoted\"/Agaric.AppImage""#);
    }

    #[test]
    fn integrate_writes_desktop_and_icons_when_missing() {
        let appdir = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        seed_appdir(appdir.path(), &["256x256", "128x128"]);

        let changed = integrate("/opt/Agaric.AppImage", appdir.path(), data.path()).unwrap();
        assert!(changed);

        let desktop = fs::read_to_string(data.path().join("applications/agaric.desktop")).unwrap();
        assert!(desktop.contains("Exec=\"/opt/Agaric.AppImage\" %u"));
        assert!(
            data.path()
                .join("icons/hicolor/256x256/apps/agaric.png")
                .is_file()
        );
        assert!(
            data.path()
                .join("icons/hicolor/128x128/apps/agaric.png")
                .is_file()
        );
    }

    #[test]
    fn integrate_second_run_is_noop() {
        let appdir = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        seed_appdir(appdir.path(), &["256x256"]);

        assert!(integrate("/opt/Agaric.AppImage", appdir.path(), data.path()).unwrap());
        assert!(!integrate("/opt/Agaric.AppImage", appdir.path(), data.path()).unwrap());
    }

    #[test]
    fn integrate_rewrites_on_exec_path_drift() {
        let appdir = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        seed_appdir(appdir.path(), &["256x256"]);

        assert!(integrate("/old/Agaric-0.1.AppImage", appdir.path(), data.path()).unwrap());
        let changed = integrate("/new/Agaric-0.2.AppImage", appdir.path(), data.path()).unwrap();
        assert!(changed);

        let desktop = fs::read_to_string(data.path().join("applications/agaric.desktop")).unwrap();
        assert!(desktop.contains("Exec=\"/new/Agaric-0.2.AppImage\" %u"));
        assert!(!desktop.contains("/old/Agaric-0.1.AppImage"));
    }

    #[test]
    fn run_integration_is_noop_without_appimage_env() {
        let data = TempDir::new().unwrap();
        run_integration(
            None,
            Some(OsString::from("/some/appdir")),
            Some(data.path().to_path_buf()),
        );
        assert!(!data.path().join("applications/agaric.desktop").exists());
    }

    #[test]
    fn run_integration_is_noop_with_empty_appimage() {
        let appdir = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        seed_appdir(appdir.path(), &["256x256"]);
        run_integration(
            Some(OsString::new()),
            Some(OsString::from(appdir.path())),
            Some(data.path().to_path_buf()),
        );
        assert!(!data.path().join("applications/agaric.desktop").exists());
    }
}
