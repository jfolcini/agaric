# PEND-34 — page-link picker progressive alias filtering

## TL;DR

The `[[` page-link picker (and the `PageBrowser` / `SearchPanel` filters,
out-of-scope here) currently only surfaces an alias when the user has
typed the **entire** alias text. Typing one character at a time never
narrows by alias — only by page title. This kills aliases as a discovery
affordance: an alias only "works" if you already remember it in full,
defeating its purpose as a shortcut.

User feedback (verbatim): *"when writing [[ and writing a page's name,
the alias is considered but only when writing it completely, no
progressive filtering, we should improve on that as it makes discovery
easier."*

This plan replaces the single exact-match alias call with a
**prefix-indexed alias search**, so every keystroke after `[[` narrows
both titles **and** aliases. It mirrors the existing
`list_tags_by_prefix` pattern used by the `#` picker.

Cost: **S** (~3–5 h). Risk: **low** (additive backend command + one
hot-path frontend swap; existing `resolvePageByAlias` stays for
out-of-picker callers). Impact: **medium** (alias becomes a real
autocomplete affordance, not a memorise-or-lose puzzle).

## Current behaviour — where the gap is

`searchPages` is the picker's data source for `[[`. It runs three
strategies in sequence:

<ref_snippet file="/home/javier/dev/agaric/src/hooks/useBlockResolve.ts" lines="309-337" />

1. **Title match** via `searchPagesViaCache` (q.length ≤ 2) or
   `searchPagesViaFts` (q.length ≥ 3). Both match titles only — aliases
   are not indexed in `fts_blocks` and not stored in the
   `pagesListRef` cache.
2. **Exact alias match** via `tryPrependAliasMatch` →
   `resolvePageByAlias(q)`:

   <ref_snippet file="/home/javier/dev/agaric/src/hooks/useBlockResolve.ts" lines="146-167" />

   The Rust side does an exact, case-insensitive lookup:

   <ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/pages.rs" lines="120-137" />

3. **Create-new-page** affordance, appended last by
   `appendCreatePageOptionIfNeeded`.

Because step 2 is exact-only, an alias `weekly-meeting-2025-q2` (on a
page titled `WGM`) never surfaces until the user has typed all 22
characters. The page does not match by title (`wee*` is not in `WGM`)
and FTS does not index aliases at all (verified — `page_aliases` is not
referenced anywhere under `src-tauri/src/fts/`).

The same gap exists in:

- `src/components/PageBrowser.tsx` — `resolvePageByAlias(filterText)` at
  <ref_snippet file="/home/javier/dev/agaric/src/components/PageBrowser.tsx" lines="141-161" />
- `src/components/SearchPanel.tsx` — `resolvePageByAlias(debouncedQuery)`
  at <ref_snippet file="/home/javier/dev/agaric/src/components/SearchPanel.tsx" lines="192-234" />

This plan fixes the picker only. PageBrowser + SearchPanel adoption is
called out in **Out of scope / follow-ups** below.

## Proposed fix

Add one new prefix-indexed Tauri command, `list_page_aliases_by_prefix`,
that mirrors the existing `list_tags_by_prefix` shape (already a
prefix-LIKE-against-an-indexed-column pattern, see
<ref_snippet file="/home/javier/dev/agaric/src-tauri/src/tag_query/query.rs" lines="117-137" />).

Replace `tryPrependAliasMatch` with `mergeAliasPrefixMatches` in
`useBlockResolve.ts`. The new helper:

1. Calls the prefix command with `q` and `limit = 50`.
2. Folds returned aliases into the existing match list — deduped by
   `pageId`, prepended in order so alias hits stay above title hits
   (existing priority).
3. Carries the matched alias text on the `PickerItem` so the input rule
   (`[[text]]`) can still detect when `text` is exactly an alias and
   resolve unambiguously.

Backend: O(log N) using the existing `idx_page_aliases_alias` index.
Frontend: replaces a single round trip with a single round trip — no
extra latency, just a different SQL shape.

## Concrete diff — backend

### 1. New inner helper: `list_page_aliases_by_prefix_inner`

In `src-tauri/src/commands/pages.rs`, alongside the existing
`resolve_page_by_alias_inner`:

```rust
const MAX_PAGE_ALIASES_PREFIX: i64 = 50;

/// List page aliases whose alias starts with `prefix` (case-insensitive,
/// `COLLATE NOCASE` matches the index on `page_aliases.alias`).
///
/// Returns `(page_id, alias, title)` rows so the frontend can render
/// "Page Title (alias: pp)" without a second round trip per match.
///
/// Bounded by `MAX_PAGE_ALIASES_PREFIX` to keep the popup responsive
/// even if a user has hundreds of single-letter-prefixed aliases.
#[instrument(skip(pool), err)]
pub async fn list_page_aliases_by_prefix_inner(
    pool: &SqlitePool,
    prefix: &str,
    limit: Option<i64>,
) -> Result<Vec<(String, String, Option<String>)>, AppError> {
    let like_pattern = format!("{}%", crate::sql_utils::escape_like(prefix));
    let effective_limit = limit.unwrap_or(MAX_PAGE_ALIASES_PREFIX);
    let rows = sqlx::query_as::<_, (String, String, Option<String>)>(
        "SELECT pa.page_id, pa.alias, b.content \
         FROM page_aliases pa \
         JOIN blocks b ON b.id = pa.page_id \
         WHERE pa.alias LIKE ?1 ESCAPE '\\' COLLATE NOCASE \
           AND b.deleted_at IS NULL \
         ORDER BY length(pa.alias), pa.alias \
         LIMIT ?2",
    )
    .bind(like_pattern)
    .bind(effective_limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
```

Notes:

- `escape_like` (already in `src-tauri/src/sql_utils.rs`) escapes `%`,
  `_`, `\` so a user-typed `_` doesn't act as a wildcard. Tag-prefix
  uses the same helper.
- `COLLATE NOCASE` makes the prefix match case-insensitive and lets
  SQLite use `idx_page_aliases_alias` (index is on `(alias COLLATE
  NOCASE)`, see migration 0015).
- `ORDER BY length(pa.alias), pa.alias` — shortest-alias first puts the
  exact match (when typed in full) at the top, then alphabetical.
  Alternatives considered:
  - `ORDER BY pa.alias` (lexicographic only) — simpler but exact match
    could be buried.
  - Two-pass ordering with `CASE WHEN pa.alias = ?1 THEN 0 ELSE 1 END`
    — more readable but adds a second bound parameter.
  Picked length-then-alias for readability; if SQLite skips the index
  on `length()` ordering in EXPLAIN QUERY PLAN, fall back to the CASE
  form (verify in Phase 0 spike — see Open Questions Q1).
- **`sqlx::query_as!` vs `query_as::<_>`** — the macro form is preferred
  per AGENTS.md ("sqlx compile-time queries"), but it requires a typed
  struct. The above uses the dynamic form for brevity in the plan;
  the actual implementation should define a `PageAliasPrefixRow`
  newtype and use `query_as!` (and re-run `cargo sqlx prepare` to
  refresh `.sqlx/`).

### 2. Tauri command + specta registration

In `src-tauri/src/commands/pages.rs`:

```rust
/// Tauri command: list page aliases by prefix.
/// Delegates to [`list_page_aliases_by_prefix_inner`].
#[cfg(not(tarpaulin_include))]
#[tauri::command]
#[specta::specta]
pub async fn list_page_aliases_by_prefix(
    read_pool: State<'_, ReadPool>,
    prefix: String,
    limit: Option<i64>,
) -> Result<Vec<(String, String, Option<String>)>, AppError> {
    list_page_aliases_by_prefix_inner(&read_pool.0, &prefix, limit)
        .await
        .map_err(sanitize_internal_error)
}
```

In `src-tauri/src/commands/mod.rs`:

- Re-export `list_page_aliases_by_prefix`,
  `list_page_aliases_by_prefix_inner`, and the `__specta__fn__…` shim
  alongside the existing alias commands.

In `src-tauri/src/lib.rs`, inside the `agaric_commands![]` macro list:

```diff
   $crate::commands::set_page_aliases,
   $crate::commands::get_page_aliases,
   $crate::commands::resolve_page_by_alias,
+  $crate::commands::list_page_aliases_by_prefix,
```

### 3. Tests (Rust)

Co-locate with the existing alias tests in
`src-tauri/src/commands/tests/page_cmd_tests.rs`. Mirror the
`list_tags_by_prefix_inner_*` test trio
(<ref_snippet file="/home/javier/dev/agaric/src-tauri/src/commands/tests/tag_cmd_tests.rs" lines="293-355" />):

- `list_page_aliases_by_prefix_inner_returns_matching` — three pages
  with three aliases; query `"work-"` returns the two work-prefixed.
- `list_page_aliases_by_prefix_inner_case_insensitive` — alias stored as
  `MyAlias`, prefix `"myAL"` matches.
- `list_page_aliases_by_prefix_inner_excludes_deleted_pages` — soft-
  delete the parent block, alias must not appear (mirrors the
  `b.deleted_at IS NULL` clause in the query).
- `list_page_aliases_by_prefix_inner_respects_limit` — 5 aliases,
  `limit=2` returns 2.
- `list_page_aliases_by_prefix_inner_orders_shortest_first` — pages
  with aliases `pp`, `ppp`, `pproject`; query `"pp"` returns in length
  order.
- `list_page_aliases_by_prefix_inner_escapes_like_metachars` — alias
  literally containing `_` or `%`; query the literal does NOT match
  unrelated aliases (proves `escape_like` is wired). Mirrors PERF-27's
  `filter_property_text_contains_pushed_into_sql` pattern.

## Concrete diff — frontend

### 1. `tauri.ts` wrapper (parity hook compliance)

In `src/lib/tauri.ts`, alongside `resolvePageByAlias`:

```ts
/**
 * List page aliases whose alias starts with the given prefix, ordered
 * shortest-alias first, then alphabetical. Bounded server-side at 50.
 *
 * Used by the [[ picker for progressive alias filtering. The exact-
 * match `resolvePageByAlias` is still used by SearchPanel /
 * PageBrowser (out of scope here — see PEND-34 follow-ups).
 */
export async function listPageAliasesByPrefix(params: {
  prefix: string
  limit?: number | undefined
}): Promise<Array<[string, string, string | null]>> {
  return unwrap(
    await commands.listPageAliasesByPrefix(params.prefix, params.limit ?? null),
  )
}
```

The PEND-08 parity hook
(`scripts/check-tauri-bindings-parity.mjs`) requires every new specta
binding to have a matching `tauri.ts` wrapper or an entry on the
allowlist. Adding the wrapper is the no-allowlist-touch path.

### 2. `PickerItem` carries the matched alias text

In `src/editor/SuggestionList.tsx`:

```diff
 export interface PickerItem {
   id: string
   label: string
   /** When true, selecting this item creates a new page instead of linking to an existing one. */
   isCreate?: boolean
-  /** When true, this item was matched via page alias (not direct title). */
+  /**
+   * When true, this item was matched via a page alias (not direct
+   * title). Used for visual differentiation only — exact-vs-prefix
+   * disambiguation lives on `aliasText`.
+   */
   isAlias?: boolean
+  /**
+   * The actual alias text that matched (e.g. "pp"). Set on every
+   * alias-source result, exact and prefix alike. Used by the
+   * `[[text]]` input rule to tell whether the typed text is exactly
+   * an alias and should auto-resolve, vs. a prefix that should not.
+   */
+  aliasText?: string
   ...
 }
```

### 3. Replace `tryPrependAliasMatch` with `mergeAliasPrefixMatches`

In `src/hooks/useBlockResolve.ts`:

```ts
/**
 * Alias-prefix strategy: looks up the query against the page-aliases
 * table by prefix and folds matches into the result list.
 *
 * Each alias hit becomes its own picker item — a page with two
 * matching aliases under the same prefix shows twice (one per alias)
 * so the user sees which alias they're matching. Same-page dedupe
 * against the title strategy still applies (an alias hit is dropped
 * when the page is already in `matches` via title match).
 *
 * Failure is logged at warn level — alias-service failure must never
 * abort the picker (see H-10 / H-11).
 */
async function mergeAliasPrefixMatches(
  matches: PickerItem[],
  q: string,
): Promise<void> {
  if (q.length === 0) return
  try {
    const rows = await listPageAliasesByPrefix({ prefix: q, limit: 50 })
    if (rows.length === 0) return

    const existingPageIds = new Set(matches.filter((m) => !m.isCreate).map((m) => m.id))
    const aliasItems: PickerItem[] = []
    for (const [pageId, alias, title] of rows) {
      if (existingPageIds.has(pageId)) continue
      existingPageIds.add(pageId)
      aliasItems.push({
        id: pageId,
        label: `${title ?? 'Untitled'} (alias: ${alias})`,
        isAlias: true,
        aliasText: alias,
      })
    }
    // Prepend in returned order (shortest-alias first → exact match first).
    matches.unshift(...aliasItems)
  } catch (err) {
    logger.warn('useBlockResolve', 'alias prefix lookup failed', { query: q }, err)
  }
}
```

Wire-up in `searchPages`:

```diff
       populatePageResolveCache(matches)
-      await tryPrependAliasMatch(matches, q)
+      await mergeAliasPrefixMatches(matches, q)
       appendCreatePageOptionIfNeeded(matches, query, q, pagesListRef)
```

Drop `tryPrependAliasMatch` and the `resolvePageByAlias` import from
`useBlockResolve.ts`. The exact-match command stays in `tauri.ts` for
SearchPanel / PageBrowser callers.

### 4. `resolveAndInsertBlockLink` — refine the exact-match check

In `src/editor/extensions/block-link-picker.ts`:

```diff
   try {
     const items = await options.items(text)
-    // Look for an exact match (case-insensitive) or an alias match
-    const exactMatch = items.find(
-      (item) => !item.isCreate && (item.label.toLowerCase() === text.toLowerCase() || item.isAlias),
-    )
+    // Look for an exact match: case-insensitive label OR exact alias
+    // text. With prefix-alias matching now in `searchPages`, multiple
+    // items can carry `isAlias: true` for prefixes that aren't `text`
+    // exactly — only the alias whose `aliasText === text` should
+    // auto-resolve from the input rule / selection-resolve path.
+    const lower = text.toLowerCase()
+    const exactMatch = items.find(
+      (item) =>
+        !item.isCreate &&
+        (item.label.toLowerCase() === lower ||
+          item.aliasText?.toLowerCase() === lower),
+    )
```

Rationale: the existing `|| item.isAlias` short-circuit was added (per
session-log batch 80) so `[[my-alias]]` typed in full would resolve to
the aliased page even though the page label includes `(alias: my-alias)`
and so doesn't equal the typed text. With prefix matching that
short-circuit becomes unsafe — typing `[[my]]` would now pick the first
prefix-alias hit (e.g. `my-favourite-page`) instead of falling through
to the create-page or no-match branch. Using `aliasText` preserves the
original intent without the false positive.

### 5. Tests (frontend)

In `src/hooks/__tests__/useBlockResolve.test.ts`:

- Mock `listPageAliasesByPrefix` (replacing the existing
  `resolvePageByAlias` mocks in the alias-block).
- `searchPages prepends every alias prefix match in returned order` —
  query `"w"`, mock returns `[("PAGE_A","wgm","WGM"), ("PAGE_B","weekly","Weekly Review")]`,
  assert items[0..1] are both `isAlias: true` with the right
  `aliasText` and labels.
- `searchPages dedupes alias match when page already present from FTS`
  — FTS returns a page; alias prefix returns the same page id; result
  contains the FTS row only, no alias dupe.
- `searchPages alias prefix lookup failure does not abort picker` —
  service throws, items still contain title matches + create option.
- Update existing alias tests to drop `resolvePageByAlias` mocking (or
  keep them as separate "exact-match command still works" tests for
  the SearchPanel/PageBrowser path, since `resolvePageByAlias` lives
  on in `tauri.ts`).

In `src/editor/__tests__/block-link-picker.test.ts`:

- `[[my-alias]] input rule resolves to alias target` — items include
  `{ id: 'PAGE', label: 'WGM (alias: my-alias)', isAlias: true,
  aliasText: 'my-alias' }`; type `[[my-alias]]`; assert `block_link`
  with `id: 'PAGE'`.
- `[[my]] input rule does NOT resolve to a prefix-alias hit` — same
  items but typed `[[my]]`; assert plain text "my" is left in place
  (or new page created if `onCreate` is set), **not** auto-resolved
  to the alias-prefix hit. This is the regression guard against the
  current `|| item.isAlias` fallthrough.

In `src/editor/__tests__/extensions.test.ts`:

- The alias-related fixtures may need their item mocks extended with
  `aliasText` to keep the existing tests green.

## PickerItem semantics — exact vs prefix alias

| Field | Set when | Used for |
| --- | --- | --- |
| `isAlias: true` | The result row came from the alias prefix command (any match, exact or not) | Visual differentiation in the popup (today's behaviour) |
| `aliasText: string` | Same — the alias text that matched (`"pp"`, `"my-alias"`, …) | `resolveAndInsertBlockLink` exact-match disambiguation |

`[[text]]` input rule:

- `text === aliasText` → auto-resolve to that page.
- `text === label` (case-insensitive title match) → auto-resolve.
- Otherwise → fall through to `onCreate` (if set) or plain-text
  re-insert.

Picker popup (live `[[`):

- All alias prefix hits are listed at the top, shortest-alias first.
- Title matches follow.
- Create-new-page is appended last (existing behaviour).

## UI rendering — labels

The existing alias label format `"${title} (alias: ${q})"` works for
the exact-match case but reads oddly for prefix matches: the popup
would show `Project Plan (alias: p)` mid-typing. Two options:

a) **Keep label format constant.** `${title ?? 'Untitled'} (alias:
   ${alias})` — always show the actual alias, not the typed query.
   Reads well at every keystroke.
b) **Drop the parenthetical for prefix matches.** Show `Project Plan`
   with a small `alias` badge next to the icon. Cleaner visually but
   needs a `SuggestionList` render-path change.

**Recommendation: (a)** for v1 — zero `SuggestionList` changes, label
self-documents. Revisit (b) as a follow-up UX pass if the
parenthetical proves cluttered.

## Out of scope / follow-ups (explicit)

| # | Item | Why |
| --- | --- | --- |
| 1 | Migrate `PageBrowser` (alias filter) to `listPageAliasesByPrefix` | Same UX gap, but on a non-picker surface. Trivial follow-up after this lands. File `MAINT-…`. |
| 2 | Migrate `SearchPanel` (single alias card above FTS results) to prefix matching | Same. SearchPanel currently shows one card; the prefix flavour would let it show several. Defer to a small follow-up. |
| 3 | Substring (not prefix) alias match | A LIKE `'%q%'` form bypasses the index. Worth considering if users find prefix-only too restrictive once shipped, but unjustified up-front. |
| 4 | Index aliases into `fts_blocks` | Heavier (trigger + rebuild); unnecessary once the prefix command exists. |
| 5 | Unicode-fold the alias-prefix LIKE so `caf` matches `café-notes` | Current `COLLATE NOCASE` is ASCII-only. Mirrors the gap in `searchPagesViaCache` (which does fold via `matchesSearchFolded`). File MAINT if asked. |
| 6 | Alias badge UI redesign (option (b) above) | Pure visual polish; deferred. |
| 7 | Keyboard shortcut to "show all aliases for the highlighted page" | Discovery aid for users who forget aliases. Not requested. |

## Cost / risk / impact

- **Cost: S (~3–5 h).** Backend command + 6 inner tests (~2 h),
  frontend wrapper + helper rewrite + 4 hook tests + 2 input-rule
  tests (~2 h), specta + parity-hook + `.sqlx/` regen (~30 min).
- **Risk: low.** Additive backend command (no migration, no schema
  change). Frontend swap is one helper + one input-rule check
  refinement; the existing `resolvePageByAlias` command and its
  callers are untouched. Existing alias tests only need their mocks
  retargeted.
- **Impact: medium.** Aliases stop being write-only memorisation
  shortcuts and become a real autocomplete affordance. Mirrors how
  the `#` picker already works for tag prefixes — closes a UX
  asymmetry between the two pickers.

## Open questions

1. **Index usage on `length(alias)` ordering.** Verify with `EXPLAIN
   QUERY PLAN` that SQLite uses `idx_page_aliases_alias` for the LIKE
   prefix scan even with `ORDER BY length(pa.alias), pa.alias`. If
   it does a sort, fall back to either `ORDER BY pa.alias` (pure
   index ordering) or the `CASE WHEN pa.alias = ?1 THEN 0 ELSE 1 END,
   pa.alias` form. Phase 0 spike (~15 min) covers this before the
   query SHA goes into `.sqlx/`.
2. **Should the prefix command also return non-alias-table title
   matches that *contain* the query as a substring of an alias?** No —
   that's the responsibility of FTS / cache strategies; mixing
   responsibilities in one command makes it harder to reason about.
   (Decided: keep the command tightly scoped to `page_aliases`.)
3. **Should the prefix command honour the active-space filter
   (FEAT-3)?** The other picker strategies do (`searchBlocks` /
   `listBlocks` both bind `spaceId`). Aliases are stored without a
   space column; the page they point to has one. Adding the filter
   would require a `JOIN blocks b ON b.id = pa.page_id` (already in
   the query) plus a `space = ?` predicate on `b`. **Recommendation:
   yes, scope to active space** — consistent with the rest of the
   picker. Add `space_id: Option<String>` parameter on the inner +
   outer commands; bind via the same `(? IS NULL OR b.space = ?)`
   short-circuit pattern used elsewhere. Cost: +15 min, +1 test.
4. **Should the picker show how many other aliases a page has?** E.g.
   `Project Plan (alias: pp, +2 more)`. Useful for power users; nice-
   to-have. Defer.

## Verification

- `cd src-tauri && cargo nextest run -E 'test(list_page_aliases_by_prefix)'`
  — the 6 new inner tests pass.
- `npm run test -- useBlockResolve` — the rewritten alias tests pass.
- `npm run test -- block-link-picker` — input-rule regression guard
  (`[[my]]` does NOT pick a prefix-alias) passes.
- `prek run --all-files` — `ts_bindings_up_to_date` and
  `tauri-bindings-parity` hooks both green (specta + wrapper added).
- Manual smoke (dev): create page `WGM` with alias `weekly-meeting`;
  type `[[w` → see `WGM (alias: weekly-meeting)` in the popup at every
  keystroke through `[[weekly-meeting`.
