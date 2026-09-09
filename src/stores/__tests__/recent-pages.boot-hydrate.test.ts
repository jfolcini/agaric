/**
 * The import-time hydrate — what actually happens at app boot.
 *
 * Every other case in this directory drives `persist.rehydrate()`, which runs
 * after module initialisation. That is a different path: for synchronous
 * storage the first hydrate runs INSIDE `create()`, before the store binding
 * exists, so anything that reaches for `useRecentPagesStore` there throws into
 * a swallowed catch. The pinned→bookmark rescue's write is exactly that, and
 * it is the write that keeps the rescue from repeating.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'agaric:recent-pages'

describe('recent-pages boot hydrate', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('strips the rescued pinned flags from storage at boot', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        state: {
          recentPages: [{ pageId: 'P', title: 'Pinned', pinned: true }],
          rawKeysMerged: true,
        },
        version: 1,
      }),
    )

    await import('@/stores/recent-pages')
    // The deferred write lands on the microtask queue.
    await Promise.resolve()

    expect(JSON.parse(localStorage.getItem('starred-pages') ?? '[]')).toEqual(['P'])
    // Without this the rescue re-runs next boot and resurrects a removed bookmark.
    expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain('pinned')
  })
})
