//! Pages command handlers.

use std::collections::HashMap;

use sqlx::SqlitePool;
use tracing::instrument;

use tauri::State;

use crate::db::{ReadPool, WritePool};
use crate::device::DeviceId;
use crate::error::AppError;
use crate::import;
use crate::import::ImportResult;
use crate::materializer::Materializer;
use crate::op_log;

use super::*;

/// Replace the full set of aliases for a page. Returns the aliases that were
/// actually inserted (empty/whitespace-only entries are skipped; duplicates
/// across different pages are silently ignored via INSERT OR IGNORE).
#[instrument(skip(pool, aliases), err)]
pub async fn set_page_aliases_inner(
    pool: &SqlitePool,
    page_id: &str,
    aliases: Vec<String>,
) -> Result<Vec<String>, AppError> {
    // Verify page exists and is a page type
    let exists: bool = sqlx::query_scalar(
        "SELECT COUNT(*) > 0 FROM blocks WHERE id = ?1 AND block_type = 'page' AND deleted_at IS NULL",
    )
    .bind(page_id)
    .fetch_one(pool)
    .await?;

    if !exists {
        return Err(AppError::NotFound("page not found".into()));
    }

    // Delete existing aliases
    sqlx::query("DELETE FROM page_aliases WHERE page_id = ?1")
        .bind(page_id)
        .execute(pool)
        .await?;

    // Insert new aliases (skip empty, trim whitespace, deduplicate)
    let mut inserted = Vec::new();
    for alias in aliases {
        let trimmed = alias.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        // INSERT OR IGNORE handles duplicate alias across different pages
        let result =
            sqlx::query("INSERT OR IGNORE INTO page_aliases (page_id, alias) VALUES (?1, ?2)")
                .bind(page_id)
                .bind(&trimmed)
                .execute(pool)
                .await?;
        if result.rows_affected() > 0 {
            inserted.push(trimmed);
        }
    }

    Ok(inserted)
}

/// Return all aliases for a page, sorted alphabetically.
#[instrument(skip(pool), err)]
pub async fn get_page_aliases_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<Vec<String>, AppError> {
    let aliases: Vec<String> =
        sqlx::query_scalar("SELECT alias FROM page_aliases WHERE page_id = ?1 ORDER BY alias")
            .bind(page_id)
            .fetch_all(pool)
            .await?;
    Ok(aliases)
}

/// Look up a page by one of its aliases. Returns `(page_id, title)` if found.
#[instrument(skip(pool), err)]
pub async fn resolve_page_by_alias_inner(
    pool: &SqlitePool,
    alias: &str,
) -> Result<Option<(String, Option<String>)>, AppError> {
    let result: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT pa.page_id, b.content \
         FROM page_aliases pa \
         JOIN blocks b ON b.id = pa.page_id \
         WHERE pa.alias = ?1 COLLATE NOCASE \
           AND b.deleted_at IS NULL",
    )
    .bind(alias)
    .fetch_optional(pool)
    .await?;
    Ok(result)
}

/// Replace `#[ULID]` with `#tagname` and `[[ULID]]` with `[[Page Title]]`
/// in content, preserving all other markdown formatting.
fn resolve_ulids_for_export(
    content: &str,
    tag_names: &HashMap<String, String>,
    page_titles: &HashMap<String, String>,
) -> String {
    use crate::fts::{PAGE_LINK_RE, TAG_REF_RE};

    // Replace #[ULID] → #tagname
    let result = TAG_REF_RE
        .replace_all(content, |caps: &regex::Captures| {
            let ulid = &caps[1];
            if let Some(name) = tag_names.get(ulid) {
                format!("#{name}")
            } else {
                format!("#[{ulid}]") // Keep original if not found
            }
        })
        .into_owned();

    // Replace [[ULID]] → [[Page Title]]
    let result = PAGE_LINK_RE
        .replace_all(&result, |caps: &regex::Captures| {
            let ulid = &caps[1];
            if let Some(title) = page_titles.get(ulid) {
                format!("[[{title}]]")
            } else {
                format!("[[{ulid}]]") // Keep original if not found
            }
        })
        .into_owned();

    result
}

/// Export a page and its child blocks as a Markdown string with
/// human-readable tag/page references and optional YAML frontmatter.
///
/// 1. Emits `# Page Title`
/// 2. If the page has properties, emits a `---` YAML frontmatter block
/// 3. For each child block (ordered by position), resolves `#[ULID]` and
///    `[[ULID]]` references to their human-readable names, preserving all
///    markdown formatting.
///
/// # Errors
///
/// - [`AppError::Validation`] — `page_id` does not refer to a `page` block
/// - [`AppError::NotFound`] — block not found
#[instrument(skip(pool), err)]
pub async fn export_page_markdown_inner(
    pool: &SqlitePool,
    page_id: &str,
) -> Result<String, AppError> {
    // 1. Get the page
    let page = get_block_inner(pool, page_id.to_string()).await?;
    if page.block_type != "page" {
        return Err(AppError::Validation("not a page".into()));
    }

    // 2. Get all child blocks (ordered by position)
    let children = pagination::list_children(
        pool,
        Some(page_id),
        &pagination::PageRequest::new(None, Some(1000))?,
    )
    .await?;

    // 3. Get all tag names and page titles for ULID replacement
    let tag_rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, content FROM blocks WHERE block_type = 'tag' AND deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    let tag_names: HashMap<String, String> = tag_rows
        .into_iter()
        .filter_map(|(id, content)| content.map(|c| (id, c)))
        .collect();

    let page_rows = sqlx::query_as::<_, (String, Option<String>)>(
        "SELECT id, content FROM blocks WHERE block_type = 'page' AND deleted_at IS NULL",
    )
    .fetch_all(pool)
    .await?;
    let page_titles: HashMap<String, String> = page_rows
        .into_iter()
        .map(|(id, content)| (id, content.unwrap_or_else(|| "Untitled".to_string())))
        .collect();

    // 4. Get page properties for frontmatter
    let properties: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT key, value_text, value_date FROM block_properties WHERE block_id = ?1",
    )
    .bind(page_id)
    .fetch_all(pool)
    .await?;

    // 5. Build markdown output
    let mut output = String::new();

    // Title
    let title = page.content.unwrap_or_else(|| "Untitled".to_string());
    output.push_str(&format!("# {title}\n\n"));

    // Frontmatter (if properties exist)
    if !properties.is_empty() {
        output.push_str("---\n");
        for (key, text, date) in &properties {
            let value = date.as_deref().or(text.as_deref()).unwrap_or("");
            output.push_str(&format!("{key}: {value}\n"));
        }
        output.push_str("---\n\n");
    }

    // Block content
    for block in &children.items {
        let content = block.content.as_deref().unwrap_or("");
        let resolved = resolve_ulids_for_export(content, &tag_names, &page_titles);
        output.push_str(&resolved);
        output.push('\n');
    }

    Ok(output)
}

/// Import a Logseq-style markdown file as a page with block hierarchy.
///
/// Creates a page from the filename (or first heading), then creates
/// blocks following the indentation hierarchy. Properties are set via
/// SetProperty ops. Returns import statistics.
#[instrument(skip(pool, device_id, materializer, content), err)]
pub async fn import_markdown_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
    filename: Option<String>,
) -> Result<ImportResult, AppError> {
    let parsed = import::parse_logseq_markdown(&content);

    // Derive page title from filename (strip .md extension)
    let page_title = filename
        .map(|f| f.trim_end_matches(".md").to_string())
        .unwrap_or_else(|| "Imported Page".to_string());

    // --- Single IMMEDIATE transaction for entire import ---
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let mut op_records: Vec<op_log::OpRecord> = Vec::new();

    // Create the page inside the transaction
    let (page, page_op) = create_block_in_tx(
        &mut tx,
        device_id,
        "page".into(),
        page_title.clone(),
        None,
        None,
    )
    .await?;
    op_records.push(page_op);
    let page_id = page.id.clone();

    let mut blocks_created: i64 = 0;
    let mut properties_set: i64 = 0;
    let mut warnings: Vec<String> = Vec::new();

    // Track parent stack: (depth, block_id)
    let mut parent_stack: Vec<(usize, String)> = vec![(0, page_id.clone())];

    for block in &parsed {
        // Find the correct parent: pop stack until we find a parent at depth < block.depth
        while parent_stack.len() > 1 && parent_stack.last().is_some_and(|(d, _)| *d >= block.depth)
        {
            parent_stack.pop();
        }
        let parent_id = parent_stack
            .last()
            .map(|(_, id)| id.clone())
            .unwrap_or(page_id.clone());

        // Create the block inside the transaction
        match create_block_in_tx(
            &mut tx,
            device_id,
            "content".into(),
            block.content.clone(),
            Some(parent_id.clone()),
            None,
        )
        .await
        {
            Ok((new_block, block_op)) => {
                blocks_created += 1;
                op_records.push(block_op);
                parent_stack.push((block.depth, new_block.id.clone()));

                // Set properties inside the same transaction
                for (key, value) in &block.properties {
                    match set_property_in_tx(
                        &mut tx,
                        device_id,
                        new_block.id.clone(),
                        key,
                        Some(value.clone()),
                        None,
                        None,
                        None,
                    )
                    .await
                    {
                        Ok((_block, prop_op)) => {
                            properties_set += 1;
                            op_records.push(prop_op);
                        }
                        Err(e) => warnings.push(format!("Property '{key}' on block failed: {e}")),
                    }
                }
            }
            Err(e) => {
                warnings.push(format!("Block creation failed: {e}"));
            }
        }
    }

    // Commit the single transaction
    tx.commit().await?;

    // Dispatch materializer tasks after commit
    for op_record in &op_records {
        if let Err(e) = materializer.dispatch_background(op_record) {
            tracing::warn!(error = %e, "import_markdown: failed to dispatch background task");
        }
    }

    Ok(ImportResult {
        page_title,
        blocks_created,
        properties_set,
        warnings,
    })
}

/// List all links between pages (for graph view).
///
/// Returns edges where both source and target are non-deleted page blocks.
/// Block-level links (where source is a content block) are rolled up to
/// their parent page.
#[instrument(skip(pool), err)]
pub async fn list_page_links_inner(pool: &SqlitePool) -> Result<Vec<PageLink>, AppError> {
    // For each block_link, find the parent page of the source block.
    // The target in block_links is already a page (since [[links]] point to pages).
    // The source might be a content block under a page — we need the page ancestor.
    //
    // Simple approach: join source_id to blocks to get parent_id (the page),
    // then filter both sides to be page-type blocks that aren't deleted.
    //
    // P-15 optimized: JOIN tb first (smaller page-only set via idx_blocks_page_alive),
    // move LEFT JOIN conditions inline so pb.id IS NOT NULL replaces the WHERE filter.
    let links = sqlx::query_as::<_, PageLink>(
        "SELECT
            COALESCE(sb.parent_id, bl.source_id) AS source_id,
            bl.target_id AS target_id,
            COUNT(*) AS ref_count
         FROM block_links bl
         JOIN blocks tb ON tb.id = bl.target_id
             AND tb.block_type = 'page'
             AND tb.deleted_at IS NULL
             AND tb.is_conflict = 0
         JOIN blocks sb ON sb.id = bl.source_id
             AND sb.deleted_at IS NULL
             AND sb.is_conflict = 0
         LEFT JOIN blocks pb ON pb.id = sb.parent_id
             AND pb.deleted_at IS NULL
             AND pb.block_type = 'page'
             AND pb.is_conflict = 0
         WHERE COALESCE(sb.parent_id, bl.source_id) != bl.target_id
             AND (sb.parent_id IS NULL OR pb.id IS NOT NULL)
         GROUP BY 1, 2",
    )
    .fetch_all(pool)
    .await?;

    Ok(links)
}

/// Tauri command: set page aliases. Delegates to [`set_page_aliases_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn set_page_aliases(
    write_pool: State<'_, WritePool>,
    page_id: String,
    aliases: Vec<String>,
) -> Result<Vec<String>, AppError> {
    set_page_aliases_inner(&write_pool.0, &page_id, aliases)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: get page aliases. Delegates to [`get_page_aliases_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn get_page_aliases(
    read_pool: State<'_, ReadPool>,
    page_id: String,
) -> Result<Vec<String>, AppError> {
    get_page_aliases_inner(&read_pool.0, &page_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: resolve a page by alias. Delegates to [`resolve_page_by_alias_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn resolve_page_by_alias(
    read_pool: State<'_, ReadPool>,
    alias: String,
) -> Result<Option<(String, Option<String>)>, AppError> {
    resolve_page_by_alias_inner(&read_pool.0, &alias)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: export a page as Markdown. Delegates to [`export_page_markdown_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn export_page_markdown(
    read_pool: State<'_, ReadPool>,
    page_id: String,
) -> Result<String, AppError> {
    export_page_markdown_inner(&read_pool.0, &page_id)
        .await
        .map_err(sanitize_internal_error)
}

/// Tauri command: import a Logseq-style markdown file as a page with
/// block hierarchy. Delegates to [`import_markdown_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn import_markdown(
    content: String,
    filename: Option<String>,
    pool: State<'_, WritePool>,
    device_id: State<'_, DeviceId>,
    materializer: State<'_, Materializer>,
) -> Result<ImportResult, AppError> {
    import_markdown_inner(
        &pool.0,
        device_id.as_str(),
        &materializer,
        content,
        filename,
    )
    .await
    .map_err(sanitize_internal_error)
}

/// Tauri command: list all page-to-page links for graph visualization.
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_links(pool: State<'_, ReadPool>) -> Result<Vec<PageLink>, AppError> {
    list_page_links_inner(&pool.0)
        .await
        .map_err(sanitize_internal_error)
}
