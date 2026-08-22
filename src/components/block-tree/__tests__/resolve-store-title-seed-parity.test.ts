/**
 * The resolve-store title MATRIX (#4228 / #4239).
 *
 * The shared resolve store holds ONE `{ title, deleted }` per
 * `${spaceId}::${ulid}`, and `set` / `batchSet` diff on the title's bytes.
 * So two writers that can reach the same id must produce the same string,
 * or the last one wins and `version` churns for a value that did not really
 * change. `@/lib/block-title` owns what that string IS; this file is the
 * proof that every writer actually applies it.
 *
 * ## Why a matrix, and why an enumeration guard
 *
 * The suite this replaced could not catch the bugs it was written for. It
 * was a three-example test, its page/tag block was scoped to "both
 * ID-FETCHING seeders" and so excluded `searchBlockRefs` — the original
 * seeder — and its `mkSearchBlock` fixture hardcoded `block_type: 'block'`,
 * a value OUTSIDE the closed `content | tag | page` domain that
 * `0005_block_type_check.sql` enforces. No realistic page row ever reached
 * path 1, so three successive reviews of #4239 each found one more ungated
 * writer, one at a time.
 *
 * The replacement is two tiers:
 *
 *   1. A behavioural matrix — every drivable writer × every block type ×
 *      every content shape that has ever produced a disagreement — asserting
 *      the agreed value per cell against LITERALS, not against the helper
 *      under test.
 *   2. `describe('writer enumeration')` at the bottom, which scans the
 *      source tree for resolve-store mutator calls and fails on any writer
 *      not declared in {@link DECLARED_WRITERS}. A new writer is therefore
 *      conspicuous by construction: it cannot be added without either
 *      registering it here (and, if it seeds from a fetched row, giving it a
 *      matrix row) or turning this file red.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve as resolvePath } from 'node:path'

import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockedSearchBlocks = vi.hoisted(() => vi.fn())
const mockedBatchResolve = vi.hoisted(() => vi.fn())
const mockedGetBlock = vi.hoisted(() => vi.fn())
const mockedListAllTagsInSpace = vi.hoisted(() => vi.fn())
const mockedListPageAliasesByPrefix = vi.hoisted(() => vi.fn())
const mockedListBlocks = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bindings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bindings')>()
  return {
    ...actual,
    commands: {
      ...actual.commands,
      searchBlocks: (...args: unknown[]) =>
        mockedSearchBlocks(...args).then((data: unknown) => ({ status: 'ok', data })),
      batchResolve: (...args: unknown[]) =>
        mockedBatchResolve(...args).then((data: unknown) => ({ status: 'ok', data })),
      getBlock: (...args: unknown[]) =>
        mockedGetBlock(...args).then((data: unknown) => ({ status: 'ok', data })),
      listAllTagsInSpace: (...args: unknown[]) =>
        mockedListAllTagsInSpace(...args).then((data: unknown) => ({ status: 'ok', data })),
      listPageAliasesByPrefix: (...args: unknown[]) =>
        mockedListPageAliasesByPrefix(...args).then((data: unknown) => ({ status: 'ok', data })),
      listBlocks: (...args: unknown[]) =>
        mockedListBlocks(...args).then((data: unknown) => ({ status: 'ok', data })),
    },
  }
})

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import { useBlockNavigateToLink } from '@/components/block-tree/use-block-navigate-to-link'
import { useBlockResolve } from '@/components/block-tree/use-block-resolve'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { useBacklinkResolution } from '@/hooks/useBacklinkResolution'
import type { BacklinkGroup, BlockRow } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const TEST_SPACE_ID = 'SPACE_TEST'

/**
 * The closed domain. `check_block_type_insert` in
 * `src-tauri/migrations/0005_block_type_check.sql` restricts `blocks.block_type`
 * to exactly these three, so a fixture outside them is not a "generic block",
 * it is a row the backend could never return — which is precisely how the old
 * `block_type: 'block'` fixture kept a page from ever flowing through
 * `searchBlockRefs`.
 */
const BLOCK_TYPES = ['content', 'page', 'tag'] as const
type BlockType = (typeof BLOCK_TYPES)[number]

/** The placeholder, pinned as a literal so the matrix cells below are literals. */
const UNTITLED = 'Untitled'

// ───────────────────────────── the content shapes ──────────────────────────

/**
 * One content shape and the two titles it must produce. `contentTitle` is
 * what a `content` row stores (first line, Untitled-substituted, capped at
 * 60 with a 57-char cut + `...`); `namedTitle` is what a `page` or `tag` row
 * stores (Untitled-substituted, otherwise VERBATIM — un-split, un-capped).
 *
 * Both are spelled out as literals rather than computed with
 * `normalizeBlockRefTitle` / `untitledOr`: the point is to pin the agreed
 * VALUE, and a test that derives its expectation from the function under
 * test passes no matter what that function does.
 */
interface Shape {
  name: string
  content: string | null
  contentTitle: string
  namedTitle: string
  why: string
}

/** 35 chars of namespace, then 40 filler — the cut lands INSIDE the leaf. */
const NS_PREFIX = 'Engineering/Platform/Observability/'
const LONG_PATH = `${NS_PREFIX}${'z'.repeat(40)}`
/** The cut lands BEFORE the last `/` — a capped page renders a NAMESPACE segment. */
const DEEP_PATH = `${'A'.repeat(50)}/${'B'.repeat(30)}/Leaf`

const SHAPES: readonly Shape[] = [
  {
    name: 'long single line',
    content: LONG_PATH,
    contentTitle: `${NS_PREFIX}${'z'.repeat(22)}...`,
    namedTitle: LONG_PATH,
    why: 'a chip caps; a page path must survive whole for getPageDisplayName',
  },
  {
    name: 'long, cut lands before the last slash',
    content: DEEP_PATH,
    contentTitle: `${'A'.repeat(50)}/${'B'.repeat(6)}...`,
    namedTitle: DEEP_PATH,
    why: 'capping this page would make a NAMESPACE segment render as the leaf',
  },
  {
    name: 'blank',
    content: '',
    contentTitle: UNTITLED,
    namedTitle: UNTITLED,
    why: 'a blank chip is the #4190 defect; every writer labels it',
  },
  {
    name: 'whitespace only',
    content: '   ',
    contentTitle: UNTITLED,
    namedTitle: UNTITLED,
    why: 'the test is TRIMMED-empty, not === "" — the cell that used to store "   " raw',
  },
  {
    name: 'newline-leading',
    content: '\nreal text on line two',
    contentTitle: UNTITLED,
    namedTitle: '\nreal text on line two',
    why: 'a content chip shows line 1 (blank → Untitled); a page title is not split at all',
  },
  {
    name: 'CRLF multi-line',
    content: 'first line\r\nsecond line',
    contentTitle: 'first line',
    namedTitle: 'first line\r\nsecond line',
    why: 'the stored title is persisted and read aloud — no stray CR may survive',
  },
  {
    name: 'null',
    content: null,
    contentTitle: UNTITLED,
    namedTitle: UNTITLED,
    why: 'the shape preload used to spell as a hardcoded English `?? "Untitled"`',
  },
] as const

// ───────────────────────────── fixtures ────────────────────────────────────

/**
 * A `search_blocks` row. `blockType` is a REQUIRED parameter — the previous
 * fixture hardcoded `block_type: 'block'` and that single default is what let
 * an ungated `searchBlockRefs` ship green three times.
 */
function mkSearchBlock(id: string, blockType: BlockType, content: string | null) {
  return {
    id,
    block_type: blockType,
    content,
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: null,
  }
}

function makeBlockRow(overrides: Record<string, unknown>): BlockRow {
  return {
    id: 'X',
    block_type: 'content',
    content: '',
    parent_id: null,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    ...overrides,
  } as BlockRow
}

/** A resolved row as `batch_resolve` returns it (`b.content AS title`). */
function mkResolved(id: string, blockType: BlockType, content: string | null) {
  return { id, title: content, block_type: blockType, deleted: false }
}

function useNavigateHarness() {
  const rovingEditorRef = useRef<RovingEditorHandle | null>(null)
  const handleFlushRef = useRef<() => string | null>(() => null)
  return useBlockNavigateToLink({
    rovingEditorRef,
    handleFlushRef,
    load: vi.fn().mockResolvedValue(undefined),
    setFocused: vi.fn(),
    rootParentId: null,
    onNavigateToPage: vi.fn(),
    t: ((k: string) => k) as unknown as TFunction,
  })
}

/**
 * Ids must be real 26-char ULIDs: `useBacklinkResolution` finds its work by
 * matching `[[([0-9A-Z]{26})]]` / `#[([0-9A-Z]{26})]` in block content, so a
 * short synthetic id would silently seed nothing there.
 */
let ulidCounter = 0
function nextUlid(): string {
  ulidCounter += 1
  return `01H${String(ulidCounter).padStart(23, '0')}`
}

function storedTitle(id: string): string | undefined {
  return useResolveStore.getState().cache.get(keyFor(TEST_SPACE_ID, id))?.title
}

async function waitForStored(id: string): Promise<string> {
  return await waitFor(() => {
    const title = storedTitle(id)
    expect(title).toBeDefined()
    return title as string
  })
}

// ───────────────────────────── the writers ─────────────────────────────────

interface Writer {
  /** Matrix row name — also the name the enumeration guard cross-checks. */
  name: string
  /** Source file, so a failure points straight at the gate that drifted. */
  source: string
  /** Which block types can actually reach this writer. */
  supports: readonly BlockType[]
  /** Shapes this writer cannot be driven with, and why. */
  skip?: Partial<Record<BlockType, readonly string[]>>
  seed: (id: string, blockType: BlockType, content: string | null) => Promise<void>
  /**
   * The documented deviation from the matrix value, or `undefined` for the
   * writers that have none. Returning a string asserts THAT instead — the
   * gap is pinned, not skipped.
   */
  deviates?: (id: string, blockType: BlockType, content: string | null) => string | undefined
}

const WRITERS: readonly Writer[] = [
  {
    name: 'searchBlockRefs',
    source: 'src/components/block-tree/use-block-resolve.ts',
    // `blockTypeFilter: null` on the `searchBlocks` call, so pages and tags
    // come back here — `searchPagesViaFts` makes the identical unfiltered
    // call and then filters `block_type === 'page'`.
    supports: BLOCK_TYPES,
    seed: async (id, blockType, content) => {
      mockedSearchBlocks.mockResolvedValueOnce({
        items: [mkSearchBlock(id, blockType, content)],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      const { result } = renderHook(() => useBlockResolve())
      await act(async () => {
        await result.current.searchBlockRefs('query matching two chars')
      })
    },
  },
  {
    name: 'fetchAndCacheLinks',
    source: 'src/components/block-tree/use-block-link-resolve.ts',
    supports: BLOCK_TYPES,
    seed: async (id, blockType, content) => {
      mockedBatchResolve.mockResolvedValueOnce([mkResolved(id, blockType, content)])
      await fetchAndCacheLinks(new Set([id]), TEST_SPACE_ID, () => false)
    },
  },
  {
    name: 'handleNavigate',
    source: 'src/components/block-tree/use-block-navigate-to-link.ts',
    supports: BLOCK_TYPES,
    seed: async (id, blockType, content) => {
      mockedGetBlock.mockResolvedValueOnce(
        makeBlockRow({ id, block_type: blockType, content, parent_id: null }),
      )
      // The space-scope check: report the target as in the active space.
      mockedBatchResolve.mockResolvedValueOnce([mkResolved(id, blockType, content)])
      const { result } = renderHook(() => useNavigateHarness())
      await act(async () => {
        await result.current.handleNavigate(id)
      })
    },
  },
  {
    name: 'useBacklinkResolution.storeTitle',
    source: 'src/hooks/useBacklinkResolution.ts',
    supports: BLOCK_TYPES,
    seed: async (id, blockType, content) => {
      mockedBatchResolve.mockResolvedValueOnce([mkResolved(id, blockType, content)])
      const token = blockType === 'tag' ? `#[${id}]` : `[[${id}]]`
      const groups: BacklinkGroup[] = [
        {
          page_id: 'SOURCE_PAGE',
          page_title: 'Source',
          blocks: [makeBlockRow({ id: 'SRC_BLOCK', content: `refers to ${token} here` })],
        },
      ]
      renderHook(() => useBacklinkResolution(groups))
      await waitFor(() => expect(mockedBatchResolve).toHaveBeenCalled())
    },
    // #4238 — the ONE cell that is deliberately off the invariant. A row the
    // backend RETURNED but with a `null`/empty title keeps the broken-link
    // shape, because `resolveBlockDisplay` pattern-matches exactly that shape
    // as "nothing real is cached". Whitespace-only is NOT in the deviation:
    // #4239 brought it back onto the invariant.
    deviates: (id, blockType, content) => {
      if (content !== null && content !== '') return undefined
      return blockType === 'tag' ? `#${id.slice(0, 8)}...` : `[[${id.slice(0, 8)}...]]`
    },
  },
  {
    name: 'preload (runPreloadScan)',
    source: 'src/stores/resolve.ts',
    supports: ['page', 'tag'],
    // `listAllTagsInSpace` types `name` as a non-null string, so the backend
    // cannot hand this writer a null tag name. The `''` row one line above
    // covers the same branch.
    skip: { tag: ['null'] },
    seed: async (id, blockType, content) => {
      // `preload` runs a PAGE half then a TAG half and a throw in either
      // aborts the whole scan silently (it logs and returns), so BOTH halves
      // have to be stubbed for every case, not just the one under test.
      mockedListBlocks.mockResolvedValueOnce({
        items: blockType === 'page' ? [{ id, content, deleted_at: null, block_type: 'page' }] : [],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListAllTagsInSpace.mockResolvedValueOnce(
        blockType === 'tag'
          ? [{ tag_id: id, name: content ?? '', usage_count: 0, updated_at: '2026-01-01' }]
          : [],
      )
      await useResolveStore.getState().preload(TEST_SPACE_ID)
    },
  },
  {
    name: 'populatePageResolveCache (searchPages)',
    source: 'src/components/block-tree/use-block-resolve.ts',
    supports: ['page'],
    seed: async (id, _blockType, content) => {
      mockedSearchBlocks.mockResolvedValueOnce({
        items: [mkSearchBlock(id, 'page', content)],
        next_cursor: null,
        has_more: false,
        total_count: null,
      })
      mockedListPageAliasesByPrefix.mockResolvedValueOnce([])
      const { result } = renderHook(() => useBlockResolve())
      await act(async () => {
        // >2 chars takes the FTS strategy, which is the one that reaches a
        // page row straight off the backend.
        await result.current.searchPages('query matching two chars')
      })
    },
  },
  {
    name: 'searchTags fill',
    source: 'src/components/block-tree/use-block-resolve.ts',
    supports: ['tag'],
    skip: { tag: ['null'] },
    seed: async (id, _blockType, content) => {
      mockedListAllTagsInSpace.mockResolvedValueOnce([
        { tag_id: id, name: content ?? '', usage_count: 0, updated_at: '2026-01-01' },
      ])
      const { result } = renderHook(() => useBlockResolve())
      await act(async () => {
        await result.current.searchTags('q')
      })
    },
  },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  useResolveStore.setState({ cache: new Map(), version: 0, _preloaded: false })
  useSpaceStore.setState({
    currentSpaceId: TEST_SPACE_ID,
    availableSpaces: [{ id: TEST_SPACE_ID, name: 'Test', accent_color: null }],
    isReady: true,
  })
})

// ───────────────────────────── the matrix ──────────────────────────────────

describe('resolve-store title matrix — {every writer} × {content, page, tag} × {shape}', () => {
  it('pins the placeholder literal the matrix cells are written against', () => {
    // Every `UNTITLED` cell below is a literal. If the catalogue entry ever
    // changes, THIS fails first and explains the rest.
    expect(t('block.untitled')).toBe(UNTITLED)
  })

  for (const writer of WRITERS) {
    describe(`${writer.name} (${writer.source})`, () => {
      for (const blockType of BLOCK_TYPES) {
        const supported = writer.supports.includes(blockType)
        for (const shape of SHAPES) {
          const skipped = writer.skip?.[blockType]?.includes(shape.name) ?? false
          const title = `${supported ? '' : 'cannot reach '}block_type=${blockType} × ${shape.name}`
          const runner = supported && !skipped ? it : it.skip
          runner(title, async () => {
            const id = nextUlid()
            await writer.seed(id, blockType, shape.content)
            const stored = await waitForStored(id)
            const expected =
              writer.deviates?.(id, blockType, shape.content) ??
              (blockType === 'content' ? shape.contentTitle : shape.namedTitle)
            expect(stored, `${writer.name}: ${shape.why}`).toBe(expected)
          })
        }
      }
    })
  }
})

/**
 * The property the matrix exists to protect, stated once directly: two
 * writers reaching the same id with the same row must be a true no-op for
 * `version`, because `batchSet` / `set` diff on value. This is the churn
 * #4228 was filed about, and it is what any future disagreement would break
 * even if both values looked "reasonable" in isolation.
 */
describe('cross-writer convergence — no version churn on a second seed', () => {
  for (const blockType of BLOCK_TYPES) {
    for (const shape of SHAPES) {
      it(`${blockType} × ${shape.name}: seeding twice via two writers bumps version once`, async () => {
        const id = nextUlid()
        // Two writers that both accept all three block types, and neither of
        // which carries the #4238 deviation.
        const first = WRITERS.find((w) => w.name === 'searchBlockRefs') as Writer
        const second = WRITERS.find((w) => w.name === 'fetchAndCacheLinks') as Writer

        await first.seed(id, blockType, shape.content)
        const titleAfterFirst = await waitForStored(id)
        const versionAfterFirst = useResolveStore.getState().version

        await second.seed(id, blockType, shape.content)

        expect(
          useResolveStore.getState().version,
          `${first.name} and ${second.name} disagree about ${blockType} × ${shape.name}`,
        ).toBe(versionAfterFirst)
        expect(storedTitle(id)).toBe(titleAfterFirst)
      })
    }
  }
})

// ──────────────────── the enumeration guard (denominator) ──────────────────

/**
 * Every file that writes a title into the resolve store, with how many
 * mutator calls it makes and which kind of writer it is:
 *
 *   `seed`  — the title comes from a row the app FETCHED, so it can be
 *             null / blank / long / namespaced and MUST go through
 *             `resolveStoreTitle`. Enforced below.
 *   `echo`  — the title is a value the caller just WROTE to the backend
 *             (create / rename / delete). Non-blank by construction and
 *             already the exact bytes a later `preload` reads back, so
 *             normalising it would be a no-op at best and a divergence from
 *             the persisted content at worst. Explicitly NOT gated.
 *
 * `writes` is the number of `useResolveStore` `set` / `batchSet` calls in the
 * file. It is part of the pin on purpose: adding a second write to a file
 * that already has one is exactly how review 3's hole got there.
 */
// `kind` is per FILE, but a file can hold both kinds — `use-block-resolve.ts`
// has three seeds and two echoes. `seedWrites` names the seed count where it
// differs from `writes`, so the gate check below counts against the right
// denominator instead of the file's total.
const DECLARED_WRITERS: Record<
  string,
  { writes: number; seedWrites?: number; kind: 'seed' | 'echo'; note: string }
> = {
  'src/App.tsx': {
    writes: 1,
    kind: 'echo',
    note: 'new page — `Untitled` is the PERSISTED content passed to createPageInSpace, so it stays that untranslated literal',
  },
  'src/components/TagList.tsx': {
    writes: 3,
    kind: 'echo',
    note: 'tag create / delete / rename',
  },
  'src/components/TrashView.tsx': {
    writes: 2,
    kind: 'seed',
    note: 'restore hint for a page/tag row read out of the trash listing',
  },
  'src/components/backlinks/UnlinkedReferences.tsx': {
    writes: 1,
    kind: 'seed',
    note: 'source-page header pre-warm from fetched group rows',
  },
  'src/components/block-tree/use-block-date-picker.ts': {
    writes: 1,
    kind: 'echo',
    note: 'journal page just created — title is the date string',
  },
  'src/components/block-tree/use-block-link-resolve.ts': {
    writes: 1,
    kind: 'seed',
    note: 'fetchAndCacheLinks — matrix row',
  },
  'src/components/block-tree/use-block-navigate-to-link.ts': {
    writes: 1,
    kind: 'seed',
    note: 'handleNavigate — matrix row',
  },
  'src/components/block-tree/use-block-resolve.ts': {
    writes: 5,
    seedWrites: 3,
    kind: 'seed',
    note: 'populatePageResolveCache + searchTags fill + searchBlockRefs (matrix rows), plus onCreatePage / onCreateTag echoes',
  },
  'src/hooks/useAppKeyboardShortcuts.ts': {
    writes: 1,
    kind: 'echo',
    note: 'new page via chord — see App.tsx',
  },
  'src/hooks/useBacklinkResolution.ts': {
    writes: 1,
    kind: 'seed',
    note: 'storeTitle — matrix row, incl. the #4238 deviation',
  },
  'src/hooks/useBlockTags.ts': { writes: 1, kind: 'echo', note: 'tag just created' },
  'src/hooks/useJournalBlockCreation.ts': {
    writes: 1,
    kind: 'echo',
    note: 'journal page just created',
  },
  'src/hooks/usePageDeleteAction.tsx': {
    writes: 1,
    kind: 'echo',
    note: 're-writes the title the caller already holds, only `deleted` changes',
  },
  'src/hooks/useRichContentCallbacks.ts': { writes: 1, kind: 'echo', note: 'tag just created' },
  'src/lib/palette-commands.ts': {
    writes: 1,
    kind: 'echo',
    note: 'new page via palette — see App.tsx',
  },
  'src/lib/paste-internalize.ts': {
    writes: 2,
    kind: 'echo',
    note: 'page / tag just created during import',
  },
  'src/stores/page-rename.ts': { writes: 1, kind: 'echo', note: 'rename just committed' },
}

/**
 * `src/stores/resolve.ts` defines the mutators rather than calling them, so
 * the scan below cannot see its own writer. `runPreloadScan`'s `mergeFetched`
 * IS a seed writer (pages + tags off the backend) and has a matrix row; it is
 * declared here so the denominator stays honest.
 */
const STORE_INTERNAL_WRITER = 'src/stores/resolve.ts'

const SRC_ROOT = resolvePath(process.cwd(), 'src')

/** Every non-test `.ts` / `.tsx` under `src/`, as repo-relative paths. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__mocks__') continue
      sourceFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue
    out.push(relative(process.cwd(), full))
  }
  return out
}

/**
 * Count `useResolveStore` title-mutator calls in `source`.
 *
 * Two spellings reach the store and both are counted:
 *   - direct: `useResolveStore.getState().set(...)` / `.batchSet(...)`,
 *     whitespace-tolerant because the codebase formats these across three
 *     lines as often as one.
 *   - aliased: `const store = useResolveStore.getState()` followed by
 *     `store.batchSet(...)` — the shape `fetchAndCacheLinks` uses, and the
 *     one a line-oriented grep misses.
 *
 * `preload` is NOT counted: it is a trigger, not a writer — the write it
 * causes happens inside `runPreloadScan`, which is declared separately.
 */
function countStoreWrites(source: string): number {
  const MUTATORS = String.raw`(?:set|batchSet)`
  let count = (
    source.match(
      new RegExp(String.raw`useResolveStore\s*\.\s*getState\(\)\s*\.\s*${MUTATORS}\(`, 'g'),
    ) ?? []
  ).length
  const aliases = [
    ...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*useResolveStore\s*\.\s*getState\(\)/g),
  ].map((m) => m[1] as string)
  for (const alias of new Set(aliases)) {
    count += (source.match(new RegExp(String.raw`\b${alias}\s*\.\s*${MUTATORS}\(`, 'g')) ?? [])
      .length
  }
  return count
}

describe('writer enumeration — the denominator, checked', () => {
  const found = new Map<string, number>()
  for (const file of sourceFiles(SRC_ROOT)) {
    if (relative(process.cwd(), resolvePath(process.cwd(), file)) === STORE_INTERNAL_WRITER)
      continue
    const writes = countStoreWrites(readFileSync(file, 'utf8'))
    if (writes > 0) found.set(file, writes)
  }

  it('finds no resolve-store writer that is not declared here', () => {
    const undeclared = [...found.keys()].filter((f) => !(f in DECLARED_WRITERS)).toSorted()
    expect(
      undeclared,
      "A new resolve-store title writer appeared. Add it to DECLARED_WRITERS with its `kind`; if it is a `seed` (its title comes from a fetched row) it must call `resolveStoreTitle` from `@/lib/block-title` AND get a row in WRITERS above. See `@/lib/block-title`'s docblock.",
    ).toEqual([])
  })

  it('has no declared writer that has since disappeared', () => {
    const stale = Object.keys(DECLARED_WRITERS)
      .filter((f) => !found.has(f))
      .toSorted()
    expect(stale, 'DECLARED_WRITERS lists a file that no longer writes to the store').toEqual([])
  })

  it('pins the number of writes per file, so a second write in an existing file is conspicuous', () => {
    const actual = Object.fromEntries([...found.entries()].toSorted())
    const declared = Object.fromEntries(
      Object.entries(DECLARED_WRITERS)
        .map(([f, d]) => [f, d.writes] as const)
        .toSorted(),
    )
    expect(actual).toEqual(declared)
  })

  it('routes every SEED writer through the shared gate — counted, not merely present', () => {
    // A bare `includes('resolveStoreTitle')` is file-granular, and that is not
    // enough: `use-block-resolve.ts` holds THREE seed writers, so one of them
    // could lose its gate while the check still passed on its siblings'
    // reference. Count the gate calls against the file's declared seed count
    // instead, so losing one is visible.
    //
    // Residual, stated rather than hidden: a file whose seeds are gated but
    // which gains a FOURTH ungated seed would also trip this — which is the
    // intent — but a gate call reached through an indirection this regex
    // cannot see would still read as covered. That is the same class of hole
    // as the three this guard was written to close; see the note on
    // `countStoreWrites`.
    const gateCalls = (src: string): number => (src.match(/\bresolveStoreTitle\s*\(/g) ?? []).length

    const shortfalls = Object.entries(DECLARED_WRITERS)
      .filter(([, d]) => d.kind === 'seed')
      .map(([file, d]) => ({
        file,
        declared: d.seedWrites ?? d.writes,
        gated: gateCalls(readFileSync(file, 'utf8')),
      }))
      .filter((r) => r.gated < r.declared)
      .toSorted((a, b) => a.file.localeCompare(b.file))

    expect(
      shortfalls,
      'A seed writer does not route through `resolveStoreTitle`. Its title comes from a fetched row, so it can be a namespaced page path or blank content and MUST go through the gate in `@/lib/block-title`. Each entry shows the declared seed-write count against the number of gate calls found.',
    ).toEqual([])
  })

  it('keeps the store itself on the gate too', () => {
    // `runPreloadScan` is the one writer the scan structurally cannot see.
    expect(readFileSync(STORE_INTERNAL_WRITER, 'utf8')).toContain('resolveStoreTitle')
  })

  it('gives every matrix writer a declared source file', () => {
    const undeclaredSources = [...new Set(WRITERS.map((w) => w.source))]
      .filter((s) => s !== STORE_INTERNAL_WRITER && !(s in DECLARED_WRITERS))
      .toSorted()
    expect(undeclaredSources).toEqual([])
  })
})
