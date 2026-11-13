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
//!
//! #6525 added a second population: a block created here under a peer's page
//! while this device's engine lacked that page (a sync import the process did
//! not live to save) was applied to SQL only, and nothing replays it.
//!
//! Only blocks this device created are hydrated. A peer's block the engine
//! lacks arrives through sync; seeded from SQL it would be a second node,
//! under this device's peer id, beside the peer's own.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use agaric_core::error::AppError;
use agaric_core::ulid::BlockId;
use agaric_store::space::SpaceId;

use crate::apply::loro_apply::{SeedRank, hydrate_page_subtree_into_engine};
use crate::loro::shared::LoroState;

/// A live block its space's engine does not hold.
struct Missing {
    space_id: String,
    block_id: String,
    page_id: String,
}

/// Hydrate every live block this device created whose space's engine does
/// not hold it, under the parent SQL shows. A block's space is
/// `resolve_block_space`'s; a space with no engine is skipped, as no doc is
/// expected to hold its blocks. Returns how many blocks it hydrated.
///
/// A block whose parent the engine lacks stays out: its parent is a peer's
/// block still to arrive, and without it the node would sit at the doc's root.
///
/// A block in `sync_deferred_purges` is skipped: a sync import took it out
/// of its doc and the next pull's sweep decides it (#5712). Boot replays the
/// sync inbox before this runs, so a crashed import's tombstone can be there.
pub async fn hydrate_engine_missing_blocks(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<usize, AppError> {
    let missing = missing_live_blocks(tx, state, device_id).await?;
    let missing = with_a_local_create_op(tx, missing).await?;
    let only: HashSet<String> = missing.iter().map(|m| m.block_id.clone()).collect();
    let pages: BTreeSet<(&str, &str)> = missing
        .iter()
        .map(|m| (m.space_id.as_str(), m.page_id.as_str()))
        .collect();
    for (space_id, page_id) in pages {
        hydrate_page_subtree_into_engine(
            tx,
            state,
            device_id,
            &BlockId::from_trusted(page_id),
            &SpaceId::from_trusted(space_id),
            SeedRank::Sql { only: &only },
            None,
        )
        .await?;
    }

    let mut hydrated = 0;
    for m in &missing {
        let space = SpaceId::from_trusted(&m.space_id);
        let mut guard = state.registry.for_space(&space, device_id)?;
        if guard.engine_mut().contains_block(&m.block_id) {
            hydrated += 1;
        }
    }
    if hydrated < missing.len() {
        tracing::warn!(
            left = missing.len() - hydrated,
            "engine hydration left blocks whose parent the engine lacks (#6525)"
        );
    }
    Ok(hydrated)
}

async fn missing_live_blocks(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    state: &LoroState,
    device_id: &str,
) -> Result<Vec<Missing>, AppError> {
    let rows = sqlx::query!(
        r#"SELECT b.id AS "id!: String",
                  COALESCE(b.page_id, b.id) AS "page_id!: String",
                  COALESCE(b.space_id, p.space_id) AS "space_id!: String"
           FROM blocks b
           LEFT JOIN blocks p ON p.id = b.page_id AND p.deleted_at IS NULL
           WHERE b.deleted_at IS NULL
             AND COALESCE(b.space_id, p.space_id) IS NOT NULL
             AND b.id NOT IN (SELECT block_id FROM sync_deferred_purges)"#,
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
    let mut missing = Vec::new();
    for (space_id, blocks) in by_space {
        let space = SpaceId::from_trusted(&space_id);
        if !installed.contains(&space) {
            continue;
        }
        let mut guard = state.registry.for_space(&space, device_id)?;
        let engine = guard.engine_mut();
        for (block_id, page_id) in blocks {
            if !engine.contains_block(&block_id) {
                missing.push(Missing {
                    space_id: space_id.clone(),
                    block_id,
                    page_id,
                });
            }
        }
    }
    Ok(missing)
}

/// The blocks of `missing` with a `create_block` op this device authored.
async fn with_a_local_create_op(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    mut missing: Vec<Missing>,
) -> Result<Vec<Missing>, AppError> {
    if missing.is_empty() {
        return Ok(missing);
    }
    let ids = serde_json::to_string(&missing.iter().map(|m| &m.block_id).collect::<Vec<_>>())?;
    let local: HashSet<String> = sqlx::query_scalar!(
        r#"SELECT block_id AS "block_id!: String" FROM op_log
           WHERE op_type = 'create_block' AND is_replicated = 0
             AND block_id IN (SELECT value FROM json_each(?))"#,
        ids,
    )
    .fetch_all(&mut **tx)
    .await?
    .into_iter()
    .collect();
    missing.retain(|m| local.contains(&m.block_id));
    Ok(missing)
}
