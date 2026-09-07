/**
 * `{{embed …}}` edit-in-place, behind a per-embed unlock (#4550, phase 2).
 *
 * The three things that can silently go wrong here, and the block that
 * catches each:
 *
 *  1. **The gate stops existing.** Without `unlocked` in `EmbeddedBlockTree`'s
 *     `editable` predicate, every embed on every page becomes editable by a
 *     click, which is exactly the surprise phase 1 refused to ship. → "stays
 *     read-only until this one embed is unlocked".
 *  2. **The write goes to the host page's store.** `EditableBlock` reads its
 *     store from context, so the editable row only lands on the right page
 *     because it is rendered INSIDE the source page's provider. Route it
 *     anywhere else and the optimistic write silently no-ops (`idx < 0` in the
 *     `edit` reducer) while the IPC still lands — the embed shows stale text
 *     until a reload. → "writes through the embedded block's own page store".
 *  3. **A second editor gets mounted.** Invariant 4 is one roving instance per
 *     mounted `BlockTree`. → the single-`block-editor` assertion.
 *
 * The roving editor is faked the way `EditableBlock.test.tsx` fakes it (TipTap
 * does not render in jsdom): a handle whose `mount`/`unmount` are spies, and a
 * stub `EditorSurface` published on `EditorSurfaceContext`. Everything BELOW
 * that seam — `EditableBlock`, `useEditorBlur`, `runUnmountFlush`, the page
 * store's `edit` reducer, the real `edit_block` round trip — is production
 * code. The end-to-end keystroke path is covered by
 * `e2e/embed-edit-in-place.spec.ts` against the real editor.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import {
  EditorSurfaceContext,
  type EditorSurfaceProps,
} from '@/components/editor/editor-surface-context'
import { EmbedRowEditorContext } from '@/components/editor/embed/embed-row-editor-context'
import { HostRowAriaContext } from '@/components/editor/embed/host-row-aria'
import { useEmbedRowEditorValue } from '@/components/editor/embed/use-embed-row-editor'
import { StaticBlock } from '@/components/editor/StaticBlock'
import type { RovingEditorHandle } from '@/editor/use-roving-editor'
import { __resetBlockCommandBus, registerBlockCommandTarget } from '@/lib/block-command-bus'
import { useBlockStore } from '@/stores/blocks'
import { getPageStore, PageBlockStoreProvider } from '@/stores/page-blocks'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

const SPACE = 'SPACE1'
const HOST_PAGE = 'PAGE_HOST'

interface FakeBlock {
  id: string
  content: string
  parent_id: string | null
  position: number
  block_type?: string
  page_id?: string | null
}

let graph = new Map<string, FakeBlock>()
/** Set by a test to say what the faked editor reports as changed on unmount. */
let unmountResult: string | null = null

function toRow(b: FakeBlock) {
  return {
    id: b.id,
    block_type: b.block_type ?? 'content',
    content: b.content,
    parent_id: b.parent_id,
    position: b.position,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: b.page_id ?? null,
  }
}

function subtreeOf(rootId: string) {
  const out: FakeBlock[] = []
  const walk = (parent: string): void => {
    for (const b of graph.values()) {
      if (b.parent_id === parent) {
        out.push(b)
        walk(b.id)
      }
    }
  }
  walk(rootId)
  return { blocks: out.map(toRow), truncated: false, total: out.length }
}

/** Spy on every `edit_block` the run makes; `null` = let it succeed. */
let editBlockFailure: Error | null = null
const editBlockCalls: Array<{ blockId: string; toText: string }> = []

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
            deleted: false,
          }))
      },
      get_block: (args) => {
        const b = graph.get(args['blockId'] as string)
        if (!b) throw new Error('block not found')
        return toRow(b)
      },
      load_page_subtree: (args) => subtreeOf(args['rootBlockId'] as string),
      edit_block: (args) => {
        const blockId = args['blockId'] as string
        const toText = args['toText'] as string
        editBlockCalls.push({ blockId, toText })
        if (editBlockFailure) throw editBlockFailure
        const b = graph.get(blockId)
        if (!b) throw new Error('block not found')
        b.content = toText
        return { ...toRow(b), op_refs: [] }
      },
      save_draft: () => null,
      delete_draft: () => null,
      flush_draft: () => null,
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  unmountResult = null
  editBlockFailure = null
  editBlockCalls.length = 0
  useSpaceStore.setState({ currentSpaceId: SPACE })
  useResolveStore.getState().clearAllForSpace(SPACE)
  useBlockStore.setState({ focusedBlockId: null, selectedBlockIds: [] })
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = vi.fn()
  }
  // The bus registry is module-global; a test that registers a mounted tree
  // would otherwise withhold the unlock control from every test after it.
  __resetBlockCommandBus()
  graph = new Map(
    [
      { id: 'PAGE_S', content: 'Source page', parent_id: null, position: 0, block_type: 'page' },
      { id: 'B1', content: 'Target block', parent_id: 'PAGE_S', position: 0, page_id: 'PAGE_S' },
      { id: 'B1C', content: 'Child of target', parent_id: 'B1', position: 0, page_id: 'PAGE_S' },
    ].map((b) => [b.id, b as FakeBlock]),
  )
  installBackend()
})

// ── The faked roving editor ──────────────────────────────────────────────

/**
 * One handle for the whole render, exactly as a `BlockTree` has one. `mount`
 * / `unmount` maintain `activeBlockId` because `useEditorBlur` bails on a
 * stale blur by comparing it against the block being blurred — a static
 * `null` would make every save assertion pass for the wrong reason (nothing
 * would ever be saved at all).
 */
function makeHandle(): RovingEditorHandle & { mount: ReturnType<typeof vi.fn> } {
  const handle = {
    editor: { fake: true, isEmpty: false },
    activeBlockId: null as string | null,
    originalMarkdown: '',
    mount: vi.fn((blockId: string, markdown: string) => {
      handle.activeBlockId = blockId
      handle.originalMarkdown = markdown
    }),
    unmount: vi.fn(() => {
      handle.activeBlockId = null
      return unmountResult
    }),
    updateListMarker: vi.fn(),
    getMarkdown: vi.fn(() => null),
    splitAtCaret: vi.fn(() => null),
    setOnUpdate: vi.fn(),
    markCommitted: vi.fn(),
  }
  return handle as unknown as RovingEditorHandle & { mount: ReturnType<typeof vi.fn> }
}

function MockEditorSurface({ blockId }: EditorSurfaceProps): ReactElement {
  return <div data-testid="editor-content" data-block-id={blockId} />
}

/**
 * The production arrangement minus the tree: a host page provider, the host
 * row's aria level, the editor surface, and the host tree's editable-row
 * renderer bound to `handle` through the REAL `useEmbedRowEditorValue`.
 */
function HostTreeStub({
  handle,
  children,
}: {
  handle: RovingEditorHandle
  children: ReactNode
}): ReactElement {
  return (
    // The host page's provider is OUTERMOST, matching production: `BlockTree`
    // — which publishes both contexts below — is itself rendered inside its
    // page's `PageBlockContext`.
    <PageBlockStoreProvider pageId={HOST_PAGE}>
      <EditorSurfaceContext.Provider value={MockEditorSurface}>
        <HostTreeContexts handle={handle}>
          <HostRowAriaContext.Provider value={1}>{children}</HostRowAriaContext.Provider>
        </HostTreeContexts>
      </EditorSurfaceContext.Provider>
    </PageBlockStoreProvider>
  )
}

function HostTreeContexts({
  handle,
  children,
}: {
  handle: RovingEditorHandle
  children: ReactNode
}): ReactElement {
  const rowEditor = useEmbedRowEditorValue(handle)
  return (
    <EmbedRowEditorContext.Provider value={rowEditor}>{children}</EmbedRowEditorContext.Provider>
  )
}

function renderEmbed(handle: RovingEditorHandle, content = '{{embed ((B1))}}') {
  return render(
    <HostTreeStub handle={handle}>
      <StaticBlock blockId="HOST1" content={content} onFocus={() => {}} onNavigate={() => {}} />
    </HostTreeStub>,
  )
}

/** Two embeds of the SAME target on one host page — the #4809 round-3 shape. */
function renderTwoEmbeds(handle: RovingEditorHandle) {
  return render(
    <HostTreeStub handle={handle}>
      <StaticBlock
        blockId="HOST1"
        content="{{embed ((B1))}}"
        onFocus={() => {}}
        onNavigate={() => {}}
      />
      <StaticBlock
        blockId="HOST2"
        content="{{embed ((B1))}}"
        onFocus={() => {}}
        onNavigate={() => {}}
      />
    </HostTreeStub>,
  )
}

/** Wait for the embed to have loaded its source page and rendered its rows. */
async function embedRow(text: string): Promise<HTMLElement> {
  return await screen.findByText(text)
}

/**
 * Unlock the embed and wait for the editor to land.
 *
 * No click on a row: unlocking MOVES the focus to the first editable row by
 * itself (that is what makes the feature keyboard-operable), so the editor is
 * already mounted here — and that row's text is no longer plain text, so
 * `embedRow` would not find it either.
 */
async function unlock(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Edit this embed in place' }))
  await screen.findByTestId('block-editor')
}

// ── 1. The gate ──────────────────────────────────────────────────────────

describe('the per-embed unlock', () => {
  it('stays read-only until this one embed is unlocked', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    const row = await embedRow('Target block')

    // Locked: the row is inert. Drop `unlocked` from the `editable` predicate
    // and this click focuses the block and mounts the editor.
    await user.click(row)
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
    expect(screen.queryByTestId('block-editor')).not.toBeInTheDocument()
    expect(handle.mount).not.toHaveBeenCalled()
    expect(screen.getByTestId('embed-container')).not.toHaveClass('embed-unlocked')

    await user.click(screen.getByRole('button', { name: 'Edit this embed in place' }))

    // Unlocked: the strip says so, the rail flips, and the state is announced.
    expect(screen.getByTestId('embed-container')).toHaveClass('embed-unlocked')
    expect(screen.getByText('Editing Source page')).toBeInTheDocument()
    expect(screen.getByText('Text edits only — open the source to restructure')).toBeInTheDocument()
    expect(screen.getByText('Editing Source page in place. Text edits only.')).toBeInTheDocument()

    // Unlocking lands the editor on the first row by itself — the toggle is
    // the ONLY way a keyboard user can reach one, since embedded rows carry no
    // tab stop and arrow-key navigation does not descend into an embed.
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')
    expect(handle.mount).toHaveBeenCalledWith('B1', 'Target block')

    // …and a click still moves it to any other row.
    await user.click(await embedRow('Child of target'))
    expect(useBlockStore.getState().focusedBlockId).toBe('B1C')
  })

  it('skips a nested embed when choosing the row to unlock into', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    // The source page's FIRST row is itself an embed: it renders a nested
    // container, not an editable row, so focusing it would unlock into nothing.
    graph.set('B1', { id: 'B1', content: '{{embed ((B2))}}', parent_id: 'PAGE_S', position: 0 })
    graph.set('B2', { id: 'B2', content: 'Second block', parent_id: 'PAGE_S', position: 1 })
    graph.delete('B1C')
    render(
      <HostTreeStub handle={handle}>
        <StaticBlock blockId="HOST1" content="{{embed [[PAGE_S]]}}" onFocus={() => {}} />
      </HostTreeStub>,
    )
    await screen.findByText('Second block')

    await user.click(screen.getByRole('button', { name: 'Edit this embed in place' }))
    expect(useBlockStore.getState().focusedBlockId).toBe('B2')
    expect(handle.mount).toHaveBeenCalledWith('B2', 'Second block')
  })

  it('offers no unlock control when the source has no editable row', async () => {
    const handle = makeHandle()
    // The one row is an embed token, so there is nothing to rove onto.
    graph.set('B1', { id: 'B1', content: '{{embed ((B1))}}', parent_id: 'PAGE_S', position: 0 })
    graph.delete('B1C')
    render(
      <HostTreeStub handle={handle}>
        <StaticBlock blockId="HOST1" content="{{embed [[PAGE_S]]}}" onFocus={() => {}} />
      </HostTreeStub>,
    )
    await screen.findByTestId('embed-container')
    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Edit this embed in place' }),
      ).not.toBeInTheDocument()
    })
  })

  it('unlocks one embed without unlocking a second embed of the same block', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    render(
      <HostTreeStub handle={handle}>
        <StaticBlock blockId="HOST1" content="{{embed ((B1))}}" onFocus={() => {}} />
        <StaticBlock blockId="HOST2" content="{{embed ((B1))}}" onFocus={() => {}} />
      </HostTreeStub>,
    )
    await waitFor(() => {
      expect(screen.getAllByTestId('embed-container')).toHaveLength(2)
    })
    const [first, second] = screen.getAllByTestId('embed-container') as [HTMLElement, HTMLElement]

    await user.click(within(first).getByRole('button', { name: 'Edit this embed in place' }))
    expect(first).toHaveClass('embed-unlocked')
    // Unlock state is per component, not per target: a shared module slot or a
    // store keyed by target id would flip both.
    expect(second).not.toHaveClass('embed-unlocked')
  })

  it('offers no unlock control outside a BlockTree — there is no editor to rove', async () => {
    render(
      <PageBlockStoreProvider pageId={HOST_PAGE}>
        <StaticBlock blockId="HOST1" content="{{embed ((B1))}}" onFocus={() => {}} />
      </PageBlockStoreProvider>,
    )
    await screen.findByTestId('embed-container')
    expect(
      screen.queryByRole('button', { name: 'Edit this embed in place' }),
    ).not.toBeInTheDocument()
  })
})

// ── 2. One editor, and it writes to the source page ──────────────────────

describe('editing in place', () => {
  it('mounts exactly one editor — the host tree’s — inside the embed', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)

    // Invariant 4: the embed borrows the host handle rather than constructing
    // one, so there is a single editing surface in the document.
    expect(screen.getAllByTestId('block-editor')).toHaveLength(1)
    expect(screen.getAllByTestId('editor-content')).toHaveLength(1)
    expect(screen.getByTestId('block-editor')).toHaveAttribute('data-block-id', 'B1')
  })

  it('writes through the embedded block’s own page store, not the host page’s', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)

    // The editor reports a change; blur runs the real save chain.
    unmountResult = 'Edited in place'
    await act(async () => {
      screen
        .getByTestId('block-editor')
        .dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    await waitFor(() => {
      expect(editBlockCalls).toEqual([{ blockId: 'B1', toText: 'Edited in place' }])
    })
    // The discriminating assertion. `edit_block` is addressed by id and would
    // land from ANY store, but the optimistic write only reaches the SOURCE
    // page's store if that is the store the row was rendered inside — the host
    // page's store does not hold B1, so its reducer returns `{}` and this stays
    // at the pre-edit text.
    await waitFor(() => {
      expect(getPageStore('PAGE_S')?.getState().blocksById.get('B1')?.content).toBe(
        'Edited in place',
      )
    })
    expect(getPageStore(HOST_PAGE)?.getState().blocksById.has('B1')).toBe(false)
    expect(await screen.findByText('Edited in place')).toBeInTheDocument()
  })

  it('rolls the row back and keeps the embed rendering when the save IPC rejects', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)

    editBlockFailure = new Error('backend refused the edit')
    unmountResult = 'Edited in place'
    await act(async () => {
      screen
        .getByTestId('block-editor')
        .dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })

    await waitFor(() => {
      expect(editBlockCalls).toHaveLength(1)
    })
    // The store's rollback is what the user sees: the pre-edit text is back in
    // the embed, and the container is still there to try again in.
    await waitFor(() => {
      expect(getPageStore('PAGE_S')?.getState().blocksById.get('B1')?.content).toBe('Target block')
    })
    expect(screen.getByTestId('embed-container')).toBeInTheDocument()
    expect(await embedRow('Target block')).toBeInTheDocument()
  })
})

// ── 3. Relock ────────────────────────────────────────────────────────────

describe('returning to read-only', () => {
  it('relocks when focus leaves the embed', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)
    expect(screen.getByTestId('embed-container')).toHaveClass('embed-unlocked')

    // Focus moves to a host-page block — the blur half of "relocking or
    // blurring returns to read-only".
    act(() => {
      useBlockStore.getState().setFocused('HOST_OTHER')
    })
    await waitFor(() => {
      expect(screen.getByTestId('embed-container')).not.toHaveClass('embed-unlocked')
    })
    expect(screen.getByText('Embedded from Source page')).toBeInTheDocument()
  })

  it('relocks on the toggle, and the row goes inert again', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await user.click(screen.getByRole('button', { name: 'Edit this embed in place' }))
    await user.click(screen.getByRole('button', { name: 'Stop editing this embed' }))

    expect(screen.getByTestId('embed-container')).not.toHaveClass('embed-unlocked')
    await user.click(await embedRow('Target block'))
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
    expect(screen.queryByTestId('block-editor')).not.toBeInTheDocument()
  })
})

// ── 3b. The two ways the unlock breaks (review round 1) ──────────────────

describe('moving between rows inside an unlocked embed', () => {
  it('survives the blur the click itself causes', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')

    const child = await embedRow('Child of target')

    // The sequence a real click produces, split so the blur can land where
    // production puts it. `userEvent.click` alone cannot reproduce this: the
    // faked handle never DOM-blurs, so `useEditorBlur` step 5 never runs and
    // the null focus below never happens — which is exactly why the original
    // version of this suite passed against the bug.
    await user.pointer({ keys: '[MouseLeft>]', target: child })
    act(() => {
      useBlockStore.getState().setFocused(null)
    })
    // Relocking here re-renders every row with `editable === false`, i.e.
    // `onClick: undefined`, so the click below would dispatch against handlers
    // that no longer exist and the caret would never leave the first row.
    expect(screen.getByTestId('embed-container')).toHaveClass('embed-unlocked')
    await user.pointer({ keys: '[/MouseLeft]', target: child })

    expect(useBlockStore.getState().focusedBlockId).toBe('B1C')
    expect(screen.getByTestId('embed-container')).toHaveClass('embed-unlocked')
    expect(screen.getByTestId('block-editor')).toHaveAttribute('data-block-id', 'B1C')
  })

  it('still relocks when the focus genuinely leaves', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)

    // The other half of the pair: no pointer went down inside the embed, so
    // this null IS the user leaving and the latch must not swallow it.
    act(() => {
      useBlockStore.getState().setFocused(null)
    })
    await waitFor(() => {
      expect(screen.getByTestId('embed-container')).not.toHaveClass('embed-unlocked')
    })
  })
})

describe('a target a mounted tree already renders', () => {
  it('is not offered the unlock, and relocks if a tree mounts while it is open', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)

    // A `BlockTree` mounting on the embed's SOURCE page — the journal week
    // shape, and also what an embed of a block on its own page looks like.
    // Both trees would then render `EditableBlock` for B1 the moment it is
    // focused, because `isFocused` is `focusedBlockId === block.id` and
    // nothing else: two editor surfaces, one roving instance.
    const sourceStore = getPageStore('PAGE_S')
    expect(sourceStore, 'the embed mounts the source page store').toBeDefined()
    act(() => {
      if (sourceStore) registerBlockCommandTarget(sourceStore, {})
    })

    await waitFor(() => {
      expect(screen.queryByTestId('embed-unlock-toggle')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('embed-container')).not.toHaveClass('embed-unlocked')
    expect(screen.queryByTestId('block-editor')).not.toBeInTheDocument()
    // Focus is deliberately left alone. In production the tree that now owns
    // B1 is the one rendering the editor for it, so clearing the focus here
    // would take the caret away from the row that just legitimately claimed
    // it; this harness simply has no such tree to render one.
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')
  })

  it('covers a PAGE target, whose own id is in no store', async () => {
    const handle = makeHandle()
    // A page embed is the case that matters most and the one a target-keyed
    // guard silently misses: `buildFlatTree` starts at the page's CHILDREN, so
    // a page's own id is never in any `blocksById` and asking about it always
    // answers "no tree renders this". Meanwhile the rows it renders are
    // precisely another mounted tree's own rows — `/embed` page P from page P,
    // or Monday's page embedding Tuesday's in the journal week.
    renderEmbed(handle, '{{embed ((PAGE_S))}}')
    await embedRow('Target block')
    // Offered while nothing else renders these rows — so the assertion below
    // is about the guard firing, not about a page embed being unlockable at
    // all.
    expect(screen.getByTestId('embed-unlock-toggle')).toBeInTheDocument()

    const sourceStore = getPageStore('PAGE_S')
    expect(sourceStore, 'the embed mounts the source page store').toBeDefined()
    act(() => {
      if (sourceStore) registerBlockCommandTarget(sourceStore, {})
    })

    await waitFor(() => {
      expect(screen.queryByTestId('embed-unlock-toggle')).not.toBeInTheDocument()
    })
  })
})

describe('two embeds of the same block', () => {
  it('never renders the editor twice for one id', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderTwoEmbeds(handle)
    await waitFor(() => {
      expect(screen.getAllByTestId('embed-container')).toHaveLength(2)
    })

    // Unlock the first, which focuses B1 — the row BOTH embeds render.
    const toggles = screen.getAllByTestId('embed-unlock-toggle')
    await user.click(toggles[0] as HTMLElement)
    await screen.findByTestId('block-editor')
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')

    // Unlock the second. Its `setFocused('B1')` is a no-op on the focus, but
    // the FIRST embed's relock effect sees `rowIds.has('B1')` and stays
    // unlocked — so without arbitration both satisfy `editable && isFocused`
    // and both call `renderRow` for B1: two `<EditorSurface>` and two
    // `id="editor-B1"` nodes driven by ONE roving instance, which is the
    // invariant-4 violation reached through a sibling embed rather than a
    // mounted tree.
    await user.click(screen.getAllByTestId('embed-unlock-toggle')[1] as HTMLElement)

    expect(screen.getAllByTestId('block-editor')).toHaveLength(1)
    expect(document.querySelectorAll('#editor-B1')).toHaveLength(1)
  })
})

describe('getting back OUT of an unlocked embed', () => {
  it('Escape relocks it and returns focus to the container', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)
    expect(useBlockStore.getState().focusedBlockId).toBe('B1')

    const embed = screen.getByTestId('embed-container')
    // Escape must be handled in the CAPTURE phase. While the roving editor is
    // on an embedded row it holds the inert callback set, and every binding in
    // `useBlockKeyboard` `preventDefault()`s before calling back and is then
    // `stopPropagation()`d — so an Escape reaching that listener does nothing
    // AND goes no further. Tab, Shift+Tab and the arrows are swallowed the
    // same way, which is what made this region a keyboard trap: a pointer was
    // the only way out, while `editor-preferences.ts` promises the opposite.
    await user.keyboard('{Escape}')

    expect(embed).not.toHaveClass('embed-unlocked')
    expect(screen.queryByTestId('block-editor')).not.toBeInTheDocument()
    // Focus lands on the container — this region's ONE tab stop — so Tab moves
    // on from here. Clearing the focus without giving it somewhere to go would
    // leave the caret on `document.body` and the trap only half-opened.
    expect(embed).toHaveFocus()
    expect(useBlockStore.getState().focusedBlockId).toBeNull()
  })

  it('leaves Escape alone while a suggestion picker is open', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    renderEmbed(handle)
    await embedRow('Target block')
    await unlock(user)

    // The `/`, `[[`, `#` and `::` pickers are portaled to `document.body` and
    // never hold focus, so their Escape arrives on the contenteditable INSIDE
    // the shell — and React's root capture listener runs before ProseMirror's
    // own handler. Without a bail, dismissing a menu ejected the user from the
    // whole region and committed the half-typed trigger to the source page.
    const popup = document.createElement('div')
    popup.className = 'suggestion-popup'
    // `isSuggestionPopupVisible` rejects a DETACHED node, so this has to be in
    // the document AND laid out — jsdom reports zero boxes, which the helper
    // falls back to `offsetParent` for.
    Object.defineProperty(popup, 'offsetParent', { value: document.body })
    document.body.append(popup)
    try {
      await user.keyboard('{Escape}')
      expect(screen.getByTestId('embed-container')).toHaveClass('embed-unlocked')
      expect(screen.getByTestId('block-editor')).toBeInTheDocument()
      expect(useBlockStore.getState().focusedBlockId).toBe('B1')
    } finally {
      popup.remove()
    }
  })
})

// ── 4. Accessibility ─────────────────────────────────────────────────────

describe('accessibility', () => {
  it('adds exactly one tab stop — the unlock toggle — and no other', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    const { container } = renderEmbed(handle)
    const embed = await screen.findByTestId('embed-container')
    await embedRow('Target block')

    // Phase 1 shipped the read-only region as ONE tab stop. An editable region
    // needs its way IN reachable without landing on the container and guessing
    // a key, so the toggle is the second — and the collapse / open-source
    // controls are still shown to be opted OUT, or this count would pass while
    // the region quietly grew to four stops.
    const tabStops = Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([tabindex="-1"]), input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    )
    expect(tabStops).toHaveLength(2)
    expect(tabStops[0]).toBe(embed)
    expect(tabStops[1]).toBe(screen.getByTestId('embed-unlock-toggle'))
    expect(screen.getByTestId('embed-unlock-toggle')).toHaveAttribute('aria-pressed', 'false')

    await user.click(screen.getByTestId('embed-unlock-toggle'))
    expect(screen.getByTestId('embed-unlock-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(await axe(container)).toHaveNoViolations()
  })

  it('is axe-clean locked, unlocked, and with the editor on a nested row', async () => {
    const user = userEvent.setup()
    const handle = makeHandle()
    const { container } = renderEmbed(handle)
    await embedRow('Target block')
    expect(await axe(container)).toHaveNoViolations()

    // Unlocked: the hint paragraph, the live region and the pressed toggle all
    // join the region, and the first row swaps to the editable one.
    await unlock(user)
    expect(screen.getByTestId('block-editor')).toHaveAttribute('data-block-id', 'B1')
    expect(await axe(container)).toHaveNoViolations()

    // Moving the editor down a level leaves an `<li aria-level="3">` holding
    // the editor while its parent `<li>` is back to a plain row — the shape
    // most likely to break the outline's aria-level / setsize contract.
    await user.click(await embedRow('Child of target'))
    expect(screen.getByTestId('block-editor')).toHaveAttribute('data-block-id', 'B1C')
    expect(await axe(container)).toHaveNoViolations()
  })
})
