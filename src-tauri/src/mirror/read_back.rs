//! Reading files changed outside Agaric back in is a setting (#5363 slice 4,
//! setting 1): off, the mirror still writes every page and still never
//! overwrites a changed file, but no outside edit, new file, rename, move or
//! delete reaches Agaric. Turning it on again reads in what changed meanwhile
//! only once the user has seen the list [`pending`] gives and said so. The
//! mirror asks the same way, reading nothing back meanwhile, when more files
//! of one space than [`MASS_CHANGE`] changed or were deleted at once
//! ([`mass_changed`]), unless the user chose not to be asked.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;

use agaric_core::error::AppError;

use super::store::{self, Adoption, StateDir};

/// Which files of the folder the mirror reads.
pub enum Scope<'a> {
    /// Those in the mirrored spaces' folders.
    Spaces(&'a HashSet<String>),
    /// Every file of a folder adopted as one space's, but those left alone
    /// at adoption and unchanged since.
    Adopted(&'a Adoption),
}

/// What reading a [`MirrorPending`] file in does to Agaric.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum MirrorPendingKind {
    /// A page's file that is not the text last written there, or cannot be
    /// read: read into its page.
    Edited,
    /// A file no page owns: read onto a new page, or the renamed file of a
    /// page listed as [`MirrorPendingKind::Gone`].
    New,
    /// A page's file that is gone: its page moves to the Trash, unless the
    /// file turns up renamed.
    Gone,
}

/// A file reading back would act on ([`pending`]), by its path below the
/// mirror's folder. The user's choice to read files in names each as it was
/// listed, so one that changed in another way since, as an edited file
/// deleted, is not among those chosen.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub struct MirrorPending {
    pub path: String,
    pub kind: MirrorPendingKind,
}

/// More files of one space than this, changed or deleted outside Agaric at
/// once, are read in only once the user has seen them listed and said so
/// ([`mass_changed`]).
pub const MASS_CHANGE: usize = 5;

/// The space folders holding more than [`MASS_CHANGE`] of `changed`, files
/// that are not among `confirmed` as they changed, each with how many. In a
/// folder `adopted` as one space's (#6540), every file is that space's: the
/// folder itself, `.`, holds them all.
pub fn mass_changed<'a>(
    changed: &'a [MirrorPending],
    confirmed: &HashSet<MirrorPending>,
    adopted: bool,
) -> BTreeMap<&'a str, usize> {
    let mut counts = BTreeMap::new();
    for file in changed.iter().filter(|file| !confirmed.contains(*file)) {
        let folder = if adopted {
            Some(".")
        } else {
            file.path.split_once('/').map(|(folder, _)| folder)
        };
        if let Some(folder) = folder {
            *counts.entry(folder).or_default() += 1;
        }
    }
    counts.retain(|_, count| *count > MASS_CHANGE);
    counts
}

/// What reading a page's `file` in does, `None` while it holds `written`, the
/// text last written there. A file that cannot be read counts as edited.
pub fn change(file: &Path, written: &[u8]) -> Option<MirrorPendingKind> {
    match store::read_optional(file) {
        Ok(Some(bytes)) if bytes == written => None,
        Ok(None) => Some(MirrorPendingKind::Gone),
        Ok(Some(_)) | Err(_) => Some(MirrorPendingKind::Edited),
    }
}

/// The files, as paths below `root`, that reading back would act on now, in
/// `scope`, by path, each with what reading it in does: each page's file
/// that is not the text last written there or is gone, and each `.md` file
/// no page owns. A file that cannot be read is listed too, as edited.
///
/// # Errors
///
/// [`AppError::Validation`] when the folder, its marker or the state files
/// cannot be read: nothing could be shown, so nothing may be read in.
pub fn pending(
    root: &Path,
    device_id: &str,
    states: &StateDir,
    scope: &Scope,
) -> Result<Vec<MirrorPending>, AppError> {
    if let Some(why) = super::pause_reason(root, device_id) {
        return Err(AppError::validation(format!(
            "cannot tell which files changed: {why}"
        )));
    }
    let unreadable =
        |e: std::io::Error| AppError::validation(format!("cannot tell which files changed: {e}"));
    let pages = states.load().map_err(unreadable)?;
    // Only the mirrored spaces' files: the others are never read.
    let mirrored = |path: &str| match scope {
        Scope::Spaces(space_folders) => path
            .split_once('/')
            .is_some_and(|(folder, _)| space_folders.contains(folder)),
        Scope::Adopted(_) => true,
    };
    let written: HashMap<&str, &[u8]> = pages
        .values()
        .filter(|state| mirrored(&state.path))
        .filter_map(|state| Some((state.path.as_str(), state.newest()?.text.as_bytes())))
        .collect();
    let mut pending: Vec<MirrorPending> = written
        .iter()
        .filter_map(|(path, text)| {
            Some(MirrorPending {
                path: (*path).to_owned(),
                kind: change(&root.join(path), text)?,
            })
        })
        .collect();
    let mut found = Vec::new();
    match scope {
        Scope::Spaces(space_folders) => {
            for folder in *space_folders {
                markdown_below(root, &root.join(folder), &mut found).map_err(unreadable)?;
            }
        }
        Scope::Adopted(adoption) => {
            markdown_below(root, root, &mut found).map_err(unreadable)?;
            found.retain(|path| {
                store::read_optional(&root.join(path))
                    .ok()
                    .flatten()
                    .is_none_or(|bytes| !adoption.leaves_alone(path, &bytes))
            });
        }
    }
    let owned = written.keys().copied().collect();
    pending.extend(
        super::paths::unowned(found, &owned, |path| root.join(path).is_file())
            .into_iter()
            .map(|path| MirrorPending {
                path,
                kind: MirrorPendingKind::New,
            }),
    );
    pending.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(pending)
}

/// Every `.md` file below `folder`, as `/`-separated paths below `root`,
/// hidden entries and copy folders left out as the mirror's scan leaves
/// them out. A missing
/// folder holds none.
fn markdown_below(root: &Path, folder: &Path, found: &mut Vec<String>) -> std::io::Result<()> {
    let entries = match std::fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            // A copy folder is never read ([`super::assets`]).
            if !path
                .strip_prefix(root)
                .is_ok_and(super::assets::is_copy_dir)
            {
                markdown_below(root, &path, found)?;
            }
        } else if name.ends_with(".md")
            && let Ok(below) = path.strip_prefix(root)
        {
            let parts: Vec<String> = below
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect();
            found.push(parts.join("/"));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "read_back_tests.rs"]
mod tests;
