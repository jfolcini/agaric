//! Resolving the page links and tags an import or paste names:
//! [`PageLinks`], [`InboundLinks`], [`LinkMatches`], [`match_page_names`],
//! [`match_tag_names`], [`resolve_link_names`], [`resolve_inbound_page_links`]
//! and [`resolve_inbound_tags`].

use super::*;

/// What the wiki-link bodies and inline-query page names of a text resolve to
/// (#5160 D9, D10).
#[derive(Default)]
pub(super) struct PageLinks {
    /// Each trimmed link body's reading: the name it links and its label. A
    /// body with none stays text.
    pub(super) readings: HashMap<String, (String, Option<String>)>,
    /// Each name's page: the names the readings give and the inline queries
    /// hold.
    pub(super) ids: HashMap<String, String>,
    /// Each anchored name's block on another page, which the link refs
    /// instead of the page (#5160 D10).
    pub(super) blocks: HashMap<String, String>,
    /// A folder import's anchored names whose anchor names no block of the
    /// page yet, each with its anchor: the link carries it to
    /// [`link_import_anchors_inner`] ([`DEFERRED_LINK_RE`]).
    pub(super) deferred: HashMap<String, String>,
}

impl PageLinks {
    /// Add what `from` holds for the link `bodies` and the query `names`.
    pub(super) fn extend_from(
        &mut self,
        from: &Self,
        bodies: &std::collections::BTreeSet<String>,
        names: &std::collections::BTreeSet<String>,
    ) {
        let readings = bodies
            .iter()
            .filter_map(|body| Some((body, from.readings.get(body)?)));
        for (body, reading) in readings {
            self.readings.insert(body.clone(), reading.clone());
            if let Some(id) = from.ids.get(&reading.0) {
                self.ids.insert(reading.0.clone(), id.clone());
            }
            if let Some(block) = from.blocks.get(&reading.0) {
                self.blocks.insert(reading.0.clone(), block.clone());
            }
        }
        for name in names {
            if let Some(id) = from.ids.get(name) {
                self.ids.insert(name.clone(), id.clone());
            }
        }
    }
}

/// The wiki-link state one import document's pre-pass produces: the resolved
/// page links the rewrite reads, plus the same-document block- and
/// heading-anchor tokens whose target block does not exist yet and so are
/// resolved in the post-commit anchor phase.
#[derive(Default)]
pub(super) struct InboundLinks {
    pub(super) page_links: PageLinks,
    /// Each resolved page's title by id, so a label equal to it is not stored
    /// (#5160 D9).
    pub(super) titles: HashMap<String, String>,
    pub(super) pending_block_anchors: HashMap<String, String>,
    pub(super) pending_heading_anchors: HashMap<String, PendingHeading>,
    /// Labels on links into another page that became block refs, which carry
    /// none (#5160 D9): the caller warns, once, with any it drops itself.
    pub(super) dropped_labels: usize,
}

impl InboundLinks {
    /// Record `id`'s title: the snapshot's, or `created_as` for a page this
    /// pass created.
    fn remember_title(&mut self, id: &str, matches: &LinkMatches, created_as: &str) {
        let title = matches.titles.get(id).map_or(created_as, String::as_str);
        self.titles.insert(id.to_string(), title.to_string());
    }

    fn defer_anchor(&mut self, name: String, deferred: DeferredAnchor) {
        match deferred {
            DeferredAnchor::Block(block_id) => {
                self.pending_block_anchors.insert(name, block_id);
            }
            DeferredAnchor::Heading(heading) => {
                self.pending_heading_anchors.insert(name, heading);
            }
        }
    }
}

/// #2510 / #2567 — the deferred resolution a same-document `#…` sub-anchor
/// needs. A block's ULID is not known until it is created in the write loop, so
/// the token is left literal here and rewritten to a real `((block ULID))` ref —
/// or to a link to the importing page, mirroring #1282's dropped-anchor
/// fallback — once every block of the document exists.
enum DeferredAnchor {
    Block(String),
    Heading(PendingHeading),
}

fn deferred_anchor(
    anchor: &str,
    block_anchor_id: Option<&str>,
    empty_base: bool,
) -> DeferredAnchor {
    match block_anchor_id {
        Some(block_id) => DeferredAnchor::Block(block_id.to_string()),
        None => DeferredAnchor::Heading(PendingHeading {
            norm: normalize_heading_anchor(anchor),
            empty_base,
        }),
    }
}

/// The in-space pages a set of link names may resolve to, read once for the
/// whole pass (#2200: one query per map, never one per name). Where several
/// pages hold a key, the lowest id holds it (#6278), so each map keeps that one.
/// The importing page (created in this tx) is visible, so a self-reference
/// resolves to it.
#[derive(Default)]
pub(super) struct LinkMatches {
    /// Title under [`name_key`](agaric_core::tag_norm::name_key) (trim, case,
    /// NFC) → id.
    pub(super) folded: HashMap<String, String>,
    /// Alias under the same key → page id.
    pub(super) aliases: HashMap<String, String>,
    /// Every matched page's title by id.
    pub(super) titles: HashMap<String, String>,
}

impl LinkMatches {
    /// Record that page `id` holds `key` in `map`, unless a lower id does.
    pub(super) fn push(map: &mut HashMap<String, String>, key: String, id: String) {
        let held = map.entry(key).or_insert_with(|| id.clone());
        if id < *held {
            *held = id;
        }
    }

    /// The page a link's `name` names (#5160 D10): the page titled with the
    /// whole name, else, when an anchor holding no `|` follows its first `#`,
    /// the page its base names. A `|` after the `#` starts a label, so it
    /// never makes an anchor.
    pub(super) fn find_name(&self, name: &str) -> Option<&str> {
        let (base, anchor) = split_wikilink_anchor(name);
        let anchored = !base.is_empty() && anchor.is_some_and(|a| !a.contains('|'));
        self.find(name)
            .or_else(|| anchored.then(|| self.find(base)).flatten())
    }

    /// The page `name` resolves to (#5160 N4): the title under
    /// [`name_key`](agaric_core::tag_norm::name_key), else an alias under it,
    /// else none. Where several pages hold the name, the lowest id does
    /// (#6278), however `name` is spelled. Titles are compared whole,
    /// namespace included.
    pub(super) fn find(&self, name: &str) -> Option<&str> {
        let key = agaric_core::tag_norm::name_key(name);
        self.folded
            .get(&key)
            .or_else(|| self.aliases.get(&key))
            .map(String::as_str)
    }
}

/// The names [`LinkMatches`] looks up for `link_names` (#5160 D10): the name
/// of each of their [`link_body_readings`], so a title holding a `|` or a `#`
/// wins first, and each anchor-stripped base. An anchor-only link like
/// `[[#heading]]` has an empty base and looks up nothing.
pub(super) fn link_lookup_names(link_names: &[String]) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for (name, _) in link_names.iter().flat_map(|body| link_body_readings(body)) {
        let (base, anchor) = split_wikilink_anchor(name);
        if base.is_empty() {
            continue;
        }
        if anchor.is_some() {
            set.insert(name.to_string());
        }
        set.insert(base.to_string());
    }
    set.into_iter().collect()
}

/// Resolve `names` an MCP agent writes in place of ids to pages of `space_id`
/// by the rule a pasted `[[Name]]` follows ([`LinkMatches::find`]), in one
/// snapshot: the page each names, in order (#5397).
pub(crate) async fn match_page_names(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    names: &[String],
) -> Result<Vec<Option<String>>, AppError> {
    let names: Vec<String> = names.iter().map(|name| name.trim().to_owned()).collect();
    let matches = snapshot_page_link_matches(conn, space_id, &names).await?;
    Ok(names
        .iter()
        .map(|name| matches.find(name).map(str::to_owned))
        .collect())
}

/// Resolve `names` to tags of `space_id` by the rule a pasted `#name` follows
/// (the normalised name): the tag each names, in order.
pub(crate) async fn match_tag_names(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    names: &[String],
) -> Result<Vec<Option<String>>, AppError> {
    let tags = snapshot_tags_by_norm(conn, space_id).await?;
    Ok(names
        .iter()
        .map(|name| {
            let norm = agaric_core::tag_norm::normalize_tag_name(name.trim());
            tags.get(&norm).cloned()
        })
        .collect())
}

/// Read the [`LinkMatches`] for `link_names` in `space_id`: the live pages
/// whose title keys like one of the names, then the live pages one of the names
/// is an alias of. SQLite cannot apply the fold, so every page and alias of the
/// space is read and folded here; with no index on `content`, SQLite reads
/// every page row for a title filter anyway.
pub(super) async fn snapshot_page_link_matches(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    link_names: &[String],
) -> Result<LinkMatches, AppError> {
    use agaric_core::tag_norm::name_key;
    let keys: HashSet<String> = link_lookup_names(link_names)
        .iter()
        .map(|name| name_key(name))
        .collect();
    let mut matches = LinkMatches::default();
    if keys.is_empty() {
        return Ok(matches);
    }
    let rows = sqlx::query!(
        r#"SELECT id AS "id!", content AS "content!"
               FROM blocks
               WHERE block_type = 'page'
                 AND deleted_at IS NULL
                 AND space_id = ?1
                 AND content IS NOT NULL
               ORDER BY id ASC"#,
        space_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    for r in rows {
        let key = name_key(&r.content);
        if !keys.contains(&key) {
            continue;
        }
        LinkMatches::push(&mut matches.folded, key, r.id.clone());
        matches.titles.insert(r.id, r.content);
    }
    let rows = sqlx::query!(
        r#"SELECT a.page_id AS "page_id!", a.alias AS "alias!", b.content AS "title?"
               FROM page_aliases a
               JOIN blocks b ON b.id = a.page_id
               WHERE b.block_type = 'page'
                 AND b.deleted_at IS NULL
                 AND b.space_id = ?1
               ORDER BY a.page_id ASC"#,
        space_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    for r in rows {
        let key = name_key(&r.alias);
        if !keys.contains(&key) {
            continue;
        }
        if let Some(title) = r.title {
            matches.titles.insert(r.page_id.clone(), title);
        }
        LinkMatches::push(&mut matches.aliases, key, r.page_id);
    }
    Ok(matches)
}

/// Resolve one wiki-link BASE name to a page ULID, creating the page when the
/// snapshot holds no match.
///
/// `resolved_base_links` remembers this pass's own resolutions so two distinct
/// tokens sharing one base (`[[Page#h1]]`, `[[Page#h2]]`) resolve to the SAME
/// page and create it AT MOST once.
async fn resolve_or_create_link_target(
    ctx: &mut NameCtx<'_>,
    tx: &mut CommandTx,
    base: String,
    link_matches: &LinkMatches,
    resolved_base_links: &mut HashMap<String, String>,
) -> Result<String, AppError> {
    if let Some(ulid) = resolved_base_links.get(&base) {
        return Ok(ulid.clone());
    }
    if let Some(found) = link_matches.find(&base) {
        let found = found.to_owned();
        resolved_base_links.insert(base, found.clone());
        return Ok(found);
    }
    // Create the missing target page inside this chunk's tx, then stamp its
    // `space` ref (mirrors the importing page), so the new page is a
    // first-class member of the import's space.
    let (new_page, new_page_op) = create_block_in_tx(
        &mut *tx,
        ctx.materializer.loro_state(),
        ctx.device_id,
        "page".into(),
        base.clone(),
        None,
        None,
        // #2849 PR2: server-generated id.
        None,
    )
    .await?;
    tx.enqueue_background(new_page_op);
    let new_page_id = new_page.id.clone().into_string();
    stamp_space_property(
        tx,
        ctx.materializer,
        ctx.device_id,
        new_page_id.clone(),
        ctx.space_id,
    )
    .await?;
    ctx.created.push(new_page);
    resolved_base_links.insert(base, new_page_id.clone());
    Ok(new_page_id)
}

/// Resolve every collected wiki-link token against the pre-loop snapshot,
/// creating missing target pages in this chunk's transaction.
///
/// #1282 — a token may carry a `#…` sub-anchor (`[[Page#Heading]]`,
/// `[[Page#^blockId]]`) addressing a heading/block INSIDE the target page. A
/// page titled with the whole token wins first (#5160 D10: `[[C# Notes]]` is
/// that page, not `C`). Otherwise only the BASE page is resolved: the returned
/// map stays keyed on the ORIGINAL full token (so the rewrite still matches
/// `[[Page#Heading]]` and swaps in `[[<ULID>]]`). A sub-anchor that points
/// INTO the document being imported is deferred instead (see
/// [`DeferredAnchor`]); one into another page links the block it names there,
/// else the page (see [`link_cross_page_anchors`]).
async fn resolve_link_names(
    ctx: &mut NameCtx<'_>,
    mut tx: CommandTx,
    link_names: Vec<String>,
    link_matches: &LinkMatches,
) -> Result<(CommandTx, InboundLinks), AppError> {
    let file_page = ctx.file_page;
    let mut links = InboundLinks::default();
    let mut resolved_base_links: HashMap<String, String> = HashMap::new();
    let mut cross_page = Vec::new();
    for name in link_names {
        let (base, anchor) = split_wikilink_anchor(&name);
        // #2510 — the `^block-id` sub-anchor id, when this is an Obsidian
        // BLOCK anchor (as opposed to a heading anchor).
        let block_anchor_id = anchor.and_then(obsidian_block_anchor_id);
        if let Some(anchor) = anchor
            && base.is_empty()
        {
            // An anchor-only link (`[[#^blockId]]` / `[[#Heading]]`): the
            // implicit target page IS the page being imported. On an
            // UNRESOLVED heading the deferred pass restores #1282's "no page
            // target" literal behaviour (`empty_base = true`).
            let deferred = deferred_anchor(anchor, block_anchor_id, true);
            links.defer_anchor(name, deferred);
            continue;
        }
        // #5160 D10 — a page titled with the whole token wins.
        if anchor.is_some()
            && let Some(id) = link_matches.find(name.trim())
        {
            links.remember_title(id, link_matches, name.trim());
            links.page_links.ids.insert(name, id.to_owned());
            continue;
        }
        let resolved_ulid = resolve_or_create_link_target(
            ctx,
            &mut tx,
            base.to_string(),
            link_matches,
            &mut resolved_base_links,
        )
        .await?;
        links.remember_title(&resolved_ulid, link_matches, base);

        if let Some(anchor) = anchor
            && file_page == Some(resolved_ulid.as_str())
        {
            // An explicit self-title anchor (`[[SelfTitle#^blockId]]` /
            // `[[SelfTitle#Heading]]`): same-document, so defer it exactly like
            // the anchor-only case. An unresolved heading falls back to a page
            // link + the aggregate dropped-anchor warning (`empty_base =
            // false`), matching #1282's existing self/page-base behaviour.
            let deferred = deferred_anchor(anchor, block_anchor_id, false);
            links.defer_anchor(name, deferred);
            continue;
        }

        if let Some(anchor) = anchor {
            cross_page.push(CrossPageAnchor {
                anchor: anchor.to_string(),
                name,
                page_id: resolved_ulid,
            });
            continue;
        }
        links.page_links.ids.insert(name, resolved_ulid);
    }
    link_cross_page_anchors(
        &mut tx,
        &mut links.page_links,
        cross_page,
        ctx.defer_anchors,
        ctx.warnings,
    )
    .await?;
    Ok((tx, links))
}

/// #1446 Part B / #1921 — resolve inbound `[[Page Name]]` wiki-links to internal
/// `[[ULID]]` refs (create-if-missing), returning the transaction, the
/// resolved-link map used by the block loop, and the deferred same-document
/// block/heading-anchor maps resolved in the post-commit anchor phase.
///
/// This is a PRE-PASS over the whole parsed document so each distinct name is
/// resolved/created exactly once (a name cited by N blocks creates at most one
/// page), and so the created pages share the FIRST chunk's atomic write
/// alongside the importing page itself (before the block loop opens a new
/// chunk).
///
/// Resolution is [`LinkMatches::find`]'s rule (#5160 N4), scoped to the name
/// context's space: the title under `name_key`, else an alias, else the page is
/// created; where several pages hold the name, the lowest id does (#6278).
///
/// A name we cannot resolve or create is simply absent from the map, so the
/// rewrite leaves its original `[[Name]]` token untouched — nothing is lost.
pub(super) async fn resolve_inbound_page_links(
    ctx: &mut NameCtx<'_>,
    tx: CommandTx,
    blocks: &[import::ParsedBlock],
) -> Result<(CommandTx, InboundLinks), AppError> {
    // #2968 — also resolve/create the PAGE names referenced by structured
    // `{{query v2n:…}}` inline queries, so a query's page/structural refs remap
    // to this vault's page ids (create-if-missing) on re-import, exactly like an
    // inbound `[[Page]]` link.
    let query_names = super::inline_query_md::query_page_names(blocks);
    resolve_page_refs(
        ctx,
        tx,
        collect_inbound_page_link_bodies(blocks),
        query_names,
    )
    .await
}

/// Resolve wiki-link `bodies` and inline-query page `names` against one
/// snapshot of the pages they may name: each body reads by [`read_link_body`]
/// (#5160 D10), and the names read and `names` resolve by
/// [`resolve_link_names`], so only a name no page matches is created. A label
/// on a link that became a block ref is dropped, counted for the caller to
/// warn of.
pub(super) async fn resolve_page_refs(
    ctx: &mut NameCtx<'_>,
    mut tx: CommandTx,
    bodies: Vec<String>,
    names: Vec<String>,
) -> Result<(CommandTx, InboundLinks), AppError> {
    let lookup: Vec<String> = bodies.iter().chain(&names).cloned().collect();
    let matches = snapshot_page_link_matches(&mut tx, ctx.space_id, &lookup).await?;
    let mut readings = HashMap::new();
    let mut read_names = std::collections::BTreeSet::new();
    for body in bodies {
        let (name, label) = read_link_body(&body, &matches);
        if name.is_empty() {
            continue;
        }
        read_names.insert(name.to_string());
        let reading = (name.to_string(), label.map(str::to_string));
        readings.insert(body, reading);
    }
    let names = read_names.into_iter().chain(names).collect();
    let (tx, mut links) = resolve_link_names(ctx, tx, names, &matches).await?;
    links.dropped_labels = readings
        .values()
        .filter(|(name, label)| label.is_some() && links.page_links.blocks.contains_key(name))
        .count();
    links.page_links.readings = readings;
    Ok((tx, links))
}

/// Warn of `n` link labels dropped with links that became block refs, which
/// carry no label (#5160 D9), when there are any.
pub(super) fn warn_dropped_labels(warnings: &mut Vec<String>, n: usize) {
    if n > 0 {
        warnings.push(format!(
            "{n} link label(s) were dropped: a block reference carries no label"
        ));
    }
}

/// #1990 — snapshot the in-space live tag blocks ONCE, indexed by normalized
/// name → smallest-id winner, instead of re-scanning every in-space tag per
/// token. The resolve pass only CREATES tags (never mutates existing tag
/// content), so a single pre-loop snapshot stays valid; within-pass creations
/// are tracked by the caller. SQLite cannot apply `normalize_tag_name`
/// (NFC → Unicode lowercase → NFC) and NOCASE folds only ASCII A–Z, so we fold
/// in Rust here to catch every case-variant the Loro engine (which keys by
/// `normalize_tag_name`) already merges. Tag count is bounded by the user's
/// vocabulary, so the snapshot is cheap. Its readers: the inbound resolve pass
/// (`resolve_tag_names`), the page buffer render (`load_name_snapshot`) and
/// the MCP name lookup (`match_tag_names`).
pub(crate) async fn snapshot_tags_by_norm(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
) -> Result<HashMap<String, String>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT id, content FROM blocks
               WHERE block_type = 'tag'
                 AND deleted_at IS NULL
                 AND content IS NOT NULL
                 AND space_id = ?1
               ORDER BY id ASC"#,
        space_id,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut map: HashMap<String, String> = HashMap::new();
    for r in rows {
        if let Some(c) = r.content {
            // `or_insert` keeps the FIRST (smallest-id, since ORDER BY id
            // ASC) row per normalized name — the tags-cache winner.
            map.entry(agaric_core::tag_norm::normalize_tag_name(&c))
                .or_insert(r.id);
        }
    }
    Ok(map)
}

/// The spelling an inbound tag `token` (`#[[multi word]]`, a front-matter
/// item) is stored under (#6278 I4): as written when the space already holds
/// that name, as a tag named before the rule may; else with each whitespace
/// run a `-`, named in `warnings`, since a new tag name holds none.
pub(super) fn inbound_tag_spelling(
    token: &str,
    existing: &HashMap<String, String>,
    warnings: &mut Vec<String>,
) -> String {
    if existing.contains_key(&agaric_core::tag_norm::normalize_tag_name(token)) {
        return token.to_owned();
    }
    let dashed = token.split_whitespace().collect::<Vec<_>>().join("-");
    if dashed != token {
        warnings.push(format!(
            "tag '{token}' was read as '{dashed}': a tag name holds no whitespace"
        ));
    }
    dashed
}

/// The resolved tag state [`resolve_tag_names`] returns with the
/// transaction: by normalised name, by token, and the pre-pass snapshot.
type ResolvedTags = (
    CommandTx,
    HashMap<String, String>,
    HashMap<String, String>,
    HashMap<String, String>,
);

/// #1924 / #1950 — resolve inbound inline tags (`#tag`, `#[[Tag With Space]]`)
/// to `#[ULID]` refs (resolve-or-create), returning the transaction plus the
/// per-pass tag state reused by the block loop and the frontmatter-tag pass.
pub(super) async fn resolve_inbound_tags(
    ctx: &mut NameCtx<'_>,
    tx: CommandTx,
    blocks: &[import::ParsedBlock],
) -> Result<ResolvedTags, AppError> {
    // #2968 — also resolve/create the TAG names referenced by structured
    // `{{query v2n:…}}` inline queries so a query's tag refs remap to this
    // vault's tag ids (create-if-missing) on re-import, exactly like an inbound
    // `#tag`.
    let tag_token_names: Vec<String> = collect_inbound_tag_names(blocks)
        .into_iter()
        .chain(super::inline_query_md::query_tag_names(blocks))
        .collect();
    resolve_tag_names(ctx, tx, tag_token_names).await
}

/// [`resolve_inbound_tags`] for names already collected.
pub(super) async fn resolve_tag_names(
    ctx: &mut NameCtx<'_>,
    mut tx: CommandTx,
    tag_token_names: Vec<String>,
) -> Result<ResolvedTags, AppError> {
    let materializer = ctx.materializer;
    let device_id = ctx.device_id;
    let space_id = ctx.space_id;
    // #1924 / #1950 — resolve inbound inline tags (`#tag` and `#[[Tag With
    // Space]]`) to internal `#[ULID]` refs, creating any missing tag block
    // (resolve-or-create). This mirrors the wiki-link pre-pass above: resolve a
    // tag by its NORMALIZED name
    // (`tag_norm::normalize_tag_name` — the engine's tag identity key) else
    // create a new `block_type='tag'` block whose content is the display name
    // (each whitespace run a `-`, #6278 I4), and return its ULID. NO explicit
    // `block_tags` association is written:
    // typing/pasting `#tag` in the editor creates an INLINE ref (materialized
    // into `block_tag_refs` from the `#[ULID]` content by the `CreateBlock`
    // dispatch's `ReindexBlockTagRefs` task — identical to how `[[ULID]]` page
    // links materialize `block_links`), not a `block_tags` row.
    //
    // The pre-pass runs in this (first) chunk's tx so created tags share its
    // atomic write. `resolved_tag_norm` keys on the normalized name so `#Foo`
    // and `#foo` converge to ONE tag; `resolved_tag_tokens` keys on the
    // ORIGINAL token name so the per-block rewrite can map each literal token
    // back to its ULID. A creation failure degrades gracefully: the token is
    // absent from `resolved_tag_tokens`, so the rewrite leaves it literal and a
    // warning is recorded (mirroring the page-link degrade behavior).
    //
    // FRONTMATTER `tags:` is intentionally NOT processed here — converting a
    // frontmatter `tags:` array into tag links is blocked on #1917 typed arrays
    // and is out of scope for #1924/#1950.
    let mut resolved_tag_norm: HashMap<String, String> = HashMap::new();
    let mut resolved_tag_tokens: HashMap<String, String> = HashMap::new();
    let existing_tag_by_norm = snapshot_tags_by_norm(&mut tx, space_id).await?;
    for token_name in tag_token_names {
        let name = inbound_tag_spelling(&token_name, &existing_tag_by_norm, ctx.warnings);
        let norm = agaric_core::tag_norm::normalize_tag_name(&name);

        // Already resolved/created in this pass (case/dedup convergence).
        if let Some(ulid) = resolved_tag_norm.get(&norm) {
            resolved_tag_tokens.insert(token_name, ulid.clone());
            continue;
        }

        // Reuse an EXISTING in-space tag whose normalized name matches, from the
        // pre-loop snapshot (smallest-id winner, mirroring the tags-cache). Tags
        // are space-scoped: a same-name tag in ANOTHER space must NOT be reused —
        // the cross-space gate in `reindex_block_tag_refs` would then drop the
        // inline `#[ULID]` ref and silently fail to attach — so the snapshot is
        // already filtered to `space_id`, and a new in-space tag is created
        // below when there is no match.
        if let Some(id) = existing_tag_by_norm.get(&norm) {
            resolved_tag_norm.insert(norm, id.clone());
            resolved_tag_tokens.insert(token_name, id.clone());
            continue;
        }

        // Create the missing tag block inside this chunk's tx. On failure,
        // degrade: warn and leave the token literal (it is simply absent from
        // `resolved_tag_tokens`).
        match create_block_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            "tag".into(),
            name,
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
                    &mut tx,
                    materializer,
                    device_id,
                    new_tag_id.clone(),
                    space_id,
                )
                .await?;
                ctx.created.push(new_tag);
                resolved_tag_norm.insert(norm, new_tag_id.clone());
                resolved_tag_tokens.insert(token_name, new_tag_id);
            }
            Err(e) => {
                tracing::warn!(
                    name = %token_name,
                    error = %e,
                    "import: tag create failed; leaving token as plain text (#1924)"
                );
                ctx.warnings.push(format!(
                    "tag '#{token_name}' could not be created; left as plain text"
                ));
            }
        }
    }
    Ok((
        tx,
        resolved_tag_norm,
        resolved_tag_tokens,
        existing_tag_by_norm,
    ))
}
