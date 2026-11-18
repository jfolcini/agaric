//! Adopting a folder of notes in place (#6540): a folder the user already
//! keeps Markdown in, imported into a space, becomes that space's mirror
//! folder without a file being rewritten, moved or added.
//!
//! Each imported page's state starts from its file's own bytes, with each of
//! the file's blocks given the id of the page's block in the same place, so
//! the mirror's splice keeps every line a later write does not change. While
//! the page renders as it did at adoption and its file is unchanged, nothing
//! is written for it ([`PageState::adopted_render`]); a page with no file of
//! its own, such as one a link to a missing note created, gets no file until
//! it changes. A file stays where it is while its page keeps the title it had
//! ([`PageState::adopted_title`]); renamed, the page's file moves to the path
//! the mirror names, `<title path>.md` below the folder. The `.md` files no
//! page took are left alone until they change.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Component, Path};

use serde::{Deserialize, Serialize};
use specta::Type;
use sqlx::SqlitePool;

use agaric_core::error::AppError;
use agaric_engine::import::parse_document_outline;

use super::store::{self, Adoption, PageState, Shadow, StateDir};
use super::{MirrorState, paths, splice};
use crate::commands::pages::{get_page_file_inner, list_all_pages_in_space_inner};

/// A file of the folder and the page it was imported as.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Type)]
pub struct AdoptFile {
    /// Below the folder, `/`-separated, ending in `.md`.
    pub path: String,
    pub page_id: String,
}

/// A file the mirror would write differently from how it stands once its
/// page is next written: `before` is the file, `after` what is written for
/// the page as it is now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct AdoptChange {
    pub path: String,
    pub page_id: String,
    pub before: String,
    pub after: String,
}

/// What adopting the folder does: nothing is written at adoption; `changes`
/// lists the files a later write of their page would change beyond its
/// edit, and `left_alone` the files of the folder no page took, which the
/// mirror neither reads nor writes while they stay as they are.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct AdoptionPreview {
    pub changes: Vec<AdoptChange>,
    pub left_alone: Vec<String>,
}

/// The states an adoption starts the mirror from, and what it shows first.
struct Plan {
    states: Vec<(String, PageState)>,
    preview: AdoptionPreview,
    left_alone: BTreeMap<String, String>,
}

/// What adopting `folder` as `space_id`'s mirror folder, with `files` as its
/// pages' files, would do. Nothing is stored.
///
/// # Errors
///
/// [`AppError::Validation`] naming why the folder or a file is refused.
pub async fn preview(
    pool: &SqlitePool,
    device_id: &str,
    app_data_dir: &Path,
    folder: &Path,
    space_id: &str,
    files: &[AdoptFile],
) -> Result<AdoptionPreview, AppError> {
    check_folder(folder, device_id, app_data_dir)?;
    Ok(plan(pool, folder, space_id, files).await?.preview)
}

/// An adoption: `folder` as `space_id`'s mirror folder, `files` as its
/// pages' files, reading files changed outside Agaric back in when
/// `read_back`.
pub struct Request<'a> {
    pub folder: &'a Path,
    pub space_id: &'a str,
    pub files: &'a [AdoptFile],
    pub read_back: bool,
}

/// Adopt the folder as `request` says. The states are written first, then
/// the marker and the settings; the next tick loads the states and writes
/// nothing that is unchanged.
///
/// # Errors
///
/// [`AppError::Validation`] while the mirror is on, or naming why the folder
/// or a file is refused; the states or the settings cannot be written.
pub async fn adopt(
    pool: &SqlitePool,
    device_id: &str,
    mirror: &MirrorState,
    request: Request<'_>,
) -> Result<(), AppError> {
    let Request {
        folder,
        space_id,
        files,
        read_back,
    } = request;
    if store::folder(pool).await?.is_some() {
        return Err(AppError::validation(
            "turn the mirror off before adopting a folder".to_owned(),
        ));
    }
    check_folder(folder, device_id, mirror.app_data_dir())?;
    let plan = plan(pool, folder, space_id, files).await?;
    let key = folder.to_string_lossy();
    let mut states = StateDir::new(mirror.app_data_dir());
    states.forget(&key)?;
    states.bind(&key)?;
    for (page_id, state) in &plan.states {
        states.save(page_id, state)?;
    }
    store::write_marker(folder, device_id).map_err(|e| {
        AppError::validation(format!(
            "cannot mark {} as the mirror: {e}",
            folder.display()
        ))
    })?;
    let adoption = Adoption {
        space_id: space_id.to_ascii_uppercase(),
        left_alone: plan.left_alone,
    };
    store::set_read_back(pool, read_back).await?;
    store::set_adoption(pool, Some(&adoption)).await?;
    store::set_folder(pool, Some(&key)).await?;
    mirror.reload();
    Ok(())
}

/// Refuse `folder` unless it is an absolute path to an existing folder,
/// apart from the app's data, and no other device's mirror. Unlike
/// [`super::check_folder`], it may hold files: they are the ones adopted.
fn check_folder(folder: &Path, device_id: &str, app_data_dir: &Path) -> Result<(), AppError> {
    let refuse = |why: &str| Err(AppError::validation(why.to_owned()));
    if !folder.is_absolute() {
        return refuse("the folder must be an absolute path");
    }
    if !folder.is_dir() {
        return refuse("the folder must be an existing folder");
    }
    let unreadable = |e: std::io::Error| {
        AppError::validation(format!("cannot read the folder {}: {e}", folder.display()))
    };
    let canonical = folder.canonicalize().map_err(unreadable)?;
    let data = app_data_dir
        .canonicalize()
        .unwrap_or_else(|_| app_data_dir.to_path_buf());
    if canonical.starts_with(&data) || data.starts_with(&canonical) {
        return refuse("the folder cannot hold Agaric's data or be inside it");
    }
    match store::marker_device(folder).map_err(unreadable)? {
        Some(owner) if owner != device_id => refuse("that folder is another device's mirror"),
        _ => Ok(()),
    }
}

async fn plan(
    pool: &SqlitePool,
    folder: &Path,
    space_id: &str,
    files: &[AdoptFile],
) -> Result<Plan, AppError> {
    let space_id = space_id.to_ascii_uppercase();
    let known = crate::commands::spaces::list_spaces_inner(pool)
        .await?
        .into_iter()
        .any(|space| space.id == space_id);
    if !known {
        return Err(AppError::validation(format!("no space {space_id}")));
    }
    let pages: Vec<paths::PageEntry> = list_all_pages_in_space_inner(pool, &space_id, None)
        .await?
        .into_iter()
        .map(|page| paths::PageEntry {
            id: page.id.into_string(),
            space_id: space_id.clone(),
            title: page.content.unwrap_or_default(),
        })
        .collect();
    let mut on_disk = Vec::new();
    files_below(folder, folder, &mut on_disk)
        .map_err(|e| AppError::validation(format!("cannot read the folder: {e}")))?;
    let mapped = mapped(files, &pages, &on_disk)?;
    let layout = paths::adopted_layout(&pages, &mapped);
    let mut states = Vec::new();
    let mut changes = Vec::new();
    for page in &pages {
        let path = mapped.get(&page.id);
        let (state, change) = page_state(
            pool,
            folder,
            page,
            path.unwrap_or(&layout[&page.id]),
            path.is_some(),
        )
        .await?;
        changes.extend(change);
        states.push((page.id.clone(), state));
    }
    let taken: HashSet<&String> = mapped.values().collect();
    let unmapped: Vec<String> = on_disk.into_iter().filter(|p| !taken.contains(p)).collect();
    let mut left_alone = BTreeMap::new();
    for path in unmapped.iter().filter(|path| path.ends_with(".md")) {
        let bytes = std::fs::read(folder.join(path))?;
        left_alone.insert(path.clone(), store::content_hash(&bytes));
    }
    changes.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    Ok(Plan {
        states,
        preview: AdoptionPreview {
            changes,
            left_alone: unmapped,
        },
        left_alone,
    })
}

/// The state `page` starts from, its file at `path` when it was `adopted`
/// with one, and how a later write would change that file, if it would.
async fn page_state(
    pool: &SqlitePool,
    folder: &Path,
    page: &paths::PageEntry,
    path: &str,
    adopted: bool,
) -> Result<(PageState, Option<AdoptChange>), AppError> {
    let render = get_page_file_inner(pool, &page.id).await?;
    let mut state = PageState {
        path: path.to_owned(),
        adopted_render: Some(render.text.clone()),
        ..PageState::default()
    };
    if !adopted {
        return Ok((state, None));
    }
    let bytes = std::fs::read(folder.join(path))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| AppError::validation(format!("{path} is not UTF-8")))?;
    let line_ids = seed_line_ids(&text, &render.line_ids);
    let (after, _) = splice::splice(&text, &line_ids, &render.text, &render.line_ids);
    let change = (after != text).then(|| AdoptChange {
        path: path.to_owned(),
        page_id: page.id.clone(),
        before: text.clone(),
        after,
    });
    state.adopted_title = Some(page.title.clone());
    state.shadows.push(Shadow {
        text,
        line_ids,
        buffer: Some(render.buffer),
    });
    Ok((state, change))
}

/// `files` as each page's path, refused unless each names a `.md` file of the
/// folder below it, and a page of the space, once.
fn mapped(
    files: &[AdoptFile],
    pages: &[paths::PageEntry],
    on_disk: &[String],
) -> Result<HashMap<String, String>, AppError> {
    let refuse = |why: String| Err(AppError::validation(why));
    let live: HashSet<&str> = pages.iter().map(|page| page.id.as_str()).collect();
    let mut by_page = HashMap::new();
    let mut paths = HashSet::new();
    for file in files {
        let page_id = file.page_id.to_ascii_uppercase();
        let below = Path::new(&file.path)
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
        if !below || !file.path.ends_with(".md") || !on_disk.contains(&file.path) {
            return refuse(format!("{} is no Markdown file of the folder", file.path));
        }
        if !live.contains(page_id.as_str()) {
            return refuse(format!("{} names no page of the space", file.path));
        }
        if !paths.insert(file.path.clone()) || by_page.contains_key(&page_id) {
            return refuse(format!("{} is named twice", file.path));
        }
        by_page.insert(page_id, file.path.clone());
    }
    Ok(by_page)
}

/// The line ids a file's state starts with: each of its blocks, in order,
/// given the id of the render's block in the same place, when the two hold
/// as many blocks; none otherwise, so a later write takes the render whole.
fn seed_line_ids(text: &str, render_ids: &[Option<String>]) -> Vec<Option<String>> {
    let mut ids = vec![None; text.split('\n').count()];
    let blocks = parse_document_outline(text).blocks;
    let rendered: Vec<&String> = render_ids.iter().flatten().collect();
    if blocks.len() != rendered.len() {
        return ids;
    }
    for (block, id) in blocks.iter().zip(rendered) {
        if let Some(slot) = block
            .line
            .and_then(|line| ids.get_mut(line.checked_sub(1)?))
        {
            *slot = Some(id.clone());
        }
    }
    ids
}

/// Every file below `dir`, as `/`-separated paths below `root`, hidden
/// entries left out as the mirror's scan leaves them out.
fn files_below(root: &Path, dir: &Path, found: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            files_below(root, &path, found)?;
        } else if let Ok(below) = path.strip_prefix(root) {
            let parts: Vec<String> = below
                .components()
                .map(|part| part.as_os_str().to_string_lossy().into_owned())
                .collect();
            found.push(parts.join("/"));
        }
    }
    found.sort_unstable();
    Ok(())
}

#[cfg(test)]
#[path = "adopt_tests.rs"]
mod tests;
