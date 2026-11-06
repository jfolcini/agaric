//! Applying an imported page's front matter: [`apply_frontmatter_properties`],
//! [`import_frontmatter_aliases`] and [`apply_frontmatter_tags`].

use super::*;

/// #2722 / #5387 — make the page's aliases `aliases` through
/// `RemovePageAlias` / `AddPageAlias` ops in the caller's transaction. An alias
/// another page holds stays off the page, with a warning rather than silently.
pub(super) async fn apply_frontmatter_aliases<S: AsRef<str>>(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    page_id: &str,
    aliases: &[S],
    warnings: &mut Vec<String>,
) -> Result<(), AppError> {
    let wanted = super::aliases::wanted_aliases(aliases);
    let state = materializer.loro_state();
    let taken =
        super::aliases::write_page_aliases_in_tx(tx, state, device_id, page_id, &wanted).await?;
    for alias in taken {
        warnings.push(format!(
            "alias '{alias}' is already used by another page; not applied to the page"
        ));
    }
    Ok(())
}

/// Front matter `aliases:` on import, added to the aliases the page holds: an
/// adopted page (D12) may hold some.
async fn import_frontmatter_aliases(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    page_id: &str,
    items: Vec<&str>,
    warnings: &mut Vec<String>,
) -> Result<(), AppError> {
    let mut aliases =
        sqlx::query_scalar!("SELECT alias FROM page_aliases WHERE page_id = ?1", page_id)
            .fetch_all(&mut ***tx)
            .await?;
    aliases.extend(items.into_iter().map(str::to_owned));
    apply_frontmatter_aliases(tx, materializer, device_id, page_id, &aliases, warnings).await
}

/// #1432 — apply the leading YAML frontmatter as page-level properties. Returns
/// the (possibly moved-through) transaction.
///
/// A key names the reserved key or definition it folds to (#5160 D13), and a
/// value its definition refuses is skipped with a warning naming it (D11):
/// front matter has no block to keep it in as text.
pub(super) async fn apply_frontmatter_properties(
    ctx: &mut ImportCtx<'_>,
    mut tx: CommandTx,
    parse_output: &import::ParseOutput,
    counters: &mut ImportCounters,
) -> Result<CommandTx, AppError> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let page_id = ctx.page_id.clone();
    let lines = &ctx.lines;
    let warnings = &mut ctx.warnings;
    // #1432 — apply the leading YAML frontmatter as PAGE-level properties,
    // closing the export↔import asymmetry: `export_page_markdown_inner`
    // already emits page properties as frontmatter, but the importer used to
    // discard them. The parser (`import::parse_markdown_file` or
    // `parse_logseq_markdown`, by dialect) has already
    // filtered the exporter's internal/reserved keys and validated each key
    // against the `^[A-Za-z0-9_-]{1,64}$` alphabet, so every pair here is a
    // user-visible scalar safe to stamp onto the page. These properties are
    // written into the FIRST chunk (alongside the page + space property),
    // before the block loop opens any new chunk, so they share the page's
    // atomic write.
    for (key, value) in &parse_output.frontmatter {
        // #2722 — `aliases` and `tags` are SEMANTIC frontmatter keys the
        // exporter emits from the `page_aliases` table and `block_tags`
        // associations (NOT from `block_properties`). The pre-#2722 importer
        // had no special-casing, so it stamped them as inert TEXT properties
        // named `aliases`/`tags` — silently killing alias resolution/search
        // and tag filtering on re-import. Intercept both here so neither is
        // ever persisted as a misleading text property:
        //   * `aliases` → `AddPageAlias` ops, written below in THIS tx;
        //   * `tags`    → real `block_tags` associations, written by the
        //     dedicated frontmatter-tag pre-pass further down (it needs the
        //     tag resolve-or-create machinery, which is set up after the
        //     wiki-link pre-pass).
        if key.as_str() == "aliases" {
            let items = frontmatter_items(parse_output, key, value);
            import_frontmatter_aliases(&mut tx, materializer, device_id, &page_id, items, warnings)
                .await?;
            continue;
        }
        if key.as_str() == "tags" {
            // Handled by the frontmatter-tag pre-pass below (resolve-or-create
            // the tag block + write a real `block_tags` association). Skip it
            // here so it is never stamped as a misleading text property.
            continue;
        }
        let key = lines.canonical_key(key);
        // #1921 (B1) — the declaration read once for the whole import. A key
        // with no `property_definitions` row stays undeclared (`None`). A ref
        // value reads as a `key::` line's does: a live block id of the space,
        // or `[[Title]]` or a title by the link rule (#6277 F3).
        let declaration = lines.declaration(&key);
        let args = match lines.read(&key, value) {
            Ok(args) => args,
            Err(reason) => {
                warnings.push(format!(
                    "front matter `{key}: {value}` was skipped: {reason}"
                ));
                continue;
            }
        };
        let (value_text, value_num, value_date, value_ref, value_bool) = args;
        let (_page_block, prop_op) = agaric_engine::block_ops::set_property_in_tx_with_declaration(
            &mut tx,
            materializer.loro_state(),
            device_id,
            page_id.clone(),
            &key,
            value_text,
            value_num,
            value_date,
            value_ref,
            value_bool,
            declaration,
        )
        .await?;
        counters.properties_set += 1;
        tx.enqueue_background(prop_op);
    }
    Ok(tx)
}

/// The individual items of a frontmatter list value.
///
/// #2829 — the comma-joined scalar in `frontmatter` is lossy for an item that
/// itself contains a literal comma, so the REAL parsed item boundaries from
/// `frontmatter_list_items` win whenever the key arrived as a genuine YAML
/// sequence; a plain unbracketed scalar (no boundary info available) falls back
/// to the legacy comma-split.
pub(super) fn frontmatter_items<'a>(
    parse_output: &'a import::ParseOutput,
    key: &str,
    value: &'a str,
) -> Vec<&'a str> {
    if let Some(items) = parse_output.frontmatter_list_items.get(key) {
        items.iter().map(String::as_str).collect()
    } else {
        value
            .split(',')
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .collect()
    }
}

/// #2722 — write the real page→tag association via the shared tag-apply helper
/// (op-log `AddTag` + engine projection), queueing the op for post-commit
/// dispatch. An association that already exists is an idempotent no-op
/// (`Ok(None)`). A cross-space rejection is impossible here (page and tag share
/// the import's space), but degrades to a warning rather than aborting the
/// durable import if it ever occurs.
pub(super) async fn associate_page_tag(
    tx: &mut CommandTx,
    materializer: &Materializer,
    device_id: &str,
    page_id: &str,
    tag_id: &str,
    tag_name: &str,
    warnings: &mut Vec<String>,
) {
    let payload = agaric_store::op::OpPayload::AddTag(agaric_store::op::AddTagPayload {
        block_id: BlockId::from_trusted(page_id),
        tag_id: BlockId::from_trusted(tag_id),
    });
    match crate::commands::tags::apply_tag_to_block_in_tx(
        &mut *tx,
        materializer.loro_state(),
        device_id,
        page_id,
        tag_id,
        payload,
    )
    .await
    {
        Ok(Some(op_record)) => tx.enqueue_background(op_record),
        Ok(None) => { /* association already exists — idempotent */ }
        Err(e) => {
            tracing::warn!(
                name = %tag_name,
                error = %e,
                "import: frontmatter tag association failed; skipped (#2722)"
            );
            warnings.push(format!(
                "page tag '{tag_name}' could not be associated ({e})"
            ));
        }
    }
}

/// Resolve one frontmatter tag NAME to a tag block id, REUSING the inline-tag
/// pre-pass state (`resolved_tag_norm` for this-pass creations,
/// `existing_tag_by_norm` for in-space matches) so a name appearing BOTH inline
/// and in frontmatter converges to ONE tag block, and creating the tag when
/// neither has it. `None` degrades: the create failed, so the caller skips this
/// tag's association with a warning already recorded.
async fn resolve_or_create_frontmatter_tag(
    ctx: &mut ImportCtx<'_>,
    tx: &mut CommandTx,
    tag_name: &str,
    resolved_tag_norm: &mut HashMap<String, String>,
    existing_tag_by_norm: &HashMap<String, String>,
) -> Result<Option<String>, AppError> {
    let tag_name = inbound_tag_spelling(tag_name, existing_tag_by_norm, &mut ctx.warnings);
    let norm = agaric_core::tag_norm::normalize_tag_name(&tag_name);
    if let Some(id) = resolved_tag_norm.get(&norm) {
        return Ok(Some(id.clone()));
    }
    if let Some(id) = existing_tag_by_norm.get(&norm) {
        let id = id.clone();
        resolved_tag_norm.insert(norm, id.clone());
        return Ok(Some(id));
    }
    // Create the missing tag block + stamp its space (mirrors the inline-tag
    // pre-pass and the importing page). On failure, degrade: warn and skip this
    // tag's association.
    match create_block_in_tx(
        &mut *tx,
        ctx.materializer.loro_state(),
        ctx.device_id,
        "tag".into(),
        tag_name.clone(),
        None,
        None,
        // #2849 PR2: server-generated id.
        None,
    )
    .await
    {
        Ok((new_tag, new_tag_op)) => {
            tx.enqueue_background(new_tag_op);
            let new_tag_id = new_tag.id.clone().into_string();
            stamp_space_property(
                tx,
                ctx.materializer,
                ctx.device_id,
                new_tag_id.clone(),
                &ctx.space_id,
            )
            .await?;
            resolved_tag_norm.insert(norm, new_tag_id.clone());
            Ok(Some(new_tag_id))
        }
        Err(e) => {
            tracing::warn!(
                name = %tag_name,
                error = %e,
                "import: frontmatter tag create failed; association skipped (#2722)"
            );
            ctx.warnings.push(format!(
                "page tag '{tag_name}' could not be created; not applied"
            ));
            Ok(None)
        }
    }
}

/// #2722 — apply page-level frontmatter `tags:` as real `block_tags`
/// associations, reusing the inline-tag pre-pass state. Returns the transaction.
pub(super) async fn apply_frontmatter_tags(
    ctx: &mut ImportCtx<'_>,
    mut tx: CommandTx,
    parse_output: &import::ParseOutput,
    resolved_tag_norm: &mut HashMap<String, String>,
    existing_tag_by_norm: &HashMap<String, String>,
) -> Result<CommandTx, AppError> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let page_id = ctx.page_id.clone();
    // #2722 — apply page-level frontmatter `tags:` as REAL `block_tags`
    // associations on the imported page, instead of the inert text property the
    // pre-#2722 importer stamped (which silently disabled tag filtering on
    // re-import). The historical blocker cited in #1924/#1950 was #1917 (typed
    // arrays could not be parsed); that is RESOLVED — the exported `[a, b]` flow
    // sequence now arrives as a comma-joined scalar via `parse_frontmatter`
    // (see the frontmatter parser), so the value is available here.
    //
    // Runs in the FIRST chunk's tx (before the block loop opens any new chunk),
    // sharing the page's atomic write. The page's `space_id` was materialised
    // in-tx by the `space` property set above (`set_property_in_tx` routes the
    // reserved `space` key through the projection's `UPDATE blocks SET
    // space_id`), and every tag we reuse/create is space-scoped to the SAME
    // space, so the helper's cross-space guard passes without adoption.
    if let Some((_k, tags_value)) = parse_output
        .frontmatter
        .iter()
        .find(|(k, _)| k.as_str() == "tags")
    {
        for tag_name in frontmatter_items(parse_output, "tags", tags_value) {
            let tag_id = resolve_or_create_frontmatter_tag(
                ctx,
                &mut tx,
                tag_name,
                resolved_tag_norm,
                existing_tag_by_norm,
            )
            .await?;
            let Some(tag_id) = tag_id else {
                continue;
            };
            associate_page_tag(
                &mut tx,
                materializer,
                device_id,
                &page_id,
                &tag_id,
                tag_name,
                &mut ctx.warnings,
            )
            .await;
        }
    }
    Ok(tx)
}
