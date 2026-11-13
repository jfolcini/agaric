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

/// `app_settings` key: `"true"` when the attachments pages link are copied
/// into the folder ([`super::assets`]). Absent, they are not.
const COPY_FILES_KEY: &str = "mirror.copy_files";
/// `app_settings` key: the ids of the spaces not mirrored, as a JSON array.
/// Absent, every space is, a new one included.
const UNMIRRORED_KEY: &str = "mirror.unmirrored_spaces";

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
    /// Whether the attachments pages link are copied into the folder.
    pub copy_files: bool,
    /// The spaces neither written nor read, every other one being both.
    pub unmirrored: Vec<String>,
}

pub async fn settings(pool: &SqlitePool) -> Result<Settings, AppError> {
    let rows = sqlx::query!(
        "SELECT key, value FROM app_settings WHERE key IN (?, ?, ?, ?)",
        FOLDER_KEY,
        READ_BACK_KEY,
        COPY_FILES_KEY,
        UNMIRRORED_KEY,
    )
    .fetch_all(pool)
    .await?;
    let value = |key: &str| {
        rows.iter()
            .find(|row| row.key == key)
            .map(|row| row.value.clone())
    };
    // Unreadable, it stops the mirror rather than mirror a space by mistake.
    let unmirrored = match value(UNMIRRORED_KEY) {
        Some(json) => serde_json::from_str(&json).map_err(|e| {
            AppError::validation(format!(
                "the mirror's unmirrored spaces cannot be read: {e}"
            ))
        })?,
        None => Vec::new(),
    };
    Ok(Settings {
        folder: value(FOLDER_KEY),
        read_back: value(READ_BACK_KEY).as_deref() != Some("false"),
        copy_files: value(COPY_FILES_KEY).as_deref() == Some("true"),
        unmirrored,
    })
}

pub async fn set_unmirrored(pool: &SqlitePool, spaces: &[String]) -> Result<(), AppError> {
    let value = serde_json::to_string(spaces)?;
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        UNMIRRORED_KEY,
        value,
        now,
    )
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn set_read_back(pool: &SqlitePool, read_back: bool) -> Result<(), AppError> {
    set_flag(pool, READ_BACK_KEY, read_back).await
}

pub async fn set_copy_files(pool: &SqlitePool, copy_files: bool) -> Result<(), AppError> {
    set_flag(pool, COPY_FILES_KEY, copy_files).await
}

async fn set_flag(pool: &SqlitePool, key: &str, on: bool) -> Result<(), AppError> {
    let value = if on { "true" } else { "false" };
    let now = crate::db::now_ms();
    sqlx::query!(
        "INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at",
        key,
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
    write_atomic_over(path, bytes, || true).map(drop)
}

/// [`write_atomic`] over a file another program may save: once the bytes are
/// synced, `unchanged` says whether the file at `path` is still the one the
/// caller read, and one that is not is left as it is. Returns the file's
/// metadata as written, read from the temporary file before the rename;
/// `None` when nothing was written.
///
/// A save landing between that answer and the rename is still written over:
/// the check narrows the window to that gap, and does not close it.
pub fn write_atomic_over(
    path: &Path,
    bytes: &[u8],
    unchanged: impl FnOnce() -> bool,
) -> std::io::Result<Option<std::fs::Metadata>> {
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other(format!("{} names no file", path.display())))?;
    let temp = path.with_file_name(format!(".{}.agaric-tmp", name.to_string_lossy()));
    let written = std::fs::File::create(&temp)
        .and_then(|mut file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        // By path once closed, as the mirror's scan stats the file.
        .and_then(|()| std::fs::metadata(&temp));
    let renamed = written.and_then(|written| {
        if !unchanged() {
            return Ok(None);
        }
        std::fs::rename(&temp, path).map(|()| Some(written))
    });
    if !matches!(renamed, Ok(Some(_))) {
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

/// The per-page state files of the folder the mirror writes:
/// `mirror/folders/<key>/<PAGE_ID>.json` in the app data dir, one directory
/// per folder, so a page whose file another folder held is never read as one
/// whose file vanished from this one, and coming back to a folder finds its
/// files as it left them. Binding moves nothing, so a crash cannot lose them.
pub struct StateDir {
    base: PathBuf,
    folder: Option<String>,
    dir: Option<PathBuf>,
}

impl StateDir {
    /// Bound to no folder: it loads nothing and saves nothing.
    pub fn new(app_data_dir: &Path) -> Self {
        Self {
            base: app_data_dir.join("mirror"),
            folder: None,
            dir: None,
        }
    }

    fn file(&self, page_id: &str) -> std::io::Result<PathBuf> {
        let dir = self
            .dir
            .as_ref()
            .ok_or_else(|| std::io::Error::other("the mirror's states are bound to no folder"))?;
        Ok(dir.join(format!("{page_id}.json")))
    }

    /// Every page's state. A file that does not parse is skipped with a
    /// warning: its page is then written as a new one, which the guard keeps
    /// from overwriting a file that differs.
    pub fn load(&self) -> std::io::Result<HashMap<String, PageState>> {
        let mut states = HashMap::new();
        let Some(dir) = &self.dir else {
            return Ok(states);
        };
        let entries = match std::fs::read_dir(dir) {
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
        let file = self.file(page_id)?;
        std::fs::create_dir_all(file.parent().unwrap_or(&file))?;
        write_atomic(&file, &serde_json::to_vec(state)?)?;
        Ok(())
    }

    pub fn delete(&self, page_id: &str) -> std::io::Result<()> {
        match std::fs::remove_file(self.file(page_id)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }

    fn dir_for(&self, folder: &str) -> PathBuf {
        let key = blake3::hash(folder.as_bytes()).to_hex();
        self.base.join("folders").join(&key[..32])
    }

    /// Bind the states to `folder`'s. Returns whether they changed.
    pub fn bind(&mut self, folder: &str) -> std::io::Result<bool> {
        if self.folder.as_deref() == Some(folder) {
            return Ok(false);
        }
        self.adopt_legacy(folder)?;
        self.dir = Some(self.dir_for(folder));
        self.folder = Some(folder.to_owned());
        Ok(true)
    }

    /// Drop `folder`'s states: the mirror then writes every page there as
    /// new, which the guard keeps from overwriting a file that differs.
    pub fn forget(&self, folder: &str) -> std::io::Result<()> {
        remove_dir_if_any(&self.dir_for(folder))
    }

    /// States written before each folder kept its own directory, in
    /// `mirror/state`: they are the folder `mirror/folder` names, or, naming
    /// none, `folder`'s. Each step can be repeated, so a crash between them
    /// is finished on the next bind.
    fn adopt_legacy(&self, folder: &str) -> std::io::Result<()> {
        let legacy = self.base.join("state");
        let named = self.base.join("folder");
        if legacy.exists() {
            let owner = match std::fs::read_to_string(&named) {
                Ok(owner) => owner,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => folder.to_owned(),
                Err(e) => return Err(e),
            };
            let target = self.dir_for(&owner);
            if target.exists() {
                tracing::warn!(
                    legacy = %legacy.display(),
                    "mirror states of an earlier layout left in place: the folder has its own"
                );
                return Ok(());
            }
            std::fs::create_dir_all(self.base.join("folders"))?;
            match std::fs::rename(&legacy, &target) {
                // Adopted meanwhile by the status's own bind.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                renamed => renamed?,
            }
        }
        match std::fs::remove_file(&named) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

fn remove_dir_if_any(dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(dir) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
