//! How a markdown surface reads a block's `key:: value` lines against the
//! property definitions (#5160): a key names the reserved key or definition it
//! folds to (D13), and a value a definition refuses is kept as text by an
//! import and a paste, and refuses an Edit as Markdown save (D11).

use agaric_engine::block_ops::{PropertyDeclaration, TypedPropertyArgs};

use super::*;

/// The property definitions, and the values written under a `ref`-declared
/// key, of one import, paste, duplicate or source save, read once before
/// anything is written.
pub(super) struct PropertyLines {
    mode: PropertyWrite,
    declarations: HashMap<String, PropertyDeclaration>,
    /// Each folded key's definitions.
    spellings: HashMap<String, Vec<String>>,
    /// Each ref value's block id, or why it names none.
    refs: HashMap<String, Result<String, String>>,
    /// The key each canonical `key:: value` line of a source buffer was typed
    /// with, when it was typed otherwise, to name the line by.
    typed: HashMap<(String, String), String>,
}

impl PropertyLines {
    /// Read the definitions. A surface that writes typed values resolves its
    /// ref values next ([`Self::resolve_refs`]); a copy writes back the ids a
    /// block held.
    pub(super) async fn load(
        conn: &mut sqlx::SqliteConnection,
        mode: PropertyWrite,
    ) -> Result<Self, AppError> {
        let rows =
            sqlx::query!(r#"SELECT key AS "key!", value_type, options FROM property_definitions"#)
                .fetch_all(&mut *conn)
                .await?;
        let mut spellings: HashMap<String, Vec<String>> = HashMap::new();
        for row in &rows {
            spellings
                .entry(import::fold_property_key(&row.key))
                .or_default()
                .push(row.key.clone());
        }
        let declarations = rows
            .into_iter()
            .map(|row| {
                let declaration = PropertyDeclaration {
                    value_type: row.value_type,
                    options: row.options,
                };
                (row.key, declaration)
            })
            .collect();
        Ok(Self {
            mode,
            declarations,
            spellings,
            refs: HashMap::new(),
            typed: HashMap::new(),
        })
    }

    /// Resolve in `space_id` the values `blocks` write under a `ref`-declared
    /// key.
    pub(super) async fn resolve_refs(
        &mut self,
        conn: &mut sqlx::SqliteConnection,
        space_id: Option<&str>,
        blocks: &[import::ParsedBlock],
    ) -> Result<(), AppError> {
        let names: Vec<&str> = blocks
            .iter()
            .flat_map(|block| &block.properties)
            .filter(|(key, _)| self.is_ref(&self.canonical_key(key)))
            .map(|(_, value)| ref_name(value))
            .collect();
        self.refs = resolve_ref_values(conn, space_id, names).await?;
        Ok(())
    }

    /// The key `typed` names (D13): the one definition it folds to, the
    /// reserved keys' included (migration 0014 declares them). Two that fold
    /// alike are never guessed between, and a key none folds to is a custom
    /// key: both stay as typed.
    pub(super) fn canonical_key(&self, typed: &str) -> String {
        match self
            .spellings
            .get(&import::fold_property_key(typed))
            .map(Vec::as_slice)
        {
            Some([single]) => single.clone(),
            _ => typed.to_string(),
        }
    }

    /// Give each of `blocks`' properties its [`Self::canonical_key`], except a
    /// key the block with its anchor in `held` holds as written: keys were
    /// stored as typed before D13, so that line is that property. A `key::`
    /// line with no value clears a key the block holds (P7); for any other key
    /// it clears nothing, so it is what the user typed and stays as text in
    /// the block.
    pub(super) fn canonicalize(
        &mut self,
        blocks: &mut [import::ParsedBlock],
        held: &[import::ParsedBlock],
    ) {
        let held: HashSet<(&str, &str)> = held
            .iter()
            .filter_map(|block| Some((block.block_anchor.as_deref()?, &block.properties)))
            .flat_map(|(anchor, properties)| {
                properties
                    .iter()
                    .map(move |(key, _)| (anchor, key.as_str()))
            })
            .collect();
        for block in blocks {
            let anchor = block.block_anchor.as_deref().unwrap_or_default();
            for (typed, value) in std::mem::take(&mut block.properties) {
                if held.contains(&(anchor, typed.as_str())) {
                    block.properties.push((typed, value));
                    continue;
                }
                let key = self.canonical_key(&typed);
                if value.is_empty() && !held.contains(&(anchor, key.as_str())) {
                    push_text_line(&mut block.content, &format!("{typed}::"));
                    continue;
                }
                if key != typed {
                    self.typed.insert((key.clone(), value.clone()), typed);
                }
                block.properties.push((key, value));
            }
        }
    }

    /// The `key:: value` line a source buffer wrote for canonical `key`, as
    /// the user typed it.
    pub(super) fn typed_line(&self, key: &str, value: &str) -> String {
        let pair = (key.to_owned(), value.to_owned());
        let typed = self.typed.get(&pair).map_or(key, String::as_str);
        format!("{typed}:: {value}")
    }

    /// The declaration `key` is written under. A copy writes back values a
    /// block held, so options the key has since narrowed are not checked.
    pub(super) fn declaration(&self, key: &str) -> Option<PropertyDeclaration> {
        let mut declaration = self.declarations.get(key).cloned()?;
        if self.mode == PropertyWrite::Copy {
            declaration.options = None;
        }
        Some(declaration)
    }

    fn is_ref(&self, key: &str) -> bool {
        self.declarations
            .get(key)
            .is_some_and(|declaration| declaration.value_type == "ref")
    }

    /// The typed arguments `value` is written with under `key`, a canonical
    /// key, or why its definition refuses it. A copy's ref value is the id it
    /// held; any other ref value is a block id or a page title in the space.
    pub(super) fn read(&self, key: &str, value: &str) -> Result<TypedPropertyArgs, String> {
        let declaration = self.declaration(key);
        let value_type = declaration.as_ref().map(|d| d.value_type.as_str());
        if self.mode == PropertyWrite::Copy {
            return Ok(match value_type {
                Some("ref") => (None, None, None, Some(value.to_string()), None),
                _ => agaric_engine::block_ops::typed_property_args_for_registry_value(
                    key,
                    value.to_string(),
                    value_type,
                ),
            });
        }
        if value.trim().is_empty() {
            return Err("it has no value".to_string());
        }
        if key == "repeat" {
            agaric_engine::recurrence::validate_repeat_rule(value).map_err(refusal)?;
        }
        let value = match (self.mode, key) {
            (PropertyWrite::Import, "priority") => import_priority_value(
                value,
                declaration.as_ref().and_then(|d| d.options.as_deref()),
            ),
            _ => value.to_string(),
        };
        let args = if value_type == Some("ref") {
            let id = self
                .refs
                .get(ref_name(&value))
                .cloned()
                .unwrap_or_else(|| Err(format!("'{value}' names no block")))?;
            (None, None, None, Some(id), None)
        } else {
            agaric_engine::block_ops::typed_property_args_for_registry_value(key, value, value_type)
        };
        agaric_engine::block_ops::check_property_value(key, &args, declaration.as_ref())
            .map_err(refusal)?;
        Ok(args)
    }

    /// Give each of `blocks`' properties its canonical key, and keep each line
    /// whose value [`Self::read`] refuses as text, with one warning naming it
    /// (D11): a `key:: value` line as it was written, at the end of its block,
    /// and a checkbox, task keyword or priority cookie back before the text
    /// it was read off. A refused ref value names no one page, so its `[[` is
    /// escaped: the name pass neither creates that page nor warns again.
    pub(super) fn keep_refused_as_text(
        &self,
        blocks: &mut [import::ParsedBlock],
        warnings: &mut Vec<String>,
    ) {
        for block in blocks {
            let mut markers = std::mem::take(&mut block.task_markers);
            let mut restored: Vec<String> = Vec::new();
            for (typed, value) in std::mem::take(&mut block.properties) {
                let marker = markers
                    .iter()
                    .position(|(key, _)| *key == typed)
                    .map(|at| markers.remove(at).1);
                let key = self.canonical_key(&typed);
                let Err(reason) = self.read(&key, &value) else {
                    block.properties.push((key, value));
                    continue;
                };
                if let Some(marker) = marker {
                    warnings.push(format!("`{marker}` was kept as text: {reason}"));
                    restored.push(marker);
                    continue;
                }
                let line = format!("{typed}:: {value}");
                warnings.push(format!("`{line}` was kept as text: {reason}"));
                let text = if self.is_ref(&key) {
                    escape_page_links(&line)
                } else {
                    line
                };
                push_text_line(&mut block.content, &text);
            }
            if !restored.is_empty() {
                if !block.content.is_empty() {
                    restored.push(std::mem::take(&mut block.content));
                }
                block.content = restored.join(" ");
            }
        }
    }
}

/// Append `line` to `content` as a line of its own.
fn push_text_line(content: &mut String, line: &str) {
    if !content.is_empty() {
        content.push('\n');
    }
    content.push_str(line);
}

/// `text` with each `[[` that opens a page link escaped (#5160 N3).
fn escape_page_links(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() + 2);
    let mut copied = 0;
    for (at, _) in text.match_indices("[[") {
        if !is_escaped(text, at) {
            escaped.push_str(&text[copied..at]);
            escaped.push('\\');
            copied = at;
        }
    }
    escaped.push_str(&text[copied..]);
    escaped
}

/// A validation error as the reason a line is refused.
fn refusal(err: AppError) -> String {
    match err {
        AppError::Validation { message, .. } => message,
        other => other.to_string(),
    }
}

/// The name a ref value is written as: `[[Title]]` less its brackets, or the
/// value.
fn ref_name(value: &str) -> &str {
    let value = value.trim();
    value
        .strip_prefix("[[")
        .and_then(|name| name.strip_suffix("]]"))
        .map_or(value, str::trim)
}

/// What each of `names` refers to (#5160 D11): a block id is the live block,
/// unless it is in a space other than `space_id`; anything else is the title
/// of a page in `space_id` by the link rule (exact, then case-insensitive,
/// then alias, never a tie).
async fn resolve_ref_values(
    conn: &mut sqlx::SqliteConnection,
    space_id: Option<&str>,
    names: Vec<&str>,
) -> Result<HashMap<String, Result<String, String>>, AppError> {
    let (ids, titles): (Vec<&str>, Vec<&str>) = names
        .into_iter()
        .partition(|name| BlockId::from_string(*name).is_ok_and(|id| id.as_str() == *name));
    let mut resolved = HashMap::new();
    if !ids.is_empty() {
        let ids_json = serde_json::to_string(&ids)?;
        let rows = sqlx::query!(
            r#"SELECT b.id AS "id!", COALESCE(b.space_id, p.space_id) AS "space_id?: String"
               FROM blocks b
               LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
               WHERE b.id IN (SELECT value FROM json_each(?1))
                 AND b.deleted_at IS NULL"#,
            ids_json,
        )
        .fetch_all(&mut *conn)
        .await?;
        let live: HashMap<String, Option<String>> =
            rows.into_iter().map(|row| (row.id, row.space_id)).collect();
        for id in ids {
            let outcome = match live.get(id) {
                None => Err(format!("'{id}' is not the id of a live block")),
                Some(Some(target)) if space_id.is_some_and(|space| space != target) => {
                    Err(format!("'{id}' is a block of another space"))
                }
                Some(_) => Ok(id.to_string()),
            };
            resolved.insert(id.to_string(), outcome);
        }
    }
    let titles: Vec<String> = titles.into_iter().map(str::to_string).collect();
    let matches = match space_id {
        Some(space) if !titles.is_empty() => {
            snapshot_page_link_matches(conn, space, &titles).await?
        }
        _ => LinkMatches::default(),
    };
    for title in titles {
        let outcome = match matches.find(&title) {
            Some(LinkMatch::Unique(id)) => Ok(id),
            Some(LinkMatch::Ambiguous) => Err(format!("more than one page is titled '{title}'")),
            None => Err(format!("no page is titled '{title}' in this space")),
        };
        resolved.insert(title, outcome);
    }
    Ok(resolved)
}

/// A text value `set_property` writes under `key` on `block_id`, as
/// `(value_text, value_ref)`: under a `ref` definition, the block a live block
/// id, `[[Title]]` or a title of a page in the block's space names, as a typed
/// `key:: value` line reads it (#5160 D11); under any other key, the text.
///
/// # Errors
///
/// [`AppError::Validation`] naming why a ref value names no block.
pub(crate) async fn read_typed_ref(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    key: &str,
    text: String,
) -> Result<(Option<String>, Option<String>), AppError> {
    let declared = sqlx::query!(
        "SELECT value_type, options FROM property_definitions WHERE key = ?",
        key,
    )
    .fetch_optional(&mut *conn)
    .await?;
    if declared.is_none_or(|row| row.value_type != "ref") {
        return Ok((Some(text), None));
    }
    let block = BlockId::from_trusted(block_id);
    let space = agaric_store::space::resolve_block_space(&mut *conn, &block).await?;
    let name = ref_name(&text);
    let id = resolve_ref_values(conn, space.as_ref().map(SpaceId::as_str), vec![name])
        .await?
        .remove(name)
        .unwrap_or_else(|| Err(format!("'{text}' names no block")))
        .map_err(AppError::validation)?;
    Ok((None, Some(id)))
}
