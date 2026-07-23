/**
 * Tauri mock handlers -- Page listing, metadata query, creation, aliases, markdown import/export.
 *
 * Split out of the former monolithic `handlers.ts` (#2931). Every handler
 * body below is UNCHANGED from the original -- only relocated. Shared
 * mutable mock state (`blocks`, `opLog`, `properties`, ...) and cross-domain
 * helpers come from `./shared` / `@/lib/tauri-mock/seed`, the single source
 * every domain module reads and writes -- there is no per-domain copy of any
 * store.
 */

import {
  type PageMetaRow,
  type TypedHandlers,
  appErrorRejection,
  buildPageMetaRow,
  compareMetaRows,
  deriveLinkEdges,
  encodeNextCursor,
  metaRowMatchesFilter,
  notFoundRejection,
  sortDiscriminator,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import {
  blockTags,
  blocks,
  fakeId,
  makeBlock,
  pageAliases,
  properties,
  pushOp,
} from '@/lib/tauri-mock/seed'

export const pagesHandlers = {
  // Indexed lookup for a single date-formatted journal page in
  // the active space. Real backend implementation: a SELECT on
  // `idx_blocks_journal_date` with a `space` ref-property subquery.
  get_journal_page_by_date: (args) => {
    const a = args as Record<string, unknown>
    const date = a['date'] as string
    // b1 — IPC arg is now `scope: SpaceScope`. Recover the active space
    // id; a `global` scope yields `null`, which the loop treats as a
    // no-match filter (the backend rejects Global via `require_active`).
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      if (b['content'] !== date) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      return b
    }
    return null
  },

  // Follow-up: list date-formatted journal pages in the active
  // space whose date falls in `[startDate, endDate]`. The real backend
  // uses the `idx_blocks_journal_date` partial index plus a content
  // range predicate so this is O(visible-days).
  list_journal_pages_in_range: (args) => {
    const a = args as Record<string, unknown>
    const startDate = a['startDate'] as string
    const endDate = a['endDate'] as string
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const datePattern = /^\d{4}-\d{2}-\d{2}$/
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const content = b['content'] as string | null
      if (!content || !datePattern.test(content)) continue
      if (content < startDate || content > endDate) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      items.push(b)
    }
    items.sort((x, y) =>
      ((x['content'] as string) ?? '').localeCompare((y['content'] as string) ?? ''),
    )
    return items
  },

  // Every page in the active space as `{ id, content }`.  No pagination,
  // no clamp — bounded by the space's intrinsic page count.  Backs
  // `exportGraphAsZip` and graph rendering.
  //
  // `tagIds`, when non-empty, restricts the result to pages carrying at
  // least one of those tags via the direct `block_tags` table (mock
  // models direct tags only — same surface as the real backend's
  // direct-tag filter; inherited tags intentionally not modelled here).
  list_all_pages_in_space: (args) => {
    const a = args as Record<string, unknown>
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const rawTagIds = a['tagIds'] as string[] | null | undefined
    const tagFilter = rawTagIds && rawTagIds.length > 0 ? new Set(rawTagIds) : null
    const items: Array<{ id: string; content: string | null }> = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      const spaceProp = blockProps?.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      if (tagFilter) {
        const tagsForBlock = blockTags.get(b['id'] as string)
        if (!tagsForBlock) continue
        let hit = false
        for (const t of tagsForBlock) {
          if (tagFilter.has(t)) {
            hit = true
            break
          }
        }
        if (!hit) continue
      }
      items.push({ id: b['id'] as string, content: (b['content'] as string | null) ?? null })
    }
    items.sort((x, y) => {
      const c = (x.content ?? '').toLowerCase().localeCompare((y.content ?? '').toLowerCase())
      return c !== 0 ? c : x.id.localeCompare(y.id)
    })
    return items
  },

  // Every active descendant under `rootBlockId` (one SELECT via the
  // materializer-maintained `page_id` index in production). Replaces
  // the FE-side recursive `listBlocks` walk.
  load_page_subtree: (args) => {
    const a = args as Record<string, unknown>
    const rootBlockId = a['rootBlockId'] as string
    // b1 — `scope: SpaceScope`. `global` → null (backend rejects Global
    // via `require_active`); the membership check below then throws.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    // Space-membership check — mirrors the backend.
    const rootProps = properties.get(rootBlockId)
    const rootSpace = rootProps?.get('space')
    if (rootSpace?.['value_ref'] !== spaceId) {
      // #2463 / #2810 — mirrors `load_page_subtree_inner`'s `Validation`
      // rejection (`src-tauri/src/commands/pages/listing.rs`), not
      // `not_found`; carries the structured `PageNotInSpace` code the
      // frontend's `page-blocks.ts` `load()` heal keys on.
      throw appErrorRejection({
        kind: 'validation',
        code: 'PageNotInSpace',
        message: `block '${rootBlockId}' not in current space '${spaceId}'`,
      })
    }
    const items: Record<string, unknown>[] = []
    for (const b of blocks.values()) {
      if (b['id'] === rootBlockId) continue
      if (b['deleted_at']) continue
      if (b['page_id'] !== rootBlockId) continue
      items.push(b)
    }
    items.sort((x, y) => {
      const px = (x['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      const py = (y['position'] as number | null) ?? Number.MAX_SAFE_INTEGER
      if (px !== py) return px - py
      return (x['id'] as string).localeCompare(y['id'] as string)
    })
    // #1258 — backend returns `{ blocks, truncated, total }` (see
    // `PageSubtree`). The mock never exceeds the 10k cap, so `truncated`
    // is always false and `total === items.length`.
    return { blocks: items, truncated: false, total: items.length }
  },

  // Paginated page list with per-page metadata columns.
  // Mock parity with `list_pages_with_metadata_inner`: returns the same
  // shape as the backend (BlockRow columns + last_modified_at +
  // inbound_link_count + child_block_count + has_property_flags), sorts
  // by the requested mode, and cursor-paginates using the same keyset
  // shape (cursor.deleted_at = last sort-key string, cursor.seq = last
  // sort-key i64, cursor.id = tiebreaker).
  list_pages_with_metadata: (args) => {
    const a = args as Record<string, unknown>
    const filter = (a['filter'] as Record<string, unknown> | undefined) ?? {}
    const spaceId = filter['spaceId'] as string
    const sort = (filter['sort'] as string | undefined) ?? 'alphabetical'
    const cursor = a['cursor'] as string | null
    const limit = Math.min(Number((a['limit'] as number | null) ?? 50), 100)

    // Block-link edges derived from `[[ULID]]` tokens (mock stand-in for the
    // backend's `block_links` table) so the link facets and `MostLinked` sort
    // reflect the seed's real topology.
    const edges = deriveLinkEdges(blocks)

    // Build the metadata-rich row for every page in the space.
    const rows: PageMetaRow[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page' || b['deleted_at']) continue
      if (properties.get(b['id'] as string)?.get('space')?.['value_ref'] !== spaceId) continue
      const descendants = Array.from(blocks.values()).filter(
        (d) => d['page_id'] === b['id'] && !d['deleted_at'] && d['id'] !== b['id'],
      )
      rows.push(buildPageMetaRow(b, descendants, edges))
    }

    // Phase 3 — AND-compose the requested filter primitives, then sort.
    const filters = (filter['filters'] as Array<Record<string, unknown>> | undefined) ?? []
    const matched = rows.filter((r) => filters.every((f) => metaRowMatchesFilter(r, f)))
    matched.sort((x, y) => compareMetaRows(x, y, sort))

    // Cursor: skip rows up to AND INCLUDING the cursor's anchor.
    let startIdx = 0
    if (cursor) {
      let decoded: Record<string, unknown> | null = null
      try {
        decoded = JSON.parse(atob(cursor)) as Record<string, unknown>
      } catch {
        // Malformed cursor: start from the top (mirrors a cursorless fetch).
        decoded = null
      }
      if (decoded) {
        // Cross-sort cursor rejection — mirror the backend's
        // `validate_pages_metadata_cursor`: a cursor minted under one sort
        // carries that sort's `position` discriminator; reusing it after a
        // sort change is rejected with a `Validation` error carrying the
        // structured `RequiresRefresh` code (#2251) the frontend's
        // `withCursorRecovery` recognises (drop cursor → refetch page 1).
        const cursorDisc = decoded['position'] as number | undefined
        if (cursorDisc !== sortDiscriminator(sort)) {
          throw appErrorRejection({
            kind: 'validation',
            code: 'RequiresRefresh',
            message: `cursor sort mismatch (expected ${sort})`,
          })
        }
        const idx = matched.findIndex((r) => r.id === (decoded['id'] as string))
        if (idx >= 0) startIdx = idx + 1
      }
    }
    const slice = matched.slice(startIdx, startIdx + limit + 1)
    const hasMore = slice.length > limit
    const items = hasMore ? slice.slice(0, limit) : slice
    const last = items.at(-1)
    const nextCursor = hasMore && last ? encodeNextCursor(last, sort) : null
    // (null-retention) — mirror the backend: the `total_count`
    // COUNT runs ONLY on the first page (`cursor == null`). The filtered-set
    // total does not change as the user pages with the same filters, so
    // recomputing it on every cursor page is wasted work. Subsequent (cursor)
    // pages return `total_count: null`; the frontend (`PageBrowser`'s
    // `displayTotalCount`) retains the first page's value. Returning the full
    // filtered-set size (not the page slice) on page 1 keeps the count chip
    // and e2e count assertions reflecting the active filters.
    const totalCount = cursor ? null : matched.length
    return { items, next_cursor: nextCursor, has_more: hasMore, total_count: totalCount }
  },

  // Every page in the space whose `template` property is set to 'true'.
  // No pagination, no clamp; the graph view uses this to flag templates.
  list_template_page_ids_in_space: (args) => {
    const a = args as Record<string, unknown>
    // b1 — `scope: SpaceScope`. `global` → null → no-match filter.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const ids: string[] = []
    for (const b of blocks.values()) {
      if (b['block_type'] !== 'page') continue
      if (b['deleted_at']) continue
      const blockProps = properties.get(b['id'] as string)
      if (!blockProps) continue
      const spaceProp = blockProps.get('space')
      if (spaceProp?.['value_ref'] !== spaceId) continue
      const tplProp = blockProps.get('template')
      if (tplProp?.['value_text'] !== 'true') continue
      ids.push(b['id'] as string)
    }
    return ids
  },

  list_undated_tasks: (args) => {
    // Honour `scope: SpaceScope` (mirrors
    // `list_undated_tasks_inner`).
    const a = (args ?? {}) as Record<string, unknown>
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    const items = [...blocks.values()].filter((b) => {
      if (b['deleted_at']) return false
      if (b['todo_state'] === null) return false
      if (b['due_date'] !== null) return false
      if (b['scheduled_date'] !== null) return false
      if (spaceId !== null) {
        const ownerId = (b['page_id'] as string | null) ?? (b['id'] as string)
        const ownerSpace = properties.get(ownerId)?.get('space')?.['value_ref'] ?? null
        if (ownerSpace !== spaceId) return false
      }
      return true
    })
    return { items, next_cursor: null, has_more: false, total_count: null }
  },

  // A mock vault always exposes a single canonical "Personal" space — the
  // matching id used across the unit tests in `App.test.tsx`,
  // `PageHeader.test.tsx`, etc. This keeps the space store hydrated and
  // `currentSpaceId` non-null so page-creation flows (Ctrl+N, the
  // PageBrowser input, the `[[` picker) don't bail out at the
  // `if (!isReady || currentSpaceId == null) return` guard in `App.tsx`.
  //
  // #2684 — ALSO scan `blocks` for any block carrying `is_space='true'`
  // (written by `create_space` below) so a space created during a test
  // actually shows up on the NEXT `list_spaces` call. Before this, the
  // handler was a hardcoded one-element array — `create_space` silently
  // produced an unreachable space (the SpaceSwitcher / Manage-spaces
  // dialog never learned it existed, so no e2e spec could ever exercise a
  // second space). Sorted alphabetically by name, matching the real
  // backend's `list_spaces_inner` ordering — `SpaceSwitcher`'s
  // `Ctrl+1`..`Ctrl+9` digit-hotkey contract depends on this order.
  list_spaces: () => {
    const created = [...blocks.values()]
      .filter(
        (b) =>
          !b['deleted_at'] &&
          properties.get(b['id'] as string)?.get('is_space')?.['value_text'] === 'true',
      )
      .map((b) => ({
        id: b['id'] as string,
        name: (b['content'] as string | null) ?? '',
        accent_color:
          (properties.get(b['id'] as string)?.get('accent_color')?.['value_text'] as
            | string
            | null
            | undefined) ?? null,
      }))
    const rows = [
      { id: 'SPACE_PERSONAL', name: 'Personal', accent_color: 'accent-emerald' },
      ...created,
    ]
    rows.sort((x, y) => x.name.localeCompare(y.name))
    return rows
  },

  // Phase 2 atomic page-creation IPC. Accepts `parentId` (null for a
  // top-level page), `content`, and `spaceId`. Returns the new page's ULID
  // as a plain string — `bindings.ts` documents this departure from the
  // BlockRow shape used by `create_block`.
  //
  // The real backend wraps both the CreateBlock and
  // SetProperty(space) ops in a single transaction; the mock mirrors
  // that here so journal-page lookups (`get_journal_page_by_date`,
  // `list_journal_pages_in_range`) find newly-created pages by their
  // active space.
  create_page_in_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const parentId = (a['parentId'] as string | null) ?? null
    const spaceId = (a['spaceId'] as string | null) ?? null
    const siblings = [...blocks.values()].filter(
      (b) => b['parent_id'] === parentId && !b['deleted_at'],
    )
    const position = siblings.length
    const row = {
      id,
      block_type: 'page',
      content: (a['content'] as string) ?? null,
      parent_id: parentId,
      page_id: id,
      position,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    if (spaceId) {
      if (!properties.has(id)) properties.set(id, new Map())
      properties.get(id)?.set('space', {
        block_id: id,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: parentId,
      block_type: 'page',
      position,
    })
    return id
  },

  // Atomic space-creation IPC. Accepts `name` and optional
  // `accentColor`. Returns the new space's ULID as a plain string.
  // Mirrors `create_page_in_space` but produces a top-level page block
  // marked with `is_space="true"` so `list_spaces` picks it up.
  create_space: (args) => {
    const a = args as Record<string, unknown>
    const id = fakeId()
    const row = {
      id,
      block_type: 'page',
      content: (a['name'] as string) ?? null,
      parent_id: null,
      page_id: id,
      position: 0,
      deleted_at: null,
      todo_state: null,
      priority: null,
      due_date: null,
      scheduled_date: null,
    }
    blocks.set(id, row)
    pushOp('create_block', {
      block_id: id,
      content: row.content,
      parent_id: null,
      block_type: 'page',
      position: 0,
    })
    pushOp('set_property', {
      block_id: id,
      key: 'is_space',
      value_text: 'true',
      value_number: null,
      value_date: null,
      value_ref: null,
    })
    // #2684 — mirror the op-log write into the queryable `properties` map
    // (the pattern every other `set_property`-style handler in this file
    // follows, e.g. `create_page_in_space`'s `space` write above). Before
    // this fix `is_space`/`accent_color` only ever reached the op log, so
    // `list_spaces`'s scan (which reads `properties`, not `opLog`) could
    // never discover a space created via this handler.
    if (!properties.has(id)) properties.set(id, new Map())
    properties.get(id)?.set('is_space', {
      block_id: id,
      key: 'is_space',
      value_text: 'true',
      value_num: null,
      value_date: null,
      value_ref: null,
      value_bool: null,
    })
    const accentColor = a['accentColor'] as string | null | undefined
    if (accentColor != null) {
      pushOp('set_property', {
        block_id: id,
        key: 'accent_color',
        value_text: accentColor,
        value_number: null,
        value_date: null,
        value_ref: null,
      })
      properties.get(id)?.set('accent_color', {
        block_id: id,
        key: 'accent_color',
        value_text: accentColor,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
      })
    }
    return id
  },

  set_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const aliases = a['aliases'] as string[]
    pageAliases.set(pid, aliases)
    return aliases
  },

  get_page_aliases: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    return pageAliases.get(pid) ?? []
  },

  resolve_page_by_alias: (args) => {
    const a = args as Record<string, unknown>
    const alias = (a['alias'] as string).toLowerCase()
    // Backend now takes `scope: SpaceScope`. Mirror
    // the `list_page_aliases_by_prefix` mock (sibling below) so an
    // alias pointing at a foreign-space page does not surface when the
    // caller is scoped to the active space. Global keeps the
    // cross-space lookup so the MCP / agent surfaces don't regress.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null
    for (const [pid, aliases] of pageAliases.entries()) {
      if (aliases.some((al) => al.toLowerCase() === alias)) {
        const page = blocks.get(pid)
        if (!page) continue
        if (spaceId !== null) {
          const space = properties.get(pid)?.get('space')?.['value_ref'] ?? null
          if (space !== spaceId) continue
        }
        return [pid, (page['content'] as string) ?? null]
      }
    }
    return null
  },

  // Substring alias autocomplete used by the [[ picker. The IPC name
  // (`prefix`) is historical — matching is now case-insensitive
  // substring (`LIKE '%q%'`) so aliases behave like FTS-backed page
  // titles. Returns `[page_id, alias, title]` rows ordered
  // shortest-alias first (then alphabetical), capped at `limit`
  // (default 50). When the IPC arg's `scope` is `{ kind: 'active',
  // space_id }`, restricts matches to aliases pointing at pages whose
  // `space` property equals the wrapped ULID. Mirrors the backend's
  // `list_page_aliases_by_prefix_inner` shape.
  list_page_aliases_by_prefix: (args) => {
    const a = args as Record<string, unknown>
    const query = ((a['prefix'] as string) ?? '').toLowerCase()
    const limit = (a['limit'] as number | null) ?? 50
    // Phase 3 — IPC arg shape: `scope: SpaceScope`. Recover the
    // legacy `spaceId | null` shape for the active-space-scoping branch.
    const scope = a['scope'] as { kind: string; space_id?: string } | undefined
    const spaceId = scope?.kind === 'active' ? (scope.space_id ?? null) : null

    const rows: Array<[string, string, string | null]> = []
    for (const [pid, aliases] of pageAliases.entries()) {
      const page = blocks.get(pid)
      if (!page) continue
      if (page['deleted_at']) continue
      // Active-space scoping: when `scope.kind === 'active'`,
      // exclude pages that don't carry `space = ?spaceId` in their
      // property map.
      if (spaceId !== null) {
        const space = properties.get(pid)?.get('space')?.['value_ref'] ?? null
        if (space !== spaceId) continue
      }
      const title = (page['content'] as string | null) ?? null
      for (const alias of aliases) {
        if (alias.toLowerCase().includes(query)) {
          rows.push([pid, alias, title])
        }
      }
    }
    rows.sort((x, y) => x[1].length - y[1].length || x[1].localeCompare(y[1]))
    return rows.slice(0, limit)
  },

  // ---------------------------------------------------------------------------
  // Markdown export
  // ---------------------------------------------------------------------------

  export_page_markdown: (args) => {
    const a = args as Record<string, unknown>
    const pid = a['pageId'] as string
    const page = blocks.get(pid)
    if (!page) throw notFoundRejection(`page '${pid}' not found`)
    const children = [...blocks.values()]
      .filter((b) => b['parent_id'] === pid && !(b['deleted_at'] as string | null))
      .toSorted((x, y) => ((x['position'] as number) ?? 0) - ((y['position'] as number) ?? 0))
    let md = `# ${(page['content'] as string) ?? 'Untitled'}\n\n`
    for (const child of children) {
      md += `- ${(child['content'] as string) ?? ''}\n`
    }
    return md
  },

  // ---------------------------------------------------------------------------
  // Markdown import (#660)
  // ---------------------------------------------------------------------------

  // DELIBERATE APPROXIMATION of the Rust importer (#1919). The real import
  // contract lives in `src-tauri/src/import.rs` (`parse_logseq_markdown`) and
  // `src-tauri/src/commands/pages/markdown.rs` (`import_markdown_with_progress`
  // / `folder_path_to_namespace_title`). This handler does NOT reimplement that
  // parser — it deliberately models a faithful *subset* of the backend so the
  // dev-preview UI (progress bar, warnings panel, "N properties" branch) is
  // exercised, while never *accepting more structure than the backend does*.
  //
  // It intentionally aligns with the backend on the two things tests can assert:
  //   - Title: derived from the filename/folder path the same way the backend
  //     does (strip `.md`, normalise `\`→`/`, drop empty segments, rejoin with
  //     `/`), falling back to "Imported Page". A leading `# heading` is NOT a
  //     title source (the backend never reads one — import.rs treats `# heading`
  //     as ordinary content).
  //   - Block bullets: ONLY a `- ` prefix marks a bullet, matching
  //     import.rs `strip_prefix("- ")`. `*`, `+`, and `1.` markers are kept as
  //     literal content (the backend does not recognise them).
  //
  // It intentionally does NOT model (and tests MUST NOT rely on the mock for
  // any of these — the Rust tests own the import contract):
  //   - Frontmatter / inline `key:: value` properties beyond a raw COUNT
  //     (`properties_set`); no property values are stamped onto blocks.
  //   - Wiki-link (`[[...]]`) resolution.
  //   - `((block-ref))` stripping.
  //   - Indentation → depth nesting (all content blocks are emitted flat).
  //   - `#tag` and attachment handling (kept as literal text).
  //
  // WARNING: mock-backed frontend tests give NO assurance about import-contract
  // fidelity. Validate import semantics against the Rust tests, not this mock.
  import_markdown: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    const filename = (a['filename'] as string | null) ?? null
    // Backend now requires `space_id`. Mirror the
    // backend behaviour: stamp `space = ?spaceId` on the created page
    // so `tauri-mock-parity` and downstream space-scoped read mocks
    // see the imported page in the active space. The backend rejects
    // empty / missing values with `AppError::Validation`; the mock is
    // permissive about the value (skips the stamp when empty) so older
    // mock fixtures that pre-date this fix don't break.
    const spaceId = (a['spaceId'] as string | undefined) ?? ''

    // `onProgress` (#128) — the real backend streams per-block progress over a
    // `Channel<ImportProgressUpdate>`. The FE wrapper (`importMarkdown` in
    // `tauri.ts`) ALWAYS passes a `Channel` as the `progress` arg, even when no
    // callback is wired. `mockIPC` forwards args verbatim (no IPC
    // serialization), so `a['progress']` is the live `Channel` instance and its
    // public `onmessage` getter returns the consumer's callback. We drive it
    // directly below so the dev-preview progress bar / aria-live announcements
    // actually fire (the real emission contract: one `started`, one `progress`
    // per block, one `complete` after the "commit"). Best-effort: if the arg is
    // absent or shaped unexpectedly, emission is silently skipped.
    const progress = a['progress'] as { onmessage?: (u: unknown) => void } | undefined
    const emit = (update: unknown): void => {
      try {
        progress?.onmessage?.(update)
      } catch {
        // A faulty consumer callback must not break the mock import.
      }
    }

    // Derive the page title the way the backend does
    // (`folder_path_to_namespace_title`, markdown.rs): strip a trailing `.md`,
    // normalise `\`→`/`, drop empty segments, rejoin with `/`. A leading
    // `# heading` is NOT a title source (import.rs never reads one — it treats
    // the heading line as ordinary content). Fall back to "Imported Page" when
    // nothing usable remains, matching markdown.rs:884.
    const namespaceTitle = (filename ?? '')
      .replace(/\.md$/i, '')
      .replace(/\\/g, '/')
      .split('/')
      .map((seg) => seg.trim())
      .filter((seg) => seg.length > 0)
      .join('/')
    const pageTitle = namespaceTitle.length > 0 ? namespaceTitle : 'Imported Page'
    // The heading line stays in `lines` as ordinary content (no shift),
    // mirroring the backend which never excises a `# heading` line.
    const lines = content.split('\n')

    // Faithful-but-simple property count: the real importer pulls properties
    // from YAML frontmatter and inline `key:: value` lines. We don't reproduce
    // the parser — we just count `key:: value` occurrences so the result panel's
    // "N properties" branch is exercised in dev-preview rather than hardcoded to
    // 0. (Frontmatter and `#tag` parsing are intentionally NOT modelled here.)
    const propertiesSet = lines.filter((line) => /^\s*[^\s:][^:]*::\s+\S/.test(line)).length

    // Create the page block + stamp `space` ref property.
    const pageId = fakeId()
    const pageBlock = makeBlock(pageId, 'page', pageTitle, null, blocks.size)
    blocks.set(pageId, pageBlock)
    if (spaceId) {
      if (!properties.has(pageId)) properties.set(pageId, new Map())
      properties.get(pageId)?.set('space', {
        block_id: pageId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }

    // Pre-compute the content blocks so we know `blocks_total` before emitting
    // `started` (the real backend reports the parser's count up front so the UI
    // can render a determinate bar from the very first event).
    const contentLines = lines
      .map((line) =>
        line
          // Strip ONLY a leading `- ` bullet marker, matching the backend
          // (import.rs `strip_prefix("- ")`). `*`, `+`, and `1.` markers are
          // NOT recognised by the importer, so they are left as literal content
          // here — the mock must not accept structure the real importer ignores.
          .replace(/^\s*-\s+/, '')
          .trim(),
      )
      .filter((trimmed) => trimmed.length > 0)
    const blocksTotal = contentLines.length

    emit({ kind: 'started', page_title: pageTitle, blocks_total: blocksTotal })

    let blocksCreated = 0
    let position = 0
    for (const trimmed of contentLines) {
      const blockId = fakeId()
      const block = makeBlock(blockId, 'content', trimmed, pageId, position)
      blocks.set(blockId, block)
      blocksCreated++
      position++
      emit({ kind: 'progress', blocks_done: blocksCreated, blocks_total: blocksTotal })
    }

    // Representative non-empty warning so the result panel's warning UI is
    // exercised in dev-preview. Mirrors the shape of a real parse-time
    // diagnostic (#tag fidelity is not implemented; hashtags stay literal text).
    const warnings: string[] = [
      'dev-preview mock: tags (#tag) and attachments are not imported (kept as literal text)',
    ]

    emit({
      kind: 'complete',
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: propertiesSet,
    })

    return {
      page_title: pageTitle,
      blocks_created: blocksCreated,
      properties_set: propertiesSet,
      warnings,
    }
  },

  // ---------------------------------------------------------------------------
  // Attachment commands (F-7)
  // ---------------------------------------------------------------------------

  // DELIBERATE APPROXIMATION of the Rust bibliography importer (#1454). The
  // real parsing contract (BibTeX field extraction, CSL-JSON mapping,
  // duplicate skipping, per-entry warnings) lives in the backend's
  // `import_bibliography` command — this handler parses NOTHING. It exists so
  // the dev-preview UI (success toast counts, warnings panel, AppError toast)
  // is exercisable in browser mode:
  //   - Entry count is a trivial derivation, not a parse: BibTeX → the number
  //     of `@type{` prefixes; CSL-JSON → `JSON.parse` array length, falling
  //     back to 0 when the JSON is malformed or not an array.
  //   - Each counted entry becomes a placeholder page ("Reference N") stamped
  //     into the target space; no reference properties are modelled beyond
  //     the raw `properties_set` count (one per page, for the space stamp).
  //   - `entries_skipped` is always 0 — duplicate detection is backend-only.
  // WARNING: mock-backed frontend tests give NO assurance about the parsing
  // contract. Validate bibliography semantics against the Rust tests.
  import_bibliography: (args) => {
    const a = args as Record<string, unknown>
    const content = (a['content'] as string) ?? ''
    const format = (a['format'] as string | null) ?? null
    const spaceId = (a['spaceId'] as string | undefined) ?? ''

    // #2463 kind-parity — the backend rejects an empty / unknown space id
    // with `AppError::Validation`, same as `import_markdown`. The mock's
    // known spaces are the canonical hardcoded 'SPACE_PERSONAL' (see
    // `list_spaces` above, which never lives in `blocks`) plus any
    // `create_space`-created block.
    if (spaceId !== 'SPACE_PERSONAL' && !blocks.has(spaceId)) {
      throw validationRejection('space_id does not refer to a live space block')
    }

    // `format: null` = auto-detect. Trivial content sniff mirroring the
    // backend's documented behaviour: BibTeX entries start with `@`,
    // anything else is treated as CSL-JSON.
    const effectiveFormat = format ?? (content.trim().startsWith('@') ? 'bibtex' : 'csl-json')

    let entryCount = 0
    if (effectiveFormat === 'bibtex') {
      entryCount = (content.match(/@[A-Za-z]+\s*\{/g) ?? []).length
    } else {
      try {
        const parsed: unknown = JSON.parse(content)
        entryCount = Array.isArray(parsed) ? parsed.length : 0
      } catch {
        entryCount = 0
      }
    }

    for (let i = 0; i < entryCount; i++) {
      const pageId = fakeId()
      blocks.set(pageId, makeBlock(pageId, 'page', `Reference ${i + 1}`, null, blocks.size))
      if (!properties.has(pageId)) properties.set(pageId, new Map())
      properties.get(pageId)?.set('space', {
        block_id: pageId,
        key: 'space',
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: spaceId,
        value_bool: null,
      })
    }

    // Representative non-empty warning so the result panel's warnings UI is
    // exercised in dev-preview, mirroring the `import_markdown` mock.
    const warnings: string[] = [
      'dev-preview mock: bibliography entries are not parsed — pages carry placeholder titles and no reference properties',
    ]
    if (entryCount === 0) {
      warnings.push('no bibliography entries detected in the file')
    }

    return {
      pages_created: entryCount,
      entries_skipped: 0,
      properties_set: entryCount,
      warnings,
    }
  },
} satisfies Pick<
  TypedHandlers,
  | 'get_journal_page_by_date'
  | 'list_journal_pages_in_range'
  | 'list_all_pages_in_space'
  | 'load_page_subtree'
  | 'list_pages_with_metadata'
  | 'list_template_page_ids_in_space'
  | 'list_undated_tasks'
  | 'list_spaces'
  | 'create_page_in_space'
  | 'create_space'
  | 'set_page_aliases'
  | 'get_page_aliases'
  | 'resolve_page_by_alias'
  | 'list_page_aliases_by_prefix'
  | 'export_page_markdown'
  | 'import_markdown'
  | 'import_bibliography'
>
