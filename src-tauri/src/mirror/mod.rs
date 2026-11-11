//! The outbound Markdown mirror (#5363 slice 1): every live page of every
//! space written to a folder the user picks, as `<space>/<title>.md`, in the
//! form [`get_page_file_inner`] renders, on desktop.
//!
//! One task polls every `TICK`. It writes the pages this device's own ops
//! touched since its watermark, an `op_log` `seq` (never a timestamp: a
//! peer's op carries its own), the pages a sync reported, and the pages whose
//! path or title changed, with the pages linking to them. A full pass over
//! every page runs at start, when the folder is set, when the mirror resumes,
//! after a sync that names no pages, and every `BACKSTOP`, and catches what
//! the dirty set cannot see: a purge, a tag's rename. The task reads through
//! the reader pool and takes no write connection.
//!
//! It never overwrites a file it did not write: a file whose bytes are not the
//! last text written for its page is left alone and listed as diverged (or
//! adopted when it already holds the render, as after a crash between the file
//! and its state). A page's file is moved when its path changes and removed
//! when the page is gone, each only while it is unchanged. While the folder or
//! its marker is missing, the mirror writes nothing and creates nothing.

pub mod assets;
pub mod ingest;
pub mod paths;
pub mod read_back;
pub mod splice;
pub mod store;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_sync::sync_events::SyncEvent;

use crate::commands::pages::{PageFile, get_page_file_inner};
use ingest::{Ingest, NotIngested};
use store::{PageState, Shadow, StateDir};

/// How often the mirror looks for pages to write.
const TICK: Duration = Duration::from_secs(2);

/// How often a full pass runs when nothing else asks for one.
const BACKSTOP: Duration = Duration::from_secs(3600);

/// The ticks a page's file may be missing before it counts as gone: a file
/// renamed outside Agaric is found at its new path within them.
const MISSING_TICKS: u8 = 2;

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
    /// Whether files changed outside Agaric are read back into it.
    pub read_back: bool,
    /// While reading back is off, the files turning it on would read in
    /// ([`read_back::pending`]); empty while it is on.
    pub pending: Vec<String>,
    /// Whether the attachments pages link are copied into the folder
    /// ([`assets`]).
    pub copy_files: bool,
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
    /// New files no page owns that could not be read onto a page, by path.
    failed_files: BTreeMap<String, String>,
    /// Copies changed outside Agaric that are no longer wanted, left in
    /// place, by path.
    kept_copies: Vec<String>,
    /// Copies that could not be written, and why, by path.
    failed_copies: BTreeMap<String, String>,
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
        inner.failed_files.clear();
        inner.kept_copies.clear();
        inner.failed_copies.clear();
    }

    /// The status, for `settings`, with `pending` from [`read_back::pending`].
    pub fn status(&self, settings: store::Settings, pending: Vec<String>) -> MirrorStatus {
        let inner = self.lock();
        let store::Settings {
            folder,
            read_back,
            copy_files,
        } = settings;
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
                .chain(
                    inner
                        .kept_copies
                        .iter()
                        .filter(|_| on)
                        .map(|path| MirrorFile {
                            page_id: String::new(),
                            path: path.clone(),
                        }),
                )
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
                .chain(
                    inner
                        .failed_files
                        .iter()
                        .filter(|_| on)
                        .chain(&inner.failed_copies)
                        .map(|(path, message)| MirrorFailure {
                            page_id: String::new(),
                            path: path.clone(),
                            message: message.clone(),
                        }),
                )
                .collect(),
            last_pass_ms: inner.last_pass_ms,
            read_back,
            pending,
            copy_files,
        }
    }

    /// Keep the new files' failures listed only for `paths`, those still new.
    fn new_files_are(&self, paths: &[String]) {
        self.lock()
            .failed_files
            .retain(|path, _| paths.contains(path));
    }

    fn file_failed(&self, path: &str, why: &str) {
        let mut inner = self.lock();
        if inner
            .failed_files
            .insert(path.to_owned(), why.to_owned())
            .is_none()
        {
            tracing::warn!(path, why, "the Markdown mirror cannot read a new file");
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

    fn set_copies(&self, kept: Vec<String>, failed: BTreeMap<String, String>) {
        let mut inner = self.lock();
        inner.kept_copies = kept;
        inner.failed_copies = failed;
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

    fn is_diverged(&self, page_id: &str) -> bool {
        self.lock().diverged.contains_key(page_id)
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
pub fn spawn(pool: SqlitePool, device_id: String, state: MirrorState, ingest: Ingest) {
    tauri::async_runtime::spawn(async move {
        let mut mirror = None;
        loop {
            tokio::time::sleep(TICK).await;
            let mirror = match &mut mirror {
                Some(mirror) => mirror,
                None => match Mirror::open(pool.clone(), device_id.clone(), state.clone()).await {
                    Ok(opened) => {
                        state.set_start_error(None);
                        mirror.insert(opened.with_ingest(ingest.clone()))
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
    /// Writes a file's outside edit into its page; without it such a file
    /// is only left alone.
    ingest: Option<Ingest>,
    /// Whether files changed outside Agaric are read back, as of this tick.
    read_back: bool,
    /// Whether attachments are copied into the folder, as of this tick.
    copy_files: bool,
    /// The copies written ([`assets::Copies`]).
    copies: assets::Copies,
    /// The copies this pass's pages link, the ones a full pass keeps.
    linked_copies: HashSet<String>,
    /// Whether a page of this pass could not be rendered, so its copies are
    /// unknown and a full pass removes none for being unlinked.
    unrendered: bool,
    /// Copies that could not be written, and why, by path.
    copy_failed: BTreeMap<String, String>,
    /// Each page's file as last seen: a change outside Agaric makes the page
    /// dirty.
    stats: HashMap<String, FileStat>,
    /// The bytes of each file changed outside Agaric as the last tick read
    /// them: one is ingested only once two reads agree, so a save still
    /// being written is not.
    settling: HashMap<String, Vec<u8>>,
    /// The bytes an ingest refused, and why: refused again without a try
    /// until they change.
    refused: HashMap<String, (Vec<u8>, String)>,
    /// Each folder below the mirror's as last listed, re-listed only when
    /// its modification time changes.
    folders: HashMap<PathBuf, Listing>,
    /// As `settling` and `refused`, for new files no page owns, by path.
    settling_new: HashMap<String, Vec<u8>>,
    refused_new: HashMap<String, (Vec<u8>, String)>,
    /// The pages whose file vanished, by the ticks it has been missing.
    missing: HashMap<String, u8>,
    /// The pages whose file was renamed to a path a refusal keeps, by that
    /// path: held as missing while the refused file stays as it was.
    refused_renames: HashMap<String, String>,
}

/// A folder's listing: its modification time, its `.md` files as paths below
/// the mirror's folder, `/`-separated, and its folders. Hidden entries, the
/// marker and temporary files among them, are left out.
struct Listing {
    modified: Option<SystemTime>,
    files: Vec<String>,
    folders: Vec<PathBuf>,
}

impl Listing {
    fn of(root: &Path, folder: &Path, modified: Option<SystemTime>) -> Self {
        let mut listing = Self {
            modified,
            files: Vec::new(),
            folders: Vec::new(),
        };
        let Ok(entries) = std::fs::read_dir(folder) else {
            return listing;
        };
        for entry in entries.flatten() {
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                if !path.strip_prefix(root).is_ok_and(assets::is_copy_dir) {
                    listing.folders.push(path);
                }
            } else if name.ends_with(".md")
                && let Ok(below) = path.strip_prefix(root)
            {
                let parts: Vec<String> = below
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect();
                listing.files.push(parts.join("/"));
            }
        }
        listing
    }
}

/// A file's length and modification time, `None` while there is no file.
type FileStat = Option<(u64, Option<SystemTime>)>;

fn file_stat(path: &Path) -> FileStat {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
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
        let copies = assets::Copies::load(state.app_data_dir());
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
            ingest: None,
            read_back: true,
            copy_files: false,
            copies,
            linked_copies: HashSet::new(),
            unrendered: false,
            copy_failed: BTreeMap::new(),
            stats: HashMap::new(),
            settling: HashMap::new(),
            refused: HashMap::new(),
            folders: HashMap::new(),
            settling_new: HashMap::new(),
            refused_new: HashMap::new(),
            missing: HashMap::new(),
            refused_renames: HashMap::new(),
        })
    }

    /// The task, writing what a file is edited to outside Agaric into its
    /// page (#5363 slice 2).
    #[must_use]
    pub fn with_ingest(mut self, ingest: Ingest) -> Self {
        self.ingest = Some(ingest);
        self
    }

    /// What writes an outside edit into Agaric, unless reading back is off.
    fn ingest(&self) -> Option<Ingest> {
        self.ingest.clone().filter(|_| self.read_back)
    }

    /// The pages whose file changed since the mirror last saw it. One stat per
    /// mirrored file every tick, dirty or not: cheap at today's vault sizes. A
    /// vault large enough to feel it would gate this scan on a slower cadence.
    fn changed_files(&self, root: &Path) -> Vec<String> {
        self.pages
            .iter()
            .filter(|(id, state)| {
                self.stats
                    .get(*id)
                    .is_some_and(|seen| *seen != file_stat(&root.join(&state.path)))
            })
            .map(|(id, _)| id.clone())
            .collect()
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
        let settings = store::settings(&self.pool).await?;
        self.read_back = settings.read_back;
        if settings.copy_files != self.copy_files {
            // Every page's links change, and the copies go or come.
            self.copy_files = settings.copy_files;
            self.full_due = true;
        }
        let Some(folder) = settings.folder else {
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
        // New files first: an edit naming one, as Obsidian writes a link to a
        // note with the note, would otherwise make an empty page of that name.
        // A file that cannot be read stops no write.
        if let Err(e) = self.read_new_files(&root).await {
            tracing::warn!(error = %e, "the Markdown mirror cannot read its new files");
        }
        let touched = self.touched_since_watermark().await?;
        let (mut dirty, full_requested) = self.state.take_synced();
        self.full_due |= full_requested;
        dirty.extend(self.state.retried());
        dirty.extend(self.missing.keys().cloned());
        dirty.extend(self.changed_files(&root));
        let full = self.full_due || self.last_full.is_none_or(|at| at.elapsed() >= BACKSTOP);
        if full {
            // A file made within a folder's timestamp resolution of its last
            // listing is found here at the latest.
            self.folders.clear();
        }
        if full || touched.is_some() || !dirty.is_empty() {
            dirty.extend(touched.unwrap_or_default());
            if let Err(e) = self.pass(&root, full, dirty).await {
                // The watermark moved and the synced pages were taken.
                self.full_due = true;
                return Err(e);
            }
        }
        Ok(())
    }

    /// Every `.md` file below the mirror's folder, as paths below it. One stat
    /// per folder every tick, its listing reread only when it changed: cheap at
    /// today's vault sizes. A vault large enough to feel it would gate this scan
    /// on a slower cadence.
    fn scan(&mut self, root: &Path) -> Vec<String> {
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(folder) = stack.pop() {
            let modified = std::fs::metadata(&folder)
                .and_then(|meta| meta.modified())
                .ok();
            let fresh = self
                .folders
                .get(&folder)
                .is_some_and(|listing| modified.is_some() && listing.modified == modified);
            if !fresh {
                let listing = Listing::of(root, &folder, modified);
                self.folders.insert(folder.clone(), listing);
            }
            if let Some(listing) = self.folders.get(&folder) {
                found.extend(listing.files.iter().cloned());
                stack.extend(listing.folders.iter().cloned());
            }
            seen.insert(folder);
        }
        self.folders.retain(|folder, _| seen.contains(folder));
        found
    }

    /// Read each new `.md` file in a space's folder, one no page's file is
    /// or is to be, onto a new page of that space titled by its path below
    /// the space's folder (#5363 slice 3a), once two ticks read the same
    /// bytes ([`ingest::create`]). A file outside every space's folder is
    /// left alone; one refused stays listed as failed until it changes.
    async fn read_new_files(&mut self, root: &Path) -> Result<(), AppError> {
        let Some(ingest) = self.ingest() else {
            return Ok(());
        };
        let found = self.scan(root);
        let owned: HashSet<&str> = self
            .pages
            .values()
            .map(|state| state.path.as_str())
            .chain(self.layout.values().map(|(path, _)| path.as_str()))
            .collect();
        let new: Vec<String> = found
            .into_iter()
            .filter(|path| !owned.contains(path.as_str()))
            .collect();
        self.settling_new.retain(|path, _| new.contains(path));
        self.refused_new.retain(|path, _| new.contains(path));
        self.state.new_files_are(&new);
        if new.is_empty() {
            return Ok(());
        }
        let spaces: Vec<(String, String)> = crate::commands::spaces::list_spaces_inner(&self.pool)
            .await?
            .into_iter()
            .map(|space| (space.id, space.name))
            .collect();
        let by_folder: HashMap<String, String> = paths::space_folders(&spaces)
            .into_iter()
            .map(|(space, folder)| (folder, space))
            .collect();
        for path in new {
            let Some((folder, below)) = path.split_once('/') else {
                continue;
            };
            let title = crate::commands::pages::folder_path_to_namespace_title(below);
            let Some(space_id) = by_folder.get(folder).filter(|_| !title.is_empty()) else {
                continue;
            };
            if !self
                .read_new_file(root, &ingest, space_id, &title, &path)
                .await?
            {
                return Ok(());
            }
        }
        Ok(())
    }

    /// [`Mirror::read_new_files`] for one file; `false` when the mirror
    /// paused, which ends the tick.
    async fn read_new_file(
        &mut self,
        root: &Path,
        ingest: &Ingest,
        space_id: &str,
        title: &str,
        path: &str,
    ) -> Result<bool, AppError> {
        let target = root.join(path);
        let Some(bytes) = store::read_optional(&target)? else {
            return Ok(true);
        };
        if self
            .refused_new
            .get(path)
            .is_some_and(|(refused, _)| *refused == bytes)
        {
            return Ok(true);
        }
        if self.settling_new.get(path) != Some(&bytes) {
            self.settling_new.insert(path.to_owned(), bytes);
            return Ok(true);
        }
        if let Some(why) = pause_reason(root, &self.device_id) {
            self.state.set_paused(Some(why));
            return Ok(false);
        }
        if let Some(page_id) = self.renamed_from(&bytes) {
            self.read_renamed_file(ingest, &page_id, space_id, title, path, bytes)
                .await;
            return Ok(true);
        }
        let created = ingest::create(
            &self.pool,
            ingest,
            &self.device_id,
            space_id,
            title,
            path,
            &bytes,
            &self.links(path),
        )
        .await;
        self.settling_new.remove(path);
        let (page_id, ingested) = match created {
            Ok(created) => created,
            Err(NotIngested::Refused(why)) => {
                self.state.file_failed(path, &why);
                self.refused_new.insert(path.to_owned(), (bytes, why));
                return Ok(true);
            }
            Err(NotIngested::NoBase) => return Ok(true),
        };
        (ingest.notify)(ingested.event);
        if let Some(shadow) = ingested.shadow {
            // Written back only over the bytes read; either way the page's
            // file is this one now, and a newer save is read as its edit.
            if shadow.text.as_bytes() != bytes
                && store::read_optional(&target)?.as_deref() == Some(bytes.as_slice())
            {
                store::write_atomic(&target, shadow.text.as_bytes())?;
            }
            self.record(&page_id, path, shadow)?;
        }
        Ok(true)
    }

    /// The page whose file vanished that `bytes`, a new file, is that file
    /// renamed: the page that last wrote these bytes, or that holds most of
    /// the file's anchors (#5363 Decide 4). None when several pages match.
    fn renamed_from(&self, bytes: &[u8]) -> Option<String> {
        let anchors = ingest::anchors(bytes);
        let mut matched = self.missing.keys().filter(|page_id| {
            let Some(state) = self.pages.get(*page_id) else {
                return false;
            };
            let held = anchors
                .iter()
                .filter(|id| {
                    state
                        .shadows
                        .iter()
                        .any(|shadow| shadow.line_ids.iter().flatten().any(|line| line == *id))
                })
                .count();
            2 * held > anchors.len()
                || state
                    .shadows
                    .iter()
                    .any(|shadow| shadow.text.as_bytes() == bytes)
        });
        let page_id = matched.next()?;
        matched.next().is_none().then(|| page_id.clone())
    }

    /// Give `page_id` the place of its file renamed to `path` outside Agaric,
    /// a page of `space_id` titled `title` ([`ingest::rename`]), and keep the
    /// file as its own: an edit made with the rename is read on a later tick.
    /// One refused stays listed as failed until it changes.
    async fn read_renamed_file(
        &mut self,
        ingest: &Ingest,
        page_id: &str,
        space_id: &str,
        title: &str,
        path: &str,
        bytes: Vec<u8>,
    ) {
        self.settling_new.remove(path);
        let renamed = ingest::rename(
            &self.pool,
            ingest,
            &self.device_id,
            page_id,
            space_id,
            title,
            path,
        )
        .await;
        let event = match renamed {
            Ok(event) => event,
            Err(why) => {
                self.state.file_failed(path, &why);
                self.refused_new.insert(path.to_owned(), (bytes, why));
                self.refused_renames
                    .insert(page_id.to_owned(), path.to_owned());
                return;
            }
        };
        (ingest.notify)(event);
        self.missing.remove(page_id);
        self.refused_renames.remove(page_id);
        let Some(mut state) = self.pages.get(page_id).cloned() else {
            return;
        };
        path.clone_into(&mut state.path);
        if let Err(e) = self.store.save(page_id, &state) {
            tracing::warn!(page_id, error = %e, "cannot save a mirror state file");
        }
        self.pages.insert(page_id.to_owned(), state);
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
    /// linking to them, the pages at the other end of their block refs, and
    /// every page whose file is not where the layout
    /// puts it, or with `full` every page.
    async fn pass(
        &mut self,
        root: &Path,
        full: bool,
        mut dirty: HashSet<String>,
    ) -> Result<(), AppError> {
        self.linked_copies.clear();
        self.unrendered = false;
        let layout = self.load_layout().await?;
        let renamed: Vec<String> = layout
            .iter()
            .filter(|(id, now)| self.layout.get(*id).is_some_and(|before| before != *now))
            .map(|(id, _)| id.clone())
            .collect();
        dirty.extend(self.linking_pages(&renamed).await?);
        dirty.extend(renamed);
        let refs = self.block_ref_pages(&dirty).await?;
        dirty.extend(refs);
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
        // A file left at its old path because it was edited outside Agaric
        // is read into its page there first, then moved by a later pass.
        if self.ingest().is_some() {
            let edited: Vec<(String, String)> = frozen
                .iter()
                .filter(|id| layout.contains_key(*id) && self.state.is_diverged(id))
                .filter_map(|id| Some((id.clone(), self.pages.get(id)?.path.clone())))
                .collect();
            for (id, old) in edited {
                if !self.write_page(root, &id, &old).await {
                    self.full_due = true;
                    return Ok(());
                }
            }
        }
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
        let complete = full && frozen.is_empty() && !self.unrendered;
        self.sweep_copies(root, complete).await?;
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

    /// Remove the copies no longer wanted, each only while unchanged
    /// ([`assets::Copies::remove_except`]): every one while copying is off,
    /// one whose attachment is gone, and, after a full pass that rendered
    /// every page (`complete`), one no page of its space links.
    async fn sweep_copies(&mut self, root: &Path, complete: bool) -> Result<(), AppError> {
        let ids = self.copies.ids();
        let live = if ids.is_empty() || !self.copy_files {
            HashSet::new()
        } else {
            assets::Copies::live(&self.pool, ids).await?
        };
        if !self.copy_files {
            self.copy_failed.clear();
        }
        let linked = std::mem::take(&mut self.linked_copies);
        let copy_files = self.copy_files;
        let kept = self.copies.remove_except(root, &|path, copy| {
            copy_files && live.contains(&copy.id) && (!complete || linked.contains(path))
        })?;
        self.state.set_copies(kept, self.copy_failed.clone());
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

    /// The live pages at the other end of a block ref from a block of
    /// `pages`: the target's page carries its `^ID` and the ref names that
    /// page (#6277 F2), so a new ref, a rename or a move changes the other
    /// end's text. A ref removed leaves a stale `^ID` until the next full
    /// pass, which reads back the same.
    async fn block_ref_pages(&self, pages: &HashSet<String>) -> Result<Vec<String>, AppError> {
        if pages.is_empty() {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(pages)?;
        Ok(sqlx::query_scalar!(
            r#"SELECT t.page_id AS "page_id!: String"
                 FROM block_links l
                 JOIN blocks s ON s.id = l.source_id
                 JOIN blocks t ON t.id = l.target_id
                WHERE l.kind = 'block_ref'
                  AND s.page_id IN (SELECT value FROM json_each(?1))
                  AND t.deleted_at IS NULL AND t.page_id IS NOT NULL
               UNION
               SELECT s.page_id
                 FROM block_links l
                 JOIN blocks s ON s.id = l.source_id
                 JOIN blocks t ON t.id = l.target_id
                WHERE l.kind = 'block_ref'
                  AND t.page_id IN (SELECT value FROM json_each(?1))
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
        self.missing.remove(page_id);
        self.refused_renames.remove(page_id);
        self.state.page_ok(page_id);
        if let Err(e) = self.store.delete(page_id) {
            tracing::warn!(page_id, error = %e, "cannot delete a mirror state file");
        }
    }

    /// Write the page and list it by the outcome; `false` when the mirror
    /// paused, which ends the pass.
    async fn write_page(&mut self, root: &Path, page_id: &str, path: &str) -> bool {
        let wrote = self.try_write_page(root, page_id, path).await;
        if !matches!(wrote, Ok(Wrote::Missing)) {
            self.missing.remove(page_id);
        }
        match wrote {
            Ok(Wrote::Done) => self.state.page_ok(page_id),
            Ok(Wrote::Missing) => {}
            Ok(Wrote::Diverged) => self.state.page_diverged(page_id, path),
            Ok(Wrote::Paused(why)) => {
                self.state.set_paused(Some(why));
                return false;
            }
            Ok(Wrote::Refused(why)) => self.state.page_failed(page_id, path, &why),
            Err(e) => {
                self.unrendered = true;
                self.state.page_failed(page_id, path, &e);
            }
        }
        self.stats
            .insert(page_id.to_owned(), file_stat(&root.join(path)));
        true
    }

    /// Write the page's render at `path` over the text last written there,
    /// keeping the lines of every block the render did not change
    /// ([`splice`]), unless a file there differs from both the render and
    /// that text: then it was edited outside Agaric, and is read into the
    /// page ([`Mirror::read_edit`]) or left alone. A file that already holds
    /// the render is adopted. Nothing is created unless the folder still
    /// holds this device's marker, which a drive unmounted mid-pass does not.
    /// The file is written before the state, so a crash between the two
    /// leaves a file the next pass adopts.
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
        let file = self.localized(root, path, file).await?;
        let target = root.join(path);
        let newest = self
            .pages
            .get(page_id)
            .filter(|state| state.path == path)
            .and_then(PageState::newest);
        let (text, line_ids) = match newest {
            Some(shadow) => {
                splice::splice(&shadow.text, &shadow.line_ids, &file.text, &file.line_ids)
            }
            None => (file.text.clone(), file.line_ids.clone()),
        };
        let mut shadow = Shadow {
            text,
            line_ids,
            buffer: Some(file.buffer.clone()),
        };
        let found = store::read_optional(&target)?;
        let vanished = found.is_none() && newest.is_some();
        match found {
            Some(bytes) if bytes == shadow.text.as_bytes() => {}
            Some(bytes) if bytes == file.text.as_bytes() => {
                shadow.text.clone_from(&file.text);
                shadow.line_ids.clone_from(&file.line_ids);
            }
            Some(bytes) if newest.is_none_or(|shadow| shadow.text.as_bytes() != bytes) => {
                return self.read_edit(root, page_id, path, bytes, &file).await;
            }
            _ => {
                if vanished && self.still_missing(page_id) {
                    return Ok(Wrote::Missing);
                }
                if let Some(why) = pause_reason(root, &self.device_id) {
                    return Ok(Wrote::Paused(why));
                }
                create_folders_below(root, path)?;
                store::write_atomic(&target, shadow.text.as_bytes())?;
            }
        }
        self.record(page_id, path, shadow)
    }

    /// `file`, the render of the page whose file is at `path`, linking each
    /// attachment to its copy while copying is on, the copies it links
    /// written first. A copy that cannot be written leaves its link as
    /// rendered, and is listed as failed.
    async fn localized(
        &mut self,
        root: &Path,
        path: &str,
        file: PageFile,
    ) -> Result<PageFile, AppError> {
        let ids = assets::linked(&file.text);
        let Some((space, _)) = path.split_once('/').filter(|_| self.copy_files) else {
            return Ok(file);
        };
        if ids.is_empty() || pause_reason(root, &self.device_id).is_some() {
            return Ok(file);
        }
        let (placed, failed) = self.copies.ensure(&self.pool, root, space, ids).await?;
        for copy in &placed {
            self.copy_failed.remove(copy);
        }
        self.linked_copies.extend(placed);
        for (copy, why) in failed {
            if self.copy_failed.insert(copy.clone(), why.clone()).is_none() {
                tracing::warn!(
                    path = copy,
                    why,
                    "the Markdown mirror cannot copy an attachment"
                );
            }
        }
        Ok(self.links(path).localize(file))
    }

    /// How the file at `path` links its attachments' copies: not at all
    /// while copying is off.
    fn links(&self, path: &str) -> assets::Links {
        match path.split_once('/') {
            Some((space, _)) if self.copy_files => {
                assets::Links::for_page(path, self.copies.in_space(space))
            }
            _ => assets::Links::default(),
        }
    }

    /// Count one more tick the page's file is missing; `false` once it has
    /// been missing for `MISSING_TICKS`, and counts as gone. Never while its
    /// file is a renamed one whose rename was refused.
    fn still_missing(&mut self, page_id: &str) -> bool {
        // The page's file is the refused one, not gone: a second file would
        // make two for one page.
        if let Some(path) = self.refused_renames.get(page_id) {
            if self.refused_new.contains_key(path) {
                return true;
            }
            self.refused_renames.remove(page_id);
        }
        let ticks = self.missing.entry(page_id.to_owned()).or_default();
        *ticks += 1;
        if *ticks <= MISSING_TICKS {
            return true;
        }
        self.missing.remove(page_id);
        false
    }

    /// Keep `shadow` as the text last written for the page at `path`.
    fn record(&mut self, page_id: &str, path: &str, shadow: Shadow) -> Result<Wrote, AppError> {
        self.settling.remove(page_id);
        self.refused.remove(page_id);
        let mut state = self
            .pages
            .get(page_id)
            .cloned()
            .unwrap_or_else(|| PageState {
                path: path.to_owned(),
                shadows: Vec::new(),
            });
        if state.path == path && state.newest() == Some(&shadow) {
            return Ok(Wrote::Done);
        }
        state.record(path.to_owned(), shadow);
        // Saved first, so a failed save leaves memory with the disk's state.
        self.store.save(page_id, &state)?;
        self.pages.insert(page_id.to_owned(), state);
        Ok(Wrote::Done)
    }

    /// `bytes`, the page's file at `path` as edited outside Agaric, read into
    /// the page once two ticks read the same bytes, then written back with
    /// only the anchors the page now needs added or dropped
    /// ([`ingest::ingest`]). Left alone, as diverged, while it settles, when
    /// the mirror cannot ingest, or when no text written can be its base;
    /// refused, as failed, when it or its save is refused, until it changes:
    /// not tried again meanwhile, which only saves a save the op cap rolls
    /// back each tick, so no test can tell.
    async fn read_edit(
        &mut self,
        root: &Path,
        page_id: &str,
        path: &str,
        bytes: Vec<u8>,
        render: &PageFile,
    ) -> Result<Wrote, AppError> {
        // A page with no blocks has nothing a blank file could delete, so an
        // editor's final newline or BOM on its empty file changes nothing
        // (#6506).
        if render.text.trim().is_empty() && is_blank(&bytes) {
            if let Some(why) = pause_reason(root, &self.device_id) {
                return Ok(Wrote::Paused(why));
            }
            // Written back as the render, as an ingest writes back LF and no BOM.
            store::write_atomic(&root.join(path), render.text.as_bytes())?;
            let shadow = Shadow {
                text: render.text.clone(),
                line_ids: render.line_ids.clone(),
                buffer: Some(render.buffer.clone()),
            };
            return self.record(page_id, path, shadow);
        }
        let Some(ingest) = self.ingest() else {
            return Ok(Wrote::Diverged);
        };
        if let Some((refused, why)) = self.refused.get(page_id)
            && *refused == bytes
        {
            return Ok(Wrote::Refused(why.clone()));
        }
        if self.settling.get(page_id) != Some(&bytes) {
            self.settling.insert(page_id.to_owned(), bytes);
            return Ok(Wrote::Diverged);
        }
        let links = self.links(path);
        let Some(state) = self.pages.get(page_id).filter(|state| state.path == path) else {
            return Ok(Wrote::Diverged);
        };
        let ingested = ingest::ingest(
            &self.pool,
            &ingest,
            &self.device_id,
            page_id,
            path,
            state,
            &bytes,
            render,
            &links,
        )
        .await;
        let ingested = match ingested {
            Ok(ingested) => ingested,
            Err(NotIngested::NoBase) => return Ok(Wrote::Diverged),
            Err(NotIngested::Refused(why)) => {
                self.settling.remove(page_id);
                self.refused
                    .insert(page_id.to_owned(), (bytes, why.clone()));
                return Ok(Wrote::Refused(why));
            }
        };
        (ingest.notify)(ingested.event);
        let target = root.join(path);
        let Some(shadow) = ingested.shadow else {
            return Ok(Wrote::Diverged);
        };
        // Written back only over the bytes ingested; a newer save is read on
        // a later tick.
        if store::read_optional(&target)?.as_deref() != Some(bytes.as_slice()) {
            return Ok(Wrote::Diverged);
        }
        if shadow.text.as_bytes() != bytes {
            if let Some(why) = pause_reason(root, &self.device_id) {
                return Ok(Wrote::Paused(why));
            }
            store::write_atomic(&target, shadow.text.as_bytes())?;
        }
        self.record(page_id, path, shadow)
    }
}

/// How [`Mirror::try_write_page`] left a page.
enum Wrote {
    Done,
    /// The file vanished, and may yet be found renamed; nothing was written.
    Missing,
    Diverged,
    /// The folder lost its marker; nothing was written.
    Paused(String),
    /// The file's edit was refused, and why; nothing was written.
    Refused(String),
}

/// Whether `bytes` hold nothing but whitespace and a BOM.
fn is_blank(bytes: &[u8]) -> bool {
    std::str::from_utf8(bytes)
        .is_ok_and(|text| text.trim_start_matches('\u{feff}').trim().is_empty())
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
