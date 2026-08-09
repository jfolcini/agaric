/**
 * #3308 drift test — pins `VIEW_HEADING_OWNER` against what the view
 * components actually render.
 *
 * Before the owner map existed, the per-view level-1 heading had no owner at
 * all: the App shell painted the view title as a plain
 * `<span data-testid="header-label">`, and six views ALSO rendered a real
 * `<h1>` through `FeaturePageHeader`. The remaining five (`pages`, `tags`,
 * `history`, `query`, `search`) rendered no heading whatsoever, so screen
 * reader heading navigation had nothing to land on after a view switch, while
 * `templates` / `trash` / … announced the same title twice.
 *
 * `VIEW_HEADING_OWNER` fixes that by naming exactly one owner per `View`, but
 * a map is only as good as its agreement with the components. This test scans
 * each view's source and asserts the strict 1:1 mapping:
 *
 *  - every `'view'`-owned entry renders its own heading primitive
 *    (`FeaturePageHeader`, or `PageTitleEditor` for the page editor), and
 *  - every `'shell'`-owned entry renders NO heading primitive, so promoting
 *    the shell label to `<h1>` cannot produce a duplicate.
 *
 * Adding a `View` member without an owner is already a compile error (the map
 * is a total `Record<View, …>`); this test is what stops the map from drifting
 * once a view later grows or loses a `FeaturePageHeader`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { shellOwnsHeading, VIEW_HEADING_OWNER } from '@/components/pages/ViewDispatcher'
import type { View } from '@/stores/navigation'

// vitest's cwd is always the project root (see the sibling drift test in
// src/lib/__tests__/keyboard-config-rebindable-drift.test.ts for why
// `import.meta.url` is unusable here).
const SRC_ROOT = join(process.cwd(), 'src')

/**
 * Source file that decides whether a view renders its own heading. Mirrors the
 * `lazy()` import table at the top of `ViewDispatcher.tsx`, except for
 * `page-editor`: `PageEditor` delegates its title row to `PageHeader`, which
 * is where the editable title (`PageTitleEditor`) actually lives.
 */
const VIEW_SOURCE: Readonly<Record<View, string>> = {
  journal: 'components/JournalPage.tsx',
  templates: 'components/templates/TemplatesView.tsx',
  trash: 'components/TrashView.tsx',
  graph: 'components/graph/GraphView.tsx',
  status: 'components/agenda/StatusPanel.tsx',
  settings: 'components/pages/SettingsView.tsx',
  'page-editor': 'components/pages/PageHeader.tsx',
  pages: 'components/PageBrowser.tsx',
  tags: 'components/TagsView.tsx',
  history: 'components/history/HistoryView.tsx',
  query: 'components/AdvancedQuery/AdvancedQueryView.tsx',
  search: 'components/SearchPanel.tsx',
}

/** Primitives that put a level-1 heading (or its labelled equivalent) on screen. */
const HEADING_PRIMITIVES = ['<FeaturePageHeader', '<PageTitleEditor']

function rendersOwnHeading(view: View): boolean {
  const source = readFileSync(join(SRC_ROOT, VIEW_SOURCE[view]), 'utf8')
  return HEADING_PRIMITIVES.some((primitive) => source.includes(primitive))
}

const ALL_VIEWS = Object.keys(VIEW_HEADING_OWNER) as View[]

describe('VIEW_HEADING_OWNER', () => {
  it('covers every View exactly once', () => {
    // Guards against a member being dropped from the map by a bad merge —
    // TypeScript catches a MISSING key, not a map that lost its pairing with
    // the `VIEW_SOURCE` table.
    expect(ALL_VIEWS.toSorted()).toEqual(Object.keys(VIEW_SOURCE).toSorted())
    expect(ALL_VIEWS).toHaveLength(12)
  })

  it.each(ALL_VIEWS)('view %s renders its own heading iff it is not shell-owned', (view) => {
    expect(rendersOwnHeading(view)).toBe(!shellOwnsHeading(view))
  })

  it('leaves no view without a heading owner', () => {
    // The finding: pages / tags / history / query / search had NO heading at
    // all. Every one of them must now be shell-owned (the shell label becomes
    // the `<h1>`), and none of them may quietly regain a second one.
    for (const view of ['pages', 'tags', 'history', 'query', 'search'] as const) {
      expect(VIEW_HEADING_OWNER[view]).toBe('shell')
      expect(rendersOwnHeading(view)).toBe(false)
    }
  })

  it('keeps the six FeaturePageHeader views out of the shell heading', () => {
    // Otherwise the same title is announced as two separate level-1 headings.
    for (const view of ['journal', 'templates', 'trash', 'graph', 'status', 'settings'] as const) {
      expect(VIEW_HEADING_OWNER[view]).toBe('view')
      expect(shellOwnsHeading(view)).toBe(false)
    }
  })
})
