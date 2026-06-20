//! Shared constants for the FTS5 search subsystem: highlight sentinels,
//! the snippet SQL projection, per-query timing thresholds, and the result
//! / query-length ceilings.

// ---------------------------------------------------------------------------
// #828 — FTS5 snippet() highlight sentinels
// ---------------------------------------------------------------------------

/// #828 — FTS5 snippet() highlight sentinels. PUA codepoints that cannot
/// occur in user content, so a literal "<mark>" typed into a block is never
/// mistaken for a highlight boundary. The web UI parser (parseSnippet in
/// src/components/search/SnippetHighlight.tsx) reads these directly; the MCP
/// search tool converts them back to <mark>/</mark> so the agent-facing
/// contract is unchanged.
pub(crate) const SNIPPET_HL_OPEN: char = '\u{E000}';
pub(crate) const SNIPPET_HL_CLOSE: char = '\u{E001}';
/// The `snippet(...)` SQL projection, shared by the production query and the
/// test mirror so the two never drift. Keep the inline sentinels in sync
/// with SNIPPET_HL_OPEN / SNIPPET_HL_CLOSE above.
pub(crate) const SNIPPET_SQL_PROJECTION: &str =
    "snippet(fts_blocks, 1, '\u{E000}', '\u{E001}', '…', 32) as snippet";

// ---------------------------------------------------------------------------
// Per-FTS-query timing thresholds
// ---------------------------------------------------------------------------

/// Per-FTS-query wall-time threshold at which [`fts_fetch_rows`] emits
/// an `info!` breadcrumb. 200 ms is a **round design figure** chosen to
/// sit comfortably above a warm-cache FTS5 trigram scan yet well below
/// the 1 s `warn!` budget — it surfaces "the cache is cold and the query
/// is doing real work" without spamming on every keystroke. It is a
/// Log-only breadcrumb, not a budget the code enforces.:
/// this is a design figure, not a benchmarked value; see
/// `benches/fts_bench.rs` if you want to derive a measured floor.
///
/// [`fts_fetch_rows`]: super::fetch::fts_fetch_rows
pub(crate) const FTS_QUERY_INFO_MS: u128 = 200;

/// Per-FTS-query wall-time threshold at which [`fts_fetch_rows`] emits
/// A `warn!`. 1 s is a **round design figure**
/// (the design's recommended ceiling), NOT a benchmarked value;
/// the earlier "measured starting point" wording overstated its
/// provenance. It is log-only — nothing aborts at this threshold. If CI
/// runners observe legitimate cold-cache scans crossing this floor on the
/// 10k-block bench fixture (`benches/fts_bench.rs::bench_search_fts` at
/// `count=10_000`), derive the new value from the observed worst-case +
/// 3× headroom and document the bump here.
///
/// [`fts_fetch_rows`]: super::fetch::fts_fetch_rows
pub(crate) const FTS_QUERY_WARN_MS: u128 = 1_000;

// ---------------------------------------------------------------------------
// FTS5 search
// ---------------------------------------------------------------------------

/// Maximum number of results returned from a single search query, regardless
/// of the client-supplied page limit.  Prevents unbounded result sets.
///
/// Phase 1 — also used by [`search_fts_partitioned`] as the
/// ceiling on the combined `page_limit + block_limit` fetch.
///
/// BE-2 — re-exported via `crate::fts` so the partitioned IPC
/// command can validate `page_limit` / `block_limit` against the same
/// ceiling and **reject** (not silently cap) an over-limit request,
/// matching the cursor path's `PageRequest::new` contract.
///
/// [`search_fts_partitioned`]: super::partitioned::search_fts_partitioned
pub(crate) const MAX_SEARCH_RESULTS: i64 = 100;

/// Maximum byte length of a raw FTS query string.
///
/// The regex-mode path already rejects patterns over [`MAX_PATTERN_LEN`]
/// (1 KiB) up front via `build_regex`; the FTS path had no equivalent
/// guard, so a pathological multi-megabyte query string was tokenised,
/// NFC-normalised, sanitised, and bound into a MATCH expression before
/// SQLite rejected it (wasting CPU on the normalise/tokenise walk and
/// risking a confusing low-level FTS5 error). 4 KiB is comfortably above
/// any realistic hand-typed or paste-built query (the longest structured
/// query the search-query DSL emits is a few hundred bytes) while keeping
/// the up-front work bounded. Measured in bytes (`str::len`) to bound the
/// allocation work, not in scalar count.
///
/// [`MAX_PATTERN_LEN`]: crate::fts::toggle_filter::MAX_PATTERN_LEN
pub(crate) const MAX_QUERY_LEN: usize = 4 * 1024;
