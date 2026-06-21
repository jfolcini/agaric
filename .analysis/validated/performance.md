# Validation — Performance & Scalability (Agaric)

**Verdict tally**: CONFIRMED 4 · CONFIRMED-BUT-RESEVERITY 2 · EXAGGERATED 2 · ALREADY-HANDLED 0 · HALLUCINATED 0 · OUT-OF-SCOPE 0
(9 findings total; one minor location error noted, not a hallucination.)

The raw report is unusually disciplined and honest — it pre-flags React Compiler interaction and bounds every impact claim. Every cited mechanism checks out against code. The main corrections are downward on the two `tags_cache`/markdown findings whose impact the report itself already hedged.

---

## Backend findings

### [MEDIUM→LOW] Tag-prefix `LIKE … ESCAPE '\'` defeats the LIKE-to-range index optimization
- **Verdict**: CONFIRMED-BUT-RESEVERITY → **LOW**
- **Evidence checked**: `tag_query/resolve.rs:96` (`format!("{}%", escape_like(prefix))`), the unconditional `ESCAPE '\'` in all 5 UNION arms (resolve.rs:103/110/117/130/137) and in `prefix_leaf_subquery_body` (resolve.rs:199-223); index `idx_tags_cache_name_nocase ON tags_cache(name COLLATE NOCASE)` confirmed in migrations 0050 + 0061; `escape_like` (sql_utils.rs:17-29) escapes only `\ % _`, so for a metachar-free prefix `escaped == prefix` (the proposed fast-path condition is sound). The SQLite mechanism (ESCAPE disables the LIKE range rewrite) is correctly stated.
- **Why LOW not MEDIUM**: the report's own impact paragraph defeats the MEDIUM. `tags_cache` is one row per distinct tag in the user's vocabulary — tens to low hundreds even for large vaults. A full scan of a ~100-row, NOCASE-indexed table that's almost certainly resident in page cache is microseconds; it does not scale with vault size (block count), only with distinct-tag count. This is a code-cleanliness / "honor the index intent" issue, not a perceptible latency one.
- **Better-approach note**: report's fix is correct (emit `LIKE 'prefix%'` without ESCAPE when `escape_like(prefix) == prefix`). But it touches the single-source `prefix_leaf_subquery_body` consumed by the #414 fast path + drift guard, so it's not a trivial string swap — both the `&'static str` body and the `resolve_tag_prefix_leaves` direct queries would need a branched variant. Effort is realistically S-M, and the payoff is small. **Worth filing only as a LOW good-first-issue with `EXPLAIN QUERY PLAN` before/after.**

### [LOW] `resolve_expr` `Not` fallback materializes the non-deleted block universe
- **Verdict**: CONFIRMED (LOW correct)
- **Evidence checked**: resolve.rs:389-410 — exactly as described: empty inner-set arm runs `SELECT id FROM blocks WHERE deleted_at IS NULL` into Rust; non-empty arm ships JSON and runs `NOT IN (SELECT value FROM json_each(?))`. Report correctly notes this is the fallback oracle for trees exceeding pushdown depth, with `compile_candidate_subquery` keeping the keyset in SQL for the common path.
- **Note**: Real, but genuinely a fallback. Report self-rates it LOW and says "no fix required." Agree. **Not worth filing** — it's a recorded curiosity, not an actionable issue.

### [LOW] Advanced-query `DateBucket{Created|LastEdited}` correlated op_log aggregate per row
- **Verdict**: CONFIRMED (LOW correct)
- **Evidence checked**: engine.rs:1180-1185 — `strftime(fmt, (SELECT MIN/MAX(created_at) FROM op_log WHERE block_id = b.id)/1000, 'unixepoch')` in `group_key_expr`. The contrast is real: the flat sort path hoists this into `LEFT JOIN (SELECT block_id, MAX(created_at) … GROUP BY block_id)` in `SortJoins::sql` (engine.rs:110-116), proving the codebase knows the better shape. `idx_op_log_block_id` exists, so each correlation is an indexed seek.
- **Note**: Real and the fix (reuse the pre-aggregated join) is principled and low-risk. Severity LOW is right — grouped-by-date queries only, indexed seeks not scans. The report's own confidence note (SQLite may hoist the invariant subquery) is fair. **Marginally file-worthy** as a consistency/perf cleanup; verify with EQP first.

---

## Frontend findings

### [MEDIUM→LOW] `blockActions` context bag busted by two inline-arrow wrappers
- **Verdict**: EXAGGERATED (mechanism real; net impact small) → effective **LOW**
- **Evidence checked**: `BlockTree.tsx:900` (`onDuplicate: (blockId) => void handleDuplicate(blockId)`) and `:904` (`onBatchDelete: () => void handleBatchDelete()`) are inline arrows in the bag object. The memo is in `src/components/block-tree/use-block-tree-context-bags.ts` (report's path `src/editor/use-block-tree-context-bags.ts` is **wrong** — minor location error, not a hallucination; consumed at BlockTree.tsx:883 via `useBlockTreeContextBags`, published at :987). Comment at BlockTree.tsx:209 explicitly acknowledges this exact hazard ("bust the `blockActions` context bag (re-rendering every memoized row)").
- **Why downgrade**: React Compiler is confirmed ON (`vite.config.ts:74`, `compilationMode: 'infer'`, target 19, default unless `REACT_COMPILER=0`). The compiler memoizes the inline arrows keyed on the stable `handleDuplicate`/`handleBatchDelete` callbacks, very likely making this a no-op in production builds — the report says exactly this and lowers its own confidence. So the "all rows re-render on drag" impact is probably not real in shipped builds.
- **Better-approach**: still wrap both in `useCallback` (matches every other handler, removes compiler dependence, fixes dev-mode/compiler-off). Cheap. **File as LOW cleanup**, not MEDIUM perf.

### [MEDIUM] Per-keystroke full active-block markdown serialization
- **Verdict**: CONFIRMED (MEDIUM defensible; lean MEDIUM-low)
- **Evidence checked**: `use-roving-editor.ts:558-563` — `handleEditorUpdate` (fires on every TipTap `update`) calls `serialize(editor.getJSON(), …)` synchronously. Scope is the focused block's doc (single roving instance per invariant), not the page. Comment confirms it replaced the old 500ms poll (#536), so it genuinely runs per keystroke now.
- **Note**: This is the most defensible FE finding — it's NOT a React-render issue, so the compiler doesn't touch it. Per-keystroke `getJSON()` + serialize is O(active-block-size) on the keystroke path. Impact is bounded to one pathologically large block (big tables / many code fences). The fix (coalesce serialize into the existing rAF, or skip on unchanged doc version) is sound. **Most file-worthy FE finding.** Confirm with a large-block typing profile.

### [MEDIUM→LOW] `renderRichContent` called unmemoized in list/render bodies
- **Verdict**: EXAGGERATED → **LOW**
- **Evidence checked**: `DuePanel.tsx:536` (inside `.map`) and `BacklinkGroupRenderer.tsx:105` (per row) confirmed calling `renderRichContent(...)` unwrapped; the codebase convention of wrapping in `useMemo` is real (the report lists ~6 sites). Did not re-verify the parser-has-no-cache claim or BlockHistoryItem/PageTitleEditor lines, but the pattern is consistent.
- **Why downgrade**: same React-Compiler caveat — `compilationMode: 'infer'` memoizes these call expressions keyed on stable inputs, so production savings are plausibly near-zero (report concedes this and calls them "mainly convention inconsistencies"). Both cited live lists are pagination-bounded, not unbounded. **LOW convention cleanup**, profiler-gated.

### [LOW] Graph worker re-spawned on every filter toggle
- **Verdict**: CONFIRMED (LOW correct; lowest priority)
- **Evidence checked**: report cites an in-code comment documenting the re-spawn and an existing in-place `resize` handler to mirror. Did not open the worker file (low severity, explicitly self-described as an accepted future-tier item). Off-main-thread, no flicker. **Borderline file-worthy** — it's a known, documented accepted gap, so filing adds little.

### [LOW] Attachment export N+1 IPC (2N sequential invokes)
- **Verdict**: CONFIRMED (LOW correct)
- **Evidence checked**: `export-graph.ts:165-179` — `for (const id of ids) { await readAttachmentMeta(id); await readAttachment(id) }`, two sequential IPCs per attachment, exactly as described. Export-time only, off the interactive path.
- **Note**: Real but export-only and infrequent. Fix needs a new backend batch command (touches the "avoid new op-types" boundary lightly, though batch read commands are additive). **File-worthy as LOW** if export latency is ever reported.

---

## Net assessment — genuinely file-worthy, ranked

1. **Per-keystroke full active-block serialization** (use-roving-editor.ts:558) — LOW-MEDIUM. The one finding the React Compiler does NOT neutralize and that sits on an interactive path. Worth a profiler check + rAF coalescing. Best candidate.
2. **DateBucket correlated op_log aggregate** (engine.rs:1180) — LOW. Clean, principled fix already templated by `SortJoins`; verify with EQP.
3. **Attachment export N+1** (export-graph.ts:166) — LOW. Real, simple, off hot path.
4. **`blockActions` inline-arrow `useCallback` fix** (BlockTree.tsx:900/904) — LOW cleanup. Do it for consistency regardless of compiler.
5. **LIKE/ESCAPE range-optimization** (resolve.rs:96) — LOW good-first-issue. Correct mechanism, but impact bounded by tiny `tags_cache`; only with EQP confirmation.

**Drop / don't file**: `resolve_expr` Not fallback (oracle path, no-fix-needed), graph-worker re-spawn (documented accepted future-tier), and `renderRichContent` unmemoized (compiler likely neutralizes; pure convention).

**Killed/corrected**: no hallucinations. Two MEDIUMs downgraded to LOW on the report's own bounded-impact reasoning (LIKE/ESCAPE: tiny table; blockActions + renderRichContent: React Compiler very likely makes them no-ops in prod). One minor wrong file path (context-bags file is under `src/components/block-tree/`, not `src/editor/`).
