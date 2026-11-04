//! The outbound Markdown mirror (#5363 slice 1): every live page of every
//! space written to a folder the user picks, as `<space>/<title>.md`, in the
//! form [`get_page_file_inner`] renders, on desktop.
//!
//! One task polls every [`TICK`]. It writes the pages this device's own ops
//! touched since its watermark, an `op_log` `seq` (never a timestamp: a
//! peer's op carries its own), the pages a sync reported, and the pages whose
//! path or title changed, with the pages linking to them. A full pass over
//! every page runs at start, when the folder is set, when the mirror resumes,
//! after a sync that names no pages, and every [`BACKSTOP`], and catches what
//! the dirty set cannot see: a purge, a tag's rename. The task reads through
//! the reader pool and takes no write connection.
//!
//! It never overwrites a file it did not write: a file whose bytes are not the
//! last text written for its page is left alone and listed as diverged (or
//! adopted when it already holds the render, as after a crash between the file
//! and its state). A page's file is moved when its path changes and removed
//! when the page is gone, each only while it is unchanged. While the folder or
//! its marker is missing, the mirror writes nothing and creates nothing.

pub mod paths;
pub mod store;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_sync::sync_events::SyncEvent;

use crate::commands::pages::get_page_file_inner;
use store::{PageState, Shadow, StateDir};

/// How often the mirror looks for pages to write.
const TICK: Duration = Duration::from_secs(2);

/// How often a full pass runs when nothing else asks for one.
const BACKSTOP: Duration = Duration::from_secs(3600);

/// A page's file, by its path below the mirror's folder, `/`-separated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct MirrorFile {
    pub page_id: String,
    pub path: String,
}

/// A page whose file could not be written, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct MirrorFailure {
    pub page_id: String,
    pub path: String,
    pub message: String,
}

/// What the mirror is doing (#5363).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct MirrorStatus {
    /// `false` where the mirror does not run, on mobile.
    pub supported: bool,
    /// The folder pages are written to; `None` when the mirror is off.
    pub folder: Option<String>,
    /// Why nothing is written while the folder is set, if nothing is.
    pub paused: Option<String>,
    /// Files changed outside Agaric, which it leaves alone: their pages are
    /// not written until the file is what Agaric last wrote again.
    pub diverged: Vec<MirrorFile>,
    pub failed: Vec<MirrorFailure>,
    /// When the last pass ended, in ms since the epoch.
    pub last_pass_ms: Option<i64>,
}

/// What the mirror's task shares with the commands and the sync sink.
#[derive(Clone)]
pub struct MirrorState(Arc<Shared>);

struct Shared {
    app_data_dir: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    synced: HashSet<String>,
    full_pass: bool,
    paused: Option<String>,
    /// Why the task could not start, until it does: no [`MirrorState::restart`]
    /// clears it.
    start_error: Option<String>,
    diverged: BTreeMap<String, String>,
    failed: BTreeMap<String, (String, String)>,
    last_pass_ms: Option<i64>,
}

impl MirrorState {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self(Arc::new(Shared {
            app_data_dir,
            inner: Mutex::new(Inner::default()),
        }))
    }

    pub fn app_data_dir(&self) -> &Path {
        &self.0.app_data_dir
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0
            .inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Pages a sync changed, written on the next tick. A sync that names
    /// none, a snapshot catch-up, asks for a full pass, unless it changed
    /// nothing.
    pub fn note_sync(&self, page_ids: &[String], changed_blocks: Option<usize>) {
        let mut inner = self.lock();
        if !page_ids.is_empty() {
            inner.synced.extend(page_ids.iter().cloned());
        } else if changed_blocks != Some(0) {
            inner.full_pass = true;
        }
    }

    /// Start over in a new folder: forget the old one's diverged and failed
    /// files and run a full pass on the next tick.
    pub fn restart(&self) {
        let mut inner = self.lock();
        inner.full_pass = true;
        inner.paused = None;
        inner.diverged.clear();
        inner.failed.clear();
    }

    /// The status, for `folder`, the mirror's folder setting.
    pub fn status(&self, folder: Option<String>) -> MirrorStatus {
        let inner = self.lock();
        let on = folder.is_some();
        MirrorStatus {
            supported: cfg!(desktop),
            folder,
            paused: inner
                .start_error
                .clone()
                .or_else(|| inner.paused.clone())
                .filter(|_| on),
            diverged: inner
                .diverged
                .iter()
                .filter(|_| on)
                .map(|(page_id, path)| MirrorFile {
                    page_id: page_id.clone(),
                    path: path.clone(),
                })
                .collect(),
            failed: inner
                .failed
                .iter()
                .filter(|_| on)
                .map(|(page_id, (path, message))| MirrorFailure {
                    page_id: page_id.clone(),
                    path: path.clone(),
                    message: message.clone(),
                })
                .collect(),
            last_pass_ms: inner.last_pass_ms,
        }
    }

    fn take_synced(&self) -> (HashSet<String>, bool) {
        let mut inner = self.lock();
        let full = std::mem::take(&mut inner.full_pass);
        (std::mem::take(&mut inner.synced), full)
    }

    fn set_paused(&self, reason: Option<String>) {
        self.lock().paused = reason;
    }

    fn set_start_error(&self, reason: Option<String>) {
        self.lock().start_error = reason;
    }

    /// The pages listed as diverged or failed, written again each tick: the
    /// guard in [`Mirror::try_write_page`] keeps a diverged file until it is
    /// what Agaric wrote, and a failed write may succeed now.
    fn retried(&self) -> Vec<String> {
        let inner = self.lock();
        inner
            .diverged
            .keys()
            .chain(inner.failed.keys())
            .cloned()
            .collect()
    }

    fn page_ok(&self, page_id: &str) {
        let mut inner = self.lock();
        inner.diverged.remove(page_id);
        inner.failed.remove(page_id);
    }

    fn page_diverged(&self, page_id: &str, path: &str) {
        let mut inner = self.lock();
        inner.failed.remove(page_id);
        inner.diverged.insert(page_id.to_owned(), path.to_owned());
    }

    fn page_failed(&self, page_id: &str, path: &str, error: &dyn std::fmt::Display) {
        let mut inner = self.lock();
        inner.diverged.remove(page_id);
        let failure = (path.to_owned(), error.to_string());
        if inner.failed.insert(page_id.to_owned(), failure).is_none() {
            tracing::warn!(page_id, error = %error, "the Markdown mirror cannot write a page");
        }
    }

    fn passed(&self, full: bool, pages: &HashSet<String>) {
        let mut inner = self.lock();
        if full {
            inner.diverged.retain(|id, _| pages.contains(id));
            inner.failed.retain(|id, _| pages.contains(id));
        }
        inner.last_pass_ms = Some(crate::db::now_ms());
    }
}

/// Feed a completed sync's pages to the mirror, when the app runs one.
pub fn on_sync_event<R: tauri::Runtime>(app: &tauri::AppHandle<R>, event: &SyncEvent) {
    use tauri::Manager;
    if let SyncEvent::Complete {
        changed_page_ids,
        changed_blocks,
        ..
    } = event
        && let Some(mirror) = app.try_state::<MirrorState>()
    {
        mirror.note_sync(changed_page_ids, *changed_blocks);
    }
}

/// Why the mirror writes nothing to `root`, if it does not: the folder is
/// missing (an unmounted drive), or its marker is missing or names another
/// device.
fn pause_reason(root: &Path, device_id: &str) -> Option<String> {
    if !root.is_dir() {
        return Some(format!("the folder {} is missing", root.display()));
    }
    match store::marker_device(root) {
        Ok(Some(owner)) if owner == device_id => None,
        Ok(Some(_)) => Some(format!(
            "the folder's {} marker names another device",
            store::MARKER_NAME
        )),
        Ok(None) => Some(format!("the folder has no {} marker", store::MARKER_NAME)),
        Err(e) => Some(format!("the folder's marker cannot be read: {e}")),
    }
}

/// Refuse `folder` as the mirror's unless it is an absolute path to an
/// existing folder, apart from the app's data, and either this device's
/// mirror already or empty: picking a vault or a home folder must not let the
/// mirror write among files it did not write.
///
/// # Errors
///
/// [`AppError::Validation`] naming what is wrong with the folder.
pub fn check_folder(folder: &Path, device_id: &str, app_data_dir: &Path) -> Result<(), AppError> {
    let refuse = |why: &str| Err(AppError::validation(why.to_owned()));
    let unreadable = |e: std::io::Error| {
        AppError::validation(format!("cannot read the folder {}: {e}", folder.display()))
    };
    if !folder.is_absolute() {
        return refuse("the mirror folder must be an absolute path");
    }
    if !folder.is_dir() {
        return refuse("the mirror folder must be an existing folder");
    }
    let canonical = folder.canonicalize().map_err(unreadable)?;
    let data = app_data_dir
        .canonicalize()
        .unwrap_or_else(|_| app_data_dir.to_path_buf());
    if canonical.starts_with(&data) || data.starts_with(&canonical) {
        return refuse("the mirror folder cannot hold Agaric's data or be inside it");
    }
    match store::marker_device(folder).map_err(unreadable)? {
        Some(owner) if owner == device_id => Ok(()),
        Some(_) => refuse("that folder is another device's mirror"),
        None if std::fs::read_dir(folder)
            .map_err(unreadable)?
            .next()
            .is_none() =>
        {
            Ok(())
        }
        None => refuse("the mirror folder must be empty, or one this device already mirrors to"),
    }
}

/// Run the mirror's task on Tauri's runtime for the life of the app.
pub fn spawn(pool: SqlitePool, device_id: String, state: MirrorState) {
    tauri::async_runtime::spawn(async move {
        let mut mirror = None;
        loop {
            tokio::time::sleep(TICK).await;
            let mirror = match &mut mirror {
                Some(mirror) => mirror,
                None => match Mirror::open(pool.clone(), device_id.clone(), state.clone()).await {
                    Ok(opened) => {
                        state.set_start_error(None);
                        mirror.insert(opened)
                    }
                    Err(e) => {
                        let why = format!("the mirror could not start: {e}");
                        if state.lock().start_error.as_ref() != Some(&why) {
                            tracing::error!(error = %e, "the Markdown mirror could not start");
                        }
                        state.set_start_error(Some(why));
                        continue;
                    }
                },
            };
            if let Err(e) = mirror.tick().await {
                tracing::warn!(error = %e, "Markdown mirror pass failed");
            }
        }
    });
}

/// A live page's place in the mirror: its path below the folder and its
/// title.
type Layout = HashMap<String, (String, String)>;

/// The mirror's task: what it last wrote, and how far it has read the op log.
pub struct Mirror {
    pool: SqlitePool,
    device_id: String,
    state: MirrorState,
    store: StateDir,
    /// Each page's file as last written, from its state file.
    pages: HashMap<String, PageState>,
    /// The layout of the last pass, to tell which pages it renamed.
    layout: Layout,
    watermark: i64,
    full_due: bool,
    last_full: Option<Instant>,
}

impl Mirror {
    /// The task, from the state files, with its watermark at this device's
    /// last op: the first tick's full pass writes what came before.
    ///
    /// # Errors
    ///
    /// The state files cannot be listed, or the op log cannot be read.
    pub async fn open(
        pool: SqlitePool,
        device_id: String,
        state: MirrorState,
    ) -> Result<Self, AppError> {
        let store = StateDir::new(state.app_data_dir());
        let pages = store.load()?;
        let watermark = own_head(&pool, &device_id).await?;
        Ok(Self {
            pool,
            device_id,
            state,
            store,
            pages,
            layout: Layout::new(),
            watermark,
            full_due: true,
            last_full: None,
        })
    }

    /// Write what changed since the last tick, or every page when a full pass
    /// is due; nothing while the mirror is off or paused.
    ///
    /// # Errors
    ///
    /// A read of the database fails; one after the dirty pages were taken
    /// makes the next tick a full pass. A page that cannot be written is
    /// listed as failed instead.
    pub async fn tick(&mut self) -> Result<(), AppError> {
        // Off or paused, the watermark stays put: the pass that resumes is a
        // full one.
        let Some(folder) = store::folder(&self.pool).await? else {
            self.state.set_paused(None);
            self.full_due = true;
            return Ok(());
        };
        let root = PathBuf::from(folder);
        let paused = pause_reason(&root, &self.device_id);
        let resumed = paused.is_none();
        self.state.set_paused(paused);
        if !resumed {
            self.full_due = true;
            return Ok(());
        }
        let touched = self.touched_since_watermark().await?;
        let (mut dirty, full_requested) = self.state.take_synced();
        self.full_due |= full_requested;
        dirty.extend(self.state.retried());
        let full = self.full_due || self.last_full.is_none_or(|at| at.elapsed() >= BACKSTOP);
        if !full && touched.is_none() && dirty.is_empty() {
            return Ok(());
        }
        dirty.extend(touched.unwrap_or_default());
        let passed = self.pass(&root, full, dirty).await;
        if passed.is_err() {
            // The watermark moved and the synced pages were taken.
            self.full_due = true;
        }
        passed
    }

    /// The pages this device's ops since the watermark touched, the source
    /// page of a move among them, with the watermark moved past those ops;
    /// `None` when there were none. A soft-deleted block still names its page.
    async fn touched_since_watermark(&mut self) -> Result<Option<HashSet<String>>, AppError> {
        let head = own_head(&self.pool, &self.device_id).await?;
        if head <= self.watermark {
            return Ok(None);
        }
        let pages = sqlx::query_scalar!(
            r#"SELECT b.page_id AS "page_id!: String"
                 FROM op_log o JOIN blocks b ON b.id = o.block_id
                WHERE o.device_id = ?1 AND o.seq > ?2 AND o.seq <= ?3
                  AND b.page_id IS NOT NULL
               UNION
               SELECT p.page_id
                 FROM op_log o JOIN blocks p ON p.id = json_extract(o.payload, '$.prior.parent_id')
                WHERE o.device_id = ?1 AND o.seq > ?2 AND o.seq <= ?3
                  AND o.op_type = 'move_block' AND p.page_id IS NOT NULL"#,
            self.device_id,
            self.watermark,
            head,
        )
        .fetch_all(&self.pool)
        .await?;
        self.watermark = head;
        Ok(Some(pages.into_iter().collect()))
    }

    /// One pass: `dirty`, the pages renamed since the last pass and those
    /// linking to them, and every page whose file is not where the layout
    /// puts it, or with `full` every page.
    async fn pass(
        &mut self,
        root: &Path,
        full: bool,
        mut dirty: HashSet<String>,
    ) -> Result<(), AppError> {
        let layout = self.load_layout().await?;
        let renamed: Vec<String> = layout
            .iter()
            .filter(|(id, now)| self.layout.get(*id).is_some_and(|before| before != *now))
            .map(|(id, _)| id.clone())
            .collect();
        dirty.extend(self.linking_pages(&renamed).await?);
        dirty.extend(renamed);
        dirty.extend(self.pages.iter().filter_map(|(id, state)| {
            let placed = layout.get(id).is_some_and(|(path, _)| *path == state.path);
            (!placed).then(|| id.clone())
        }));
        if full {
            dirty.extend(layout.keys().cloned());
            dirty.extend(self.pages.keys().cloned());
        }
        let mut dirty: Vec<String> = dirty.into_iter().collect();
        dirty.sort_unstable();
        let frozen = self.vacate(root, &layout, &dirty);
        for id in &dirty {
            if let Some((path, _)) = layout.get(id)
                && !frozen.contains(id)
                && !self.write_page(root, id, path).await
            {
                self.full_due = true;
                return Ok(());
            }
        }
        self.layout = layout;
        if full {
            self.full_due = false;
            self.last_full = Some(Instant::now());
        }
        let known: HashSet<String> = self
            .pages
            .keys()
            .chain(self.layout.keys())
            .cloned()
            .collect();
        self.state.passed(full, &known);
        Ok(())
    }

    /// Every live page of every space, laid out by [`paths::layout`].
    async fn load_layout(&self) -> Result<Layout, AppError> {
        let spaces: Vec<(String, String)> = crate::commands::spaces::list_spaces_inner(&self.pool)
            .await?
            .into_iter()
            .map(|space| (space.id, space.name))
            .collect();
        let mut pages = Vec::new();
        for (space_id, _) in &spaces {
            let listed =
                crate::commands::pages::list_all_pages_in_space_inner(&self.pool, space_id, None)
                    .await?;
            pages.extend(listed.into_iter().map(|page| paths::PageEntry {
                id: page.id.into_string(),
                space_id: space_id.clone(),
                title: page.content.unwrap_or_default(),
            }));
        }
        let mut paths = paths::layout(&spaces, &pages);
        Ok(pages
            .into_iter()
            .filter_map(|page| Some((page.id.clone(), (paths.remove(&page.id)?, page.title))))
            .collect())
    }

    /// The live pages holding a link to one of `pages`, which a rename
    /// changes the text of.
    async fn linking_pages(&self, pages: &[String]) -> Result<Vec<String>, AppError> {
        if pages.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(pages)?;
        Ok(sqlx::query_scalar!(
            r#"SELECT DISTINCT s.page_id AS "page_id!: String"
                 FROM block_links l JOIN blocks s ON s.id = l.source_id
                WHERE l.target_id IN (SELECT value FROM json_each(?1))
                  AND s.deleted_at IS NULL AND s.page_id IS NOT NULL"#,
            ids,
        )
        .fetch_all(&self.pool)
        .await?)
    }

    /// Clear the way for the layout: each of `dirty` whose file is not where
    /// the layout puts it, or that is gone, has its file removed while it is
    /// still the text last written, and a gone page its state too. Returns the
    /// pages left where they are, because their file changed outside Agaric or
    /// could not be removed.
    fn vacate(&mut self, root: &Path, layout: &Layout, dirty: &[String]) -> HashSet<String> {
        let mut frozen = HashSet::new();
        for id in dirty {
            let Some(state) = self.pages.get(id) else {
                continue;
            };
            let target = layout.get(id).map(|(path, _)| path);
            if target == Some(&state.path) {
                continue;
            }
            let old = root.join(&state.path);
            let newest = state.newest().map(|shadow| shadow.text.as_bytes());
            let removed = match store::read_optional(&old) {
                Ok(Some(bytes)) if Some(bytes.as_slice()) != newest => {
                    self.state.page_diverged(id, &state.path);
                    frozen.insert(id.clone());
                    continue;
                }
                Ok(Some(_)) => remove_with_empty_folders(root, &old),
                Ok(None) => Ok(()),
                Err(e) => Err(e),
            };
            if let Err(e) = removed {
                self.state.page_failed(id, &state.path, &e);
                frozen.insert(id.clone());
            } else if target.is_none() {
                self.forget(id);
            }
        }
        frozen
    }

    fn forget(&mut self, page_id: &str) {
        self.pages.remove(page_id);
        self.state.page_ok(page_id);
        if let Err(e) = self.store.delete(page_id) {
            tracing::warn!(page_id, error = %e, "cannot delete a mirror state file");
        }
    }

    /// Write the page and list it by the outcome; `false` when the mirror
    /// paused, which ends the pass.
    async fn write_page(&mut self, root: &Path, page_id: &str, path: &str) -> bool {
        match self.try_write_page(root, page_id, path).await {
            Ok(Wrote::Done) => self.state.page_ok(page_id),
            Ok(Wrote::Diverged) => self.state.page_diverged(page_id, path),
            Ok(Wrote::Paused(why)) => {
                self.state.set_paused(Some(why));
                return false;
            }
            Err(e) => self.state.page_failed(page_id, path, &e),
        }
        true
    }

    /// Write the page's render at `path`, unless a file there differs from
    /// both the render and the text last written at `path`: then leave it. A
    /// file that already holds the render is adopted. Nothing is created
    /// unless the folder still holds this device's marker, which a drive
    /// unmounted mid-pass does not. The file is written before the state, so
    /// a crash between the two leaves a file the next pass adopts.
    async fn try_write_page(
        &mut self,
        root: &Path,
        page_id: &str,
        path: &str,
    ) -> Result<Wrote, AppError> {
        let file = match get_page_file_inner(&self.pool, page_id).await {
            Ok(file) => file,
            Err(AppError::NotFound(_)) => return Ok(Wrote::Done),
            Err(e) => return Err(e),
        };
        let target = root.join(path);
        let state = self.pages.get(page_id).filter(|state| state.path == path);
        let newest = state.and_then(PageState::newest);
        match store::read_optional(&target)? {
            Some(bytes) if bytes == file.text.as_bytes() => {}
            Some(bytes) if newest.is_none_or(|shadow| shadow.text.as_bytes() != bytes) => {
                return Ok(Wrote::Diverged);
            }
            _ => {
                if let Some(why) = pause_reason(root, &self.device_id) {
                    return Ok(Wrote::Paused(why));
                }
                create_folders_below(root, path)?;
                store::write_atomic(&target, file.text.as_bytes())?;
            }
        }
        let shadow = Shadow {
            text: file.text,
            line_ids: file.line_ids,
        };
        if newest == Some(&shadow) {
            return Ok(Wrote::Done);
        }
        let mut state = self
            .pages
            .get(page_id)
            .cloned()
            .unwrap_or_else(|| PageState {
                path: path.to_owned(),
                shadows: Vec::new(),
            });
        state.record(path.to_owned(), shadow);
        // Saved first, so a failed save leaves memory with the disk's state.
        self.store.save(page_id, &state)?;
        self.pages.insert(page_id.to_owned(), state);
        Ok(Wrote::Done)
    }
}

/// How [`Mirror::try_write_page`] left a page.
enum Wrote {
    Done,
    Diverged,
    /// The folder lost its marker; nothing was written.
    Paused(String),
}

/// This device's last op `seq`, `0` before its first.
async fn own_head(pool: &SqlitePool, device_id: &str) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT COALESCE(MAX(seq), 0) AS "seq!: i64" FROM op_log WHERE device_id = ?"#,
        device_id,
    )
    .fetch_one(pool)
    .await?)
}

/// Create the folders `path`'s file sits in, one at a time below `root` and
/// never `root` itself, so a vanished mirror folder makes the first fail.
fn create_folders_below(root: &Path, path: &str) -> std::io::Result<()> {
    let mut folder = root.to_path_buf();
    for part in Path::new(path)
        .parent()
        .into_iter()
        .flat_map(Path::components)
    {
        folder.push(part);
        if let Err(e) = std::fs::create_dir(&folder)
            && e.kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err(e);
        }
    }
    Ok(())
}

/// Remove `file`, then each folder above it that it leaves empty, up to
/// `root`.
fn remove_with_empty_folders(root: &Path, file: &Path) -> std::io::Result<()> {
    std::fs::remove_file(file)?;
    let mut folder = file.parent();
    while let Some(dir) = folder.filter(|dir| *dir != root && dir.starts_with(root)) {
        if std::fs::remove_dir(dir).is_err() {
            break;
        }
        folder = dir.parent();
    }
    Ok(())
}

#[cfg(test)]
mod tests;
