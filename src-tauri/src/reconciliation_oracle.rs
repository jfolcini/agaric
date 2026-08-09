//! Reconciliation oracle (#3345, programme #3351 theme T3).
//!
//! Derived state in this codebase is **hand-maintained per op arm**. The
//! apply kernel (`agaric_engine::apply::kernel::apply_op_tx_with_mode`)
//! captures a bespoke `PreOpState` variant per op type and feeds it to
//! `maintain_pages_cache_counts_after_op`, so every new op type is a fresh
//! chance to forget an arm. The content-addressed attachment blob store
//! (`attachment_blobs`, migration 0094) has the same shape one level down:
//! three independent sites INSERT a blob row (`persist_attachment` on local
//! ingest, `sync_files::register_received_blob` after a verified receive,
//! `recovery::backfill_attachment_blobs`), none of them INCREMENTS or
//! DECREMENTS anything — the only reconciliation is a background GC sweep.
//!
//! Only local ingest is driven by this slice's tests; the sync-receive arm is
//! covered by the oracle (any state it produces is diffed) but is not yet
//! *exercised* by a driver. That is a follow-up, not a claim made here.
//!
//! Nothing in the tree rebuilt those artefacts from base tables and diffed
//! the result against the incrementally-maintained state. This module is
//! that missing oracle.
//!
//! # Contract
//!
//! * [`rebuild_pages_cache_counts_from_base`] and
//!   [`rebuild_attachment_blobs_from_base`] recompute a derived artefact
//!   from **base tables only**, in Rust, from first principles. They are
//!   deliberately slow and naive — an oracle, not a fast path.
//! * They share **no code** with the incremental maintenance path. They do
//!   not call `recompute_pages_cache_counts_for_pages`, `rebuild_pages_cache`,
//!   `recompute_all_pages_cache_counts`, `cleanup_orphaned_attachments`, or
//!   any SQL those functions use. A rebuild that calls the same projection
//!   helper it is auditing proves nothing, so every aggregate here is folded
//!   in Rust over a raw row dump. They do share the *specification* — see
//!   [`rebuild_pages_cache_counts_from_base`] for the one assumption
//!   (`blocks.page_id` as page ownership) that is therefore outside what this
//!   oracle can falsify, and where that gap is covered instead.
//! * [`assert_reconciled`] diffs both artefacts and reports the **first**
//!   divergence in a stable order, naming the artefact, the key, expected
//!   vs. actual, and the maintenance site that owns the arm — enough to
//!   identify which op caused it when the caller asserts per-op.
//!
//! # Where this runs
//!
//! Oracles are slow by construction, so they belong in nextest and the
//! scheduled lanes, **not** the commit path. The only prek hook that runs
//! Rust tests (`cargo-test` → `scripts/test-related-rust.sh`) is
//! `stages = ["pre-push"]`; nothing here is reachable from `pre-commit`.
//!
//! # What is covered
//!
//! | Artefact | Base tables | Maintained by |
//! |---|---|---|
//! | `attachment_blobs` (blob refcount) | `attachments` | `persist_attachment` (insert arm) / `cleanup_orphaned_attachments` (prune arm) |
//! | `pages_cache.{inbound_link_count,child_block_count}` | `blocks`, `block_links` | `maintain_pages_cache_counts_after_op` (sync arms) / `rebuild_pages_cache_counts` (deferred cohort arm) |
//!
//! Deliberately **not** covered here — see the follow-up issues: the agenda
//! cache, the projected-agenda cache, `page_link_cache`, `block_tag_refs`,
//! `tags_cache.usage_count`, `blocks.page_id`/`space_id` re-derivation, and
//! the FTS index.
//!
//! # Eventual consistency is part of the contract, not an excuse
//!
//! Two of the maintenance arms are deliberately DEFERRED in production:
//!
//! * `maintain_pages_cache_counts_after_op` returns early for
//!   `PreOpState::{Cohort, RestoreCohortAndAncestors, Purge}` (#2042) and
//!   `materializer::dispatch` enqueues `MaterializeTask::RebuildPagesCacheCounts`
//!   instead;
//! * `delete_attachment_inner` / the purge paths never unlink bytes or prune
//!   `attachment_blobs` (#1993/#3259); `cleanup_orphaned_attachments` does.
//!
//! So the oracle is a statement about the **settled** state. A caller that
//! drives an op which production defers MUST also drive production's
//! deferred pass before asserting — that is what
//! [`settle_deferred_pages_cache_counts`] and the GC call in the attachment
//! tests do. Both deferred passes are production code, so breaking either of
//! them still turns the oracle red; nothing is repaired by test-local code.

#![cfg(test)]

use std::collections::{BTreeMap, BTreeSet};

use agaric_core::error::AppError;
use sqlx::SqlitePool;

// ---------------------------------------------------------------------------
// Divergence report
// ---------------------------------------------------------------------------

/// One way in which incrementally-maintained derived state disagrees with a
/// from-base rebuild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divergence {
    /// Derived artefact + column, e.g. `pages_cache.child_block_count`.
    pub artefact: &'static str,
    /// The row key the divergence is about (page id, content hash, …).
    pub key: String,
    /// What a from-base rebuild says the value must be.
    pub expected: String,
    /// What the incrementally-maintained state actually holds.
    pub actual: String,
    /// The maintenance site that owns this arm — where to look first.
    pub owner: &'static str,
}

impl std::fmt::Display for Divergence {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} [{}]\n      rebuilt-from-base: {}\n      incremental state: {}\n      maintained by:     {}",
            self.artefact, self.key, self.expected, self.actual, self.owner
        )
    }
}

/// How much of the oracle's subject matter actually EXISTS in a given
/// database. Callers assert on this so a green oracle can never be a green
/// vacuum: an artefact with zero rows is not evidence of anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OracleCoverage {
    /// Rows in `pages_cache` (the pages whose counts are being audited).
    pub pages_cache_rows: i64,
    /// Live `attachments` rows carrying a non-NULL `content_hash` — the rows
    /// that can produce a blob-refcount obligation at all.
    pub hashed_attachment_rows: i64,
    /// Rows in `attachment_blobs`.
    pub attachment_blob_rows: i64,
}

/// Count the artefact rows the oracle is auditing.
pub async fn oracle_coverage(pool: &SqlitePool) -> Result<OracleCoverage, AppError> {
    // Kept off the offline `.sqlx` cache so the oracle needs no regeneration.
    // dynamic-sql: static SQL, test-only oracle read-back.
    let pages_cache_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pages_cache")
        .fetch_one(pool)
        .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let hashed_attachment_rows: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM attachments WHERE content_hash IS NOT NULL AND deleted_at IS NULL",
    )
    .fetch_one(pool)
    .await?;
    // dynamic-sql: static SQL, test-only oracle read-back.
    let attachment_blob_rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM attachment_blobs")
        .fetch_one(pool)
        .await?;
    Ok(OracleCoverage {
        pages_cache_rows,
        hashed_attachment_rows,
        attachment_blob_rows,
    })
}

// ---------------------------------------------------------------------------
// Base-table snapshots
//
// Every rebuild below folds one of these dumps in Rust. No aggregate, no
// JOIN, no correlated subquery is pushed into SQLite — that is the whole
// point: the maintenance path expresses its aggregates as SQL, so an oracle
// written in the same SQL would be a copy of the thing it audits.
// ---------------------------------------------------------------------------

/// One `blocks` row, reduced to the columns the derived counts depend on.
#[derive(Debug, Clone)]
struct BaseBlock {
    id: String,
    page_id: Option<String>,
    /// `None` = live. `blocks.deleted_at` is epoch-ms INTEGER (migration 0080).
    deleted_at: Option<i64>,
}

/// One `attachments` row, reduced to the columns the blob store depends on.
#[derive(Debug, Clone)]
struct BaseAttachment {
    id: String,
    fs_path: String,
    content_hash: Option<String>,
    /// `None` = live. `attachments.deleted_at` is still TEXT (out of #109 scope).
    deleted_at: Option<String>,
}

async fn dump_blocks(pool: &SqlitePool) -> Result<Vec<BaseBlock>, AppError> {
    // Kept off the offline `.sqlx` cache and deliberately aggregate-free — the
    // fold happens in Rust so this shares nothing with the maintenance path.
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, Option<String>, Option<i64>)>(
        "SELECT id, page_id, deleted_at FROM blocks",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, page_id, deleted_at)| BaseBlock {
            id,
            page_id,
            deleted_at,
        })
        .collect())
}

async fn dump_block_links(pool: &SqlitePool) -> Result<Vec<(String, String)>, AppError> {
    const SQL: &str = "SELECT source_id, target_id FROM block_links";
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String)>(SQL)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

async fn dump_attachments(pool: &SqlitePool) -> Result<Vec<BaseAttachment>, AppError> {
    // dynamic-sql: static SQL, test-only oracle base-table dump.
    let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        "SELECT id, fs_path, content_hash, deleted_at FROM attachments",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, fs_path, content_hash, deleted_at)| BaseAttachment {
            id,
            fs_path,
            content_hash,
            deleted_at,
        })
        .collect())
}

// ---------------------------------------------------------------------------
// Artefact 1 — `pages_cache.{inbound_link_count, child_block_count}`
// ---------------------------------------------------------------------------

/// The two materialised aggregate columns of one `pages_cache` row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageCounts {
    pub inbound_link_count: i64,
    pub child_block_count: i64,
}

/// Recompute both `pages_cache` count columns for every page id that has a
/// cache row, from `blocks` + `block_links` alone.
///
/// The rules are transcribed from the column semantics (migrations 0069 /
/// 0070), NOT from the maintenance SQL:
///
/// * `child_block_count[P]` — live blocks whose `page_id` is `P`, excluding
///   the page block itself.
/// * `inbound_link_count[P]` — distinct link SOURCES that point at any live
///   block owned by `P`, excluding sources that are themselves deleted,
///   orphaned (`page_id IS NULL`), or on page `P` (same-page/self links).
///
/// Folded in Rust over three flat row dumps: no `COUNT`, no `DISTINCT`, no
/// `JOIN` is delegated to SQLite, so this cannot accidentally inherit a bug
/// from the correlated-subquery UPDATE it audits.
///
/// # The one assumption this rebuild DOES share with the thing it audits
///
/// Both count rules above read the denormalised `blocks.page_id` column, and
/// so does the maintenance UPDATE. Page ownership is therefore **not** the
/// subject of this oracle: if `page_id` itself drifts from the `parent_id`
/// tree (the E4 shape — a cross-page move whose re-derivation is missed), the
/// UPDATE and this rebuild read the same drifted column and agree.
///
/// That gap is deliberately covered elsewhere, not left open:
/// `materializer::tests::pages_cache_parity::canonical_counts` derives
/// `child_block_count` by walking `parent_id` structurally and never reads
/// `page_id`. What THIS rebuild adds over that one is not a stronger
/// definition but a different question — whether the per-`PreOpState`-arm
/// affected-page resolution refreshed the rows it had to, over *generated* op
/// interleavings rather than hand-written fixtures. Re-deriving `page_id`
/// from `parent_id` here as well is the natural next slice.
pub async fn rebuild_pages_cache_counts_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, PageCounts>, AppError> {
    let blocks = dump_blocks(pool).await?;
    let links = dump_block_links(pool).await?;
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let page_ids: Vec<String> = sqlx::query_scalar("SELECT page_id FROM pages_cache")
        .fetch_all(pool)
        .await?;

    let by_id: BTreeMap<&str, &BaseBlock> = blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out = BTreeMap::new();
    for page in page_ids {
        let mut child_block_count: i64 = 0;
        for b in &blocks {
            if b.deleted_at.is_none() && b.page_id.as_deref() == Some(page.as_str()) && b.id != page
            {
                child_block_count += 1;
            }
        }

        let mut sources: BTreeSet<&str> = BTreeSet::new();
        for (source_id, target_id) in &links {
            // Target must be a LIVE block owned by this page.
            let Some(target) = by_id.get(target_id.as_str()) else {
                continue;
            };
            if target.deleted_at.is_some() || target.page_id.as_deref() != Some(page.as_str()) {
                continue;
            }
            // Source must be live, page-owned, and on a DIFFERENT page.
            let Some(source) = by_id.get(source_id.as_str()) else {
                continue;
            };
            if source.deleted_at.is_some() {
                continue;
            }
            let Some(source_page) = source.page_id.as_deref() else {
                continue;
            };
            if source_page == page {
                continue;
            }
            sources.insert(source_id.as_str());
        }

        out.insert(
            page,
            PageCounts {
                inbound_link_count: i64::try_from(sources.len()).unwrap_or(i64::MAX),
                child_block_count,
            },
        );
    }
    Ok(out)
}

/// Read the incrementally-maintained `pages_cache` counts as they stand.
async fn read_pages_cache_counts(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, PageCounts>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let rows = sqlx::query_as::<_, (String, i64, i64)>(
        "SELECT page_id, inbound_link_count, child_block_count FROM pages_cache",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(page_id, inbound_link_count, child_block_count)| {
            (
                page_id,
                PageCounts {
                    inbound_link_count,
                    child_block_count,
                },
            )
        })
        .collect())
}

/// Run production's DEFERRED `pages_cache` count pass — the one
/// `materializer::dispatch` enqueues as `MaterializeTask::RebuildPagesCacheCounts`
/// for every cohort op (`DeleteBlock` / `RestoreBlock` / `PurgeBlock`),
/// because `maintain_pages_cache_counts_after_op` returns early for those
/// (#2042).
///
/// A driver that applies a cohort op and then asserts reconciliation without
/// this is asserting against an un-settled state. This is production code
/// (`agaric_store::cache::rebuild_pages_cache_counts`), not a test-local
/// repair: breaking it turns the oracle red exactly as breaking a synchronous
/// arm does. That is what makes the DECREMENT half of the count pair covered
/// rather than left open.
pub async fn settle_deferred_pages_cache_counts(pool: &SqlitePool) -> Result<(), AppError> {
    agaric_store::cache::rebuild_pages_cache_counts(pool).await
}

// ---------------------------------------------------------------------------
// Artefact 2 — `attachment_blobs` (the attachment blob refcount)
// ---------------------------------------------------------------------------

/// What a from-base rebuild says one content hash's blob entry must look like.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobExpectation {
    /// Number of LIVE `attachments` rows carrying this hash. Never 0 — a hash
    /// with no referencing row does not appear in the rebuild at all.
    pub refcount: usize,
    /// The `fs_path`s those rows point at. Under #1993 dedup this is normally
    /// a single canonical path shared by all of them.
    pub referenced_paths: BTreeSet<String>,
    /// The ids of the referencing rows, so a divergence report names the rows
    /// whose bytes are at stake rather than just a hash.
    pub referrer_ids: BTreeSet<String>,
}

/// Recompute the blob store from `attachments` alone.
///
/// `attachment_blobs` (migration 0094) has **no refcount column**: the link
/// is by-hash on demand, and no op arm increments or decrements anything. The
/// derived truth is therefore purely a fold over `attachments`:
///
/// > a blob row must exist for exactly those content hashes carried by at
/// > least one live `attachments` row, and its `on_disk_path` must be a path
/// > one of those rows actually references.
///
/// The second half is the load-bearing one. `cleanup_orphaned_attachments`
/// decides what to unlink by testing `on_disk_path` membership in
/// `SELECT fs_path FROM attachments` — it never consults `content_hash`. A
/// blob whose `on_disk_path` no live referrer uses is therefore a blob whose
/// bytes the GC will unlink while live rows still resolve that hash to them.
pub async fn rebuild_attachment_blobs_from_base(
    pool: &SqlitePool,
) -> Result<BTreeMap<String, BlobExpectation>, AppError> {
    let attachments = dump_attachments(pool).await?;
    let mut out: BTreeMap<String, BlobExpectation> = BTreeMap::new();
    for a in &attachments {
        // Soft-deleted rows are not references. `attachments.deleted_at` has no
        // production writer today (`delete_attachment_inner` hard-deletes the
        // row), so this arm is unreachable in the current tree.
        //
        // It is NOT neutral, though, and the choice is deliberate: the two
        // production writers of `attachment_blobs` disagree about soft-deleted
        // rows. `backfill_attachment_blobs` scopes the blob set with
        // `WHERE deleted_at IS NULL`; `cleanup_orphaned_attachments` loads
        // `SELECT fs_path FROM attachments` with NO predicate and therefore
        // treats a soft-deleted row as a live reference that keeps both the
        // blob row and its bytes alive. This rebuild sides with the backfill,
        // so the first production writer of `attachments.deleted_at` will turn
        // this oracle red on that disagreement rather than let it ship silently.
        if a.deleted_at.is_some() {
            continue;
        }
        let Some(hash) = a.content_hash.as_deref() else {
            // Rows written by the op-apply arm (`apply_add_attachment_tx`)
            // carry no hash at all and therefore impose no blob obligation.
            continue;
        };
        let entry = out
            .entry(hash.to_owned())
            .or_insert_with(|| BlobExpectation {
                refcount: 0,
                referenced_paths: BTreeSet::new(),
                referrer_ids: BTreeSet::new(),
            });
        entry.refcount += 1;
        entry.referenced_paths.insert(a.fs_path.clone());
        entry.referrer_ids.insert(a.id.clone());
    }
    Ok(out)
}

/// Read the blob store as it stands.
async fn read_attachment_blobs(pool: &SqlitePool) -> Result<BTreeMap<String, String>, AppError> {
    // dynamic-sql: static SQL, test-only oracle read-back of the derived table.
    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT content_hash, on_disk_path FROM attachment_blobs",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

/// Diff every covered derived artefact against its from-base rebuild.
///
/// Divergences come back in a stable order (attachment blob store first, then
/// `pages_cache`, each sorted by key) so `first` is deterministic and a
/// shrunk proptest counter-example reports the same line every run.
pub async fn reconcile(pool: &SqlitePool) -> Result<Vec<Divergence>, AppError> {
    let mut out = Vec::new();

    // --- Artefact 2: attachment blob refcount --------------------------------
    let expected_blobs = rebuild_attachment_blobs_from_base(pool).await?;
    let actual_blobs = read_attachment_blobs(pool).await?;

    for (hash, on_disk_path) in &actual_blobs {
        match expected_blobs.get(hash) {
            None => out.push(Divergence {
                artefact: "attachment_blobs.refcount",
                key: hash.clone(),
                expected: "no blob row (refcount 0 — no live attachments row carries this hash)"
                    .to_owned(),
                actual: format!("blob row present, on_disk_path={on_disk_path}"),
                owner: "cleanup_orphaned_attachments (the only INCREMENTAL prune arm; \
                        keys on fs_path, never on content_hash — snapshot restore \
                        wipes the table wholesale) — a delete/purge arm dropped the \
                        last referencing row without the blob store ever noticing",
            }),
            Some(expectation) => {
                if !expectation.referenced_paths.contains(on_disk_path) {
                    out.push(Divergence {
                        artefact: "attachment_blobs.on_disk_path",
                        key: hash.clone(),
                        expected: format!(
                            "one of the {} live referrers' fs_paths {:?} (rows {:?})",
                            expectation.refcount,
                            expectation.referenced_paths,
                            expectation.referrer_ids
                        ),
                        actual: format!("{on_disk_path} (referenced by no live row)"),
                        owner: "persist_attachment (dedup INSERT arm) / \
                                cleanup_orphaned_attachments (prune arm) — the GC unlinks \
                                bytes whose path no `attachments.fs_path` matches, so these \
                                bytes are about to be destroyed while live rows still \
                                resolve this hash to them",
                    });
                }
            }
        }
    }
    for (hash, expectation) in &expected_blobs {
        if !actual_blobs.contains_key(hash) {
            out.push(Divergence {
                artefact: "attachment_blobs.refcount",
                key: hash.clone(),
                expected: format!(
                    "blob row present (refcount {}, referenced_paths {:?}, referrers {:?})",
                    expectation.refcount, expectation.referenced_paths, expectation.referrer_ids
                ),
                actual: "no blob row".to_owned(),
                owner: "the insert arms — persist_attachment (local ingest), \
                        sync_files::register_received_blob (INSERT OR IGNORE after a \
                        verified receive), recovery::backfill_attachment_blobs — a live \
                        attachments row carries a content_hash with no blob entry, so \
                        the next ingest of those bytes writes a second copy and the \
                        dedup target is lost",
            });
        }
    }

    // --- Artefact 1: pages_cache counts --------------------------------------
    let expected_counts = rebuild_pages_cache_counts_from_base(pool).await?;
    let actual_counts = read_pages_cache_counts(pool).await?;
    for (page_id, expected) in &expected_counts {
        let Some(actual) = actual_counts.get(page_id) else {
            continue;
        };
        if expected.child_block_count != actual.child_block_count {
            out.push(Divergence {
                artefact: "pages_cache.child_block_count",
                key: page_id.clone(),
                expected: expected.child_block_count.to_string(),
                actual: actual.child_block_count.to_string(),
                owner: "maintain_pages_cache_counts_after_op (PreOpState arms for \
                        Create/Edit/Move) + rebuild_pages_cache_counts (the deferred \
                        cohort pass dispatch enqueues for Delete/Restore/Purge)",
            });
        }
        if expected.inbound_link_count != actual.inbound_link_count {
            out.push(Divergence {
                artefact: "pages_cache.inbound_link_count",
                key: page_id.clone(),
                expected: expected.inbound_link_count.to_string(),
                actual: actual.inbound_link_count.to_string(),
                owner: "maintain_pages_cache_counts_after_op (PreOpState arms for \
                        Create/Edit/Move) + rebuild_pages_cache_counts (the deferred \
                        cohort pass dispatch enqueues for Delete/Restore/Purge)",
            });
        }
    }

    Ok(out)
}

/// The formatted first divergence, or `None` when derived state reconciles.
///
/// Returns a `String` rather than panicking so proptest callers can feed it
/// to `prop_assert!` and let the shrinker minimise the counter-example.
pub async fn reconciliation_failure(pool: &SqlitePool, context: &str) -> Option<String> {
    let divergences = match reconcile(pool).await {
        Ok(d) => d,
        Err(e) => {
            return Some(format!(
                "reconciliation oracle could not read the database at [{context}]: {e}"
            ));
        }
    };
    let first = divergences.first()?;
    Some(format!(
        "RECONCILIATION FAILED at [{context}]\n  \
         derived state disagrees with a from-base rebuild in {} place(s); first:\n    {first}",
        divergences.len(),
    ))
}

/// Panic with the first divergence unless every covered derived artefact
/// equals its from-base rebuild. `context` should identify the op that just
/// applied (index + type) so the failure names the arm that broke.
pub async fn assert_reconciled(pool: &SqlitePool, context: &str) {
    if let Some(report) = reconciliation_failure(pool, context).await {
        panic!("{report}");
    }
}

#[cfg(test)]
mod tests;
