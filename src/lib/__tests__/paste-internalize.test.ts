/**
 * buildImportRefInternalizers (#1484) — unit tests for the paste/import
 * name→ULID resolvers, including the list-fetch FAILURE branches.
 *
 * The critical contract: when the list-all IPC rejects (e.g. transient
 * pool_busy), the resolver must treat existence as UNKNOWN and skip creation —
 * caching an empty map instead would send every already-existing
 * `[[Page Name]]` / `#tag` down the "matching NONE → create" branch, minting
 * duplicate pages/tags that the pasted links then point at.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NameChange } from '@/lib/name-change-bus'
import { subscribeToNameChanges } from '@/lib/name-change-bus'
import { buildImportRefInternalizers } from '@/lib/paste-internalize'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockListAllPagesInSpace = vi.fn()
const mockListAllTagsInSpace = vi.fn()
const mockCreatePageInSpace = vi.fn()
const mockCreateBlock = vi.fn()

// The stores imported above pull additional names from `./tauri` at module
// load; stub the ones they bind so the mocked module satisfies every importer.
// (#2927 phase 7 — `@/stores/space` no longer binds `listSpaces` from this
// module, so the stub that used to satisfy it has been dropped.)
vi.mock('@/lib/tauri', () => ({
  listBlocks: vi.fn(),
  listBlocksLimit: vi.fn(),
  listAllPagesInSpace: (...args: unknown[]) => mockListAllPagesInSpace(...args),
  listAllTagsInSpace: (...args: unknown[]) => mockListAllTagsInSpace(...args),
  createPageInSpace: (...args: unknown[]) => mockCreatePageInSpace(...args),
  createBlock: (...args: unknown[]) => mockCreateBlock(...args),
}))

const SPACE = '01HZ0SPACE0000000000000000'
const EXISTING_PAGE = '01HZ0PAGE00000000000000001'
const EXISTING_TAG = '01HZ0TAG000000000000000001'

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: SPACE })
  useResolveStore.setState({ cache: new Map() })
  mockListAllPagesInSpace.mockResolvedValue([{ id: EXISTING_PAGE, content: 'Project Alpha' }])
  mockListAllTagsInSpace.mockResolvedValue([{ tag_id: EXISTING_TAG, name: 'work' }])
  mockCreatePageInSpace.mockResolvedValue('01HZ0CREATEDPAGE0000000000')
  mockCreateBlock.mockResolvedValue({ id: '01HZ0CREATEDTAG00000000000' })
})

function buildOrThrow() {
  const internalizers = buildImportRefInternalizers()
  if (internalizers === null) throw new Error('expected internalizers (space is active)')
  return internalizers
}

describe('buildImportRefInternalizers — success paths (behavior pin)', () => {
  it('resolves an existing page title without creating', async () => {
    const { page } = buildOrThrow()

    await expect(page('Project Alpha')).resolves.toBe(EXISTING_PAGE)
    expect(mockCreatePageInSpace).not.toHaveBeenCalled()
  })

  it('creates a genuinely missing page (list succeeded, name absent)', async () => {
    const { page } = buildOrThrow()

    await expect(page('Fresh Page')).resolves.toBe('01HZ0CREATEDPAGE0000000000')
    expect(mockCreatePageInSpace).toHaveBeenCalledWith({ content: 'Fresh Page', spaceId: SPACE })
  })

  // #4338 — the picker's `pagesListRef` / `tagsListRef` live in React refs
  // inside `useBlockResolve`, which this module has no way to reach. Without
  // the bus emissions below, a `[[Name]]` internalized on paste created a
  // page that a warm `[[` picker could not offer — so the very next `[[Name]]`
  // showed "Create new page" for a page that already existed.
  it("publishes an 'added' event for a page created from a pasted [[link]]", async () => {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      const { page } = buildOrThrow()
      await page('Fresh Page')
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      {
        kind: 'added',
        entity: 'page',
        id: '01HZ0CREATEDPAGE0000000000',
        name: 'Fresh Page',
      },
    ])
  })

  it("publishes an 'added' event for a tag created from a pasted #tag", async () => {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      const { tag } = buildOrThrow()
      await tag('freshtag')
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([
      { kind: 'added', entity: 'tag', id: '01HZ0CREATEDTAG00000000000', name: 'freshtag' },
    ])
  })

  it('publishes nothing when the name already resolves — no create, no event', async () => {
    const changes: NameChange[] = []
    const unsubscribe = subscribeToNameChanges((c) => changes.push(c))
    try {
      const { page, tag } = buildOrThrow()
      await page('Project Alpha')
      await tag('work')
    } finally {
      unsubscribe()
    }

    expect(changes).toEqual([])
  })

  it('resolves an existing tag without creating', async () => {
    const { tag } = buildOrThrow()

    await expect(tag('work')).resolves.toBe(EXISTING_TAG)
    expect(mockCreateBlock).not.toHaveBeenCalled()
  })

  it('returns null when no space is active', () => {
    useSpaceStore.setState({ currentSpaceId: null })
    expect(buildImportRefInternalizers()).toBeNull()
  })
})

describe('buildImportRefInternalizers — list-fetch failure = UNKNOWN, never create', () => {
  it('does NOT create a duplicate page when the page list IPC rejects', async () => {
    mockListAllPagesInSpace.mockRejectedValue(new Error('pool_busy'))
    const { page } = buildOrThrow()

    // Existence is unknown → leave the link as plain text (null), never mint
    // a duplicate 'Project Alpha' next to the real one.
    await expect(page('Project Alpha')).resolves.toBeNull()
    expect(mockCreatePageInSpace).not.toHaveBeenCalled()
  })

  it('does NOT create a duplicate tag when the tag list IPC rejects', async () => {
    mockListAllTagsInSpace.mockRejectedValue(new Error('pool_busy'))
    const { tag } = buildOrThrow()

    await expect(tag('work')).resolves.toBeNull()
    expect(mockCreateBlock).not.toHaveBeenCalled()
  })

  it('skips creation for EVERY reference in the paste after one failed fetch (single list attempt)', async () => {
    mockListAllPagesInSpace.mockRejectedValue(new Error('pool_busy'))
    const { page } = buildOrThrow()

    await expect(page('Project Alpha')).resolves.toBeNull()
    await expect(page('Another Page')).resolves.toBeNull()
    expect(mockCreatePageInSpace).not.toHaveBeenCalled()
    // The paste-scoped cache fetches ONCE — a failure is not retried per token.
    expect(mockListAllPagesInSpace).toHaveBeenCalledTimes(1)
  })

  it('a page-list failure does not poison tag resolution (independent caches)', async () => {
    mockListAllPagesInSpace.mockRejectedValue(new Error('pool_busy'))
    const { page, tag } = buildOrThrow()

    await expect(page('Project Alpha')).resolves.toBeNull()
    await expect(tag('work')).resolves.toBe(EXISTING_TAG)
  })
})
