//! Reading files changed outside Agaric back in is a setting (#5363 slice 4,
//! setting 1): off, the mirror still writes every page and still never
//! overwrites a changed file, but no outside edit, new file, rename, move or
//! delete reaches Agaric. Turning it on again reads in what changed meanwhile
//! only once the user has seen the list [`pending`] gives and said so.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use agaric_core::error::AppError;

use super::store::{self, StateDir};

/// The files, as paths below `root`, that reading back would act on now: each
/// page's file that is not the text last written there or is gone, and each
/// `.md` file in one of `space_folders` that no page owns. A file that cannot
/// be read is listed too.
///
/// # Errors
///
/// [`AppError::Validation`] when the folder, its marker or the state files
/// cannot be read: nothing could be shown, so nothing may be read in.
pub fn pending(
    root: &Path,
    device_id: &str,
    states: &StateDir,
    space_folders: &HashSet<String>,
) -> Result<Vec<String>, AppError> {
    if let Some(why) = super::pause_reason(root, device_id) {
        return Err(AppError::validation(format!(
            "cannot tell which files changed: {why}"
        )));
    }
    let unreadable =
        |e: std::io::Error| AppError::validation(format!("cannot tell which files changed: {e}"));
    let pages = states.load().map_err(unreadable)?;
    let written: HashMap<&str, &[u8]> = pages
        .values()
        .filter_map(|state| Some((state.path.as_str(), state.newest()?.text.as_bytes())))
        .collect();
    let mut pending: Vec<String> = written
        .iter()
        .filter(|(path, text)| {
            store::read_optional(&root.join(path))
                .map_or(true, |bytes| bytes.as_deref() != Some(**text))
        })
        .map(|(path, _)| (*path).to_owned())
        .collect();
    for folder in space_folders {
        let mut found = Vec::new();
        markdown_below(root, &root.join(folder), &mut found).map_err(unreadable)?;
        pending.extend(
            found
                .into_iter()
                .filter(|path| !written.contains_key(path.as_str())),
        );
    }
    pending.sort_unstable();
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
