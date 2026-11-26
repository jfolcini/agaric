//! A tag's page (#6755): tag `x` of a space is paired with the page titled
//! `Tag/x` of that space, by that title alone ([`tag_page_title`]). A page
//! under `Tag/` is made by its tag ([`create_tag_page_inner`]), or with it by
//! a `[[Tag/x]]` link or an import ([`create_tag_page_titled_inner`]), and a tag and
//! its page are renamed together (`tag_path_rename`) and reverted together
//! (`with_tag_path_partners`); a page that was there before the rule, or
//! whose tag is gone, is an ordinary page.

use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use agaric_core::error::{AppError, ValidationCode};
use agaric_core::tag_norm::{name_key, tag_of_page_title, tag_page_title};
use agaric_core::ulid::BlockId;
use agaric_store::op::OpRef;
use agaric_store::pagination::BlockRow;
use agaric_store::space::SpaceId;

use super::blocks::crud::{create_tag_in_space_in_tx, space_tag_names};
use super::spaces::{
    PageNameHolder, create_page_in_space_in_tx, find_live_page_by_name, reserved_tag_page_title,
};
use super::{get_active_block_inner, sanitize_internal_error};
use crate::db::{CommandTx, WriteCtx};
use crate::materializer::Materializer;

/// The page of the live tag `tag_id`, titled `Tag/<its name>` in the tag's
/// space: the page already holding that title, or a new one.
///
/// # Errors
///
/// - [`AppError::NotFound`] — `tag_id` is no live tag of a space.
/// - [`AppError::Validation`] coded [`ValidationCode::DuplicatePageTitle`] —
///   another page of the space holds the title as an alias.
#[instrument(skip(pool, device_id, materializer), err(level = "info"))]
pub async fn create_tag_page_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    tag_id: BlockId,
) -> Result<BlockRow, AppError> {
    let tag_id = tag_id.into_string();
    let mut tx = CommandTx::begin_immediate(pool, "create_tag_page").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let tag = sqlx::query!(
        r#"SELECT content AS "name!", space_id AS "space_id!" FROM blocks
           WHERE id = ?1 AND block_type = 'tag' AND deleted_at IS NULL
             AND content IS NOT NULL AND space_id IS NOT NULL"#,
        tag_id,
    )
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("tag '{tag_id}' (not found or deleted)")))?;
    let page = Box::pin(create_page_in_space_in_tx(
        &mut tx,
        device_id,
        materializer,
        None,
        tag_page_title(&tag.name),
        &tag.space_id,
        None,
    ))
    .await?;
    let page_id = page.commit(tx, materializer).await?;
    get_active_block_inner(pool, page_id).await
}

/// Tauri command: the page a tag's notes are written on, created when the
/// tag has none. Delegates to [`create_tag_page_inner`].
#[tauri::command]
#[specta::specta]
pub async fn create_tag_page(
    ctx: State<'_, WriteCtx>,
    tag_id: BlockId,
) -> Result<BlockRow, AppError> {
    create_tag_page_inner(ctx.pool(), ctx.device_id(), ctx.materializer(), tag_id)
        .await
        .map_err(sanitize_internal_error)
}

/// The page a `[[Tag/x]]` link names where no page holds its title, as the
/// editor makes it (#6755): tag `x` of `space_id` and its page `Tag/x`, each
/// the one the space holds or a new one, in one transaction, named as an
/// import names them (`import_tag_page_title`). A title naming no tag is
/// refused: it is no tag's page.
///
/// # Errors
///
/// - [`AppError::Validation`] coded [`ValidationCode::ReservedTagPageTitle`]
///   — `title` is not under `Tag/`, or is `Tag/` alone.
/// - [`AppError::Validation`] — `space_id` is no live space.
#[instrument(skip(pool, device_id, materializer), err(level = "info"))]
pub async fn create_tag_page_titled_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    title: String,
) -> Result<BlockRow, AppError> {
    if tag_of_page_title(&title).is_none_or(|name| name.trim().is_empty()) {
        return Err(reserved_tag_page_title(&title));
    }
    let mut tx = CommandTx::begin_immediate(pool, "create_tag_page_titled").await?;
    tx.arm_engine_rollback(materializer.loro_state());
    let mut warnings = Vec::new();
    let title = import_tag_page_title(
        &mut tx,
        device_id,
        materializer,
        space_id,
        &title,
        &mut warnings,
    );
    let title = Box::pin(title).await?;
    let page = Box::pin(create_page_in_space_in_tx(
        &mut tx,
        device_id,
        materializer,
        None,
        title,
        space_id,
        None,
    ))
    .await?;
    let page_id = page.commit(tx, materializer).await?;
    get_active_block_inner(pool, page_id).await
}

/// Tauri command: the page a `[[Tag/x]]` link names, with its tag.
/// Delegates to [`create_tag_page_titled_inner`].
#[tauri::command]
#[specta::specta]
pub async fn create_tag_page_titled(
    ctx: State<'_, WriteCtx>,
    space_id: SpaceId,
    title: String,
) -> Result<BlockRow, AppError> {
    space_id.validate_shape()?;
    create_tag_page_titled_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        space_id.as_str(),
        title,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// The tag a page an import makes titled `title` brings in `space_id`, and
/// the title the page then takes ([`import_tag_page_title`]). A name a new
/// tag cannot take, one holding whitespace, is dashed, title included;
/// unless the space has a page of that title or a tag of that name already,
/// both from before the rule, when the title stays and brings no tag
/// (`None`), as a title off the path and `Tag/` alone bring none.
pub(crate) async fn import_tag_page_naming(
    conn: &mut sqlx::SqliteConnection,
    space_id: &str,
    title: &str,
) -> Result<Option<(String, String)>, AppError> {
    let Some(raw) = tag_of_page_title(title) else {
        return Ok(None);
    };
    let name = raw.trim();
    let dashed = name.split_whitespace().collect::<Vec<_>>().join("-");
    if dashed.is_empty() {
        return Ok(None);
    }
    if dashed == name {
        // `Tag/ x` would never be found as tag x's page, which is `Tag/x` by title.
        let title = if raw == name {
            title.to_owned()
        } else {
            tag_page_title(&dashed)
        };
        return Ok(Some((dashed, title)));
    }
    let tag_held = space_tag_names(conn, space_id)
        .await?
        .iter()
        .any(|(_, key)| *key == name_key(name));
    if tag_held
        || find_live_page_by_name(conn, space_id, title, None)
            .await?
            .is_some()
    {
        return Ok(None);
    }
    let retitled = tag_page_title(&dashed);
    Ok(Some((dashed, retitled)))
}

/// The title a page an import makes under `Tag/` takes, once its tag is
/// resolved or made in `space_id` inside `tx` ([`create_tag_in_space_in_tx`]),
/// so the page never lands without its tag. A respelled title
/// ([`import_tag_page_naming`]) is named in `warnings`. Any other title is
/// answered as it is.
pub(crate) async fn import_tag_page_title(
    tx: &mut CommandTx,
    device_id: &str,
    materializer: &Materializer,
    space_id: &str,
    title: &str,
    warnings: &mut Vec<String>,
) -> Result<String, AppError> {
    let Some((name, retitled)) = import_tag_page_naming(tx, space_id, title).await? else {
        return Ok(title.to_owned());
    };
    if retitled != title {
        warnings.push(format!(
            "the page '{title}' was imported as '{retitled}': a tag name holds no whitespace"
        ));
    }
    Box::pin(create_tag_in_space_in_tx(
        tx,
        device_id,
        materializer,
        name,
        None,
        None,
        space_id,
        None,
    ))
    .await?;
    Ok(retitled)
}

/// What renaming the page or tag `block` to `to_text` takes along: a tag and
/// its page are renamed together, so this answers the other one's id and the
/// name it moves to, for the caller to write in the same transaction. A page
/// is refused a title under `Tag/` unless it is a live tag's page, and a live
/// tag's page a title off the path ([`ValidationCode::ReservedTagPageTitle`]);
/// respelling a title is neither. A restore, an incoming op and the name-tie
/// repair do not run it; a revert takes the other half along
/// ([`with_tag_path_partners`]).
pub(crate) async fn tag_path_rename(
    conn: &mut sqlx::SqliteConnection,
    block: &BlockRow,
    to_text: &str,
) -> Result<Option<(String, String)>, AppError> {
    let from = block.content.as_deref().unwrap_or_default();
    match block.block_type.as_str() {
        "page" if name_key(from) != name_key(to_text) => {
            page_rename(conn, block.id.as_str(), from, to_text).await
        }
        "tag" if from != to_text => Ok(tag_page_of(conn, block.id.as_str(), from)
            .await?
            .map(|page_id| (page_id, tag_page_title(to_text)))),
        _ => Ok(None),
    }
}

/// A clash of the name the other half of a rename moves to, which the user
/// resolves on the page or tag holding it (#6755).
pub(crate) fn taken_by_another(err: AppError) -> AppError {
    match err {
        AppError::Validation {
            code: Some(ValidationCode::DuplicatePageTitle),
            message,
        } => AppError::validation_coded(ValidationCode::TagPageTitleTaken, message),
        other => other,
    }
}

async fn space_of(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
) -> Result<Option<String>, AppError> {
    Ok(sqlx::query_scalar!(
        r#"SELECT space_id as "space_id?: String" FROM blocks WHERE id = ?"#,
        block_id
    )
    .fetch_one(&mut *conn)
    .await?)
}

async fn page_rename(
    conn: &mut sqlx::SqliteConnection,
    page_id: &str,
    from: &str,
    to_text: &str,
) -> Result<Option<(String, String)>, AppError> {
    let tag = match tag_of_page_title(from) {
        Some(name) => live_tag_named(conn, page_id, name).await?,
        None => None,
    };
    match (tag, tag_of_page_title(to_text)) {
        (Some(tag_id), Some(name)) if !name.is_empty() => Ok(Some((tag_id, name.to_owned()))),
        (Some(_), _) => Err(reserved_tag_page_title(from)),
        (None, Some(_)) => Err(reserved_tag_page_title(to_text)),
        (None, None) => Ok(None),
    }
}

/// The live tag named `name` in the space of `block_id`.
async fn live_tag_named(
    conn: &mut sqlx::SqliteConnection,
    block_id: &str,
    name: &str,
) -> Result<Option<String>, AppError> {
    let Some(space_id) = space_of(conn, block_id).await? else {
        return Ok(None);
    };
    let key = name_key(name);
    Ok(space_tag_names(conn, &space_id)
        .await?
        .into_iter()
        .find(|(_, held)| *held == key)
        .map(|(tag_id, _)| tag_id))
}

/// The page titled `Tag/<name>` in the space of the tag `tag_id`.
async fn tag_page_of(
    conn: &mut sqlx::SqliteConnection,
    tag_id: &str,
    name: &str,
) -> Result<Option<String>, AppError> {
    let Some(space_id) = space_of(conn, tag_id).await? else {
        return Ok(None);
    };
    let held = find_live_page_by_name(conn, &space_id, &tag_page_title(name), None).await?;
    Ok(match held {
        Some(PageNameHolder::Title(page_id)) => Some(page_id),
        _ => None,
    })
}

/// `ops` with the other half of each tag and page rename among them (#6755):
/// the two `EditBlock`s one rename appends, adjacent on one device, one of a
/// tag and one of the page of its space titled with its path. A revert takes
/// both or neither, whichever half the History view or a page's undo names.
/// Also answers each half of such a pair with the block it renamed.
pub(crate) async fn with_tag_path_partners(
    conn: &mut sqlx::SqliteConnection,
    mut ops: Vec<OpRef>,
) -> Result<(Vec<OpRef>, Vec<(OpRef, BlockId)>), AppError> {
    let refs = serde_json::to_string(
        &ops.iter()
            .map(|r| (r.device_id.as_str(), r.seq))
            .collect::<Vec<_>>(),
    )?;
    let neighbours = sqlx::query!(
        r#"SELECT o.device_id AS "own_device!: String", o.seq AS "own_seq!: i64",
                  ob.id AS "own_block!: String", pb.id AS "partner_block!: String",
                  p.device_id AS "device_id!: String", p.seq AS "seq!: i64",
                  ob.block_type AS "own_type!: String",
                  json_extract(o.payload, '$.to_text') AS "own_text?: String",
                  json_extract(p.payload, '$.to_text') AS "partner_text?: String"
           FROM json_each(?1) je
           JOIN op_log o ON o.device_id = json_extract(je.value, '$[0]')
                        AND o.seq = json_extract(je.value, '$[1]')
           JOIN op_log p ON p.device_id = o.device_id AND p.seq IN (o.seq - 1, o.seq + 1)
           JOIN blocks ob ON ob.id = o.block_id
           JOIN blocks pb ON pb.id = p.block_id
           WHERE o.op_type = 'edit_block' AND p.op_type = 'edit_block'
             AND p.is_undo = o.is_undo
             AND ob.space_id = pb.space_id
             AND ((ob.block_type = 'tag' AND pb.block_type = 'page')
               OR (ob.block_type = 'page' AND pb.block_type = 'tag'))"#,
        refs,
    )
    .fetch_all(&mut *conn)
    .await?;
    let mut halves = Vec::new();
    for n in neighbours {
        let (own, partner) = (
            n.own_text.unwrap_or_default(),
            n.partner_text.unwrap_or_default(),
        );
        let (tag, page) = if n.own_type == "tag" {
            (own, partner)
        } else {
            (partner, own)
        };
        if tag_of_page_title(&page).map(name_key) != Some(name_key(&tag)) {
            continue;
        }
        let own = OpRef {
            device_id: n.own_device,
            seq: n.own_seq,
        };
        let partner = OpRef {
            device_id: n.device_id,
            seq: n.seq,
        };
        if !ops.contains(&partner) {
            ops.push(partner.clone());
        }
        halves.push((own, BlockId::from_trusted(&n.own_block)));
        halves.push((partner, BlockId::from_trusted(&n.partner_block)));
    }
    Ok((ops, halves))
}

/// The tag or page `op` renamed when it is one half of a tag and page rename
/// ([`with_tag_path_partners`]).
pub(crate) async fn paired_rename_of(
    conn: &mut sqlx::SqliteConnection,
    op: &OpRef,
) -> Result<Option<BlockId>, AppError> {
    let (_, halves) = with_tag_path_partners(conn, vec![op.clone()]).await?;
    Ok(halves
        .into_iter()
        .find(|(half, _)| half == op)
        .map(|(_, block)| block))
}
