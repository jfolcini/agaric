/**
 * `{{embed ((ULID))}}` — block and page embeds (#4550, phase 1).
 *
 * Each block below names the failure it would see if the production code
 * under test were absent, because that is the only thing a passing assertion
 * proves. The four that matter:
 *
 *  1. without `StaticBlock`'s sniff branch the token renders as inert literal
 *     text and no container exists;
 *  2. without `EmbedChainContext`'s ancestor set, A-embeds-B-embeds-A either
 *     recurses until the depth cap (wrong stub, wrong level) or, with neither
 *     guard, does not terminate;
 *  3. without the registry fan-out, editing the source through a provider
 *     that is NOT the registry slot's leaves the embed rendering pre-edit
 *     content — and the test below asserts the embed's store is not the
 *     slot's, so it cannot pass vacuously;
 *  4. without the depth re-base + host-relative `aria-level`, an embedded row
 *     is announced at the SOURCE page's level rather than the host's.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { HostRowAriaContext } from '@/components/editor/embed/host-row-aria'
import { StaticBlock } from '@/components/editor/StaticBlock'
import { PREFERENCES, effectiveKey } from '@/lib/preferences'
import {
  getPageStore,
  PageBlockStoreProvider,
  usePageBlockStoreApi,
  type PageBlockState,
} from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const SPACE = 'SPACE1'

interface FakeBlock {
  id: string
  content: string
  parent_id: string | null
  position: number
  block_type?: string
  page_id?: string | null
  deleted?: boolean
}

/** Rows the fake backend serves, keyed by id. Mutated per test. */
let graph = new Map<string, FakeBlock>()

function seed(blocks: FakeBlock[]): void {
  graph = new Map(blocks.map((b) => [b.id, b]))
}

function toRow(b: FakeBlock) {
  return {
    id: b.id,
    block_type: b.block_type ?? 'content',
    content: b.content,
    parent_id: b.parent_id,
    position: b.position,
    deleted_at: b.deleted ? 1 : null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: b.page_id ?? null,
  }
}

/** Every descendant of `rootId`, in `buildFlatTree`'s expected bag form. */
function subtreeOf(rootId: string) {
  const out: FakeBlock[] = []
  const walk = (parent: string): void => {
    for (const b of graph.values()) {
      if (b.parent_id === parent && !b.deleted) {
        out.push(b)
        walk(b.id)
      }
    }
  }
  walk(rootId)
  return { blocks: out.map(toRow), truncated: false, total: out.length }
}

function installBackend(): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      batch_resolve: (args) => {
        const ids = (args['ids'] as string[]) ?? []
        return ids
          .map((id) => graph.get(id))
          .filter((b): b is FakeBlock => b != null)
          .map((b) => ({
            id: b.id,
            title: b.content,
            block_type: b.block_type ?? 'content',
            deleted: b.deleted === true,
          }))
      },
      get_block: (args) => {
        const b = graph.get(args['blockId'] as string)
        if (!b || b.deleted) throw new Error('block not found')
        return toRow(b)
      },
      load_page_subtree: (args) => subtreeOf(args['rootBlockId'] as string),
      edit_block: (args) => {
        const b = graph.get(args['blockId'] as string)
        if (!b) throw new Error('block not found')
        b.content = args['toText'] as string
        return { ...toRow(b), ops: [] }
      },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSpaceStore.setState({ currentSpaceId: SPACE })
  useResolveStore.getState().clearAllForSpace(SPACE)
  installBackend()
})

/** The default fixture: PAGE_S holds B1 (with a child) at storage depth 2. */
function seedDefaultGraph(): void {
  seed([
    { id: 'PAGE_S', content: 'Source page', parent_id: null, position: 0, block_type: 'page' },
    { id: 'ANC1', content: 'Ancestor one', parent_id: 'PAGE_S', position: 0, page_id: 'PAGE_S' },
    { id: 'ANC2', content: 'Ancestor two', parent_id: 'ANC1', position: 0, page_id: 'PAGE_S' },
    { id: 'B1', content: 'Target block', parent_id: 'ANC2', position: 0, page_id: 'PAGE_S' },
    { id: 'B1C', content: 'Child of target', parent_id: 'B1', position: 0, page_id: 'PAGE_S' },
  ])
}

const HOST_PAGE = 'PAGE_HOST'

/**
 * A host block inside its own page's provider — the production arrangement.
 * The provider matters for more than realism: the embed's collapse state is
 * scoped to the HOST page, read before the source page's provider mounts.
 */
function renderHostBlock(content: string, hostAriaLevel = 0) {
  return render(
    <PageBlockStoreProvider pageId={HOST_PAGE}>
      <HostRowAriaContext.Provider value={hostAriaLevel}>
        <StaticBlock blockId="HOST1" content={content} onFocus={() => {}} onNavigate={() => {}} />
      </HostRowAriaContext.Provider>
    </PageBlockStoreProvider>,
  )
}

// ── 1. The sniff ─────────────────────────────────────────────────────────

describe('the {{embed}} content sniff', () => {
  it('renders the target subtree instead of the literal token', async () => {
    seedDefaultGraph()
    renderHostBlock('{{embed ((B1))}}')

    // Absent the sniff branch in StaticBlock this is the failure: the token
    // renders as ordinary text and no container ever mounts.
    expect(await screen.findByTestId('embed-container')).toBeInTheDocument()
    expect(await screen.findByText('Target block')).toBeInTheDocument()
    expect(screen.getByText('Child of target')).toBeInTheDocument()
    expect(screen.queryByText('{{embed ((B1))}}')).not.toBeInTheDocument()
  })

  it('accepts the [[ULID]] page form and renders the page top-level blocks', async () => {
    seedDefaultGraph()
    renderHostBlock('{{embed [[PAGE_S]]}}')

    expect(await screen.findByTestId('embed-container')).toBeInTheDocument()
    // A page embed shows the page's own children, and the strip is the page
    // title alone — there are no ancestors to show.
    expect(await screen.findByText('Ancestor one')).toBeInTheDocument()
    expect(screen.getByText('Embedded from Source page')).toBeInTheDocument()
  })

  it('leaves a half-typed token as plain text', async () => {
    seedDefaultGraph()
    renderHostBlock('{{embed ((B1))')
    await waitFor(() => {
      expect(screen.getByText(/\{\{embed/)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('embed-container')).not.toBeInTheDocument()
  })
})

// ── 2. Cycles and depth ──────────────────────────────────────────────────

describe('cycle and depth guards', () => {
  it('renders the cycle stub where the loop closes, at nesting level 2', async () => {
    seed([
      { id: 'PAGE_S', content: 'Page S', parent_id: null, position: 0, block_type: 'page' },
      {
        id: 'B1',
        content: '{{embed ((B2))}}',
        parent_id: 'PAGE_S',
        position: 0,
        page_id: 'PAGE_S',
      },
      { id: 'PAGE_T', content: 'Page T', parent_id: null, position: 0, block_type: 'page' },
      {
        id: 'B2',
        content: '{{embed ((B1))}}',
        parent_id: 'PAGE_T',
        position: 0,
        page_id: 'PAGE_T',
      },
    ])
    renderHostBlock('{{embed ((B1))}}')

    // No infinite render, no thrown boundary: the loop closes visibly, with
    // real (announced) text, and it is the ANCESTOR SET that stops it — the
    // depth cap would only fire one level deeper and label it differently.
    const stub = await screen.findByTestId('embed-stub')
    expect(stub).toHaveAttribute('data-embed-stub', 'cycle')
    expect(within(stub).getByText('Already shown above')).toBeInTheDocument()
    expect(within(stub).getByRole('button', { name: 'Open source' })).toBeInTheDocument()
    // Exactly two containers were materialised before the loop was caught.
    expect(screen.getAllByTestId('embed-container')).toHaveLength(2)
  })

  it('stubs a chain of four distinct embeds at the fourth level', async () => {
    seed([
      { id: 'PAGE_S', content: 'Page S', parent_id: null, position: 0, block_type: 'page' },
      {
        id: 'B1',
        content: '{{embed ((B2))}}',
        parent_id: 'PAGE_S',
        position: 0,
        page_id: 'PAGE_S',
      },
      {
        id: 'B2',
        content: '{{embed ((B3))}}',
        parent_id: 'PAGE_S',
        position: 1,
        page_id: 'PAGE_S',
      },
      {
        id: 'B3',
        content: '{{embed ((B4))}}',
        parent_id: 'PAGE_S',
        position: 2,
        page_id: 'PAGE_S',
      },
      {
        id: 'B4',
        content: 'Bottom of the chain',
        parent_id: 'PAGE_S',
        position: 3,
        page_id: 'PAGE_S',
      },
    ])
    renderHostBlock('{{embed ((B1))}}')

    // MAX_EMBED_DEPTH = 3 containers, then the depth stub. No id repeats, so
    // the ancestor set can never fire here — this is the independent bound.
    const stub = await screen.findByTestId('embed-stub')
    expect(stub).toHaveAttribute('data-embed-stub', 'depth')
    expect(within(stub).getByText('Nested too deep')).toBeInTheDocument()
    expect(screen.getAllByTestId('embed-container')).toHaveLength(3)
    expect(screen.queryByText('Bottom of the chain')).not.toBeInTheDocument()
  })
})

// ── 3. Liveness ──────────────────────────────────────────────────────────

/**
 * Mounts a SECOND provider for the same page — the source page's own view —
 * AFTER the embed, so the registry slot points at this one and the embed's
 * store is deliberately not the canonical one. That is the whole point: it is
 * the default arrangement today, and it is the arrangement in which reusing
 * `slot.store` would produce a permanently stale embed.
 */
let sourceStore: StoreApi<PageBlockState> | null = null

function SourceProbe(): React.ReactElement {
  const store = usePageBlockStoreApi()
  useEffect(() => {
    sourceStore = store
    if (store.getState().blocks.length === 0) void store.getState().load()
  }, [store])
  return <div data-testid="source-probe" />
}

function LivenessHarness({ showSource }: { showSource: boolean }): React.ReactElement {
  return (
    <>
      <StaticBlock
        blockId="HOST1"
        content="{{embed ((B1))}}"
        onFocus={() => {}}
        onNavigate={() => {}}
      />
      {showSource && (
        <PageBlockStoreProvider pageId="PAGE_S">
          <SourceProbe />
        </PageBlockStoreProvider>
      )}
    </>
  )
}

describe('liveness across two providers for one page', () => {
  beforeEach(() => {
    sourceStore = null
    seedDefaultGraph()
  })

  it('re-renders the embed when the source is edited through a NON-slot provider, with no refetch', async () => {
    const { rerender } = render(<LivenessHarness showSource={false} />)
    expect(await screen.findByText('Target block')).toBeInTheDocument()

    rerender(<LivenessHarness showSource />)
    await screen.findByTestId('source-probe')
    await waitFor(() => {
      expect(sourceStore).not.toBeNull()
      expect(sourceStore?.getState().blocks.length).toBeGreaterThan(0)
    })

    // THE ANTI-VACUITY ASSERTION. The later-mounted source view owns the
    // registry slot; the embed holds a different store for the same pageId.
    // Without the fan-out, a write through this store cannot reach the embed.
    expect(getPageStore('PAGE_S')).toBe(sourceStore)

    const loadsBefore = mockedInvoke.mock.calls.filter((c) => c[0] === 'load_page_subtree').length

    // The real write path: the source page's own store edits its own block.
    await act(async () => {
      await sourceStore?.getState().edit('B1', 'Edited target')
    })

    expect(await screen.findByText('Edited target')).toBeInTheDocument()
    expect(screen.queryByText('Target block')).not.toBeInTheDocument()
    // Push, not refetch: the embed learned about the edit without an IPC.
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'load_page_subtree').length).toBe(
      loadsBefore,
    )
  })
})

// ── 4. Host-relative ARIA ────────────────────────────────────────────────

describe('host-relative accessibility', () => {
  it('announces embedded rows at the HOST tree level, not the source page depth', async () => {
    seedDefaultGraph()
    // B1 sits at storage depth 2 on its own page (PAGE_S › ANC1 › ANC2 › B1),
    // so its native `aria-level` there would be 3 and its child's 4.
    renderHostBlock('{{embed ((B1))}}', 2)
    await screen.findByTestId('embed-container')

    const tree = screen.getByTestId('embed-tree')
    const rows = within(tree).getAllByRole('listitem')
    // Host row is level 2 → the container occupies level 3 → the re-based
    // target is level 3 and its child level 4. Inheriting the source depths
    // would announce 3 and 4 for rows that are visually at 1 and 2 of a
    // three-row embed — the mismatch this re-base exists to prevent.
    expect(rows[0]).toHaveAttribute('aria-level', '3')
    expect(rows[0]).toHaveAttribute('aria-setsize', '1')
    expect(rows[0]).toHaveAttribute('aria-posinset', '1')
    expect(rows[1]).toHaveAttribute('aria-level', '4')
  })

  it('introduces no tree / treeitem roles', async () => {
    seedDefaultGraph()
    renderHostBlock('{{embed ((B1))}}', 1)
    await screen.findByTestId('embed-container')
    expect(screen.queryAllByRole('tree')).toHaveLength(0)
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0)
  })

  it('is axe-clean rendered and collapsed', async () => {
    seedDefaultGraph()
    const { container } = renderHostBlock('{{embed ((B1))}}', 1)
    await screen.findByTestId('embed-container')
    expect(await axe(container)).toHaveNoViolations()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Collapse embed' }))
    await waitFor(() => {
      expect(screen.queryByTestId('embed-tree')).not.toBeInTheDocument()
    })
    expect(await axe(container)).toHaveNoViolations()
  })

  it('is axe-clean as a cycle stub', async () => {
    seed([
      { id: 'PAGE_S', content: 'Page S', parent_id: null, position: 0, block_type: 'page' },
      {
        id: 'B1',
        content: '{{embed ((B1))}}',
        parent_id: 'PAGE_S',
        position: 0,
        page_id: 'PAGE_S',
      },
    ])
    const { container } = renderHostBlock('{{embed ((B1))}}', 1)
    await screen.findByTestId('embed-stub')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('is axe-clean with a deleted target', async () => {
    seed([
      { id: 'PAGE_S', content: 'Page S', parent_id: null, position: 0, block_type: 'page' },
      {
        id: 'B1',
        content: 'Deleted target',
        parent_id: 'PAGE_S',
        position: 0,
        page_id: 'PAGE_S',
        deleted: true,
      },
    ])
    const { container } = renderHostBlock('{{embed ((B1))}}', 1)
    await screen.findByTestId('embed-deleted')
    expect(await axe(container)).toHaveNoViolations()
  })
})

// ── 5. Degraded targets ──────────────────────────────────────────────────

describe('degraded targets', () => {
  it('keeps the container visible with a Source deleted strip and a Restore control', async () => {
    seed([
      { id: 'PAGE_S', content: 'Page S', parent_id: null, position: 0, block_type: 'page' },
      {
        id: 'B1',
        content: 'Gone but not forgotten',
        parent_id: 'PAGE_S',
        position: 0,
        page_id: 'PAGE_S',
        deleted: true,
      },
    ])
    renderHostBlock('{{embed ((B1))}}')

    // Never nothing: the host block's content still holds the token, so a
    // silent disappearance would leave an empty, unexplained row.
    const shell = await screen.findByTestId('embed-deleted')
    expect(within(shell).getByText('Source deleted')).toBeInTheDocument()
    expect(within(shell).getByRole('button', { name: 'Restore from Trash' })).toBeInTheDocument()
    expect(within(shell).getByText('Gone but not forgotten')).toBeInTheDocument()
  })

  it('renders a non-navigating broken chip for a purged or cross-space target', async () => {
    seed([{ id: 'PAGE_S', content: 'Page S', parent_id: null, position: 0, block_type: 'page' }])
    renderHostBlock('{{embed ((NOPE))}}')

    const shell = await screen.findByTestId('embed-unresolved')
    const chip = within(shell).getByTestId('embed-broken-chip')
    expect(chip).toBeInTheDocument()
    // Non-navigating by construction — no control anywhere in the container.
    expect(within(shell).queryAllByRole('button')).toHaveLength(0)
    expect(within(shell).queryAllByRole('link')).toHaveLength(0)
  })
})

// ── 6. Interaction ───────────────────────────────────────────────────────

describe('container interaction', () => {
  it('is exactly one tab stop, with Enter opening the source and Space collapsing', async () => {
    seedDefaultGraph()
    const onNavigate = vi.fn()
    render(
      <HostRowAriaContext.Provider value={1}>
        <StaticBlock
          blockId="HOST1"
          content="{{embed ((B1))}}"
          onFocus={() => {}}
          onNavigate={onNavigate}
        />
      </HostRowAriaContext.Provider>,
    )
    const container = await screen.findByTestId('embed-container')
    expect(container).toHaveAttribute('tabindex', '0')
    // EXACTLY one tab stop for the whole region. Counting `[tabindex="0"]`
    // alone would pass vacuously: a <button> is a tab stop with no tabindex
    // attribute at all, so the header's two controls have to be counted and
    // shown to be opted OUT (`tabIndex={-1}`). They stay pointer-reachable and
    // keyboard-reachable through the container's own Enter / Space.
    const tabStops = container.parentElement?.querySelectorAll(
      'a[href], button:not([tabindex="-1"]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )
    expect(tabStops).toHaveLength(1)
    expect(tabStops?.[0]).toBe(container)
    expect(
      within(screen.getByTestId('embed-tree')).queryAllByRole('listitem', { hidden: true }).length,
    ).toBeGreaterThan(0)

    const user = userEvent.setup()
    container.focus()
    await user.keyboard('{Enter}')
    expect(onNavigate).toHaveBeenCalledWith('B1')

    await user.keyboard(' ')
    await waitFor(() => {
      expect(screen.queryByTestId('embed-tree')).not.toBeInTheDocument()
    })
  })

  // Review note 3 (#4572): `aria-expanded` used to live only on the
  // tabIndex={-1} collapse button. The container is the element that is
  // ACTUALLY focused when Space fires (see the test above), so it is the
  // container's own `aria-expanded` a screen reader announces a change on —
  // a button-only attribute update is silent from there. axe does not flag
  // this (it is not an axe rule), so this assertion, not an axe run, is what
  // has to catch a regression.
  it('carries aria-expanded on the focusable container itself, tracking collapse state', async () => {
    seedDefaultGraph()
    renderHostBlock('{{embed ((B1))}}')
    const container = await screen.findByTestId('embed-container')
    expect(container).toHaveAttribute('aria-expanded', 'true')

    const user = userEvent.setup()
    container.focus()
    await user.keyboard(' ')
    await waitFor(() => {
      expect(screen.queryByTestId('embed-tree')).not.toBeInTheDocument()
    })
    expect(container).toHaveAttribute('aria-expanded', 'false')

    await user.keyboard(' ')
    await screen.findByTestId('embed-tree')
    expect(container).toHaveAttribute('aria-expanded', 'true')
  })

  it('never writes either page’s collapsed_ids key when an embed collapses', async () => {
    seedDefaultGraph()
    const sourceKey = effectiveKey(PREFERENCES.blockCollapse, 'PAGE_S')
    const hostKey = effectiveKey(PREFERENCES.blockCollapse, HOST_PAGE)
    localStorage.setItem(sourceKey, JSON.stringify(['ANC1']))
    localStorage.setItem(hostKey, JSON.stringify(['SOME_HOST_BLOCK']))
    const sourceBefore = localStorage.getItem(sourceKey)
    const hostBefore = localStorage.getItem(hostKey)

    renderHostBlock('{{embed ((B1))}}')
    await screen.findByTestId('embed-container')
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Collapse embed' }))
    await waitFor(() => {
      expect(screen.queryByTestId('embed-tree')).not.toBeInTheDocument()
    })

    // Byte-identical on BOTH sides. Writing into the source page's key would
    // rewrite its saved layout for every other view of it; writing into the
    // host page's key would collide with the host outline's own collapsed
    // block ids.
    expect(localStorage.getItem(sourceKey)).toBe(sourceBefore)
    expect(localStorage.getItem(hostKey)).toBe(hostBefore)
    expect(localStorage.getItem(effectiveKey(PREFERENCES.embedCollapse, HOST_PAGE))).toBe(
      JSON.stringify(['HOST1']),
    )
  })

  it('restores a persisted collapse, and expanding prunes the id back out', async () => {
    seedDefaultGraph()
    const embedKey = effectiveKey(PREFERENCES.embedCollapse, HOST_PAGE)
    // A sibling embed's id shares the entry and must survive untouched.
    localStorage.setItem(embedKey, JSON.stringify(['HOST1', 'HOST_SIBLING']))

    renderHostBlock('{{embed ((B1))}}')
    const container = await screen.findByTestId('embed-container')
    expect(within(container).queryByTestId('embed-tree')).not.toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Expand embed' }))
    await screen.findByTestId('embed-tree')
    expect(localStorage.getItem(embedKey)).toBe(JSON.stringify(['HOST_SIBLING']))
  })

  // #3881 — the stored value is a `string[]`, and it comes back out of
  // `JSON.parse` as `any`. `PREFERENCES.embedCollapse` therefore parses
  // through `parseStringArray`, which CHECKS the shape rather than asserting
  // it. Without that check a stale entry from an older schema (the boolean
  // this preference briefly was), or a hand-edited devtools value, reaches
  // `.includes(hostBlockId)` as a non-array and throws during render — the
  // embed, and the host row around it, disappear behind an error.
  it.each([
    ['the boolean an older schema stored', 'true'],
    ['an object', '{"HOST1":true}'],
    ['a bare string', '"HOST1"'],
    ['a number', '3'],
    ['null', 'null'],
    ['undecodable bytes', '{not json'],
  ])('renders expanded when the stored collapse entry is %s', async (_label, stored) => {
    seedDefaultGraph()
    localStorage.setItem(effectiveKey(PREFERENCES.embedCollapse, HOST_PAGE), stored)

    renderHostBlock('{{embed ((B1))}}')

    // Falls back to "nothing collapsed" rather than throwing or collapsing.
    await screen.findByTestId('embed-container')
    expect(await screen.findByTestId('embed-tree')).toBeInTheDocument()
    expect(await screen.findByText('Target block')).toBeInTheDocument()
  })

  it('still collapses from a WELL-FORMED stored entry, so the rejection above is not vacuous', async () => {
    seedDefaultGraph()
    localStorage.setItem(
      effectiveKey(PREFERENCES.embedCollapse, HOST_PAGE),
      JSON.stringify(['HOST1']),
    )

    renderHostBlock('{{embed ((B1))}}')
    await screen.findByTestId('embed-container')
    expect(screen.queryByTestId('embed-tree')).not.toBeInTheDocument()
  })
})
