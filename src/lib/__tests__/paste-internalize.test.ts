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

import { useResolveStore } from '../../stores/resolve'
import { useSpaceStore } from '../../stores/space'
import { buildImportRefInternalizers } from '../paste-internalize'

const mockListAllPagesInSpace = vi.fn()
const mockListAllTagsInSpace = vi.fn()
const mockCreatePageInSpace = vi.fn()
const mockCreateBlock = vi.fn()

// The stores imported above pull additional names from `./tauri` at module
// load; stub the ones they bind so the mocked module satisfies every importer.
vi.mock('../tauri', () => ({
  listSpaces: vi.fn(),
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
