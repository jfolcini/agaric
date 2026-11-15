/**
 * #6746 — on a touch phone a long press on a `((ref))` chip opens the peek's
 * content as a bottom sheet, with Open and Copy reference; a tap still
 * navigates. The real gesture on a device is pending (#6513).
 */
import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { BlockRow } from '@/lib/bindings'
import { normalizeBlockRefTitle } from '@/lib/block-title'
import { t } from '@/lib/i18n'
import { queryClient } from '@/lib/query-client'
import { LONG_PRESS_DELAY } from '@/lib/touch-press'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/hooks/useIsTouch', () => ({ useIsTouch: () => true }))
vi.mock('@/hooks/useIsMobile', () => ({ useIsMobile: () => true }))

import { BlockRefPeek } from '@/components/BlockRefPeek'
import { renderRichContent } from '@/components/RichContentRenderer'

const SPACE = 'SPACE_PERSONAL'
const TARGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const PAGE = '01CRZ3NDEKTSV4RRFFQ69G5FAV'
const CONTENT = 'The decision, in full, which the chip has no room for.'

function blockRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: TARGET,
    block_type: 'content',
    content: CONTENT,
    parent_id: PAGE,
    position: 0,
    deleted_at: null,
    todo_state: null,
    priority: null,
    due_date: null,
    scheduled_date: null,
    page_id: PAGE,
    ...overrides,
  }
}

function Chip({ onNavigate }: { onNavigate: (id: string) => void }): ReactElement {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setEl}>
      {renderRichContent(`((${TARGET}))`, {
        interactive: true,
        onNavigate,
        resolveBlockTitle: () => normalizeBlockRefTitle(CONTENT),
      })}
      <BlockRefPeek container={el} />
    </div>
  )
}

function chip(): HTMLElement {
  return document.querySelector(`[data-type="block-ref"][data-id="${TARGET}"]`) as HTMLElement
}

const touch = { touches: [{ clientX: 10, clientY: 10 }] }

/** Hold the chip past the long-press delay; returns whether the release was let through. */
async function longPress(): Promise<boolean> {
  fireEvent.touchStart(chip(), touch)
  await act(async () => {
    vi.advanceTimersByTime(LONG_PRESS_DELAY)
  })
  return fireEvent.touchEnd(chip(), { touches: [] })
}

async function openSheet(): Promise<HTMLElement> {
  await longPress()
  const sheet = await screen.findByTestId('ref-peek-sheet')
  await within(sheet).findByText(CONTENT)
  return sheet
}

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  // Advancing with real time too: TanStack's notify runs on a timer the payload waits for.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useSpaceStore.setState({
    currentSpaceId: SPACE,
    availableSpaces: [{ id: SPACE, name: 'Personal', accent_color: null }],
  })
  vi.mocked(invoke).mockImplementation(
    mockInvokeCommands({
      batch_resolve: (args) =>
        (args['ids'] as string[]).map((id) => ({
          id,
          title: id === PAGE ? 'Decisions' : CONTENT,
          block_type: id === PAGE ? 'page' : 'content',
          deleted: false,
        })),
      get_block: (args) =>
        args['blockId'] === PAGE
          ? blockRow({ id: PAGE, block_type: 'page', content: 'Decisions', page_id: null })
          : blockRow(),
      count_backlinks_batch: () => ({ [TARGET]: 2 }),
    }),
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BlockRefPeek on a touch phone (#6746)', () => {
  it('a long press opens the target as a bottom sheet with Open and Copy reference', async () => {
    render(<Chip onNavigate={vi.fn()} />)
    const sheet = await openSheet()
    expect(sheet).toHaveAttribute('data-slot', 'sheet-content')
    expect(within(sheet).getByText(t('refPeek.references', { count: 2 }))).toBeInTheDocument()
    expect(within(sheet).getByRole('button', { name: t('refPeek.open') })).toBeInTheDocument()
    expect(
      within(sheet).getByRole('button', { name: t('refPeek.copyReference') }),
    ).toBeInTheDocument()
  })

  it('the long press keeps its release from following the chip', async () => {
    render(<Chip onNavigate={vi.fn()} />)
    expect(await longPress()).toBe(false)
  })

  it('a tap still navigates and opens nothing', () => {
    const onNavigate = vi.fn()
    render(<Chip onNavigate={onNavigate} />)
    fireEvent.touchStart(chip(), touch)
    expect(fireEvent.touchEnd(chip(), { touches: [] })).toBe(true)
    fireEvent.click(chip())
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(TARGET)
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })
    expect(screen.queryByTestId('ref-peek-sheet')).not.toBeInTheDocument()
  })

  it('a finger that moves is a scroll, not a long press', () => {
    render(<Chip onNavigate={vi.fn()} />)
    fireEvent.touchStart(chip(), touch)
    fireEvent.touchMove(chip(), { touches: [{ clientX: 10, clientY: 40 }] })
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_DELAY)
    })
    expect(screen.queryByTestId('ref-peek-sheet')).not.toBeInTheDocument()
  })

  it('Open follows the chip', async () => {
    const onNavigate = vi.fn()
    render(<Chip onNavigate={onNavigate} />)
    const sheet = await openSheet()
    fireEvent.click(within(sheet).getByRole('button', { name: t('refPeek.open') }))
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith(TARGET)
  })

  it('its buttons are 44 px targets', async () => {
    render(<Chip onNavigate={vi.fn()} />)
    const sheet = await openSheet()
    for (const name of [t('refPeek.open'), t('refPeek.copyReference')]) {
      expect(within(sheet).getByRole('button', { name })).toHaveClass(
        '[@media(pointer:coarse)]:h-11',
      )
    }
  })

  it('has no a11y violations', async () => {
    render(<Chip onNavigate={vi.fn()} />)
    await openSheet()
    expect(await axe(document.body)).toHaveNoViolations()
  })
})
