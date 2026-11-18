//! The outbound Markdown mirror (#5363 slice 1): every live page of every
//! space written to a folder the user picks, as `<space>/<title>.md`, in the
//! form [`get_page_file_inner`] renders, on desktop; in a folder of notes
//! adopted in place, one space's pages directly below it ([`adopt`]).
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
//! its marker is missing, or the vault is older than the folder
//! ([`MirrorState::is_behind`]), the mirror writes nothing and creates nothing.
//! After a restore from a daily snapshot it is paused until the folder is
//! chosen again ([`store::RESTORED_KEY`]).
//!
//! Reading back, it acts on few files at a time unasked: more files of one
//! space changed or deleted outside Agaric at once than
//! [`read_back::MASS_CHANGE`] are read in only once the user has seen them
//! listed and said so ([`MirrorState::hold_mass_change`]), unless the user
//! chose not to be asked ([`store::Settings::ask_mass_change`]). A file
//! outside every space's folder is never read, and holds its page when it is
//! that page's file moved there (`Mirror::hold_outside_file`).

pub mod adopt;
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
use crate::db::ReadPool;
use ingest::{Ingest, NotIngested};
use store::{Head, PageState, Shadow, StateDir};

/// How often the mirror looks for pages to write.
const TICK: Duration = Duration::from_secs(2);

/// How often a full pass runs when nothing else asks for one.
const BACKSTOP: Duration = Duration::from_secs(3600);

/// The ticks a page's file may be missing before it counts as gone: a file
/// renamed outside Agaric is found at its new path within them.
const MISSING_TICKS: u8 = 2;

/// Why the mirror writes and reads nothing after a restore from a daily
/// snapshot ([`store::RESTORED_KEY`]).
const RESTORED_PAUSE: &str = "a daily snapshot was restored, and files in the folder may be newer \
     than the notes; sync with your paired devices, then choose the folder again to resume. \
     Reading changes back was turned off";

/// Why the mirror writes nothing while [`Mirror::behind`].
const BEHIND: &str = "the vault is older than the folder, as after a restore from a backup or a \
                      new start; choose the folder again to write this vault's pages there, which \
                      removes no file and writes over none, or choose another folder";

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
    /// While reading back is off, the files turning it on would read in,
    /// each with what reading it in does ([`read_back::pending`]); empty
    /// while it is on.
    pub pending: Vec<read_back::MirrorPending>,
    /// Whether the attachments pages link are copied into the folder
    /// ([`assets`]).
    pub copy_files: bool,
    /// Whether many files changed at once are read in only once the user
    /// says so ([`MirrorState::hold_mass_change`]).
    pub ask_mass_change: bool,
    /// The space folders whose changed files hold reading back until the
    /// user reads them in ([`MirrorState::hold_mass_change`]); each is listed
    /// under `failed` with why.
    pub held: Vec<String>,
    /// The spaces not mirrored; every other one is, a new one included.
    pub unmirrored_spaces: Vec<String>,
    /// The space whose folder the mirror's is, when a folder of notes was
    /// adopted in place ([`adopt`]); `None` for a folder of space folders.
    pub adopted_space: Option<String>,
}

/// Whether `root` holds nothing but hidden entries, as the mirror's marker.
pub fn is_emptied(root: &Path) -> bool {
    !std::fs::read_dir(root).is_ok_and(|entries| {
        entries
            .flatten()
            .any(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
    })
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
    /// Whether a tick found the vault older than the folder
    /// ([`Mirror::behind`]), which, as [`Head::older`], only choosing a
    /// folder ends.
    behind: bool,
    /// Why the task could not start, until it does: no [`MirrorState::restart`]
    /// clears it.
    start_error: Option<String>,
    diverged: BTreeMap<String, String>,
    failed: BTreeMap<String, (String, String)>,
    /// New files no page owns that could not be read onto a page, by path.
    failed_files: BTreeMap<String, String>,
    /// Copies changed outside Agaric, wanted or not, left in place, by path.
    kept_copies: Vec<String>,
    /// Copies that could not be written, and why, by path.
    failed_copies: BTreeMap<String, String>,
    last_pass_ms: Option<i64>,
    /// The folder chosen again while it is emptied, or while the vault is
    /// older than it: the next tick drops its states and writes every page
    /// there as new.
    start_fresh: bool,
    /// The space folders whose changed files hold reading back, and why
    /// ([`MirrorState::hold_mass_change`]); none while nothing does.
    held: BTreeMap<String, String>,
    /// The files the user chose to read in, which hold nothing while they
    /// stay changed.
    confirmed: HashSet<String>,
    /// The folder's states were written outside the task, by an adoption:
    /// the next tick loads them.
    reload: bool,
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

    /// Drop the folder's states on the next tick, the way out of the pause
    /// [`is_emptied`] holds and of the one [`MirrorState::is_behind`] tells:
    /// the user chose the folder again, so it is the one to fill. With no
    /// state, no file there is removed, and one that differs from its page's
    /// render is kept as changed outside Agaric; nor is the copy of an
    /// attachment the vault lacks.
    pub fn start_fresh(&self) {
        self.lock().start_fresh = true;
        self.restart();
    }

    /// Whether the mirror is paused because the vault is older than the
    /// folder, as one restored from a backup is.
    pub fn is_behind(&self) -> bool {
        self.lock().behind
    }

    /// Whether [`MirrorState::start_fresh`] is yet to drop the states.
    pub fn start_fresh_due(&self) -> bool {
        self.lock().start_fresh
    }

    fn started_fresh(&self) {
        self.lock().start_fresh = false;
    }

    /// Load the folder's states on the next tick, as [`adopt::adopt`] wrote
    /// them, and start over there.
    pub fn reload(&self) {
        self.lock().reload = true;
        self.restart();
    }

    fn take_reload(&self) -> bool {
        std::mem::take(&mut self.lock().reload)
    }

    /// Start over in a new folder: forget the old one's diverged and failed
    /// files, and whether it held reading back, and run a full pass on the
    /// next tick.
    pub fn restart(&self) {
        let mut inner = self.lock();
        inner.full_pass = true;
        inner.paused = None;
        inner.behind = false;
        inner.held.clear();
        inner.diverged.clear();
        inner.failed.clear();
        inner.failed_files.clear();
        inner.kept_copies.clear();
        inner.failed_copies.clear();
    }

    /// Whether reading back waits for the user this tick: `changed`, every
    /// file, by its path below the folder, that the tick is about to read in,
    /// move or trash for a change made outside Agaric, holds more files of
    /// one space's folder than [`read_back::MASS_CHANGE`] that the user has
    /// not chosen to read in ([`MirrorState::confirm_read_back`]). While it
    /// waits the status says reading back is off, lists the folder as failed
    /// with the reason and under `held`, and its `pending` names the files,
    /// as when reading back was turned off. Whatever is about to act on files
    /// changed outside Agaric asks here first, once a tick, with all of them;
    /// none while the user chose not to be asked.
    pub fn hold_mass_change(&self, changed: &[String], adopted: bool) -> bool {
        let mut inner = self.lock();
        let now: HashSet<&str> = changed.iter().map(String::as_str).collect();
        // A choice lasts while its file stays changed.
        inner.confirmed.retain(|path| now.contains(path.as_str()));
        let held: BTreeMap<String, String> =
            read_back::mass_changed(changed, &inner.confirmed, adopted)
                .into_iter()
                .map(|(folder, count)| {
                    let why = format!(
                        "{count} of its files changed or vanished outside Agaric at once, more \
                     than {}: nothing is read back until you turn reading changes back on and \
                     read them in, or turn off asking before reading in many changes",
                        read_back::MASS_CHANGE
                    );
                    (folder.to_owned(), why)
                })
                .collect();
        if inner.held.is_empty() && !held.is_empty() {
            tracing::warn!(?held, "the Markdown mirror holds reading back");
        }
        inner.held = held;
        !inner.held.is_empty()
    }

    /// The user was shown `files` and chose to read them in, turned reading
    /// back off, or chose not to be asked: nothing is held for them.
    pub fn confirm_read_back(&self, files: &[String]) {
        let mut inner = self.lock();
        inner.held.clear();
        inner.confirmed = files.iter().cloned().collect();
    }

    /// Whether reading back waits for the user
    /// ([`MirrorState::hold_mass_change`]).
    pub fn read_back_held(&self) -> bool {
        !self.lock().held.is_empty()
    }

    /// The status, for `settings`, with `pending` from [`read_back::pending`].
    pub fn status(
        &self,
        settings: store::Settings,
        pending: Vec<read_back::MirrorPending>,
    ) -> MirrorStatus {
        let inner = self.lock();
        let store::Settings {
            folder,
            read_back,
            copy_files,
            ask_mass_change,
            unmirrored,
            restored: _,
            adopted,
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
                        .chain(&inner.failed_copies)
                        .chain(&inner.held)
                        .filter(|_| on)
                        .map(|(path, message)| MirrorFailure {
                            page_id: String::new(),
                            path: path.clone(),
                            message: message.clone(),
                        }),
                )
                .collect(),
            last_pass_ms: inner.last_pass_ms,
            read_back: read_back && inner.held.is_empty(),
            pending,
            copy_files,
            ask_mass_change,
            held: inner.held.keys().filter(|_| on).cloned().collect(),
            unmirrored_spaces: unmirrored,
            adopted_space: adopted.map(|adoption| adoption.space_id),
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

    fn found_behind(&self) {
        self.lock().behind = true;
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
            "the folder's {} marker names another device: two devices cannot mirror to one \
             folder, so choose an empty folder for this device",
            store::MARKER_NAME
        )),
        Ok(None) => Some(format!(
            "the folder has no {} marker, so it may no longer be this device's mirror: put the \
             file back if it was deleted by mistake, or choose an empty folder",
            store::MARKER_NAME
        )),
        Err(e) => Some(format!("the folder's marker cannot be read: {e}")),
    }
}

/// Refuse `folder` as the mirror's unless it is an absolute path to an
/// existing folder, apart from the app's data, and either this device's
/// mirror already or empty but for hidden entries ([`is_emptied`]), as a
/// fresh `git init` or a `.DS_Store` leaves it: picking a vault or a home
/// folder must not let the mirror write among files it did not write.
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
        Some(_) => refuse(
            "that folder is another device's mirror, and each device mirrors to a folder of its \
             own: choose an empty folder",
        ),
        None => {
            // An unreadable folder is refused, never taken for an empty one.
            std::fs::read_dir(folder).map_err(unreadable)?;
            if is_emptied(folder) {
                Ok(())
            } else {
                refuse(
                    "the mirror folder must be empty, or one this device already mirrors to: \
                     choose an empty folder (hidden files such as .git or .DS_Store may stay)",
                )
            }
        }
    }
}

/// Run the mirror's task on Tauri's runtime, until the handle is aborted or
/// the app exits.
pub fn spawn(
    pool: SqlitePool,
    device_id: String,
    state: MirrorState,
    ingest: Ingest,
) -> tauri::async_runtime::JoinHandle<()> {
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
    })
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
    /// The copies written in the folder mirrored ([`assets::Copies`]).
    copies: assets::Copies,
    /// The copies this pass's pages link, the ones a full pass keeps.
    linked_copies: HashSet<String>,
    /// Whether a page of this pass could not be rendered, so its copies are
    /// unknown and a full pass removes none for being unlinked.
    unrendered: bool,
    /// Copies that could not be written, and why, by path.
    copy_failed: BTreeMap<String, String>,
    /// The spaces neither written nor read, as of this tick.
    unmirrored: HashSet<String>,
    /// The folder's adoption as one space's, as of this tick.
    adoption: Option<store::Adoption>,
    /// What the mirror learned of the folder it writes, forgotten for another.
    seen: Seen,
    #[cfg(test)]
    races: Races,
}

/// What a test runs on a page's file while the mirror writes the page, as a
/// save from another editor landing there.
#[cfg(test)]
#[derive(Default)]
struct Races {
    /// Once the file is read.
    after_read: Option<Race>,
    /// Once the mirror has decided to write it, before it does.
    before_write: Option<Race>,
    /// Once it is written.
    after_write: Option<Race>,
}

#[cfg(test)]
type Race = Box<dyn FnMut(&Path) + Send + Sync>;

#[cfg(test)]
fn run(race: &mut Option<Race>, file: &Path) {
    if let Some(race) = race {
        race(file);
    }
}

/// What [`Mirror`] learned of the folder it writes: all of it is that
/// folder's, so another folder starts from [`Seen::default`].
#[derive(Default)]
struct Seen {
    /// The layout of the last pass, to tell which pages it renamed.
    layout: Layout,
    /// Each page's file as the mirror last read or wrote it: a change outside
    /// Agaric makes the page dirty.
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

impl Seen {
    /// Whether the new file at `path` holds `bytes` as the last tick read
    /// them too, and they are not bytes an ingest refused.
    fn new_file_settled(&mut self, path: &str, bytes: &[u8]) -> bool {
        if self
            .refused_new
            .get(path)
            .is_some_and(|(refused, _)| *refused == bytes)
        {
            return false;
        }
        if self.settling_new.get(path).map(Vec::as_slice) != Some(bytes) {
            self.settling_new.insert(path.to_owned(), bytes.to_vec());
            return false;
        }
        true
    }
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
    stat_of(&std::fs::metadata(path).ok()?)
}

fn stat_of(meta: &std::fs::Metadata) -> FileStat {
    Some((meta.len(), meta.modified().ok()))
}

impl Mirror {
    /// The task, from the state files, with its watermark at this device's
    /// last op: the first tick's full pass writes what came before, unless
    /// the vault is older than the folder ([`MirrorState::is_behind`]).
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
        let copies = assets::Copies::new(state.app_data_dir());
        let pages = store.load()?;
        let watermark = own_head(&pool, &device_id).await?;
        Ok(Self {
            pool,
            device_id,
            state,
            store,
            pages,
            watermark,
            full_due: true,
            last_full: None,
            ingest: None,
            seen: Seen::default(),
            read_back: true,
            copy_files: false,
            copies,
            linked_copies: HashSet::new(),
            unrendered: false,
            copy_failed: BTreeMap::new(),
            unmirrored: HashSet::new(),
            adoption: None,
            #[cfg(test)]
            races: Races::default(),
        })
    }

    /// The task, writing what a file is edited to outside Agaric into its
    /// page (#5363 slice 2).
    #[must_use]
    pub fn with_ingest(mut self, ingest: Ingest) -> Self {
        self.ingest = Some(ingest);
        self
    }

    /// Why the mirror writes nothing to `root` although its marker is there:
    /// it holds nothing else while pages were written to it, as a drive
    /// unmounted under a marker kept elsewhere or a folder emptied by hand.
    /// Writing would put every file back; reading would trash every page.
    fn emptied(&self, root: &Path) -> Option<String> {
        if self.pages.is_empty() {
            return None;
        }
        is_emptied(root).then(|| {
            format!(
                "the folder {} is empty; choose it again to write every page there",
                root.display()
            )
        })
    }

    /// Whether the vault is older than the folder: restored from a backup, a
    /// new one, or short of its last commits after a power cut, while the
    /// folder's states, kept outside it, are those of the vault that last
    /// wrote there. A pass would then remove the file of every page this
    /// vault lacks and write its older text over every other (#6887). So it
    /// is when this device's last op is before the folder's saved [`Head`],
    /// or when its op at that head has another hash: a restored vault soon
    /// numbers its own ops past it. A folder with no head saved yet, or whose
    /// head's op compaction has removed, is taken as this vault's; a vault
    /// once found older stays so ([`Head::older`]) until the folder is
    /// chosen again.
    async fn behind(&self) -> Result<bool, AppError> {
        let Some(saved) = self.store.head()? else {
            return Ok(false);
        };
        if saved.older {
            return Ok(true);
        }
        let mut older = durable_head(&self.pool, &self.device_id).await? < saved.seq;
        if let (false, Some(hash)) = (older, &saved.hash) {
            let now = op_hash(&self.pool, &self.device_id, saved.seq).await?;
            older = now.is_some_and(|now| now != *hash);
        }
        if older {
            self.store.save_head(&Head { older, ..saved })?;
        }
        Ok(older)
    }

    /// Save this device's last op as the folder's [`Head`], which
    /// [`Mirror::behind`] compares the vault with.
    async fn save_head(&self) -> Result<(), AppError> {
        let seq = durable_head(&self.pool, &self.device_id).await?;
        let hash = op_hash(&self.pool, &self.device_id, seq).await?;
        let older = false;
        self.store.save_head(&Head { seq, hash, older })
    }

    /// On a fresh start, forget the copies whose attachments the vault
    /// lacks, as one restored from a backup does: such a copy may be the
    /// only one of its file left, and [`Mirror::sweep_copies`] would remove
    /// it as unchanged. The rest stay recorded, so one changed in the folder
    /// is not written over.
    async fn forget_lost_copies(&mut self) -> Result<(), AppError> {
        let live = assets::attachments(&self.pool, self.copies.ids()).await?;
        self.copies.forget_except(&live.into_keys().collect())
    }

    /// Bind the copies and the states to `folder`'s, the copies first: a
    /// fresh start due there ([`MirrorState::start_fresh`]) forgets among
    /// that folder's own.
    async fn bind(&mut self, folder: &str) -> Result<(), AppError> {
        self.copies.bind(&self.store, folder)?;
        // Due until done: a tick failing part way would leave the states in
        // memory, their head gone, for the next pass to roll the folder back.
        let fresh = self.state.start_fresh_due();
        if fresh {
            self.store.forget(folder)?;
            self.forget_lost_copies().await?;
            self.state.started_fresh();
        }
        let reload = self.state.take_reload();
        if self.store.bind(folder)? || fresh || reload {
            self.forget_folder();
            self.pages = self.store.load()?;
        }
        Ok(())
    }

    /// Start over in another folder, with its own states: nothing it lacks
    /// is a file that vanished from it.
    fn forget_folder(&mut self) {
        self.pages.clear();
        self.seen = Seen::default();
        self.full_due = true;
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
                self.seen
                    .stats
                    .get(*id)
                    .is_some_and(|seen| *seen != file_stat(&root.join(&state.path)))
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// The files this tick may read in, move or trash, for
    /// [`MirrorState::hold_mass_change`]: of the pages an earlier tick found
    /// missing their file or listed as diverged or failed, which are all a
    /// tick acts on (an edit is read once two ticks read the same bytes, a
    /// vanished file counts once it was missed), each file in a mirrored
    /// space's folder that is gone or not the text last written there, as
    /// [`read_back::pending`] tells them.
    async fn outside_changes(&self, root: &Path) -> Result<Vec<String>, AppError> {
        let pages: HashSet<String> = self
            .seen
            .missing
            .keys()
            .cloned()
            .chain(self.state.retried())
            .collect();
        let files: Vec<&String> = pages
            .iter()
            .filter_map(|id| {
                let state = self.pages.get(id)?;
                let written = state.newest()?.text.as_bytes();
                let unchanged = store::read_optional(&root.join(&state.path))
                    .is_ok_and(|bytes| bytes.as_deref() == Some(written));
                (!unchanged).then_some(&state.path)
            })
            .collect();
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let spaces = self.space_folders().await?;
        // An adopted folder is one space's: every file below it is mirrored.
        let mirrored = |path: &str| {
            self.adoption.is_some()
                || path
                    .split_once('/')
                    .and_then(|(folder, _)| spaces.get(folder))
                    .is_some_and(|space| !self.unmirrored.contains(space))
        };
        Ok(files
            .into_iter()
            .filter(|path| mirrored(path))
            .cloned()
            .collect())
    }

    /// Whether reading back waits for the user this tick
    /// ([`MirrorState::hold_mass_change`]): never while it is off, and never
    /// while the user chose not to be asked (`ask`), which ends a hold.
    async fn mass_change_held(&self, root: &Path, ask: bool) -> Result<bool, AppError> {
        if self.ingest().is_none() {
            return Ok(false);
        }
        let changed = if ask {
            self.outside_changes(root).await?
        } else {
            Vec::new()
        };
        Ok(self
            .state
            .hold_mass_change(&changed, self.adoption.is_some()))
    }

    /// Each space's id, mirrored or not, by its folder below the mirror's.
    async fn space_folders(&self) -> Result<HashMap<String, String>, AppError> {
        let spaces: Vec<(String, String)> = crate::commands::spaces::list_spaces_inner(&self.pool)
            .await?
            .into_iter()
            .map(|space| (space.id, space.name))
            .collect();
        Ok(paths::space_folders(&spaces)
            .into_iter()
            .map(|(space, folder)| (folder, space))
            .collect())
    }

    /// Take this tick's `settings`: whether files are read back and copied,
    /// the adoption, and the spaces not mirrored, which are taken out.
    fn follow(&mut self, settings: &mut store::Settings) {
        self.read_back = settings.read_back;
        // An adopted folder is the user's own: no copy folders are made in it.
        let copy_files = settings.copy_files && settings.adopted.is_none();
        if copy_files != self.copy_files {
            // Every page's links change, and the copies go or come.
            self.copy_files = copy_files;
            self.full_due = true;
        }
        self.adoption = settings.adopted.take();
        let unmirrored: HashSet<String> = std::mem::take(&mut settings.unmirrored)
            .into_iter()
            .collect();
        if unmirrored != self.unmirrored {
            // A file refused because its space was off is read again.
            self.seen.refused_new.clear();
            self.seen.refused_renames.clear();
            self.unmirrored = unmirrored;
        }
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
        let mut settings = store::settings(&self.pool).await?;
        self.follow(&mut settings);
        let Some(folder) = settings.folder else {
            self.state.set_paused(None);
            self.full_due = true;
            return Ok(());
        };
        if settings.restored {
            self.state.set_paused(Some(RESTORED_PAUSE.to_owned()));
            self.full_due = true;
            return Ok(());
        }
        self.bind(&folder).await?;
        let root = PathBuf::from(folder);
        let mut paused = pause_reason(&root, &self.device_id).or_else(|| self.emptied(&root));
        if paused.is_none() && self.behind().await? {
            paused = Some(BEHIND.to_owned());
            self.state.found_behind();
        }
        let resumed = paused.is_none();
        self.state.set_paused(paused);
        if !resumed {
            self.full_due = true;
            return Ok(());
        }
        // Before anything is read in: held, this tick reads nothing back.
        self.read_back &= !self
            .mass_change_held(&root, settings.ask_mass_change)
            .await?;
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
        dirty.extend(self.seen.missing.keys().cloned());
        dirty.extend(self.changed_files(&root));
        let full = self.full_due || self.last_full.is_none_or(|at| at.elapsed() >= BACKSTOP);
        if full {
            // A file made within a folder's timestamp resolution of its last
            // listing is found here at the latest.
            self.seen.folders.clear();
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
                .seen
                .folders
                .get(&folder)
                .is_some_and(|listing| modified.is_some() && listing.modified == modified);
            if !fresh {
                let listing = Listing::of(root, &folder, modified);
                self.seen.folders.insert(folder.clone(), listing);
            }
            if let Some(listing) = self.seen.folders.get(&folder) {
                found.extend(listing.files.iter().cloned());
                stack.extend(listing.folders.iter().cloned());
            }
            seen.insert(folder);
        }
        self.seen.folders.retain(|folder, _| seen.contains(folder));
        found
    }

    /// Read each new `.md` file in a space's folder, one no page's file is
    /// or is to be ([`paths::unowned`]), onto a new page of that space titled
    /// by its path below the space's folder (#5363 slice 3a), once two ticks
    /// read the same bytes ([`ingest::create`]). A file outside every space's folder is
    /// never read onto a page ([`Mirror::hold_outside_file`]); one refused
    /// stays listed as failed until it changes.
    async fn read_new_files(&mut self, root: &Path) -> Result<(), AppError> {
        let Some(ingest) = self.ingest() else {
            return Ok(());
        };
        let found = self.scan(root);
        let owned: HashSet<&str> = self
            .pages
            .values()
            .map(|state| state.path.as_str())
            .chain(self.seen.layout.values().map(|(path, _)| path.as_str()))
            .collect();
        let new = paths::unowned(found, &owned, |path| root.join(path).is_file());
        self.seen.settling_new.retain(|path, _| new.contains(path));
        self.seen.refused_new.retain(|path, _| new.contains(path));
        self.state.new_files_are(&new);
        if new.is_empty() {
            return Ok(());
        }
        let by_folder = self.space_folders().await?;
        let adopted = self.adoption.as_ref().map(|a| a.space_id.clone());
        for path in new {
            // An adopted folder is one space's: every file below it is its.
            let in_space = match &adopted {
                Some(space_id) => Some((space_id.clone(), path.as_str())),
                None => path
                    .split_once('/')
                    .and_then(|(folder, below)| Some((by_folder.get(folder)?.clone(), below))),
            };
            let Some((space_id, below)) = in_space else {
                self.hold_outside_file(root, &path);
                continue;
            };
            let title = crate::commands::pages::folder_path_to_namespace_title(below);
            if title.is_empty() {
                continue;
            }
            if !self
                .read_new_file(root, &ingest, &space_id, &title, &path)
                .await?
            {
                return Ok(());
            }
        }
        Ok(())
    }

    /// List the new file at `path`, outside every space's folder, as not
    /// read. One that is a page's file moved there ([`Mirror::renamed_from`])
    /// holds that page as a refused rename does, so the page is neither moved
    /// nor trashed while a file sits there. Matched afresh every tick, the
    /// bytes unsettled, since none are read in: a file listed before its
    /// page's file was seen gone is still found to be that file.
    fn hold_outside_file(&mut self, root: &Path, path: &str) {
        // Only a page whose file is missing can have had it moved here.
        let moved = (!self.seen.missing.is_empty())
            .then(|| store::read_optional(&root.join(path)).ok().flatten())
            .flatten()
            .and_then(|bytes| Some((self.renamed_from(&bytes)?, bytes)));
        match moved {
            Some((page_id, bytes)) => self.refuse_rename(
                &page_id,
                path,
                bytes,
                "moved outside the space folders; move it back into a space's folder",
            ),
            None => self
                .state
                .file_failed(path, "files are read only inside a space's folder"),
        }
    }

    /// [`Mirror::read_new_files`] for one file; `false` when the mirror
    /// paused, which ends the tick. One that cannot be read is listed as
    /// failed, and the next is read.
    async fn read_new_file(
        &mut self,
        root: &Path,
        ingest: &Ingest,
        space_id: &str,
        title: &str,
        path: &str,
    ) -> Result<bool, AppError> {
        let target = root.join(path);
        let read = store::read_optional(&target).inspect_err(|e| {
            self.state
                .file_failed(path, &format!("the file cannot be read: {e}"));
        });
        let Ok(Some(bytes)) = read else {
            return Ok(true);
        };
        let left_alone = (self.adoption.as_ref()).is_some_and(|a| a.leaves_alone(path, &bytes));
        if left_alone || !self.seen.new_file_settled(path, &bytes) {
            return Ok(true);
        }
        if let Some(why) = pause_reason(root, &self.device_id) {
            self.state.set_paused(Some(why));
            return Ok(false);
        }
        let unmirrored = self.unmirrored.contains(space_id);
        if let Some(page_id) = self.renamed_from(&bytes) {
            if unmirrored {
                // Left where it is, its page held where it was: a page whose
                // file moved into a space not mirrored is neither moved there
                // nor trashed.
                self.refuse_rename(
                    &page_id,
                    path,
                    bytes,
                    "the space it was moved to is not mirrored",
                );
            } else {
                self.read_renamed_file(ingest, &page_id, space_id, title, path, bytes)
                    .await;
            }
            return Ok(true);
        }
        if unmirrored {
            return Ok(true);
        }
        let ids = assets::copy_linked(&String::from_utf8_lossy(&bytes));
        let links = self.placed(root, path, ids).await?;
        let created = ingest::create(
            &self.pool,
            ingest,
            &self.device_id,
            space_id,
            title,
            path,
            &bytes,
            &links,
        )
        .await;
        self.seen.settling_new.remove(path);
        let (page_id, ingested) = match created {
            Ok(created) => created,
            Err(NotIngested::Refused(why)) => {
                self.state.file_failed(path, &why);
                self.seen.refused_new.insert(path.to_owned(), (bytes, why));
                return Ok(true);
            }
            Err(NotIngested::NoBase) => return Ok(true),
        };
        (ingest.notify)(ingested.event);
        if let Some(shadow) = ingested.shadow {
            // Written back only over the bytes read, in the file as seen
            // before this read of it; either way the page's file is this one
            // now, and a newer save is read as its edit.
            self.seen.stats.insert(page_id.clone(), file_stat(&target));
            if shadow.text.as_bytes() != bytes
                && store::read_optional(&target)?.as_deref() == Some(bytes.as_slice())
            {
                self.write_file(&page_id, &target, &shadow.text)?;
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
        let mut matched = self.seen.missing.keys().filter(|page_id| {
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
        self.seen.settling_new.remove(path);
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
                self.refuse_rename(page_id, path, bytes, &why);
                return;
            }
        };
        (ingest.notify)(event);
        self.seen.missing.remove(page_id);
        self.seen.refused_renames.remove(page_id);
        let Some(mut state) = self.pages.get(page_id).cloned() else {
            return;
        };
        path.clone_into(&mut state.path);
        if let Err(e) = self.store.save(page_id, &state) {
            tracing::warn!(page_id, error = %e, "cannot save a mirror state file");
        }
        self.pages.insert(page_id.to_owned(), state);
    }

    /// List the renamed file at `path` as refused, and why, and hold the page
    /// whose file it is: it is neither written again nor trashed while the
    /// file stays as it was.
    fn refuse_rename(&mut self, page_id: &str, path: &str, bytes: Vec<u8>, why: &str) {
        self.state.file_failed(path, why);
        self.seen
            .refused_new
            .insert(path.to_owned(), (bytes, why.to_owned()));
        self.seen
            .refused_renames
            .insert(page_id.to_owned(), path.to_owned());
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
            .filter(|(id, now)| {
                self.seen
                    .layout
                    .get(*id)
                    .is_some_and(|before| before != *now)
            })
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
        self.seen.layout = layout;
        let complete = full && frozen.is_empty() && !self.unrendered;
        self.sweep_copies(root, complete).await?;
        if full {
            self.full_due = false;
            self.last_full = Some(Instant::now());
        }
        let known: HashSet<String> = self
            .pages
            .keys()
            .chain(self.seen.layout.keys())
            .cloned()
            .collect();
        self.state.passed(full, &known);
        self.save_head().await
    }

    /// Remove the copies no longer wanted ([`assets::Copies::remove_except`]):
    /// every one while copying is off, one whose attachment is gone, and,
    /// after a full pass that rendered every page (`complete`), one no page of
    /// its space links. A changed copy is never removed, and every one, wanted
    /// or not, is listed as kept.
    async fn sweep_copies(&mut self, root: &Path, complete: bool) -> Result<(), AppError> {
        let ids = self.copies.ids();
        let live = if ids.is_empty() || !self.copy_files {
            HashSet::new()
        } else {
            assets::attachments(&self.pool, ids)
                .await?
                .into_keys()
                .collect()
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
        let adopted = self.adoption.as_ref().map(|a| a.space_id.as_str());
        let mut pages = Vec::new();
        for (space_id, _) in spaces.iter().filter(|(id, _)| match adopted {
            Some(adopted) => id == adopted,
            None => !self.unmirrored.contains(id),
        }) {
            let listed =
                crate::commands::pages::list_all_pages_in_space_inner(&self.pool, space_id, None)
                    .await?;
            pages.extend(listed.into_iter().map(|page| paths::PageEntry {
                id: page.id.into_string(),
                space_id: space_id.clone(),
                title: page.content.unwrap_or_default(),
            }));
        }
        let mut paths = if adopted.is_some() {
            let pinned = pages
                .iter()
                .filter_map(|page| Some((page.id.clone(), self.pages.get(&page.id)?.pin.clone()?)))
                .collect();
            paths::adopted_layout(&pages, &pinned)
        } else {
            paths::layout(&spaces, &pages)
        };
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
                // An adopted file is the user's own note: one whose page is
                // gone goes to the OS trash, its folders kept.
                Ok(Some(_)) if target.is_none() && state.pin.is_some() => to_os_trash(&old),
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
        self.seen.missing.remove(page_id);
        self.seen.refused_renames.remove(page_id);
        self.state.page_ok(page_id);
        if let Err(e) = self.store.delete(page_id) {
            tracing::warn!(page_id, error = %e, "cannot delete a mirror state file");
        }
    }

    /// Write the page and list it by the outcome; `false` when the mirror
    /// paused, which ends the pass.
    async fn write_page(&mut self, root: &Path, page_id: &str, path: &str) -> bool {
        // Before the file is read, never after: a save landing behind the
        // read would be the file seen, and so never read.
        self.seen
            .stats
            .insert(page_id.to_owned(), file_stat(&root.join(path)));
        let wrote = self.try_write_page(root, page_id, path).await;
        if !matches!(wrote, Ok(Wrote::Missing)) {
            self.seen.missing.remove(page_id);
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
        true
    }

    /// Write `text` as the page's file, unless the file is no longer the one
    /// seen before it was read: a save from another editor landed since, and
    /// is left for the next pass to read in first. `false` then, and the
    /// page stays dirty, its file differing from the one seen. This narrows
    /// the window in which such a save is written over to the gap between
    /// this stat and the rename ([`store::write_atomic_over`]); it does not
    /// close it.
    ///
    /// What is written is seen as it was written: a stat taken after could
    /// be that of a save landing behind the write.
    fn write_file(&mut self, page_id: &str, target: &Path, text: &str) -> std::io::Result<bool> {
        #[cfg(test)]
        run(&mut self.races.before_write, target);
        let seen = self.seen.stats.get(page_id).copied();
        let written =
            store::write_atomic_over(target, text.as_bytes(), || seen == Some(file_stat(target)))?;
        let Some(written) = written else {
            return Ok(false);
        };
        self.seen
            .stats
            .insert(page_id.to_owned(), stat_of(&written));
        #[cfg(test)]
        run(&mut self.races.after_write, target);
        Ok(true)
    }

    /// Write `shadow` as the page's file at `path` and keep it as the text
    /// last written there; [`Wrote::Diverged`], with nothing kept, when the
    /// file changed since it was read ([`Mirror::write_file`]).
    fn write_and_record(
        &mut self,
        root: &Path,
        page_id: &str,
        path: &str,
        shadow: Shadow,
    ) -> Result<Wrote, AppError> {
        if !self.write_file(page_id, &root.join(path), &shadow.text)? {
            return Ok(Wrote::Diverged);
        }
        self.record(page_id, path, shadow)
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
        if self.adopted_unchanged(root, page_id, path, &file.buffer)? {
            return Ok(Wrote::Done);
        }
        // Each attachment linked to its copy while copying is on.
        let rendered = assets::linked(&file.text);
        let file = self
            .placed(root, path, rendered.clone())
            .await?
            .localize(file);
        let target = root.join(path);
        let newest = self
            .pages
            .get(page_id)
            .filter(|state| state.path == path)
            .and_then(PageState::newest);
        let (text, line_ids) = self.spliced(page_id, &file);
        let mut shadow = Shadow {
            text,
            line_ids,
            buffer: Some(file.buffer.clone()),
            render: Some(store::Render::of(&file)),
        };
        let found = store::read_optional(&target)?;
        #[cfg(test)]
        run(&mut self.races.after_read, &target);
        let vanished = found.is_none() && newest.is_some();
        match found {
            Some(bytes) if bytes == shadow.text.as_bytes() => {}
            Some(bytes) if bytes == file.text.as_bytes() => {
                shadow.text.clone_from(&file.text);
                shadow.line_ids.clone_from(&file.line_ids);
            }
            Some(bytes) if newest.is_none_or(|shadow| shadow.text.as_bytes() != bytes) => {
                // A copy only the save links is placed too, or the write-back
                // would turn the save's link to it into the attachment's.
                let mut ids = rendered;
                ids.extend(assets::copy_linked(&String::from_utf8_lossy(&bytes)));
                let links = self.placed(root, path, ids).await?;
                return self
                    .read_edit(root, page_id, path, bytes, &file, &links)
                    .await;
            }
            _ => {
                // While reading back is off, a vanished file is not written
                // again: it is listed as pending, and read in, as the rename or
                // the delete it was, once the user chooses to.
                if vanished && !self.read_back {
                    self.seen.missing.entry(page_id.to_owned()).or_insert(0);
                    return Ok(Wrote::Missing);
                }
                if vanished && self.still_missing(page_id) {
                    return Ok(Wrote::Missing);
                }
                if vanished
                    && let Some(ingest) = self.ingest()
                    && let Some(trashed) = self.trash(root, &ingest, page_id, path).await
                {
                    return trashed;
                }
                if let Some(why) = pause_reason(root, &self.device_id) {
                    return Ok(Wrote::Paused(why));
                }
                create_folders_below(root, path)?;
                return self.write_and_record(root, page_id, path, shadow);
            }
        }
        self.record(page_id, path, shadow)
    }

    /// `file`, the page's render, written over the text last written for the
    /// page, keeping the lines of every block it did not change ([`splice`]),
    /// wherever that text was: a page whose file moves keeps its own lines.
    fn spliced(&self, page_id: &str, file: &PageFile) -> (String, Vec<Option<String>>) {
        match self.pages.get(page_id).and_then(PageState::newest) {
            Some(last) => splice::splice(
                &last.text,
                &last.line_ids,
                last.base(),
                &file.text,
                &file.line_ids,
            ),
            None => (file.text.clone(), file.line_ids.clone()),
        }
    }

    /// Whether the page was adopted with its file (#6540), or with none, and
    /// neither has changed since: the page's buffer is `buffer`, as it was
    /// then, and its file is still what was adopted, or still missing. Nothing
    /// is written for such a page, so adopting a folder rewrites no file and
    /// adds none.
    fn adopted_unchanged(
        &self,
        root: &Path,
        page_id: &str,
        path: &str,
        buffer: &str,
    ) -> std::io::Result<bool> {
        let Some(state) = self.pages.get(page_id) else {
            return Ok(false);
        };
        if state.adopted_buffer.as_deref() != Some(buffer) {
            return Ok(false);
        }
        Ok(match state.newest() {
            Some(adopted) if state.path == path => {
                store::read_optional(&root.join(path))?.as_deref() == Some(adopted.text.as_bytes())
            }
            Some(_) => false,
            None => !root.join(path).exists(),
        })
    }

    /// How the file at `path` links `ids`' copies while copying is on, the
    /// copies written first; not at all while it is off. A copy that cannot
    /// be written leaves its link as rendered, and is listed as failed. Only
    /// the copies placed now are linked: a renamed attachment's old copy may
    /// still be recorded.
    async fn placed(
        &mut self,
        root: &Path,
        path: &str,
        ids: Vec<String>,
    ) -> Result<assets::Links, AppError> {
        let Some((space, _)) = path.split_once('/').filter(|_| self.copy_files) else {
            return Ok(assets::Links::default());
        };
        if ids.is_empty() || pause_reason(root, &self.device_id).is_some() {
            return Ok(assets::Links::default());
        }
        let (placed, failed) = self.copies.ensure(&self.pool, root, space, ids).await?;
        let prefix = format!("{space}/");
        let mut copies = HashMap::new();
        for (id, copy) in placed {
            self.copy_failed.remove(&copy);
            if let Some(below) = copy.strip_prefix(&prefix) {
                copies.insert(id, below.to_owned());
            }
            self.linked_copies.insert(copy);
        }
        for (copy, why) in failed {
            if self.copy_failed.insert(copy.clone(), why.clone()).is_none() {
                tracing::warn!(
                    path = copy,
                    why,
                    "the Markdown mirror cannot copy an attachment"
                );
            }
        }
        Ok(assets::Links::for_page(path, copies))
    }

    /// Count one more tick the page's file is missing; `false` once it has
    /// been missing for `MISSING_TICKS`, and counts as gone. Never while its
    /// file is a renamed one whose rename was refused.
    fn still_missing(&mut self, page_id: &str) -> bool {
        // The page's file is the refused one, not gone: a second file would
        // make two for one page.
        if let Some(path) = self.seen.refused_renames.get(page_id) {
            if self.seen.refused_new.contains_key(path) {
                return true;
            }
            self.seen.refused_renames.remove(page_id);
        }
        let ticks = self.seen.missing.entry(page_id.to_owned()).or_default();
        *ticks += 1;
        if *ticks <= MISSING_TICKS {
            return true;
        }
        self.seen.missing.remove(page_id);
        false
    }

    /// Move the page whose file at `path` was deleted outside Agaric to the
    /// Trash ([`ingest::trash`]), once nothing says the folder only looks
    /// empty: its marker is there, it holds other files, and so does the
    /// page's space folder, which an `rm -r` of one space or an unmounted
    /// link does not. `None` when one of these does not hold: the file is
    /// then written again.
    async fn trash(
        &mut self,
        root: &Path,
        ingest: &Ingest,
        page_id: &str,
        path: &str,
    ) -> Option<Result<Wrote, AppError>> {
        if let Some(why) = pause_reason(root, &self.device_id).or_else(|| self.emptied(root)) {
            return Some(Ok(Wrote::Paused(why)));
        }
        let space_folder = if self.adoption.is_some() {
            Some(root.to_path_buf())
        } else {
            path.split_once('/').map(|(folder, _)| root.join(folder))
        };
        if !space_folder.is_some_and(|folder| folder.is_dir()) {
            return None;
        }
        Some(
            match ingest::trash(ingest, &self.device_id, page_id, path).await {
                Ok(event) => {
                    (ingest.notify)(event);
                    // Its file is gone: a page restored from the Trash is
                    // written as a new one, not taken for a file vanished
                    // again and trashed once more.
                    self.forget(page_id);
                    Ok(Wrote::Done)
                }
                Err(why) => Ok(Wrote::Refused(why)),
            },
        )
    }

    /// Keep `shadow` as the text last written for the page at `path`.
    fn record(&mut self, page_id: &str, path: &str, shadow: Shadow) -> Result<Wrote, AppError> {
        self.seen.settling.remove(page_id);
        self.seen.refused.remove(page_id);
        let mut state = self
            .pages
            .get(page_id)
            .cloned()
            .unwrap_or_else(|| PageState {
                path: path.to_owned(),
                ..PageState::default()
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
        links: &assets::Links,
    ) -> Result<Wrote, AppError> {
        // A page with no blocks has nothing a blank file could delete, so an
        // editor's final newline or BOM on its empty file changes nothing
        // (#6506).
        if render.text.trim().is_empty() && is_blank(&bytes) {
            if let Some(why) = pause_reason(root, &self.device_id) {
                return Ok(Wrote::Paused(why));
            }
            // Written back as the render, as an ingest writes back LF and no BOM.
            let shadow = Shadow {
                text: render.text.clone(),
                line_ids: render.line_ids.clone(),
                buffer: Some(render.buffer.clone()),
                render: Some(store::Render::of(render)),
            };
            return self.write_and_record(root, page_id, path, shadow);
        }
        let Some(ingest) = self.ingest() else {
            return Ok(Wrote::Diverged);
        };
        if let Some((refused, why)) = self.seen.refused.get(page_id)
            && *refused == bytes
        {
            return Ok(Wrote::Refused(why.clone()));
        }
        if self.seen.settling.get(page_id) != Some(&bytes) {
            self.seen.settling.insert(page_id.to_owned(), bytes);
            return Ok(Wrote::Diverged);
        }
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
            links,
        )
        .await;
        let ingested = match ingested {
            Ok(ingested) => ingested,
            Err(NotIngested::NoBase) => return Ok(Wrote::Diverged),
            Err(NotIngested::Refused(why)) => {
                self.seen.settling.remove(page_id);
                self.seen
                    .refused
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
            return self.write_and_record(root, page_id, path, shadow);
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

/// This device's last op `seq` ever, which compaction does not lower as it
/// does [`own_head`].
async fn durable_head(pool: &SqlitePool, device_id: &str) -> Result<i64, AppError> {
    let mut conn = pool.acquire().await?;
    Ok(agaric_store::op_log::next_seq_for_device(&mut conn, device_id).await? - 1)
}

/// The hash of this device's op `seq`, `None` when the op log holds no such
/// op.
async fn op_hash(pool: &SqlitePool, device_id: &str, seq: i64) -> Result<Option<String>, AppError> {
    match agaric_store::op_log::get_op_by_seq(&ReadPool(pool.clone()), device_id, seq).await {
        Ok(op) => Ok(Some(op.hash)),
        Err(AppError::NotFound(_)) => Ok(None),
        Err(e) => Err(e),
    }
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

/// Move `file` to the OS trash (#6540). The mirror runs on desktop only;
/// elsewhere there is no trash, and nothing calls this.
fn to_os_trash(file: &Path) -> std::io::Result<()> {
    #[cfg(desktop)]
    return trash::delete(file).map_err(std::io::Error::other);
    #[cfg(not(desktop))]
    return std::fs::remove_file(file);
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
