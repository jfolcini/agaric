//! A merged file in the form a buffer save reads (#6277 G5): the import's
//! per-file rewrites applied to its text before [`merge_into_page`] saves it,
//! and what only a file says ([`FILE_KEYS`](agaric_engine::import)) taken
//! out, for [`finish_merge`] to apply once the save is done.

use super::*;

/// A live attachment of the page a file merges into.
pub(super) struct HeldFile {
    id: String,
    filename: String,
    mime: String,
    hash: Option<String>,
}

/// The live attachments of `page_id` and its blocks.
pub(super) async fn held_files(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
) -> Result<Vec<HeldFile>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT a.id AS "id!", a.filename AS "filename!",
                  a.mime_type AS "mime!", a.content_hash
           FROM attachments a JOIN blocks b ON b.id = a.block_id
           WHERE (b.id = ?1 OR b.page_id = ?1) AND a.deleted_at IS NULL
             AND b.deleted_at IS NULL"#,
        page_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| HeldFile {
            id: row.id,
            filename: row.filename,
            mime: row.mime,
            hash: row.content_hash,
        })
        .collect())
}

/// What a file brings that a merge reads: the vault's files, the folder the
/// note sits in and, for a folder's note, its notes by name.
pub(super) struct MergeVault<'a> {
    pub(super) files: &'a [VaultFile],
    pub(super) dir: &'a str,
    pub(super) notes: Option<HashMap<String, String>>,
}

impl MergeVault<'_> {
    /// The page's attachment holding the bytes of the file `reference` names,
    /// under the file's own name: the file is the attachment it was exported
    /// from, or one imported from it before.
    fn held<'h>(&self, held: &'h [HeldFile], reference: &str) -> Option<&'h HeldFile> {
        let (index, _) = import::match_vault_file(reference, self.dir, self.files)?;
        let file = &self.files[index];
        let name = file.path.rsplit(['/', '\\']).next().unwrap_or(&file.path);
        let hash = blake3::hash(&file.bytes).to_hex().to_string();
        held.iter()
            .find(|held| held.filename == name && held.hash.as_deref() == Some(hash.as_str()))
    }
}

/// A file read for a merge: its text as a buffer save reads it, and what the
/// save cannot read, which [`finish_merge`] applies.
pub(super) struct MergeSource {
    pub(super) text: String,
    /// The value of the file's `template:` front matter, `None` when it has
    /// none, which leaves the page's flag as it is.
    pub(super) template: Option<String>,
    /// The values of the file's `attachments:` front matter.
    pub(super) page_files: Vec<String>,
    /// Each `attachments::` line naming a file the page does not hold, by the
    /// block whose `^id` anchor it follows: taken out of the text, which the
    /// anchor must end.
    pub(super) block_files: Vec<(String, String)>,
    /// The `^name` blocks the save creates, which its links refer to.
    pub(super) named: Vec<NewNamedBlock>,
}

/// `text`, a file's lines less its title, as a buffer save reads what an
/// import reads: its `template:` and `attachments:` front matter taken out, a
/// file it names that the page holds written as that attachment, an
/// `attachments::` line every file of which the page holds dropped, and for a
/// folder's note its links to other notes written as those notes' titles.
/// Code is left as it is. An `attachments::` line goes to the block whose
/// `^id` it follows only when that block is one of the page's (`own`).
pub(super) fn merge_source(
    text: &str,
    vault: &MergeVault<'_>,
    held: &[HeldFile],
    own: &HashSet<&str>,
) -> MergeSource {
    let mut source = MergeSource {
        text: String::with_capacity(text.len()),
        template: None,
        page_files: Vec::new(),
        block_files: Vec::new(),
        named: Vec::new(),
    };
    let body = match import::front_matter_fence(text) {
        Some((yaml, len)) => {
            let kept = file_front_matter(yaml, &mut source);
            if !kept.is_empty() {
                source.text.push_str(&format!("---\n{kept}---\n"));
            }
            &text[len..]
        }
        None => text,
    };
    let mut fence = None;
    let mut anchor: Option<String> = None;
    for line in body.split_inclusive('\n') {
        if let Some(open) = fence {
            if import::closes_fence(line, open) {
                fence = None;
            }
            source.text.push_str(line);
            continue;
        }
        fence = import::document_fence_opener(line);
        if fence.is_some() {
            source.text.push_str(line);
            continue;
        }
        match merged_line(line, vault, held) {
            Merged::Line(line) => {
                let named = line_anchor(&line).filter(|id| own.contains(id.as_str()));
                anchor = named.or(anchor.filter(|_| block_tail(&line)));
                source.text.push_str(&line);
            }
            Merged::Held => {}
            Merged::Files(value) => match &anchor {
                Some(id) => source.block_files.push((id.clone(), value)),
                None => source.text.push_str(line),
            },
        }
    }
    source
}

/// Whether `line` can follow a block's `^id` line inside that block: blank, or
/// one of the `key:: value` lines an export writes between the anchor and the
/// block's `attachments::` line.
fn block_tail(line: &str) -> bool {
    line.trim().is_empty() || import::split_property_line(line.trim()).is_some()
}

/// The block id a line's `^ULID` anchor ends it with.
fn line_anchor(line: &str) -> Option<String> {
    let (_, id) = line.trim_end().rsplit_once(" ^")?;
    BlockId::from_string(id)
        .ok()
        .map(|id| id.as_str().to_owned())
}

/// What becomes of one line outside code in a merge ([`merged_line`]).
enum Merged {
    /// The line, as the save reads it.
    Line(String),
    /// An `attachments::` line the page holds every file of: dropped.
    Held,
    /// An `attachments::` line naming a file the page does not hold: its value.
    Files(String),
}

/// The lines of front matter `yaml` a buffer save reads, each ending in a line
/// break; the `template:` and `attachments:` values go to `source`.
fn file_front_matter(yaml: &str, source: &mut MergeSource) -> String {
    let mut kept = String::new();
    for line in yaml.lines().filter(|line| !line.trim().is_empty()) {
        let key = line.split_once(':').map(|(key, _)| key.trim());
        let value = line.split_once(':').map_or("", |(_, value)| value.trim());
        match key.map(import::fold_property_key).as_deref() {
            Some("template") => source.template = Some(value.trim_matches('"').to_string()),
            Some("attachments") => source.page_files.push(value.to_string()),
            _ => {
                kept.push_str(line);
                kept.push('\n');
            }
        }
    }
    kept
}

/// One line outside code as the save reads it ([`merge_source`]).
fn merged_line(line: &str, vault: &MergeVault<'_>, held: &[HeldFile]) -> Merged {
    let trimmed = line.trim_start();
    if let Some(value) = trimmed.strip_prefix("attachments::") {
        let links: Vec<_> = import::markdown_link_tokens(value).collect();
        let all_held = !links.is_empty()
            && links.iter().all(|link| {
                let destination = percent_decode(link.destination.trim());
                match destination.strip_prefix("attachment:") {
                    Some(id) => held.iter().any(|file| file.id == id),
                    None => vault.held(held, &destination).is_some(),
                }
            });
        return if all_held {
            Merged::Held
        } else {
            Merged::Files(value.trim().to_string())
        };
    }
    let mut line = line.to_string();
    if let Some(notes) = &vault.notes {
        line = rewrite_relative_md_links(&line, vault.dir);
        line = rewrite_vault_wikilinks(&line, notes);
    }
    for att in import::detect_attachment_refs(&line, &import::inline_code_spans(&line)) {
        if let Some(file) = vault.held(held, &att.original_ref) {
            let token = attachment_token(&att, &file.id, &file.filename, &file.mime);
            line = line.replacen(&att.full_match, &token, 1);
        }
    }
    Merged::Line(line)
}

/// Apply what a merged file says that its save did not read ([`MergeSource`]),
/// once the save is done: the page's template flag as the file sets it, and
/// the files it names that the page does not hold yet, attached as an import
/// attaches them, onto the page for its `attachments:` front matter and onto
/// the block a link or an `attachments::` line is in; and the links to a
/// `^name` block the save created made refs to it. Returns the ops the flag
/// and those links appended, which undo with the merge.
pub(super) async fn finish_merge(
    ctx: &mut ImportCtx<'_>,
    source: &MergeSource,
    vault_files: Vec<VaultFile>,
) -> Result<Vec<agaric_store::op::OpRef>, AppError> {
    let mut op_refs = sync_template(ctx, source.template.as_deref()).await?;
    op_refs.extend(link_new_named_blocks(ctx, &source.named).await?);
    if vault_files.is_empty() {
        return Ok(op_refs);
    }
    let mut pending = PendingAttachments::default();
    let held = held_files(&mut *ctx.pool.acquire().await?, &ctx.page_id).await?;
    let dir = ctx
        .page_title
        .rsplit_once('/')
        .map_or("", |(dir, _)| dir)
        .to_owned();
    let vault = MergeVault {
        files: &vault_files,
        dir: &dir,
        notes: None,
    };
    let new_files = |value: &str| -> Vec<import::AttachmentRef> {
        import::detect_attachment_refs(value, &[])
            .into_iter()
            .filter(|att| vault.held(&held, &att.original_ref).is_none())
            .collect()
    };
    let page = (ctx.page_id.clone(), source.page_files.join(", "));
    for (owner, value) in std::iter::once(&page).chain(&source.block_files) {
        let new = new_files(value);
        if !new.is_empty() {
            pending.scoped.push((owner.clone(), new));
        }
    }
    queue_block_files(ctx, &vault_files, &mut pending, new_files).await?;
    ingest_attachments(ctx, vault_files, pending).await;
    Ok(op_refs)
}

/// Set the page's `template` flag to the file's `template:` value, or clear
/// it on `false`, when that differs from what the page holds. A file without
/// the key leaves the flag alone: it is a plain file, not a page's export.
async fn sync_template(
    ctx: &ImportCtx<'_>,
    file: Option<&str>,
) -> Result<Vec<agaric_store::op::OpRef>, AppError> {
    let Some(file) = file else {
        return Ok(Vec::new());
    };
    let wanted = (file != "false").then_some(file);
    let page = ctx.page_id.as_str();
    let held: Option<String> = sqlx::query_scalar!(
        "SELECT value_text FROM block_properties WHERE block_id = ? AND key = 'template'",
        page,
    )
    .fetch_optional(ctx.pool)
    .await?
    .flatten();
    if held.as_deref() == wanted {
        return Ok(Vec::new());
    }
    let block = crate::ulid::verify_active(ctx.pool, &BlockId::from_trusted(page)).await?;
    let (pool, device, mat) = (ctx.pool, ctx.device_id, ctx.materializer);
    let Some(value) = wanted else {
        let delete = crate::commands::properties::delete_property_inner(
            pool,
            device,
            mat,
            block,
            "template".into(),
        );
        return Ok(capture_op_refs(delete).await?.op_refs);
    };
    let set = crate::commands::properties::set_property_inner(
        pool,
        device,
        mat,
        block,
        "template".into(),
        Some(value.to_string()),
        None,
        None,
        None,
        None,
        None,
    );
    Ok(capture_op_refs(set).await?.op_refs)
}

/// Queue the files each block's `attachments::` line names that the page does
/// not hold (`new_files`), the line the save kept as text, and the links in
/// its text to such files, as an import queues them. The line is taken out of
/// the block's text. Only a new block, which has no `^id`, keeps such a line,
/// so undoing the merge removes the block and needs no undo of this edit.
async fn queue_block_files(
    ctx: &mut ImportCtx<'_>,
    vault_files: &[VaultFile],
    pending: &mut PendingAttachments,
    new_files: impl Fn(&str) -> Vec<import::AttachmentRef>,
) -> Result<(), AppError> {
    let page = ctx.page_id.clone();
    let blocks = sqlx::query!(
        r#"SELECT id AS "id!", content FROM blocks WHERE page_id = ?1 AND id != ?1
           AND deleted_at IS NULL AND block_type = 'content'"#,
        page,
    )
    .fetch_all(ctx.pool)
    .await?;
    for block in blocks {
        let (id, content) = (block.id, block.content.unwrap_or_default());
        if content.trim_start().starts_with("```") || content.trim_start().starts_with("~~~") {
            continue;
        }
        let (lines, kept): (Vec<&str>, Vec<&str>) = content
            .split('\n')
            .partition(|line| line.trim_start().starts_with("attachments::"));
        for line in &lines {
            let value = line.trim_start().trim_start_matches("attachments::");
            let new = new_files(value);
            let new: Vec<&str> = new.iter().map(|att| att.full_match.as_str()).collect();
            pending.queue_block(
                &id,
                Vec::new(),
                &[("attachments".into(), new.join(", "))],
                vault_files,
                &mut ctx.warnings,
            );
        }
        let text = kept.join("\n");
        if !lines.is_empty() {
            crate::commands::blocks::crud::edit_block_inner(
                ctx.pool,
                ctx.device_id,
                ctx.materializer,
                BlockId::from_trusted(&id),
                text.clone(),
            )
            .await?;
        }
        let linked = detect_import_attachment_refs(&text, false, vault_files);
        if !linked.is_empty() {
            pending.linked.push((id, linked));
        }
    }
    Ok(())
}
