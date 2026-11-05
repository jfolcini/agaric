//! Linking block and heading anchors after an import:
//! [`link_cross_page_anchors`], [`anchor_block`], [`resolve_anchor_links`],
//! [`rewrite_anchor_tokens`] and [`link_deferred_links`].

use super::*;

/// A link into another page (#5160 D10): `name` is `Page#anchor`, and
/// `page_id` the page its base names.
pub(super) struct CrossPageAnchor {
    pub(super) anchor: String,
    pub(super) name: String,
    pub(super) page_id: String,
}

/// Link each of `anchors` to the block it names on its page (#5160 D10): the
/// first heading in document order whose text is the anchor, compared as the
/// same-file pass compares it and as Obsidian resolves a repeated heading, or,
/// for `^id`, the block of that id, which is the anchor an
/// export writes for a ref to another page's block. An Obsidian `^name` names
/// no block once its own file's import is done: a folder import, `defer`,
/// leaves it, and any anchor whose page is not imported yet, for
/// [`link_import_anchors_inner`] ([`PageLinks::deferred`]). Any other anchor
/// links the page, and the anchors dropped so are counted in one warning
/// (#1282). Each name keeps its page too, which an inline query naming it
/// remaps to.
pub(super) async fn link_cross_page_anchors(
    conn: &mut sqlx::SqliteConnection,
    links: &mut PageLinks,
    anchors: Vec<CrossPageAnchor>,
    defer: bool,
    warnings: &mut Vec<String>,
) -> Result<(), AppError> {
    if anchors.is_empty() {
        return Ok(());
    }
    let pages: HashSet<&str> = anchors.iter().map(|a| a.page_id.as_str()).collect();
    let candidates = load_anchor_candidates(conn, &pages).await?;
    let by_id: HashMap<&str, &AnchorCandidate> =
        candidates.iter().map(|c| (c.id.as_str(), c)).collect();
    let mut dropped = 0;
    for a in anchors {
        if let Some(block) = anchor_block(&candidates, &by_id, &a.page_id, &a.anchor) {
            links.blocks.insert(a.name.clone(), block.to_string());
        } else if defer {
            links.deferred.insert(a.name.clone(), a.anchor);
        } else {
            dropped += 1;
        }
        links.ids.insert(a.name, a.page_id);
    }
    warn_dropped_anchors(warnings, dropped);
    Ok(())
}

/// The blocks of `pages` an anchor may name, in one read: `page_id` holds a
/// page's whole subtree, and only a heading's text is read.
pub(super) async fn load_anchor_candidates(
    conn: &mut sqlx::SqliteConnection,
    pages: &HashSet<&str>,
) -> Result<Vec<AnchorCandidate>, AppError> {
    let pages_json = serde_json::to_string(pages)?;
    let candidates = sqlx::query_as!(
        AnchorCandidate,
        r#"SELECT id AS "id!", page_id AS "page_id!", parent_id, position,
                  CASE WHEN ltrim(content) LIKE '#%' THEN content ELSE '' END
                      AS "content!: String"
               FROM blocks
               WHERE block_type = 'content'
                 AND deleted_at IS NULL
                 AND page_id IN (SELECT value FROM json_each(?1))"#,
        pages_json,
    )
    .fetch_all(&mut *conn)
    .await?;
    Ok(candidates)
}

/// Warn of `n` anchors whose links fell back to their page, when there are
/// any (#1282).
pub(super) fn warn_dropped_anchors(warnings: &mut Vec<String>, n: usize) {
    if n > 0 {
        warnings.push(format!(
            "{n} wikilink block/heading anchors were dropped; links resolve to the page"
        ));
    }
}

/// A block of a page some link names by an anchor, where it sits in the page,
/// and its text when it is a heading.
pub(super) struct AnchorCandidate {
    pub(super) id: String,
    pub(super) page_id: String,
    pub(super) parent_id: Option<String>,
    pub(super) position: Option<i64>,
    pub(super) content: String,
}

/// The block `anchor` names among `candidates`, `by_id` indexing them: on the
/// page `page_id`, the block of the `^id` or the first heading of the
/// anchor's text in document order.
pub(super) fn anchor_block<'a>(
    candidates: &'a [AnchorCandidate],
    by_id: &HashMap<&str, &'a AnchorCandidate>,
    page_id: &str,
    anchor: &str,
) -> Option<&'a str> {
    let block_id = obsidian_block_anchor_id(anchor);
    let norm = normalize_heading_anchor(anchor);
    let names = |c: &&AnchorCandidate| {
        if let Some(id) = block_id {
            c.id == id
        } else {
            obsidian_heading_text(&c.content)
                .is_some_and(|text| normalize_heading_anchor(text) == norm)
        }
    };
    candidates
        .iter()
        .filter(|c| c.page_id == page_id)
        .filter(names)
        .min_by_key(|c| tree_path(by_id, c))
        .map(|c| c.id.as_str())
}

/// Where `block` sits in its page read depth first: the `(position, id)` of
/// its outermost ancestor on the page down to its own, so an ancestor sorts
/// before its descendants and a page's smallest path is its first block. The
/// walk is bounded like every descendant walk (invariant 9).
fn tree_path<'a>(
    by_id: &HashMap<&str, &'a AnchorCandidate>,
    block: &'a AnchorCandidate,
) -> Vec<(i64, &'a str)> {
    let mut path = Vec::new();
    let mut next = Some(block);
    for _ in 0..agaric_store::block_descendants::DESCENDANT_DEPTH_CAP {
        let Some(row) = next else {
            break;
        };
        path.push((
            row.position.unwrap_or(NULL_POSITION_SENTINEL),
            row.id.as_str(),
        ));
        next = row
            .parent_id
            .as_deref()
            .and_then(|parent| by_id.get(parent).copied());
    }
    path.reverse();
    path
}

/// #2510 / #2567 — what one document's deferred anchor links resolved to, so
/// each outcome can surface its own diagnostic once, in aggregate.
#[derive(Default)]
struct AnchorOutcomes {
    resolved_block_refs: usize,
    unresolved_block_anchors: usize,
    resolved_heading_refs: usize,
    unresolved_headings: usize,
    unresolved_empty_base_headings: std::collections::BTreeSet<String>,
    /// Labels on links that became block refs, which have no label (#5160 D9).
    dropped_labels: usize,
}

/// The block's CURRENT (durable, tag/link-rewritten) content, or `None` when the
/// block vanished (concurrent delete) or could not be read. This phase runs
/// AFTER the import committed, so a transient read error warns and skips rather
/// than turning a durable import into a hard failure.
async fn fetch_anchor_block_content(
    pool: &SqlitePool,
    block_id: &str,
    warnings: &mut Vec<String>,
) -> Option<String> {
    match sqlx::query_scalar!(
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
                "import: block-anchor content re-fetch failed (#2510)"
            );
            warnings.push(format!(
                "block '{block_id}' block-anchor link(s) could not be resolved \
                 (content re-fetch failed: {e})"
            ));
            None
        }
    }
}

/// Rewrite one block's deferred anchor tokens, returning the new content when
/// anything was patched.
///
/// The PRECISE match is re-run here via the same `HUMAN_PAGE_LINK_RE` the
/// initial rewrite pass uses, against the block's CURRENT content — this avoids
/// any literal-substring drift between the captured map key (`caps[1].trim()`)
/// and the token's actual on-disk bytes.
///
///   * #2510 — the anchor id matches a `^block-id` marker recorded on one of
///     this document's OWN blocks, and that block was actually created →
///     rewrite every occurrence of the token to a real Agaric block-ref
///     `((<block ULID>))`.
///   * #2567 — a heading anchor resolves its normalized label to the owning
///     block's ULID, rewriting to the SAME block-ref form so navigation
///     (scroll/focus-to-block) is reused verbatim.
///   * otherwise (marker not found anywhere in this document, or its owning
///     block was skipped) → fall back to a link to THIS page, mirroring #1282's
///     dropped-anchor fallback, with its label unless that is `page_title`
///     (#5160 D9). The one exception is an anchor-only
///     `[[#Heading]]` that matched no heading: it is left LITERAL with a
///     per-token "no page target" warning, exactly as before #2567.
fn rewrite_anchor_tokens(
    current_content: &str,
    page_id: &str,
    page_title: &str,
    created_block_ids: &[Option<String>],
    refs: &DocumentRefs,
    outcomes: &mut AnchorOutcomes,
) -> Option<String> {
    let mut any_patched = false;
    let new_content = HUMAN_PAGE_LINK_RE
        .replace_all(current_content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            let whole = m.as_str();
            // Same guards as `rewrite_inbound_page_links`: skip the
            // `#[[Tag]]` / `![[embed]]` forms and any already-internal
            // `[[ULID]]` ref.
            if current_content[..m.start()].ends_with('#')
                || current_content[..m.start()].ends_with('!')
            {
                return whole.to_string();
            }
            if agaric_store::cache::PAGE_LINK_RE.is_match(whole) {
                return whole.to_string();
            }
            // A block ref has no label form, so a label is dropped with it
            // (#5160 D9); the page-link fallback keeps it.
            let Some((name, label)) = refs.links.page_links.readings.get(caps[1].trim()) else {
                return whole.to_string();
            };
            let label = label.as_deref();
            let mut block_ref = |target_id: String| {
                outcomes.dropped_labels += usize::from(label.is_some());
                format!("(({target_id}))")
            };
            if let Some(anchor) = refs.links.pending_block_anchors.get(name) {
                any_patched = true;
                if let Some(target_id) = refs
                    .anchor_to_block_index
                    .get(anchor)
                    .and_then(|&target_idx| created_block_ids.get(target_idx).cloned().flatten())
                {
                    outcomes.resolved_block_refs += 1;
                    block_ref(target_id)
                } else {
                    outcomes.unresolved_block_anchors += 1;
                    stored_page_link(page_id, label, Some(page_title))
                }
            } else if let Some(pending) = refs.links.pending_heading_anchors.get(name) {
                if let Some(target_id) = refs
                    .heading_to_block_index
                    .get(&pending.norm)
                    .and_then(|&target_idx| created_block_ids.get(target_idx).cloned().flatten())
                {
                    any_patched = true;
                    outcomes.resolved_heading_refs += 1;
                    block_ref(target_id)
                } else if pending.empty_base {
                    outcomes.unresolved_empty_base_headings.insert(name.clone());
                    whole.to_string()
                } else {
                    any_patched = true;
                    outcomes.unresolved_headings += 1;
                    stored_page_link(page_id, label, Some(page_title))
                }
            } else {
                whole.to_string()
            }
        })
        .into_owned();
    any_patched.then_some(new_content)
}

/// Surface each anchor-resolution outcome once, in aggregate.
fn push_anchor_warnings(warnings: &mut Vec<String>, outcomes: &AnchorOutcomes) {
    if outcomes.resolved_block_refs > 0 {
        tracing::debug!(
            resolved_block_ref_count = outcomes.resolved_block_refs,
            "import: Obsidian block-anchor wiki-link(s) resolved to a block-ref (#2510)"
        );
    }
    if outcomes.unresolved_block_anchors > 0 {
        // #2510 — mirrors #1282's dropped-anchor aggregate warning: the
        // block-anchor marker was not found anywhere in this document
        // (or its owning block was skipped), so the link fell back to a
        // page link to this page instead of a block-ref.
        let unresolved_block_anchor_count = outcomes.unresolved_block_anchors;
        warnings.push(format!(
            "{unresolved_block_anchor_count} wikilink block-anchor(s) (`#^blockId`) could not \
             be matched to a block in this document; left as a page link (an Obsidian \
             `^name` resolves only in the file that defines it)"
        ));
    }
    if outcomes.resolved_heading_refs > 0 {
        tracing::debug!(
            resolved_heading_ref_count = outcomes.resolved_heading_refs,
            "import: Obsidian heading-anchor wiki-link(s) resolved to a block-ref (#2567)"
        );
    }
    if outcomes.unresolved_headings > 0 {
        // #2567 — mirrors the block-anchor aggregate warning: an explicit
        // self-title heading link matched no heading in this document, so it
        // fell back to a page link instead of a block-ref.
        let unresolved_heading_count = outcomes.unresolved_headings;
        warnings.push(format!(
            "{unresolved_heading_count} wikilink heading-anchor(s) (`#Heading`) could not be \
             matched to a heading in this document; left as a page link"
        ));
    }
    for name in &outcomes.unresolved_empty_base_headings {
        // #1282 — an anchor-only `[[#Heading]]` with no matching heading is
        // left literal; surface the same per-occurrence "no page target"
        // diagnostic the pre-#2567 pre-pass emitted, so behavior (and the
        // #1282 test) is unchanged for the unresolved case.
        warnings.push(format!(
            "wiki-link '[[{name}]]' has no page target (intra-note anchor); left as plain text"
        ));
    }
    warn_dropped_labels(warnings, outcomes.dropped_labels);
}

/// #2510 / #2567 — post-commit resolution of deferred same-document block- and
/// heading-anchor wiki-links to real `((block ULID))` refs (with the #1282
/// page-link fallback), and of Logseq `((uuid))` refs to the block whose `id::`
/// line names it (#5160 D14). Warn-and-continue only; never aborts the durable
/// import.
///
/// Runs HERE, AFTER the import writer tx has fully committed (mirrors the #1925
/// attachment phase below, for the same reason: `edit_block_inner` is pool-based
/// and opens its OWN writer tx, which would deadlock against the still-held
/// import tx). Every block in this document now has its final ULID (or `None`,
/// if skipped by #1918), so a deferred `[[Page#^blockId]]` / `[[#^blockId]]`
/// token — left LITERAL in its owning block's content by the pre-pass — can
/// finally be resolved.
pub(super) async fn resolve_anchor_links(
    ctx: &mut ImportCtx<'_>,
    parse_output: &import::ParseOutput,
    created_block_ids: &[Option<String>],
    refs: &DocumentRefs,
) {
    let pending = !refs.links.pending_block_anchors.is_empty()
        || !refs.links.pending_heading_anchors.is_empty();
    let anchored = !refs.anchor_to_block_index.is_empty();
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let pool = ctx.pool;
    let page_id = ctx.page_id.clone();
    // The pre-pass's dropped labels are warned of with this pass's, once.
    let mut outcomes = AnchorOutcomes {
        dropped_labels: refs.links.dropped_labels,
        ..AnchorOutcomes::default()
    };

    for (block_index, block) in parse_output.blocks.iter().enumerate() {
        // A cheap in-memory pre-filter over the ORIGINAL parsed content so
        // only blocks that could possibly carry a pending token are re-fetched
        // from the database. A code block's `((uuid))` is literal, as its
        // links and tags are (#3605).
        let links = pending && block.content.contains("[[");
        let logseq_refs = anchored && !block.is_code && block.content.contains("((");
        if !links && !logseq_refs {
            continue;
        }
        let Some(Some(container_id)) = created_block_ids.get(block_index) else {
            // The containing block itself was skipped (#1918) — nothing
            // to patch.
            continue;
        };
        let Some(current_content) =
            fetch_anchor_block_content(pool, container_id, &mut ctx.warnings).await
        else {
            continue;
        };
        let linked = links
            .then(|| {
                rewrite_anchor_tokens(
                    &current_content,
                    &page_id,
                    &ctx.page_title,
                    created_block_ids,
                    refs,
                    &mut outcomes,
                )
            })
            .flatten();
        // #5160 D14 — a Logseq `((uuid))` to a block of this file refs it.
        let resolved = logseq_refs
            .then(|| {
                import::resolve_logseq_refs(linked.as_deref().unwrap_or(&current_content), |uuid| {
                    let &index = refs.anchor_to_block_index.get(uuid)?;
                    created_block_ids.get(index).cloned().flatten()
                })
            })
            .flatten();
        let Some(new_content) = resolved.or(linked) else {
            continue;
        };

        if let Err(e) = crate::commands::blocks::crud::edit_block_inner(
            pool,
            device_id,
            materializer,
            BlockId::from_trusted(container_id),
            new_content,
        )
        .await
        {
            tracing::warn!(
                block_id = %container_id,
                error = %e,
                "import: block-anchor rewrite failed (#2510)"
            );
            ctx.warnings.push(format!(
                "block '{container_id}' block-anchor link(s) could not be rewritten ({e})"
            ));
        }
    }

    push_anchor_warnings(&mut ctx.warnings, &outcomes);
}

/// What [`link_import_anchors_inner`] could not keep, each warned of once.
#[derive(Default)]
pub(super) struct DeferredOutcomes {
    pub(super) dropped_anchors: usize,
    pub(super) dropped_labels: usize,
    pub(super) stripped_refs: usize,
}

/// `content` with each [`DEFERRED_LINK_RE`] link outside inline code written
/// as a ref to the block `target` finds for its page and anchor, its label
/// dropped since a block ref carries none, else as the link to the page with
/// its label.
pub(super) fn link_deferred_links(
    content: &str,
    target: impl Fn(&str, &str) -> Option<String>,
    outcomes: &mut DeferredOutcomes,
) -> String {
    let code_spans = import::inline_code_spans(content);
    DEFERRED_LINK_RE
        .replace_all(content, |caps: &regex::Captures<'_>| {
            let m = caps.get(0).expect("group 0 always present");
            if is_in_span(m.start(), &code_spans) {
                return m.as_str().to_string();
            }
            let label = caps.get(3).map(|l| l.as_str()).filter(|l| !l.is_empty());
            if let Some(block) = target(&caps[1], &caps[2]) {
                outcomes.dropped_labels += usize::from(label.is_some());
                return format!("(({block}))");
            }
            outcomes.dropped_anchors += 1;
            stored_page_link(&caps[1], label, None)
        })
        .into_owned()
}

/// The `(id, content)` of each of `blocks` live in `space_id`, read in batches.
pub(super) async fn live_contents(
    pool: &SqlitePool,
    space_id: &str,
    blocks: &[BlockId],
) -> Result<Vec<(String, String)>, AppError> {
    let scope = agaric_store::space::SpaceScope::Active(SpaceId::from_trusted(space_id));
    let mut contents = Vec::new();
    for chunk in blocks.chunks(agaric_store::pagination::MAX_BATCH_BLOCK_IDS) {
        let rows = batch_resolve_inner(pool, chunk.to_vec(), &scope).await?;
        let live = rows.into_iter().filter(|row| !row.deleted);
        contents.extend(live.filter_map(|row| Some((row.id, row.title?))));
    }
    Ok(contents)
}
