/**
 * An embedded row draws what the block's own row draws (#6747): the task
 * checkbox, the list marker, and a read-only metadata row (priority, due and
 * scheduled chips, property chips). The checkbox steps the task's state
 * through the SOURCE page's store, so every mounted view of the block moves.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { emptyPage, withOps } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { HostRowAriaContext } from '@/components/editor/embed/host-row-aria'
import { StaticBlock } from '@/components/editor/StaticBlock'
import { PageBlockStoreProvider, usePageBlockStore } from '@/stores/page-blocks'
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
  todo_state?: string | null
  priority?: string | null
  due_date?: string | null
  scheduled_date?: string | null
}

let graph = new Map<string, FakeBlock>()
let props: Record<string, { key: string; value_text: string }[]> = {}

function toRow(b: FakeBlock) {
  return {
    id: b.id,
    block_type: b.block_type ?? 'content',
    content: b.content,
    parent_id: b.parent_id,
    position: b.position,
    deleted_at: null,
    todo_state: b.todo_state ?? null,
    priority: b.priority ?? null,
    due_date: b.due_date ?? null,
    scheduled_date: b.scheduled_date ?? null,
    page_id: b.block_type === 'page' ? null : 'PAGE_S',
  }
}

function propertyRow(key: string, value: string) {
  return {
    key,
    value_text: value,
    value_num: null,
    value_date: null,
    value_ref: null,
    value_bool: null,
    value_list: null,
  }
}

function installBackend(): void {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      batch_resolve: (args) =>
        ((args['ids'] as string[]) ?? [])
          .map((id) => graph.get(id))
          .filter((b): b is FakeBlock => b != null)
          .map((b) => ({
            id: b.id,
            title: b.content,
            block_type: b.block_type ?? 'content',
            deleted: false,
          })),
      get_block: (args) => {
        const b = graph.get(args['blockId'] as string)
        if (!b) throw new Error('block not found')
        return toRow(b)
      },
      load_page_subtree: (args) => {
        const root = args['rootBlockId'] as string
        const out = [...graph.values()].filter((b) => b.parent_id === root)
        return { blocks: out.map(toRow), truncated: false, total: out.length }
      },
      list_property_defs: () => emptyPage,
      get_batch_properties: (args) =>
        Object.fromEntries(
          ((args['blockIds'] as string[]) ?? []).map((id) => [
            id,
            (props[id] ?? []).map((p) => propertyRow(p.key, p.value_text)),
          ]),
        ),
      set_todo_state: (args) => {
        const b = graph.get(args['blockId'] as string)
        if (!b) throw new Error('block not found')
        b.todo_state = args['state'] as string | null
        return withOps(toRow(b))
      },
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useSpaceStore.setState({ currentSpaceId: SPACE })
  useResolveStore.getState().clearAllForSpace(SPACE)
  graph = new Map(
    (
      [
        { id: 'PAGE_S', content: 'Source page', parent_id: null, position: 0, block_type: 'page' },
        {
          id: 'TASK1',
          content: 'Ship the release',
          parent_id: 'PAGE_S',
          position: 0,
          todo_state: 'TODO',
          priority: '1',
          due_date: '2026-11-20',
          scheduled_date: '2026-11-19',
        },
        { id: 'NOTE1', content: 'A plain note', parent_id: 'PAGE_S', position: 1 },
        { id: 'ITEM1', content: 'A bullet item', parent_id: 'PAGE_S', position: 2 },
      ] satisfies FakeBlock[]
    ).map((b) => [b.id, b]),
  )
  props = {
    TASK1: [{ key: 'effort', value_text: '2h' }],
    ITEM1: [{ key: 'listStyle', value_text: 'bullet' }],
  }
  installBackend()
})

/** The source page's own view of TASK1's state, through a second provider. */
function SourceProbe() {
  const state = usePageBlockStore((s) => s.blocksById.get('TASK1')?.todo_state ?? 'unloaded')
  return <output data-testid="source-probe">{state}</output>
}

function renderEmbed(withSourceView = false) {
  return render(
    <>
      <PageBlockStoreProvider pageId="PAGE_HOST">
        <HostRowAriaContext.Provider value={1}>
          <StaticBlock
            blockId="HOST1"
            content="{{embed [[PAGE_S]]}}"
            onFocus={() => {}}
            onNavigate={() => {}}
          />
        </HostRowAriaContext.Provider>
      </PageBlockStoreProvider>
      {withSourceView && (
        <PageBlockStoreProvider pageId="PAGE_S">
          <SourceProbe />
        </PageBlockStoreProvider>
      )}
    </>,
  )
}

function embeddedRow(id: string): HTMLElement {
  const row = screen
    .getByTestId('embed-tree')
    .querySelector<HTMLElement>(`[data-embed-block-id="${id}"]`)
  if (!row) throw new Error(`no embedded row ${id}`)
  return row
}

describe('embedded row chrome', () => {
  it('draws the task checkbox, priority, dates and property chips the block has', async () => {
    renderEmbed()
    await screen.findByText('Ship the release')
    const task = embeddedRow('TASK1')

    expect(within(task).getByTestId('task-checkbox-todo')).toBeInTheDocument()
    expect(within(task).getByText('P1')).toBeInTheDocument()
    expect(task.querySelector('.due-date-chip')).toHaveTextContent('Nov 20')
    expect(task.querySelector('.scheduled-chip')).toHaveTextContent('Nov 19')
    expect(await within(task).findByTestId('property-chip')).toHaveTextContent('2h')

    // A plain note carries none of it.
    const note = embeddedRow('NOTE1')
    expect(within(note).queryByTestId('task-marker')).not.toBeInTheDocument()
    expect(within(note).queryByTestId('block-metadata-row')).not.toBeInTheDocument()
  })

  it('draws a list-styled block’s marker', async () => {
    renderEmbed()
    await screen.findByText('A bullet item')
    expect(await within(embeddedRow('ITEM1')).findByTestId('list-marker')).toHaveTextContent('•')
  })

  it('keeps the chips read-only: the checkbox is the row’s only control', async () => {
    renderEmbed()
    await screen.findByText('Ship the release')
    const task = embeddedRow('TASK1')
    await within(task).findByTestId('property-chip')
    const buttons = within(task).getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toHaveAttribute('data-testid', 'task-marker')
  })

  it('reads every row’s properties in one batch', async () => {
    renderEmbed()
    await within(await screen.findByTestId('embed-tree')).findAllByTestId('property-chip')
    const batches = mockedInvoke.mock.calls.filter((c) => c[0] === 'get_batch_properties')
    expect(batches).toHaveLength(1)
    const args = batches[0]?.[1] as { blockIds: string[] } | undefined
    expect(new Set(args?.blockIds)).toEqual(new Set(['TASK1', 'NOTE1', 'ITEM1']))
  })

  it('ticking steps the task on its own page, and every view of it moves', async () => {
    const user = userEvent.setup()
    renderEmbed(true)
    await screen.findByText('Ship the release')
    await waitFor(() => expect(screen.getByTestId('source-probe')).toHaveTextContent('TODO'))

    await user.click(within(embeddedRow('TASK1')).getByTestId('task-marker'))

    expect(await within(embeddedRow('TASK1')).findByTestId('task-checkbox-doing')).toBeVisible()
    // The source page's own store holds the new state, and so does the backend.
    expect(screen.getByTestId('source-probe')).toHaveTextContent('DOING')
    expect(graph.get('TASK1')?.todo_state).toBe('DOING')
    expect(mockedInvoke.mock.calls.filter((c) => c[0] === 'set_todo_state')).toHaveLength(1)
    // The tick unlocks nothing: the locked embed still mounts no editable row.
    expect(screen.getByTestId('embed-tree').querySelector('[data-embed-editable]')).toBeNull()
  })

  it('is axe-clean with the chrome drawn', async () => {
    const { container } = renderEmbed()
    await within(await screen.findByTestId('embed-tree')).findAllByTestId('property-chip')
    expect(await axe(container)).toHaveNoViolations()
  })
})
