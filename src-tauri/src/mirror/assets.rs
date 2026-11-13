//! Copies of the attachments pages link to (#5363 setting 3): off by default;
//! on, each attachment a page's file links as `attachment:<id>` is copied to
//! `<space>/assets/<id>/<name>` and the link points at the copy, the layout an
//! unzipped *Export all spaces* has (#6277 G3). Copies go out only: a link to
//! a copy is read back as the attachment, and a file put in `assets/` is never
//! read. A copy is written when it is missing or its file changed since, and
//! removed, while unchanged, once no page of its space links it, its
//! attachment is gone, or copying is turned off; a changed one is left and
//! listed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use agaric_core::error::AppError;

use crate::commands::pages::PageFile;

/// The folder below a space's folder that holds its copies.
pub const ASSETS_DIR: &str = "assets";

/// An `attachment:<id>` link, as the export's `ATTACHMENT_REF_RE` reads one
/// (`src/lib/export-graph.ts`): `!`, the label, the id.
static ATTACHMENT_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(!?)\[([^\]]*)\]\(attachment:([0-9A-Za-z_-]+)\)").expect("a valid pattern")
});

/// A link to a copy: `!`, the label, the id. The destination may be wrapped
/// in `<…>`, as [`destination`] writes one with a space or a parenthesis.
static COPY_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(!?)\[([^\]]*)\]\((?:<(?:\.\./)*assets/([0-9A-HJKMNP-TV-Z]{26})/[^>\n]*>|(?:\.\./)*assets/([0-9A-HJKMNP-TV-Z]{26})/[^)\s]*)\)",
    )
    .expect("a valid pattern")
});

/// Windows device names, matched on a name's part before its first `.`.
static RESERVED_DEVICE_NAME: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$").expect("a valid pattern")
});

/// The characters JavaScript's `String.prototype.trim` strips, which the
/// export's sanitizer uses: Rust's `char::is_whitespace` adds U+0085 and
/// leaves out U+FEFF.
fn js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// The name an attachment's copy takes, as the export names its asset
/// (`rewriteAttachmentRefs` in `src/lib/export-graph.ts`): one segment, a
/// path separator in it made `_`, then `sanitizeSegment`. Pinned against
/// the export by `conformance/asset-names.vectors.json`.
pub fn asset_name(filename: &str) -> String {
    let flat = filename.replace('/', "_");
    let cleaned: String = flat
        .chars()
        .map(|c| {
            if matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned
        .trim_matches(js_whitespace)
        .trim_end_matches(['.', ' ']);
    if cleaned.is_empty() {
        return "Untitled".to_owned();
    }
    let (base, rest) = cleaned.split_at(cleaned.find('.').unwrap_or(cleaned.len()));
    if RESERVED_DEVICE_NAME.is_match(base.trim_end_matches(js_whitespace)) {
        format!("{base}_{rest}")
    } else {
        cleaned.to_owned()
    }
}

/// `path` as a Markdown link destination, as the export writes one: in
/// `<…>` when it holds whitespace or a parenthesis.
fn destination(path: &str) -> String {
    if path
        .chars()
        .any(|c| js_whitespace(c) || c == '(' || c == ')')
    {
        format!("<{path}>")
    } else {
        path.to_owned()
    }
}

/// Whether `below`, a folder below the mirror's, holds a copy: exactly
/// `<space>/assets/<id>`. The mirror's scan never reads into one, so a page
/// titled `assets/x` is still a page.
pub fn is_copy_dir(below: &Path) -> bool {
    let parts: Vec<&str> = below
        .components()
        .filter_map(|part| match part {
            Component::Normal(name) => name.to_str(),
            _ => None,
        })
        .collect();
    matches!(parts.as_slice(), [_, ASSETS_DIR, id] if is_attachment_id(id))
}

fn is_attachment_id(id: &str) -> bool {
    id.len() == 26
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b.is_ascii_uppercase() && !b"ILOU".contains(&b)))
}

/// The attachments `text` links, each once, in order.
pub fn linked(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    ATTACHMENT_LINK
        .captures_iter(text)
        .map(|link| link[3].to_owned())
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

/// How one page's file links its attachments: to their copies, by a path
/// relative to the page's file.
#[derive(Debug, Default)]
pub struct Links {
    /// `../` once per folder between the page's file and its space's folder.
    prefix: String,
    /// Each copied attachment, by id, as its path below the space's folder.
    copies: HashMap<String, String>,
}

impl Links {
    /// For the page whose file is at `path`, with `copies` from
    /// [`Copies::ensure`], as paths below the space's folder.
    pub fn for_page(path: &str, copies: HashMap<String, String>) -> Self {
        let depth = path.matches('/').count().saturating_sub(1);
        Self {
            prefix: "../".repeat(depth),
            copies,
        }
    }

    /// `file` with each link to a copied attachment pointing at its copy;
    /// the rest as rendered. Only text within a line changes, so the line
    /// ids still hold.
    pub fn localize(&self, mut file: PageFile) -> PageFile {
        if self.copies.is_empty() {
            return file;
        }
        file.text = ATTACHMENT_LINK
            .replace_all(&file.text, |link: &Captures<'_>| {
                match self.copies.get(&link[3]) {
                    Some(copy) => format!(
                        "{}[{}]({})",
                        &link[1],
                        &link[2],
                        destination(&format!("{}{copy}", self.prefix))
                    ),
                    None => link[0].to_owned(),
                }
            })
            .into_owned();
        file
    }
}

/// `text` with each link to a copy of a live attachment back as its
/// `attachment:<id>` link; any other link stays as it is.
///
/// # Errors
///
/// Which attachments are live cannot be read.
pub async fn delocalize(pool: &SqlitePool, text: &str) -> Result<String, AppError> {
    let ids = copy_linked(text);
    if ids.is_empty() {
        return Ok(text.to_owned());
    }
    let live: HashSet<String> = attachments(pool, ids).await?.into_keys().collect();
    Ok(COPY_LINK
        .replace_all(text, |link: &Captures<'_>| {
            let id = link
                .get(3)
                .or_else(|| link.get(4))
                .map_or("", |id| id.as_str());
            if live.contains(id) {
                format!("{}[{}](attachment:{id})", &link[1], &link[2])
            } else {
                link[0].to_owned()
            }
        })
        .into_owned())
}

/// The attachments `text` links the copies of, each once.
pub fn copy_linked(text: &str) -> Vec<String> {
    let ids: HashSet<&str> = COPY_LINK
        .captures_iter(text)
        .filter_map(|link| link.get(3).or_else(|| link.get(4)))
        .map(|id| id.as_str())
        .collect();
    ids.into_iter().map(str::to_owned).collect()
}

/// The live attachments among `ids`: each one's file name and stored path
/// below the app's data.
pub(super) async fn attachments(
    pool: &SqlitePool,
    ids: Vec<String>,
) -> Result<HashMap<String, (String, String)>, AppError> {
    let ids = serde_json::to_string(&ids)?;
    let rows = sqlx::query!(
        r#"SELECT id AS "id!: String", filename, fs_path FROM attachments
            WHERE id IN (SELECT value FROM json_each(?1)) AND deleted_at IS NULL"#,
        ids,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.id, (row.filename, row.fs_path)))
        .collect())
}

/// One copy as written: its attachment, and its file's length and
/// modification time then.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Copy {
    pub id: String,
    pub len: u64,
    pub modified_ms: Option<u128>,
}

fn stat(path: &Path) -> Option<(u64, Option<u128>)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|since| since.as_millis());
    Some((meta.len(), modified))
}

/// The copies the mirror wrote, by path below its folder: `mirror/copies.json`
/// in the app's data, beside the pages' state files.
pub struct Copies {
    file: PathBuf,
    app_data_dir: PathBuf,
    written: BTreeMap<String, Copy>,
}

impl Copies {
    /// The copies as last saved; none when the file is missing, or does not
    /// parse, whose copies are then written again and their first removal
    /// left to the unchanged rule.
    pub fn load(app_data_dir: &Path) -> Self {
        let file = app_data_dir.join("mirror").join("copies.json");
        let written = std::fs::read(&file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            file,
            app_data_dir: app_data_dir.to_path_buf(),
            written,
        }
    }

    fn save(&self) -> Result<(), AppError> {
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        super::store::write_atomic(&self.file, &serde_json::to_vec(&self.written)?)?;
        Ok(())
    }

    /// Copy each live attachment among `ids` into `space`'s folder below
    /// `root`, unless its copy is there: one the user changed since is left
    /// as they made it, and listed by [`Copies::remove_except`]. Returns each copy in
    /// place, as its attachment and path, and the copies that could not be
    /// written, and why.
    ///
    /// # Errors
    ///
    /// The attachments cannot be read, or the record of copies not saved.
    pub async fn ensure(
        &mut self,
        pool: &SqlitePool,
        root: &Path,
        space: &str,
        ids: Vec<String>,
    ) -> Result<(Vec<(String, String)>, Vec<(String, String)>), AppError> {
        let found = attachments(pool, ids).await?;
        let mut placed = Vec::new();
        let mut failed = Vec::new();
        let mut changed = false;
        for (id, (filename, fs_path)) in found {
            let path = format!("{space}/{ASSETS_DIR}/{id}/{}", asset_name(&filename));
            let target = root.join(&path);
            let there =
                target.is_file() && self.written.get(&path).is_some_and(|copy| copy.id == id);
            if !there {
                if let Err(e) = copy_file(root, &path, &self.app_data_dir.join(&fs_path)) {
                    failed.push((path, e.to_string()));
                    continue;
                }
                let (len, modified_ms) = stat(&target).unwrap_or_default();
                self.written.insert(
                    path.clone(),
                    Copy {
                        id: id.clone(),
                        len,
                        modified_ms,
                    },
                );
                changed = true;
            }
            placed.push((id, path));
        }
        if changed {
            self.save()?;
        }
        Ok((placed, failed))
    }

    /// Remove each copy below `root` that `keep` does not hold. A copy changed
    /// since it was written is never removed: it is returned, kept or not,
    /// as no longer its attachment.
    ///
    /// # Errors
    ///
    /// The record of copies cannot be saved.
    pub fn remove_except(
        &mut self,
        root: &Path,
        keep: &dyn Fn(&str, &Copy) -> bool,
    ) -> Result<Vec<String>, AppError> {
        let mut left = Vec::new();
        let mut changed = false;
        let paths: Vec<String> = self.written.keys().cloned().collect();
        for path in paths {
            let Some(copy) = self.written.get(&path) else {
                continue;
            };
            let target = root.join(&path);
            let now = stat(&target);
            if now.is_some_and(|now| now != (copy.len, copy.modified_ms)) {
                left.push(path);
                continue;
            }
            if keep(&path, copy) {
                continue;
            }
            if now.is_some() {
                super::remove_with_empty_folders(root, &target)?;
            }
            self.written.remove(&path);
            changed = true;
        }
        if changed {
            self.save()?;
        }
        Ok(left)
    }

    /// The attachments the copies are of.
    pub fn ids(&self) -> Vec<String> {
        let ids: HashSet<&String> = self.written.values().map(|copy| &copy.id).collect();
        ids.into_iter().cloned().collect()
    }
}

/// Copy the file at `from` to `path` below `root`, all or nothing: into a
/// temporary file beside it, synced, then renamed over it. Never a hard
/// link: an edit to the copy would change the stored bytes.
fn copy_file(root: &Path, path: &str, from: &Path) -> std::io::Result<()> {
    super::create_folders_below(root, path)?;
    let target = root.join(path);
    let name = target
        .file_name()
        .ok_or_else(|| std::io::Error::other(format!("{path} names no file")))?;
    let temp = target.with_file_name(format!(".{}.agaric-tmp", name.to_string_lossy()));
    let copied = std::fs::copy(from, &temp)
        .and_then(|_| std::fs::File::options().append(true).open(&temp))
        .and_then(|mut file| {
            file.flush()?;
            file.sync_all()
        })
        .and_then(|()| std::fs::rename(&temp, &target));
    if copied.is_err() {
        // The temporary file is ours; what failed is reported, not this.
        let _ = std::fs::remove_file(&temp);
    }
    copied
}

#[cfg(test)]
#[path = "assets_tests.rs"]
mod tests;
