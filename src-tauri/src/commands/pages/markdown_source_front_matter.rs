//! The page's own properties in its source buffer (#5160 S8): the YAML front
//! matter the buffer opens with, the export's form, or Logseq's `key:: value`
//! lines above its first bullet. A save writes what they changed from the
//! source the edit started from, as the property drawer, the alias list and
//! the tag picker write them.

use super::*;
use crate::commands::tags::remove_tag_in_tx;

/// A page's properties, aliases and tags as its front matter writes them,
/// each property under the key it is written as.
#[derive(Clone, Default)]
pub(super) struct FrontMatter {
    properties: Vec<(String, String)>,
    aliases: Vec<String>,
    tags: Vec<String>,
}

impl FrontMatter {
    /// What a source buffer's parse opens with.
    pub(super) fn of(parsed: &import::ParseOutput) -> Self {
        let mut front = Self::default();
        for (key, value) in &parsed.frontmatter {
            let items = || -> Vec<String> {
                let items = frontmatter_items(parsed, key, value);
                items.into_iter().map(str::to_owned).collect()
            };
            match key.as_str() {
                "aliases" => front.aliases = items(),
                "tags" => front.tags = items(),
                _ => front.properties.push((key.clone(), value.clone())),
            }
        }
        front
    }
}

/// The front matter a buffer was edited from, and the one it writes: each of
/// the latter's keys names the reserved key or definition it folds to (#5160
/// D13), unless the former holds it as written, as a block's `key::` line is
/// read.
pub(super) struct FrontMatterEdit {
    from: FrontMatter,
    to: FrontMatter,
    /// Each of `to`'s keys as it was typed, and its line.
    typed: HashMap<String, (String, Option<usize>)>,
}

impl FrontMatterEdit {
    /// `parsed`'s front matter as edited from `from`.
    ///
    /// # Errors
    ///
    /// [`AppError::Validation`] naming the first front matter line no page
    /// property is read from, or the second of two keys that name one
    /// property.
    pub(super) fn read(
        parsed: &import::ParseOutput,
        from: FrontMatter,
        lines: &PropertyLines,
    ) -> Result<Self, AppError> {
        if let Some((line, why)) = &parsed.frontmatter_refusal {
            return Err(at_line(Some(*line), AppError::validation(why.clone())));
        }
        let mut to = FrontMatter::of(parsed);
        let mut typed = HashMap::new();
        for (key, _) in &mut to.properties {
            let line = parsed.frontmatter_lines.get(key.as_str()).copied();
            let as_typed = key.clone();
            if !from.properties.iter().any(|(held, _)| held == key) {
                *key = lines.canonical_key(key);
            }
            if typed.insert(key.clone(), (as_typed, line)).is_some() {
                let why = format!("`{key}` is written twice");
                return Err(at_line(line, AppError::validation(why)));
            }
        }
        Ok(Self { from, to, typed })
    }

    /// The property values the buffer writes, whose ref values the save
    /// resolves.
    pub(super) fn values(&self) -> &[(String, String)] {
        &self.to.properties
    }

    /// The property writes: each value the buffer changed that the page does
    /// not hold already, and each key the buffer left out that the page still
    /// holds. A key with no value is left out.
    ///
    /// # Errors
    ///
    /// [`AppError::Validation`] naming the line of a value its definition
    /// refuses, as the property drawer refuses it.
    fn property_changes(
        &self,
        now: &FrontMatter,
        lines: &PropertyLines,
    ) -> Result<PropertyChanges, AppError> {
        let (from, to, now) = (valued(&self.from), valued(&self.to), valued(now));
        let mut changes = PropertyChanges::default();
        for (&key, &value) in &to {
            if from.get(key) == Some(&value) || now.get(key) == Some(&value) {
                continue;
            }
            if let Err(reason) = lines.read(key, value) {
                let (typed, line) = &self.typed[key];
                let why = format!("`{typed}: {value}` cannot be saved: {reason}");
                return Err(at_line(*line, AppError::validation(why)));
            }
            changes.set.push((key.to_owned(), value.to_owned()));
        }
        changes.deleted = from
            .keys()
            .filter(|key| !to.contains_key(*key) && now.contains_key(*key))
            .map(|key| (*key).to_owned())
            .collect();
        Ok(changes)
    }
}

/// `front`'s properties that hold a value, by key.
fn valued(front: &FrontMatter) -> BTreeMap<&str, &str> {
    front
        .properties
        .iter()
        .filter(|(_, value)| !value.is_empty())
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect()
}

/// Write what the buffer's front matter changed from the source the edit
/// started from over the page, which holds `now`: a key or item the buffer
/// left as it was writes nothing, so a merge keeps what the page changed
/// since. The properties are written as a block's `key::` lines are, the
/// aliases replace the page's when they differ, and the tags are added and
/// removed. Returns the tags created.
///
/// # Errors
///
/// [`AppError::Validation`] naming the line of a value its definition refuses.
pub(super) async fn write_front_matter(
    mut tx: CommandTx,
    save: &mut Save<'_>,
    data: &PageExportData,
    now: &FrontMatter,
    edit: FrontMatterEdit,
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, Vec<BlockRow>), AppError> {
    let page = data.page.id.as_str();
    let changes = edit.property_changes(now, save.lines)?;
    let prior = PriorTaskState::default();
    Box::pin(write_properties(&mut tx, save, page, changes, &prior)).await?;
    let aliases = edited_list(&edit.from.aliases, &edit.to.aliases, &now.aliases);
    if aliases.iter().collect::<BTreeSet<_>>() != now.aliases.iter().collect::<BTreeSet<_>>() {
        sqlx::query!("DELETE FROM page_aliases WHERE page_id = ?1", page)
            .execute(&mut **tx)
            .await?;
        let aliases = aliases.iter().map(String::as_str).collect();
        apply_frontmatter_aliases(&mut tx, page, aliases, warnings).await?;
    }
    let (tx, created) = Box::pin(write_tags(tx, save, data, now, &edit, warnings)).await?;
    crate::commands::ensure_batch_within_cap("ops", tx.pending_len())?;
    Ok((tx, created))
}

/// `now` less what `to` removed from `from`, then what it added.
fn edited_list(from: &[String], to: &[String], now: &[String]) -> Vec<String> {
    let added = to
        .iter()
        .filter(|item| !from.contains(item) && !now.contains(item));
    now.iter()
        .filter(|item| to.contains(item) || !from.contains(item))
        .chain(added)
        .cloned()
        .collect()
}

/// Remove the page's tags the buffer removed, and add those it added, each
/// name resolved in the page's space as a typed `#tag` is and created where no
/// tag has it. A tag counts as its normalised name. Returns the tags created.
async fn write_tags(
    mut tx: CommandTx,
    save: &Save<'_>,
    data: &PageExportData,
    now: &FrontMatter,
    edit: &FrontMatterEdit,
    warnings: &mut Vec<String>,
) -> Result<(CommandTx, Vec<BlockRow>), AppError> {
    let page = data.page.id.as_str();
    let (from, to) = (&edit.from.tags, &edit.to.tags);
    let removed = from
        .iter()
        .filter(|name| !holds(to, name) && holds(&now.tags, name));
    let loro = save.materializer.loro_state();
    for tag in data.name_snapshot.tags(removed.cloned().collect()).values() {
        let removed = remove_tag_in_tx(&mut tx, loro, save.device_id, page, tag).await?;
        if let Some(op) = removed {
            tx.enqueue_background(op);
        }
    }
    let added: BTreeSet<String> = to
        .iter()
        .filter(|name| !holds(from, name) && !holds(&now.tags, name))
        .cloned()
        .collect();
    let names = Names {
        tags: added.clone(),
        ..Names::default()
    };
    let (mut tx, resolved) = Box::pin(resolve_new_names(
        tx,
        save.materializer,
        save.device_id,
        &data.page,
        names,
        warnings,
    ))
    .await?;
    for name in &added {
        let Some(tag) = resolved.tags.get(name) else {
            warnings.push(format!(
                "tag '{name}' names no tag of the page's space; not applied"
            ));
            continue;
        };
        associate_page_tag(
            &mut tx,
            save.materializer,
            save.device_id,
            page,
            tag,
            name,
            warnings,
        )
        .await;
    }
    Ok((tx, resolved.created))
}

/// Whether `list` holds the tag `name` names: its normalised name.
fn holds(list: &[String], name: &str) -> bool {
    let name = agaric_core::tag_norm::normalize_tag_name(name);
    list.iter()
        .any(|held| agaric_core::tag_norm::normalize_tag_name(held) == name)
}
