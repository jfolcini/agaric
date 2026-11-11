//! What the Markdown mirror (#5363) keeps: the folder setting, the marker in
//! the folder naming the device that writes it, and a state file per page in
//! the app data dir, outside the folder, holding the path and the texts last
//! written there. Every file goes through [`write_atomic`].

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use agaric_core::error::AppError;

/// `app_settings` key: the mirror's folder, an absolute path. Absent, the
/// mirror is off.
const FOLDER_KEY: &str = "mirror.folder";

/// `app_settings` key: `"false"` when files changed outside Agaric are not
/// read back. Absent, they are.
const READ_BACK_KEY: &str = "mirror.read_back";

/// The file in the mirror's folder that names the device writing it, so a
/// second device refuses the folder.
pub const MARKER_NAME: &str = ".agaric-mirror";

/// How many texts a page's state keeps, newest last.
const SHADOWS_KEPT: usize = 3;

/// The mirror's folder, `None` when the mirror is off.
pub async fn folder(pool: &SqlitePool) -> Result<Option<String>, AppError> {
    let value = sqlx::query_scalar!("SELECT value FROM app_settings WHERE key = ?", FOLDER_KEY)
        .fetch_optional(pool)
        .await?;
    Ok(value)
}

/// Store the mirror's folder, or with `None` turn the mirror off.
pub async fn set_folder(pool: &SqlitePool, folder: Option<&str>) -> Result<(), AppError> {
    let Some(folder) = folder else {
        sqlx::query!("DELETE FROM app_settings WHERE key = ?", FOLDER_KEY)
            .execute(pool)
            .await?;
        return Ok(());
    };
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        FOLDER_KEY,
        folder,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// The mirror's settings, read once per tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// `None` when the mirror is off.
    pub folder: Option<String>,
    /// Whether files changed outside Agaric are read back into Agaric.
    pub read_back: bool,
}

pub async fn settings(pool: &SqlitePool) -> Result<Settings, AppError> {
    let rows = sqlx::query!(
        "SELECT key, value FROM app_settings WHERE key IN (?, ?)",
        FOLDER_KEY,
        READ_BACK_KEY,
    )
    .fetch_all(pool)
    .await?;
    let value = |key: &str| {
        rows.iter()
            .find(|row| row.key == key)
            .map(|row| row.value.clone())
    };
    Ok(Settings {
        folder: value(FOLDER_KEY),
        read_back: value(READ_BACK_KEY).as_deref() != Some("false"),
    })
}

pub async fn set_read_back(pool: &SqlitePool, read_back: bool) -> Result<(), AppError> {
    let value = if read_back { "true" } else { "false" };
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        READ_BACK_KEY,
        value,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// The device the folder's marker names, `None` when it has none.
pub fn marker_device(root: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(root.join(MARKER_NAME)) {
        Ok(text) => Ok(Some(text.trim().to_owned())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn write_marker(root: &Path, device_id: &str) -> std::io::Result<()> {
    write_atomic(&root.join(MARKER_NAME), format!("{device_id}\n").as_bytes())
}

/// `bytes` at `path`, all or nothing: written to a temporary file beside it,
/// synced, then renamed over it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other(format!("{} names no file", path.display())))?;
    let temp = path.with_file_name(format!(".{}.agaric-tmp", name.to_string_lossy()));
    let written = std::fs::File::create(&temp).and_then(|mut file| {
        file.write_all(bytes)?;
        file.sync_all()
    });
    let renamed = written.and_then(|()| std::fs::rename(&temp, path));
    if renamed.is_err() {
        // The temporary file is ours; what failed is reported, not this.
        let _ = std::fs::remove_file(&temp);
    }
    renamed
}

/// `path`'s bytes, `None` when there is no file.
pub fn read_optional(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// One text the mirror wrote for a page: its exact bytes, and for each of its
/// lines the id of the block that starts there, `None` on every other line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shadow {
    pub text: String,
    pub line_ids: Vec<Option<String>>,
    /// The page's buffer from the read `text` was written from, the base an
    /// ingest saves against; `None` in a state written before ingests.
    #[serde(default)]
    pub buffer: Option<String>,
}

/// A page's file as the mirror last wrote it: the path below the folder,
/// `/`-separated, and the last texts written, newest last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageState {
    pub path: String,
    pub shadows: Vec<Shadow>,
}

impl PageState {
    pub fn newest(&self) -> Option<&Shadow> {
        self.shadows.last()
    }

    /// Record `shadow` as written at `path`, keeping the last
    /// `SHADOWS_KEPT` texts.
    pub fn record(&mut self, path: String, shadow: Shadow) {
        self.path = path;
        if self.newest() != Some(&shadow) {
            self.shadows.push(shadow);
        }
        let excess = self.shadows.len().saturating_sub(SHADOWS_KEPT);
        self.shadows.drain(..excess);
    }
}

/// The per-page state files: `mirror/state/<PAGE_ID>.json` in the app data
/// dir.
pub struct StateDir(PathBuf);

impl StateDir {
    pub fn new(app_data_dir: &Path) -> Self {
        Self(app_data_dir.join("mirror").join("state"))
    }

    fn file(&self, page_id: &str) -> PathBuf {
        self.0.join(format!("{page_id}.json"))
    }

    /// Every page's state. A file that does not parse is skipped with a
    /// warning: its page is then written as a new one, which the guard keeps
    /// from overwriting a file that differs.
    pub fn load(&self) -> std::io::Result<HashMap<String, PageState>> {
        let mut states = HashMap::new();
        let entries = match std::fs::read_dir(&self.0) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(states),
            Err(e) => return Err(e),
        };
        for entry in entries {
            let path = entry?.path();
            let Some(page_id) = path
                .file_name()
                .and_then(std::ffi::OsStr::to_str)
                .and_then(|n| n.strip_suffix(".json"))
            else {
                continue;
            };
            let parsed = std::fs::read(&path)
                .map_err(AppError::from)
                .and_then(|bytes| Ok(serde_json::from_slice::<PageState>(&bytes)?));
            match parsed {
                Ok(state) => {
                    states.insert(page_id.to_owned(), state);
                }
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "unreadable mirror state");
                }
            }
        }
        Ok(states)
    }

    pub fn save(&self, page_id: &str, state: &PageState) -> Result<(), AppError> {
        std::fs::create_dir_all(&self.0)?;
        write_atomic(&self.file(page_id), &serde_json::to_vec(state)?)?;
        Ok(())
    }

    pub fn delete(&self, page_id: &str) -> std::io::Result<()> {
        match std::fs::remove_file(self.file(page_id)) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    /// The file beside the states naming the folder their paths are below.
    fn folder_file(&self) -> PathBuf {
        self.0.with_file_name("folder")
    }

    /// Where the states of a folder other than the bound one are kept.
    fn kept_for(&self, folder: &str) -> PathBuf {
        let key = blake3::hash(folder.as_bytes()).to_hex();
        self.0.with_file_name("folders").join(&key[..32])
    }

    /// Bind the states to `folder`. When they were written below another
    /// folder, they are set aside for it and `folder`'s own, kept from when
    /// the mirror last wrote there, take their place, or none: a page whose
    /// file another folder held is never read as one whose file vanished
    /// from this one, and coming back finds the files as it left them.
    /// Returns whether the states changed. States that name no folder, as
    /// those written before the binding, are taken as `folder`'s.
    pub fn bind(&self, folder: &str) -> std::io::Result<bool> {
        let bound = match std::fs::read_to_string(self.folder_file()) {
            Ok(bound) => Some(bound),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => return Err(e),
        };
        if bound.as_deref() == Some(folder) {
            return Ok(false);
        }
        if let Some(bound) = &bound {
            let aside = self.kept_for(bound);
            remove_dir_if_any(&aside)?;
            std::fs::create_dir_all(aside.parent().unwrap_or(&aside))?;
            rename_if_any(&self.0, &aside)?;
            rename_if_any(&self.kept_for(folder), &self.0)?;
        }
        std::fs::create_dir_all(&self.0)?;
        write_atomic(&self.folder_file(), folder.as_bytes())?;
        Ok(bound.is_some())
    }
}

fn remove_dir_if_any(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

fn rename_if_any(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
