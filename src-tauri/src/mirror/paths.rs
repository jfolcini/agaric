//! Where the Markdown mirror writes each page (#5363): `<space folder>/<title
//! path>.md` below the mirror's folder.
//!
//! A port of the ZIP export's mapping (`src/lib/export-graph.ts`), which gives
//! a clean title the same path, plus what a folder kept in step on disk needs:
//! control characters replaced, a segment cut to `MAX_SEGMENT_BYTES`, and
//! collisions found as APFS and NTFS compare names, case-insensitively and
//! under NFC, then settled in id order, so a page keeps its name from one pass
//! to the next.

use std::collections::{HashMap, HashSet};

/// The longest segment written, in bytes: ext4 and NTFS refuse a name past
/// 255, and a segment this long still takes a disambiguation suffix and `.md`.
const MAX_SEGMENT_BYTES: usize = 200;

/// Windows device names, reserved whatever extension follows them.
const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A character no segment may hold: the ones Windows refuses in a name, the
/// path separators other than the namespace's `/`, and control characters,
/// which no file system takes all of.
fn is_illegal(c: char) -> bool {
    matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
}

/// `segment` as one file or folder name: trimmed, its illegal characters
/// replaced by `_`, cut to `MAX_SEGMENT_BYTES` on a char boundary, its
/// trailing dots and spaces removed (Windows drops them, and a segment of dots
/// alone would climb out of its folder), a Windows device name escaped with
/// `_` (`CON` → `CON_`, `con.txt` → `con_.txt`), and `Untitled` when nothing is
/// left.
pub fn sanitize_segment(segment: &str) -> String {
    let replaced: String = segment
        .trim()
        .chars()
        .map(|c| if is_illegal(c) { '_' } else { c })
        .collect();
    let cleaned = cut_to(&replaced, MAX_SEGMENT_BYTES).trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        return "Untitled".to_owned();
    }
    escape_reserved_device_name(cleaned)
}

/// The longest prefix of `text` within `max` bytes that ends on a char
/// boundary.
fn cut_to(text: &str, max: usize) -> &str {
    let end = text
        .char_indices()
        .map(|(i, c)| i + c.len_utf8())
        .take_while(|&end| end <= max)
        .last()
        .unwrap_or(0);
    &text[..end]
}

fn escape_reserved_device_name(name: &str) -> String {
    let (base, rest) = name.split_at(name.find('.').unwrap_or(name.len()));
    let reserved = RESERVED_DEVICE_NAMES
        .iter()
        .any(|device| base.trim_end().eq_ignore_ascii_case(device));
    if reserved {
        format!("{base}_{rest}")
    } else {
        name.to_owned()
    }
}

/// A page title's path below its space folder, without `.md`: a folder per
/// namespace segment, each segment [`sanitize_segment`]ed, an empty one
/// included (`/etc/x` → `Untitled/etc/x`).
pub fn title_path(title: &str) -> String {
    title
        .split('/')
        .map(sanitize_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// A space's folder: its name as one segment, any `/` in it flattened to `_`,
/// since a space has no namespaces.
pub fn space_folder(name: &str) -> String {
    sanitize_segment(&name.replace('/', "_"))
}

/// The key two paths collide under on a case-insensitive, normalization-
/// insensitive file system: the fold the tag key uses, NFC, lowercase, NFC.
fn fold(path: &str) -> String {
    agaric_core::tag_norm::normalize_tag_name(path)
}

/// Each `(id, name)` owner's name, made distinct under `fold`. In id order,
/// a name already taken gets `_` and its owner's first 8 id characters, and a
/// counter after that while it is still taken, so the lowest id of a colliding
/// set keeps the bare name.
fn disambiguate(mut owners: Vec<(&str, String)>) -> HashMap<String, String> {
    owners.sort_unstable_by(|a, b| a.0.cmp(b.0));
    let mut taken = HashSet::new();
    owners
        .into_iter()
        .map(|(id, base)| {
            let mut name = base.clone();
            if taken.contains(&fold(&name)) {
                let with_id = format!("{base}_{}", id.get(..8).unwrap_or(id));
                name.clone_from(&with_id);
                let mut n = 2;
                while taken.contains(&fold(&name)) {
                    name = format!("{with_id}-{n}");
                    n += 1;
                }
            }
            taken.insert(fold(&name));
            (id.to_owned(), name)
        })
        .collect()
}

/// Each `(id, name)` space's folder below the mirror's folder, distinct
/// under `fold`.
pub fn space_folders(spaces: &[(String, String)]) -> HashMap<String, String> {
    disambiguate(
        spaces
            .iter()
            .map(|(id, name)| (id.as_str(), space_folder(name)))
            .collect(),
    )
}

/// A live page as the mirror lays it out: its id, its space's and its title.
pub struct PageEntry {
    pub id: String,
    pub space_id: String,
    pub title: String,
}

/// Each page's file below the mirror's folder, `/`-separated:
/// `<space folder>/<title path>.md`, distinct under `fold` within a space,
/// as the space folders are among themselves. `spaces` are `(id, name)`; a
/// page whose space is not among them gets no file.
pub fn layout(spaces: &[(String, String)], pages: &[PageEntry]) -> HashMap<String, String> {
    let folders = space_folders(spaces);
    let mut by_space: HashMap<&str, Vec<(&str, String)>> = HashMap::new();
    for page in pages.iter().filter(|p| folders.contains_key(&p.space_id)) {
        by_space
            .entry(page.space_id.as_str())
            .or_default()
            .push((page.id.as_str(), title_path(&page.title)));
    }
    by_space
        .into_iter()
        .flat_map(|(space, pages)| {
            let folder = &folders[space];
            disambiguate(pages)
                .into_iter()
                .map(move |(id, path)| (id, format!("{folder}/{path}.md")))
        })
        .collect()
}

#[cfg(test)]
#[path = "paths_tests.rs"]
mod tests;
