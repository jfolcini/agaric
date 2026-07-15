//! Bibliography import command (#1454 tier a).
//!
//! `import_bibliography` turns a BibTeX or CSL-JSON file into one reference
//! page per entry, each carrying typed properties (`citation-key`,
//! `reference-type`, `authors`, `year`, `doi`, `url`, `journal`,
//! `abstract`). Parsing is pure and lives in [`crate::bibliography`]; this
//! module owns the transactional apply, mirroring `import_markdown_inner`'s
//! patterns (in-tx space validation, `CommandTx::begin_immediate`, chunked
//! commits, materializer dispatch).
//!
//! Authors-as-ref-pages is a documented follow-up and deliberately NOT in
//! scope here: `authors` is stored as one "; "-joined text property.

use std::collections::{BTreeSet, HashMap, HashSet};

use serde::Serialize;
use specta::Type;
use sqlx::SqlitePool;
use tauri::State;
use tracing::instrument;

use crate::bibliography::{self, BibEntry, BibliographyFormat};
use crate::db::{CommandTx, WriteCtx};
use crate::error::AppError;
use crate::materializer::Materializer;
use crate::space::SpaceId;

use super::super::*;

/// #1454 — number of bibliography entries written into one import chunk
/// before the open transaction is committed (releasing the single SQLite
/// writer lock) and a fresh one is opened. Mirrors the
/// [`super::markdown::IMPORT_CHUNK_BLOCKS`] contract from #662 /
/// docs/architecture/operations.md (#2470): chunking bounds the writer-lock
/// *hold time*, and a chunk boundary only ever falls BETWEEN entries — an
/// entry's page block and all of its property ops always land in the same
/// transaction, so a partially-imported file is always a prefix of whole
/// entries. Entries are tiny (1 block + ≤ 9 property ops), so 200 entries
/// per chunk keeps typical bibliographies single-transaction while bounding
/// pathological multi-thousand-entry files.
///
/// `pub(crate)` so the chunk-boundary test can size a multi-chunk import
/// relative to the threshold instead of hardcoding the number.
pub(crate) const IMPORT_BIB_CHUNK_ENTRIES: usize = 200;

/// The typed property definitions every bibliography import declares
/// upfront (idempotent — `create_property_def_inner` is `INSERT OR
/// IGNORE`, so a user's pre-existing declaration for any of these keys
/// wins and the import coerces values to THAT type instead).
const BIB_PROPERTY_DEFS: &[(&str, &str)] = &[
    ("citation-key", "text"),
    ("reference-type", "text"),
    ("authors", "text"),
    ("year", "number"),
    ("doi", "text"),
    ("url", "text"),
    ("journal", "text"),
    ("abstract", "text"),
];

/// Outcome of one `import_bibliography` call. Field shapes are part of the
/// agreed IPC contract — do not change.
#[derive(Debug, Clone, Serialize, Type)]
pub struct ImportBibliographyResult {
    /// Reference pages made durable by the import.
    pub pages_created: u64,
    /// Entries skipped by the dedup/idempotence rule (a page in the space
    /// already carries the entry's `citation-key`, or — fallback — the same
    /// non-empty `doi`), including duplicates within the imported file.
    pub entries_skipped: u64,
    /// Typed properties stamped onto the created pages (excluding the
    /// reserved `space` membership property).
    pub properties_set: u64,
    /// Non-fatal diagnostics: parser warnings (skipped directives, ignored
    /// fields, LaTeX kept literal, …) plus per-entry apply notices
    /// (dedup skips, title-collision renames, rejected property values).
    pub warnings: Vec<String>,
}

/// The page title ("citation display name") for one entry:
/// `"{first author family name} {year}"`, falling back to the citation key
/// when either half is missing.
fn citation_display_name(entry: &BibEntry) -> String {
    match (entry.first_author_family(), entry.year) {
        (Some(family), Some(year)) => format!("{family} {year}"),
        _ => entry.citation_key.clone(),
    }
}

/// Import a bibliography file as reference pages with typed properties.
///
/// `format` is `"bibtex"`, `"csl-json"`, or `None` to auto-detect from the
/// first non-whitespace character (`@` → BibTeX, `[` / `{` → CSL-JSON).
///
/// # Idempotence / dedup (#1454 acceptance)
///
/// An entry is skipped (counted in `entries_skipped`, with a warning) when
/// a live page in the target space already carries a `citation-key`
/// property equal to the entry's key, or — fallback — the same non-empty
/// `doi`. The existing keys/DOIs are fetched in ONE batched pre-query, and
/// the running sets also cover duplicates within the imported file itself,
/// so re-importing the same file is a no-op.
///
/// # Title collisions
///
/// The page title is the citation display name (`"{family} {year}"` or the
/// citation key). On a collision — within the import or with an existing
/// page in the space — the title becomes `"{name} ({citation_key})"`.
///
/// # Chunked transactions
///
/// Like `import_markdown_inner` (#662), the import is a *sequence* of
/// `BEGIN IMMEDIATE` transactions flushed every
/// [`IMPORT_BIB_CHUNK_ENTRIES`] entries, bounding the writer-lock hold time
/// per the #2470 contract (docs/architecture/operations.md). A chunk
/// boundary never splits an entry, so an interrupted import leaves a prefix
/// of complete reference pages; imports of ≤ one chunk keep whole-file
/// atomicity.
#[instrument(skip(pool, device_id, materializer, content), fields(space = %space_id), err)]
pub async fn import_bibliography_inner(
    pool: &SqlitePool,
    device_id: &str,
    materializer: &Materializer,
    content: String,
    format: Option<String>,
    space_id: String,
) -> Result<ImportBibliographyResult, AppError> {
    // Normalize ULID to uppercase per AGENTS.md invariant #8 — mirrors
    // `import_markdown_with_progress` (raw String args from MCP tools /
    // scripted imports must never land a case-mismatched space ref).
    let space_id = space_id.to_ascii_uppercase();

    let format = match format.as_deref() {
        Some("bibtex") => BibliographyFormat::Bibtex,
        Some("csl-json") => BibliographyFormat::CslJson,
        Some(other) => {
            return Err(AppError::validation(format!(
                "unknown bibliography format '{other}': must be 'bibtex' or 'csl-json'"
            )));
        }
        None => bibliography::detect_bibliography_format(&content)?,
    };
    let parsed = bibliography::parse_bibliography(&content, format)?;
    let mut warnings = parsed.warnings;
    let entries = parsed.entries;

    tracing::info!(
        entries = entries.len(),
        parse_warnings = warnings.len(),
        "import: starting bibliography import"
    );

    if entries.is_empty() {
        // Non-empty input that yielded nothing importable (e.g. only
        // `@comment`/`@string` directives). Nothing to write — surface the
        // parse warnings instead of opening a transaction.
        warnings.push("no importable bibliography entries found".to_string());
        return Ok(ImportBibliographyResult {
            pages_created: 0,
            entries_skipped: 0,
            properties_set: 0,
            warnings,
        });
    }

    // Idempotent pre-pass: declare the typed property definitions on the
    // pool (INSERT OR IGNORE — an existing user declaration for a key wins,
    // and the value coercion below follows the WINNING declaration).
    for (key, value_type) in BIB_PROPERTY_DEFS {
        create_property_def_inner(pool, (*key).to_string(), (*value_type).to_string(), None)
            .await?;
    }

    // --- Chunked IMMEDIATE transactions (#662 pattern) ---
    let mut tx = CommandTx::begin_immediate(pool, "import_bibliography").await?;
    // #2604 — rollback-safe engine apply (rewind on tx abort). Re-armed per
    // chunk at the re-open below.
    tx.arm_engine_rollback(materializer.loro_state());

    // Validate `space_id` upfront inside the tx, identically to
    // `import_markdown_with_progress` / `create_page_in_space_inner`: the
    // target must exist as a live block carrying `is_space = 'true'`.
    // TOCTOU-safe against a concurrent delete.
    let space_ok = sqlx::query_scalar!(
        r#"SELECT 1 as "ok: i32" FROM blocks b
           WHERE b.id = ?
             AND b.deleted_at IS NULL
             AND EXISTS (
                 SELECT 1 FROM block_properties p
                 WHERE p.block_id = b.id
                   AND p.key = 'is_space'
                   AND p.value_text = 'true'
             )"#,
        space_id,
    )
    .fetch_optional(&mut **tx)
    .await?;
    if space_ok.is_none() {
        return Err(AppError::validation(format!(
            "space_id '{space_id}' does not refer to a live space block (is_space = 'true')"
        )));
    }

    // Dedup pre-query (ONE batched query, not per-entry): every live page's
    // `citation-key` / `doi` text value in the target space. The two sets
    // also accumulate the keys/DOIs written by THIS import so duplicates
    // within the file dedup identically.
    let mut existing_keys: HashSet<String> = HashSet::new();
    let mut existing_dois: HashSet<String> = HashSet::new();
    {
        let rows = sqlx::query!(
            r#"SELECT p.key AS "key!: String", p.value_text AS "value_text!: String"
               FROM block_properties p
               JOIN blocks b ON b.id = p.block_id
               WHERE b.deleted_at IS NULL
                 AND b.space_id = ?1
                 AND p.key IN ('citation-key', 'doi')
                 AND p.value_text IS NOT NULL"#,
            space_id,
        )
        .fetch_all(&mut **tx)
        .await?;
        for row in rows {
            if row.key == "citation-key" {
                existing_keys.insert(row.value_text);
            } else {
                existing_dois.insert(row.value_text);
            }
        }
    }

    // Title-collision pre-query (ONE batched `json_each` lookup, the
    // established import idiom): which candidate titles — base display name
    // or its `(citation-key)`-suffixed variant — already exist as live page
    // titles in this space. `used_titles` then also accumulates the titles
    // assigned during this import so within-import collisions disambiguate.
    let mut used_titles: HashSet<String> = {
        let candidates: BTreeSet<String> = entries
            .iter()
            .flat_map(|e| {
                let base = citation_display_name(e);
                let suffixed = format!("{base} ({})", e.citation_key);
                [base, suffixed]
            })
            .collect();
        let candidates: Vec<&String> = candidates.iter().collect();
        let names_json = serde_json::to_string(&candidates)?;
        let rows = sqlx::query!(
            r#"SELECT content AS "content!: String"
               FROM blocks
               WHERE block_type = 'page'
                 AND deleted_at IS NULL
                 AND space_id = ?1
                 AND content IN (SELECT value FROM json_each(?2))"#,
            space_id,
            names_json,
        )
        .fetch_all(&mut **tx)
        .await?;
        rows.into_iter().map(|r| r.content).collect()
    };

    // Batched property-declaration lookup (#1921 idiom): fetch every import
    // key's winning `(value_type, options)` once and drive the loop from the
    // map via `set_property_in_tx_with_declaration`, instead of a per-key
    // round-trip inside `set_property_in_tx` for every entry.
    let decls: HashMap<String, (String, Option<String>)> = {
        let keys: Vec<&str> = BIB_PROPERTY_DEFS.iter().map(|(k, _)| *k).collect();
        let keys_json = serde_json::to_string(&keys)?;
        let rows = sqlx::query!(
            r#"SELECT key AS "key!", value_type, options
               FROM property_definitions
               WHERE key IN (SELECT value FROM json_each(?1))"#,
            keys_json,
        )
        .fetch_all(&mut **tx)
        .await?;
        rows.into_iter()
            .map(|r| (r.key, (r.value_type, r.options)))
            .collect()
    };

    let mut pages_created: u64 = 0;
    let mut entries_skipped: u64 = 0;
    let mut properties_set: u64 = 0;
    let mut chunk_entries: usize = 0;
    let mut chunks_committed: u64 = 0;

    for entry in &entries {
        // #662-style chunk flush — only ever BETWEEN entries, so an entry's
        // page + properties always share one transaction.
        if chunk_entries >= IMPORT_BIB_CHUNK_ENTRIES {
            tx.commit_and_dispatch(materializer).await.map_err(|e| {
                tracing::error!(
                    chunks_committed,
                    pages_created,
                    error = %e,
                    "import: bibliography chunk commit failed; committed chunks remain durable"
                );
                AppError::from(e)
            })?;
            chunks_committed += 1;
            tx = CommandTx::begin_immediate(pool, "import_bibliography").await?;
            // #2604 — re-arm rollback for the new per-chunk tx.
            tx.arm_engine_rollback(materializer.loro_state());
            chunk_entries = 0;
        }

        // Dedup/idempotence: skip when the citation key — or, fallback, the
        // non-empty DOI — is already present (pre-existing page or an
        // earlier entry of this same import).
        if existing_keys.contains(&entry.citation_key) {
            entries_skipped += 1;
            warnings.push(format!(
                "entry '{}' skipped: a page in this space already carries this citation-key",
                entry.citation_key
            ));
            continue;
        }
        let entry_doi = entry
            .doi
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty());
        if let Some(doi) = entry_doi
            && existing_dois.contains(doi)
        {
            entries_skipped += 1;
            warnings.push(format!(
                "entry '{}' skipped: a page in this space already carries doi '{doi}'",
                entry.citation_key
            ));
            continue;
        }

        // Page title = citation display name, disambiguated on collision.
        let base_title = citation_display_name(entry);
        let title = if used_titles.contains(&base_title) {
            let disambiguated = format!("{base_title} ({})", entry.citation_key);
            warnings.push(format!(
                "entry '{}': page title '{base_title}' already exists; \
                 using '{disambiguated}'",
                entry.citation_key
            ));
            disambiguated
        } else {
            base_title
        };

        // Create the reference page inside the current chunk's transaction.
        // A per-entry Validation rejection (e.g. an absurdly long title
        // exceeding the content cap) degrades to skip-and-warn — mirroring
        // the #1918 recoverable-failure contract — instead of aborting the
        // whole import. No writes have landed for the entry at that point.
        let (page, page_op) = match create_block_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            "page".into(),
            title.clone(),
            None,
            None,
        )
        .await
        {
            Ok(created) => created,
            Err(AppError::Validation { message, .. }) => {
                entries_skipped += 1;
                warnings.push(format!(
                    "entry '{}' skipped: could not create page ({message})",
                    entry.citation_key
                ));
                continue;
            }
            Err(e) => return Err(e),
        };
        tx.enqueue_background(page_op);
        let page_id = page.id.clone().into_string();
        used_titles.insert(title);

        // Stamp the `space` ref property — same op order as
        // `create_page_in_space_inner` (create → set) so a sync peer never
        // observes the page without its space membership.
        let (_page_block, space_op) = set_property_in_tx(
            &mut tx,
            materializer.loro_state(),
            device_id,
            page_id.clone(),
            "space",
            None,
            None,
            None,
            Some(space_id.clone()),
            None,
        )
        .await?;
        tx.enqueue_background(space_op);

        // Typed entry properties. Values are flat strings; the coercion into
        // the right `block_properties` column follows the WINNING declaration
        // fetched above (`typed_property_args_for_registry_value`), so a
        // pre-existing user declaration (e.g. `year` as text) still imports
        // cleanly instead of failing validation.
        let mut props: Vec<(&str, String)> = vec![
            ("citation-key", entry.citation_key.clone()),
            ("reference-type", entry.entry_type.clone()),
        ];
        if !entry.authors.is_empty() {
            props.push(("authors", entry.authors.join("; ")));
        }
        if let Some(year) = entry.year {
            props.push(("year", year.to_string()));
        }
        for (key, value) in [
            ("doi", &entry.doi),
            ("url", &entry.url),
            ("journal", &entry.journal),
            ("abstract", &entry.abstract_text),
        ] {
            if let Some(v) = value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
                props.push((key, v.to_string()));
            }
        }

        for (key, value) in props {
            let (value_type, options) = match decls.get(key) {
                Some((t, o)) => (Some(t.clone()), o.clone()),
                None => (None, None),
            };
            let (value_text, value_num, value_date, value_ref, value_bool) =
                crate::domain::block_ops::typed_property_args_for_registry_value(
                    key,
                    value,
                    value_type.as_deref(),
                );
            let declaration = value_type.map(|vt| crate::domain::block_ops::PropertyDeclaration {
                value_type: vt,
                options,
            });
            match crate::domain::block_ops::set_property_in_tx_with_declaration(
                &mut tx,
                materializer.loro_state(),
                device_id,
                page_id.clone(),
                key,
                value_text,
                value_num,
                value_date,
                value_ref,
                value_bool,
                declaration,
            )
            .await
            {
                Ok((_block, prop_op)) => {
                    tx.enqueue_background(prop_op);
                    properties_set += 1;
                }
                // A value the (possibly user-owned) declaration rejects —
                // e.g. a select-typed key whose options exclude the value —
                // skips THIS property with a warning rather than aborting
                // the import. `validate_property_value` runs before any
                // write, so the tx is untouched by the rejection.
                Err(AppError::Validation { message, .. }) => {
                    warnings.push(format!(
                        "entry '{}': property '{key}' was rejected ({message}); skipped",
                        entry.citation_key
                    ));
                }
                Err(e) => return Err(e),
            }
        }

        existing_keys.insert(entry.citation_key.clone());
        if let Some(doi) = entry_doi {
            existing_dois.insert(doi.to_string());
        }
        pages_created += 1;
        chunk_entries += 1;
    }

    tx.commit_and_dispatch(materializer).await?;

    if !warnings.is_empty() {
        tracing::warn!(
            count = warnings.len(),
            warnings = ?warnings,
            "bibliography import produced diagnostics"
        );
    }
    tracing::info!(
        pages_created,
        entries_skipped,
        properties_set,
        warnings = warnings.len(),
        chunks_committed = chunks_committed + 1,
        "import: completed bibliography import"
    );

    Ok(ImportBibliographyResult {
        pages_created,
        entries_skipped,
        properties_set,
        warnings,
    })
}

/// Tauri command: import a BibTeX / CSL-JSON bibliography into `space_id`
/// as reference pages. Delegates to [`import_bibliography_inner`].
///
/// `format` is `"bibtex"`, `"csl-json"`, or `null` to auto-detect. No
/// progress channel in v1 — entries are tiny and the import chunk-commits
/// every [`IMPORT_BIB_CHUNK_ENTRIES`] entries (#2470 writer-lock contract).
#[tauri::command]
#[specta::specta]
pub async fn import_bibliography(
    ctx: State<'_, WriteCtx>,
    content: String,
    format: Option<String>,
    space_id: SpaceId,
) -> Result<ImportBibliographyResult, AppError> {
    // b2 (#2248): required-target-space commands take the `SpaceId` newtype
    // at the wire boundary; reject a malformed id before it reaches the
    // in-transaction space-existence check with an opaque error.
    space_id.validate_shape()?;
    import_bibliography_inner(
        ctx.pool(),
        ctx.device_id(),
        ctx.materializer(),
        content,
        format,
        space_id.into_string(),
    )
    .await
    .map_err(sanitize_internal_error)
}
