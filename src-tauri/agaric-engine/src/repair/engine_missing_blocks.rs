//! Repair 5 (#5670) — live blocks their space's Loro engine does not hold.
//!
//! A pre-#5418 boot replayed the last session onto engines that already held
//! it, and before #5630 that replay could leave a block's engine node under a
//! parent SQL had moved it out of. Purging that parent then took the node
//! with it, while SQL kept the block live: it reaches no peer, and an
//! engine-first recovery loses it.
//!
//! The op log already holds every op of such a block, and no new op can
//! reach the engine: a `CreateBlock` collides with the row and a `MoveBlock`
//! finds no node to move. So the repair is engine hydration from the block's
//! rows, the shape #4775 seeds a space block with
//! ([`crate::apply::loro_apply::hydrate_space_block_into_own_engine`]): no
//! op, and no SQL write beyond the dense positions the seed reprojects.

use std::collections::{BTreeMap, BTreeSet};

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::space::SpaceId;

use crate::apply::loro_apply::hydrate_page_subtree_into_engine;
use crate::loro::shared::LoroState;

/// Hydrate every live block whose space's engine does not hold it, by
/// re-seeding its page's group (the seed skips the nodes the engine holds).
/// A block's space is `resolve_block_space`'s; a space with no engine is
/// skipped, as no doc is expected to hold its blocks. Returns how many
/// blocks were missing.
pub async fn hydrate_engine_missing_blocks(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<usize, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!: String",
                  COALESCE(b.page_id, b.id) AS "page_id!: String",
                  COALESCE(b.space_id, p.space_id) AS "space_id!: String"
           FROM blocks b
           LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
           WHERE b.deleted_at IS NULL
             AND COALESCE(b.space_id, p.space_id) IS NOT NULL"#,
    )
    .fetch_all(&mut **tx)
    .await?;
    let mut by_space: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for row in rows {
        by_space
            .entry(row.space_id)
            .or_default()
            .push((row.id, row.page_id));
    }

    let installed = state.registry.space_ids();
    let mut missing = 0;
    let mut pages: BTreeSet<(String, String)> = BTreeSet::new();
    for (space_id, blocks) in by_space {
        let space = SpaceId::from_trusted(&space_id);
        if !installed.contains(&space) {
            continue;
        }
        let mut guard = state.registry.for_space(&space, device_id)?;
        let engine = guard.engine_mut();
        for (block_id, page_id) in blocks {
            if !engine.contains_block(&block_id) {
                missing += 1;
                pages.insert((space_id.clone(), page_id));
            }
        }
    }

    for (space_id, page_id) in &pages {
        hydrate_page_subtree_into_engine(
            tx,
            state,
            device_id,
            &BlockId::from_trusted(page_id),
            &SpaceId::from_trusted(space_id),
        )
        .await?;
    }
    Ok(missing)
}
