//! Ingesting an import's attachments: [`check_attachment_budget`],
//! [`ingest_read_counts`], [`ingest_attachments`] and
//! [`rewrite_block_attachment_refs`].

use super::*;

/// #2724 — aggregate attachment-budget check for one import.
///
/// Factored out of [`import_markdown_with_progress`] so the caps can be
/// unit-tested against fabricated `(file_count, total_bytes)` pairs WITHOUT
/// allocating gigabytes of `VaultFile` bytes. Returns a clear
/// [`AppError::validation`] when the file COUNT or the aggregate BYTE total
/// exceeds its cap, and `Ok(())` when within budget. `total_bytes` is
/// pre-summed by the caller (as `u64`, to avoid any `usize as i64` wrap on a
/// pathological length). The count check runs first so a huge-count / tiny-byte
/// payload is rejected on the cheaper predicate.
pub(super) fn check_attachment_budget(file_count: usize, total_bytes: u64) -> Result<(), AppError> {
    if file_count > crate::commands::MAX_ATTACHMENT_FILE_COUNT {
        return Err(AppError::validation(format!(
            "import references {file_count} attachment files, exceeding the maximum of {} \
             per import",
            crate::commands::MAX_ATTACHMENT_FILE_COUNT
        )));
    }
    let cap = crate::commands::MAX_TOTAL_ATTACHMENT_BYTES as u64;
    if total_bytes > cap {
        return Err(AppError::validation(format!(
            "import attachments total {total_bytes} bytes across {file_count} files, exceeding \
             the maximum aggregate of {cap} bytes"
        )));
    }
    Ok(())
}

/// #2724 — count how many attachment INGEST ATTEMPTS will read each vault file,
/// keyed by its index in `vault_files`. The result drives the move-vs-clone
/// decision in the ingest loop: an index whose count is exactly `1` is read by a
/// single possible ingest attempt, so its bytes may be MOVED out
/// (`std::mem::take`) instead of cloned; any index with count `> 1` is always
/// cloned so a later attempt never reads a moved-away (emptied) buffer.
///
/// The count is the number of ref OCCURRENCES that resolve to the file, NOT the
/// number of *distinct* refs — a ref repeated within one block counts once PER
/// occurrence. This matters because the per-block `block_ingested` cache only
/// suppresses a re-ingest AFTER a *successful* first ingest; if the first
/// attempt fails transiently (e.g. `PoolTimedOut`) the second occurrence
/// re-enters the ingest path. Counting occurrences (not distinct refs) keeps
/// such a twice-in-one-block file at count `2`, so it is cloned and the retry
/// still sees full bytes — never a 0-byte buffer left behind by a `mem::take`.
///
/// `match_vault_file` keys on `path`/basename (never bytes), so this pre-pass is
/// stable even as the ingest loop later empties `bytes` via `mem::take`. It
/// resolves each ref from the same `note_dir` the ingest does, so both pick the
/// same file.
pub fn ingest_read_counts(
    pending_attachments: &[(String, Vec<import::AttachmentRef>)],
    note_dir: &str,
    vault_files: &[VaultFile],
) -> HashMap<usize, usize> {
    let mut counts: HashMap<usize, usize> = HashMap::new();
    for (_block_id, refs) in pending_attachments {
        for att in refs {
            if let Some((idx, _ambiguous)) =
                import::match_vault_file(&att.original_ref, note_dir, vault_files)
            {
                *counts.entry(idx).or_insert(0) += 1;
            }
        }
    }
    counts
}

/// The path-derived fields and byte length one vault file ingests with.
///
/// #2724 — read in a SHORT immutable borrow of the file so the `std::mem::take`
/// that follows is not blocked by a live `&vf` spanning the whole ingest.
fn vault_file_ingest_fields(vf: &VaultFile) -> (String, String, i64) {
    let filename = vf
        .path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(&vf.path)
        .to_string();
    let mime_type = import::guess_attachment_mime(&vf.path);
    // `i64::try_from` avoids the `usize as i64` wrap; a length
    // that doesn't fit i64 is by definition over the limit.
    let size_bytes = i64::try_from(vf.bytes.len()).unwrap_or(i64::MAX);
    (filename, mime_type, size_bytes)
}

/// #2724 — MOVE the bytes out for a single-ATTEMPT file so the buffer is freed
/// right after ingest instead of cloned (a transient per-file doubling).
/// `ingest_counts[idx] == 1` proves no other ingest attempt — including a retry
/// of a transiently failed first attempt within this block — will read this
/// file, so the move is safe. `remove` flips it out of the single-attempt set
/// and `moved_out` records the empty buffer. Any file with count > 1 always
/// clones, exactly as before.
///
/// `None` means the bytes were already moved out: under a correct count that is
/// unreachable, but refusing to ingest an emptied buffer guarantees it is NEVER
/// re-ingested as a 0-byte attachment.
fn take_or_clone_bytes(
    vault_files: &mut [VaultFile],
    idx: usize,
    ingest_counts: &mut HashMap<usize, usize>,
    moved_out: &mut std::collections::HashSet<usize>,
) -> Option<Vec<u8>> {
    if ingest_counts.get(&idx).copied() == Some(1) {
        ingest_counts.remove(&idx);
        moved_out.insert(idx);
        return Some(std::mem::take(&mut vault_files[idx].bytes.0));
    }
    if moved_out.contains(&idx) {
        return None;
    }
    Some(vault_files[idx].bytes.0.clone())
}

/// The vault-file index one attachment ref resolves to. A ref matching nothing
/// is left as-is, and one matching several files by basename uses the first —
/// both warn rather than failing the already-durable import, except a link
/// matching nothing, which may point anywhere.
fn match_ref_to_vault_file(
    att: &import::AttachmentRef,
    note_dir: &str,
    vault_files: &[VaultFile],
    warnings: &mut Vec<String>,
) -> Option<usize> {
    let Some((idx, ambiguous)) = import::match_vault_file(&att.original_ref, note_dir, vault_files)
    else {
        if att.is_link() {
            return None;
        }
        warnings.push(format!(
            "referenced attachment '{}' was not found among the imported \
             vault files; left as-is",
            att.original_ref
        ));
        return None;
    };
    if ambiguous {
        warnings.push(format!(
            "attachment ref '{}' matched multiple vault files by basename; \
             used the first match",
            att.original_ref
        ));
    }
    Some(idx)
}

/// The token a ref to the ingested attachment `id` is rewritten to: a link
/// stays the link `[label](attachment:<id>)`, an embedded image stays the
/// image `![alt](attachment:<id>)`, and any other embedded file becomes a
/// link, since a PDF written as an image renders broken. A link is labelled by
/// its label or alt, else the file's name; an Obsidian embed's alt is only its
/// image size, so it is labelled by the file's name.
pub(super) fn attachment_token(
    att: &import::AttachmentRef,
    id: &str,
    filename: &str,
    mime: &str,
) -> String {
    if !att.is_link() && mime.starts_with("image/") {
        return format!("![{}](attachment:{id})", att.alt);
    }
    let label = if att.alt.is_empty() || att.full_match.starts_with("![[") {
        filename
    } else {
        &att.alt
    };
    format!("[{}](attachment:{id})", attachment_link_label(label))
}

/// Ingest every attachment ref detected in ONE content block, returning the
/// `(ref, attachment token)` pairs its content rewrite needs.
///
/// ROW OWNERSHIP: a FRESH attachment row per owning block (matching the editor's
/// `add_attachment_with_bytes_inner`; identical bytes may still share a
/// content-addressed blob). The ONLY row-level dedup is within a single block:
/// the same `original_ref` appearing multiple times in ONE block ingests once
/// and both rewrites share that id — safe because the duplicates share the same
/// owning block and thus the same CASCADE lifetime. Cross-page/cross-block asset
/// dedup is intentionally DEFERRED: it needs attachment refcounting/GC the schema
/// lacks (`attachments.block_id` is `ON DELETE CASCADE` and not space-scoped, so
/// reusing one row across blocks would dangle peers when the owner block is
/// deleted, and cross-space peers would never receive the `AddAttachment` op).
///
/// Warnings (not-found, oversized, disallowed mime, ingest failure) leave the
/// original ref in place and never abort the already-durable import.
async fn ingest_block_attachments(
    ctx: &mut ImportCtx<'_>,
    note_dir: &str,
    vault_files: &mut [VaultFile],
    ingest_counts: &mut HashMap<usize, usize>,
    moved_out: &mut std::collections::HashSet<usize>,
    block_id: &str,
    refs: &[import::AttachmentRef],
) -> Vec<(import::AttachmentRef, String)> {
    // Per-BLOCK cache: original_ref → the ingested `(id, filename, mime)` for
    // refs already ingested for THIS block. NOT carried across blocks.
    let mut block_ingested: HashMap<String, (String, String, String)> = HashMap::new();
    let mut block_rewrites: Vec<(import::AttachmentRef, String)> = Vec::new();

    for att in refs {
        // Already ingested for this block (same original ref string).
        if let Some((id, filename, mime)) = block_ingested.get(&att.original_ref) {
            block_rewrites.push((att.clone(), attachment_token(att, id, filename, mime)));
            continue;
        }

        let Some(idx) = match_ref_to_vault_file(att, note_dir, vault_files, &mut ctx.warnings)
        else {
            continue;
        };
        let (filename, mime_type, size_bytes) = vault_file_ingest_fields(&vault_files[idx]);

        // Size guard (mirrors the attachment ingest's 50 MB limit). On
        // an oversized file: warn + skip (leave the original ref). This
        // `continue` fires BEFORE the move/clone below, so a size-skipped
        // file's bytes are never taken.
        if size_bytes > crate::commands::MAX_ATTACHMENT_SIZE {
            ctx.warnings.push(format!(
                "attachment '{}' ({size_bytes} bytes) exceeds the maximum size; skipped",
                att.original_ref,
            ));
            continue;
        }

        let Some(bytes) = take_or_clone_bytes(vault_files, idx, ingest_counts, moved_out) else {
            ctx.warnings.push(format!(
                "attachment '{}' could not be re-imported (source bytes already \
                 consumed by a prior ingest); left as-is",
                att.original_ref
            ));
            continue;
        };

        // Fresh ingest, owned by this content block. A failure
        // (disallowed mime, write error, transient DB error, etc.)
        // degrades to warn+skip so a single bad asset never fails the
        // (already durable) import.
        let attachment_id = match crate::commands::attachments::add_attachment_with_bytes_inner(
            ctx.pool,
            ctx.device_id,
            ctx.materializer,
            ctx.app_data_dir,
            BlockId::from_trusted(block_id),
            filename.clone(),
            mime_type.clone(),
            bytes,
        )
        .await
        {
            Ok(row) => row.id.into_string(),
            Err(e) => {
                tracing::warn!(
                    reference = %att.original_ref,
                    error = %e,
                    "import: attachment ingest failed; leaving original ref (#1925)"
                );
                ctx.warnings.push(format!(
                    "attachment '{}' could not be imported ({e}); left as-is",
                    att.original_ref
                ));
                continue;
            }
        };

        let token = attachment_token(att, &attachment_id, &filename, &mime_type);
        block_ingested.insert(
            att.original_ref.clone(),
            (attachment_id, filename, mime_type),
        );
        block_rewrites.push((att.clone(), token));
    }
    block_rewrites
}

/// Rewrite one block's content: each matched ref's full token (`![[file]]`,
/// `![alt](path)`, `[label](path)`) → its canonical `attachment:<id>` token
/// ([`attachment_token`]), an embed's size pipe escaped where its `\|` in a
/// table row was ([`escape_pipes_as`]). The CURRENT content is fetched first (it is the
/// durable, tag/link-rewritten version) and tokens are replaced in it.
///
/// A transient DB read error, a vanished block, or a failed edit must NOT abort
/// the (already durable) import — each warns and skips instead.
async fn rewrite_block_attachment_refs(
    ctx: &mut ImportCtx<'_>,
    block_id: &str,
    block_rewrites: &[(import::AttachmentRef, String)],
) {
    let pool = ctx.pool;
    let current: Option<String> = match sqlx::query_scalar!(
        "SELECT content FROM blocks WHERE id = ? AND deleted_at IS NULL",
        block_id,
    )
    .fetch_optional(pool)
    .await
    {
        Ok(row) => row.flatten(),
        Err(e) => {
            tracing::warn!(
                block_id = %block_id,
                error = %e,
                "import: attachment-ref content re-fetch failed (#1925)"
            );
            ctx.warnings.push(format!(
                "block '{block_id}' attachment refs could not be rewritten \
                 (content re-fetch failed: {e})"
            ));
            return;
        }
    };
    let Some(mut new_content) = current else {
        // Block vanished (concurrent delete) — nothing to rewrite.
        return;
    };
    for (att, token) in block_rewrites {
        if let Some(at) = new_content.find(&att.full_match) {
            // An image's alt and a link's label are copied as written, escape
            // and all; only an embed's size is re-written after a bare `|`.
            let token = if att.full_match.starts_with("![[") {
                escape_pipes_as(&new_content, at, &att.full_match, token)
            } else {
                token.clone()
            };
            new_content.replace_range(at..at + att.full_match.len(), &token);
        }
    }

    // Edit via the normal in-tx content-update path (opens its own
    // writer tx — safe now the import tx is committed).
    if let Err(e) = crate::commands::blocks::crud::edit_block_inner(
        pool,
        ctx.device_id,
        ctx.materializer,
        BlockId::from_trusted(block_id),
        new_content,
    )
    .await
    {
        tracing::warn!(
            block_id = %block_id,
            error = %e,
            "import: attachment-ref content rewrite failed (#1925)"
        );
        ctx.warnings.push(format!(
            "block '{block_id}' attachment refs could not be rewritten ({e})"
        ));
    }
}

/// #1925 — post-commit attachment ingest + content rewrite. Takes ownership of
/// `vault_files` so single-attempt files' bytes can be moved out. Warn-and-
/// continue only; never aborts the durable import.
///
/// Runs HERE, AFTER the import writer tx has fully committed and released the
/// writer lock, so it never overlaps the held IMMEDIATE tx.
/// `add_attachment_with_bytes_inner` and `edit_block_inner` are both pool-based
/// (each opens its OWN `BEGIN IMMEDIATE` tx); running them inside the import tx
/// would deadlock on the single SQLite writer lock — sequencing them strictly
/// after the final commit is what makes this safe.
///
/// OWNERSHIP: each attachment is owned by the CONTENT block it appears in (the
/// block's `block_id` FK), matching editor semantics — an attachment's lifecycle
/// follows its owning block (delete the block, the attachment GCs). The block
/// already exists + is committed (durable) by the time we ingest, so the FK is
/// satisfied and the rewrite is a normal `edit_block_inner`.
pub(super) async fn ingest_attachments(
    ctx: &mut ImportCtx<'_>,
    mut vault_files: Vec<VaultFile>,
    pending: PendingAttachments,
) {
    if pending.linked.is_empty() && pending.scoped.is_empty() {
        return;
    }
    // The note's folder within the vault: its title's path below the picked
    // folder (#6277 decision 8), less the note's own name.
    let note_dir = ctx
        .page_title
        .rsplit_once('/')
        .map_or("", |(dir, _name)| dir)
        .to_string();
    // #2724 — count how many INGEST ATTEMPTS will read each vault file so a
    // SINGLE-ATTEMPT file (the overwhelming common case) can have its bytes
    // MOVED out at ingest instead of cloned.
    let mut ingest_counts = ingest_read_counts(&pending.linked, &note_dir, &vault_files);
    for (idx, count) in ingest_read_counts(&pending.scoped, &note_dir, &vault_files) {
        *ingest_counts.entry(idx).or_insert(0) += count;
    }
    // Defence-in-depth for the move/clone decision: an index whose bytes were
    // taken (moved) is recorded here so the clone arm can never re-ingest an
    // emptied buffer as a 0-byte attachment, even if the count above were ever
    // wrong. Under a correct `ingest_counts` this set is never consulted on a
    // reachable path, but it makes "a moved buffer is never re-ingested" total.
    let mut moved_out: std::collections::HashSet<usize> = std::collections::HashSet::new();

    for (block_id, refs) in &pending.scoped {
        // A text's link may point anywhere, but a file an `attachments`
        // value names and the import does not bring is left out (#6277 G3).
        for att in refs.iter().filter(|att| att.is_link()) {
            if import::match_vault_file(&att.original_ref, &note_dir, &vault_files).is_none() {
                ctx.warnings.push(format!(
                    "attachment '{}' was not found among the imported files; left out",
                    att.original_ref
                ));
            }
        }
        ingest_block_attachments(
            ctx,
            &note_dir,
            &mut vault_files,
            &mut ingest_counts,
            &mut moved_out,
            block_id,
            refs,
        )
        .await;
    }
    for (block_id, refs) in &pending.linked {
        let block_rewrites = ingest_block_attachments(
            ctx,
            &note_dir,
            &mut vault_files,
            &mut ingest_counts,
            &mut moved_out,
            block_id,
            refs,
        )
        .await;
        if block_rewrites.is_empty() {
            continue;
        }
        rewrite_block_attachment_refs(ctx, block_id, &block_rewrites).await;
    }
}
