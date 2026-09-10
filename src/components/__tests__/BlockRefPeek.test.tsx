/**
 * Tests for `BlockRefPeek` — the popover a `((ULID))` chip opens (#4551).
 *
 * Driven through the REAL `useBlockRefPeek` and real chips: the whole point of
 * the feature is the delegation, so a suite that mocked the hook would pin
 * nothing. `@floating-ui/dom` is the one mock — its placement is
 * layout-dependent and happy-dom has no layout.
 */

import { invoke } from '@tauri-apps/api/core'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import type { BlockRow } from '@/lib/bindings'
import { normalizeBlockRefTitle } from '@/lib/block-title'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'
import { useSpaceStore } from '@/stores/space'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 50, y: 120 }),
  flip: vi.fn(() => ({})),
  shift: vi.fn(() => ({})),
}))

import { BlockRefPeek } from '@/components/BlockRefPeek'
import { renderRichContent } from '@/components/RichContentRenderer'

const SPACE = 'SPACE_PERSONAL'
const TARGET = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const OTHER = '01BRZ3NDEKTSV4RRFFQ69G5FAV'
const PAGE = '01CRZ3NDEKTSV4RRFFQ69G5FAV'

/** 118 chars — well past the chip's 60-char `TITLE_MAX_LEN`. */
const LONG_CONTENT =
  'The second paragraph of the design note, which the chip has no room for and ' +
  'therefore never shows to anybody at all.'

function blockRow(overrides: Partial<BlockRow> = {}): BlockRow {
  return {
    id: TARGET,
    block_type: 'content',
    content: LONG_CONTENT,
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

function stubBackend(
  options: { deleted?: boolean; resolved?: boolean; refCount?: number } = {},
): void {
  const { deleted = false, resolved = true, refCount = 3 } = options
  vi.mocked(invoke).mockImplementation(
    mockInvokeCommands({
      batch_resolve: (args) =>
        resolved
          ? (args['ids'] as string[]).map((id) => ({
              id,
              title: id === PAGE ? 'Design Notes' : LONG_CONTENT,
              block_type: id === PAGE ? 'page' : 'content',
              deleted,
            }))
          : [],
      get_block: (args) =>
        args['blockId'] === PAGE
          ? blockRow({ id: PAGE, block_type: 'page', content: 'Design Notes', page_id: null })
          : blockRow({ id: args['blockId'] as string }),
      count_backlinks_batch: (args) =>
        Object.fromEntries((args['pageIds'] as string[]).map((id) => [id, refCount])),
    }),
  )
}

/** A container with N chips and the peek host that serves them. */
function Chips({
  ids,
  onNavigate,
}: {
  ids: string[]
  onNavigate?: (id: string) => void
}): ReactElement {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setEl}>
      {renderRichContent(ids.map((id) => `((${id}))`).join(' '), {
        interactive: true,
        onNavigate: onNavigate ?? (() => {}),
        resolveBlockTitle: () => normalizeBlockRefTitle(LONG_CONTENT),
      })}
      <BlockRefPeek container={el} />
    </div>
  )
}

function chipFor(id: string): HTMLElement {
  const chip = document.querySelector(`[data-type="block-ref"][data-id="${id}"]`)
  if (!(chip instanceof HTMLElement)) throw new Error(`no chip for ${id}`)
  return chip
}

/** Hover a chip, wait past the dwell, and wait for the payload to settle. */
async function hoverOpen(
  user: ReturnType<typeof userEvent.setup>,
  id: string,
): Promise<HTMLElement> {
  await user.hover(chipFor(id))
  const peek = await screen.findByTestId('ref-peek')
  await waitFor(() => {
    expect(within(peek).queryByText(/Loading preview/)).not.toBeInTheDocument()
  })
  return peek
}

describe('BlockRefPeek', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient.clear()
    useSpaceStore.setState({
      currentSpaceId: SPACE,
      availableSpaces: [{ id: SPACE, name: 'Personal', accent_color: null }],
    })
    stubBackend()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing until a chip is activated', () => {
    render(<Chips ids={[TARGET]} />)
    expect(screen.getByTestId('block-ref-chip')).toBeInTheDocument()
    expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
  })

  it('opens on hover intent and shows what the chip cannot: full content and a breadcrumb', async () => {
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    // The chip is capped at TITLE_MAX_LEN; the content is not.
    const chip = chipFor(TARGET)
    expect(chip.textContent).not.toContain('never shows to anybody')

    const peek = await hoverOpen(user, TARGET)
    expect(within(peek).getByText(LONG_CONTENT)).toBeInTheDocument()
    expect(within(peek).getByText('Personal › Design Notes')).toBeInTheDocument()
    expect(within(peek).getByText('3 references')).toBeInTheDocument()
  })

  // `fireEvent`, not `userEvent`: the assertion is about the DWELL, so the
  // clock has to be fake, and `userEvent`'s own scheduling deadlocks against
  // it here. The pointer sequence is the same two events either way.
  it('does not open for a dwell shorter than the hover-intent threshold', async () => {
    vi.useFakeTimers()
    render(<Chips ids={[TARGET]} />)

    const chip = chipFor(TARGET)
    fireEvent.pointerEnter(chip, { pointerType: 'mouse' })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    // The assertion that carries the threshold: nothing has opened YET.
    expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()

    fireEvent.pointerLeave(chip, { pointerType: 'mouse' })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
  })

  it('opens from the keyboard and returns focus to the chip on Escape', async () => {
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    const chip = chipFor(TARGET)
    chip.focus()
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')

    const peek = await screen.findByTestId('ref-peek')
    await waitFor(() => {
      expect(peek).toHaveFocus()
    })

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
    })
    expect(chip).toHaveFocus()
  })

  // The peek's `Open` is the chip's own click handler. A chip rendered
  // without one (`interactive: true`, no `onNavigate` — backlink rows,
  // Due/Done rows) would let that click bubble to the enclosing row and
  // navigate somewhere else entirely, so such a chip is not peekable.
  it('does not attach to a chip that has no navigation of its own', async () => {
    const rowClick = vi.fn()
    const user = userEvent.setup()
    function InertRow(): ReactElement {
      const [el, setEl] = useState<HTMLDivElement | null>(null)
      return (
        <div ref={setEl}>
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- stand-in for the real backlink/agenda row, whose own click handler is the hazard under test */}
          <div onClick={rowClick}>
            {renderRichContent(`((${TARGET}))`, {
              interactive: true,
              resolveBlockTitle: () => normalizeBlockRefTitle(LONG_CONTENT),
            })}
          </div>
          <BlockRefPeek container={el} />
        </div>
      )
    }
    render(<InertRow />)

    const chip = screen.getByTestId('block-ref-chip')
    expect(chip).not.toHaveAttribute('data-id')
    await user.hover(chip)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 500))
    })
    expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
  })

  // A hover peek that focused itself would blur the roving TipTap editor
  // mid-word (`useEditorBlur`), so the caret has to stay exactly where the
  // pointer found it — and Escape then belongs to whoever holds focus, not
  // to the peek.
  it('never takes focus when opened by the pointer', async () => {
    const user = userEvent.setup()
    render(
      <>
        <input data-testid="caret" />
        <Chips ids={[TARGET]} />
      </>,
    )
    const caret = screen.getByTestId('caret')
    caret.focus()

    await hoverOpen(user, TARGET)
    expect(caret).toHaveFocus()

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
    })
    expect(caret).toHaveFocus()
  })

  it('parks the chip title while open and puts it back on close', async () => {
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    const chip = chipFor(TARGET)
    const originalTitle = chip.getAttribute('title')
    expect(originalTitle).not.toBeNull()

    await hoverOpen(user, TARGET)
    expect(chip.hasAttribute('title')).toBe(false)
    // The marker the editor NodeView reads so its next `update()` does not
    // put the native tooltip back over the open popover.
    expect(chip.hasAttribute('data-peek-title-parked')).toBe(true)
    expect(chip.getAttribute('aria-expanded')).toBe('true')

    await user.unhover(chip)
    await waitFor(() => {
      expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
    })
    expect(chip.getAttribute('title')).toBe(originalTitle)
    expect(chip.hasAttribute('data-peek-title-parked')).toBe(false)
    expect(chip.getAttribute('aria-expanded')).toBe('false')
  })

  // The first commit is the spinner. A peek placed below a chip near the
  // bottom of the window while 40 px tall grows past the viewport when the
  // payload lands, so the placement has to run again with the full box.
  it('re-places itself once the payload lands', async () => {
    const { computePosition } = await import('@floating-ui/dom')
    vi.mocked(computePosition).mockClear()
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    const peek = await hoverOpen(user, TARGET)
    await waitFor(() => {
      expect(within(peek).getByText(LONG_CONTENT)).toBeInTheDocument()
    })
    await waitFor(() => {
      expect(vi.mocked(computePosition).mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  // "Open" borrows the chip's own navigation rather than growing a second
  // path to it, so the assertion is that the chip's handler ran.
  // A hover peek over a chip in the block being edited: if Open took focus,
  // the editor would blur, unmount the roving instance and the chip, and the
  // click would land on a detached node.
  it('Open does not move focus off the editor', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(
      <>
        <input data-testid="editor-stand-in" />
        <Chips ids={[TARGET]} onNavigate={onNavigate} />
      </>,
    )
    const editorStandIn = screen.getByTestId('editor-stand-in')
    editorStandIn.focus()

    const peek = await hoverOpen(user, TARGET)
    const open = within(peek).getByRole('button', { name: 'Open' })
    await user.pointer({ keys: '[MouseLeft>]', target: open })
    expect(document.activeElement).toBe(editorStandIn)
    await user.pointer({ keys: '[/MouseLeft]', target: open })

    expect(onNavigate).toHaveBeenCalledWith(TARGET)
  })

  it('routes Open through the chip and closes', async () => {
    const onNavigate = vi.fn()
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} onNavigate={onNavigate} />)

    const peek = await hoverOpen(user, TARGET)
    await user.click(within(peek).getByRole('button', { name: 'Open' }))

    expect(onNavigate).toHaveBeenCalledWith(TARGET)
    await waitFor(() => {
      expect(screen.queryByTestId('ref-peek')).not.toBeInTheDocument()
    })
  })

  it('shows a tombstone for a deleted target', async () => {
    stubBackend({ deleted: true })
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    const peek = await hoverOpen(user, TARGET)
    expect(within(peek).getByText(/is in the Trash/)).toBeInTheDocument()
  })

  it('shows the space-switch line for a target outside the active space', async () => {
    stubBackend({ resolved: false })
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    const peek = await hoverOpen(user, TARGET)
    expect(within(peek).getByText(/not in the current space/)).toBeInTheDocument()
  })

  it('logs and degrades when the target fetch rejects — the chip is untouched', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    vi.mocked(invoke).mockImplementation(
      mockInvokeCommands({ batch_resolve: () => Promise.reject(new Error('IPC down')) }),
    )
    const user = userEvent.setup()
    render(<Chips ids={[TARGET]} />)

    const peek = await hoverOpen(user, TARGET)
    // NOT the foreign-space line: a backend that is down has not told us the
    // target is somewhere else, and "switch space" would send the reader
    // hunting for a block that never moved.
    expect(within(peek).getByText(/Could not load this block/)).toBeInTheDocument()
    expect(within(peek).queryByText(/not in the current space/)).not.toBeInTheDocument()
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        'BlockRefPeek',
        'failed to load peek target',
        { refId: TARGET },
        expect.anything(),
      )
    })
    expect(chipFor(TARGET).textContent).toContain('The second paragraph')
  })

  // #4228 acceptance criterion 11 — the chips carry no per-chip popover
  // subtree. One host, one peek, however many chips are on the page.
  it('mounts exactly one peek no matter how many chips are rendered', async () => {
    const ids = Array.from(
      { length: 50 },
      (_, i) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(i).padStart(2, '0')}`,
    )
    const user = userEvent.setup()
    render(<Chips ids={ids} />)

    expect(document.querySelectorAll('[data-testid="ref-peek"]')).toHaveLength(0)

    await hoverOpen(user, ids[0] as string)
    expect(document.querySelectorAll('[data-testid="ref-peek"]')).toHaveLength(1)

    await user.unhover(chipFor(ids[0] as string))
    await hoverOpen(user, ids[1] as string)
    expect(document.querySelectorAll('[data-testid="ref-peek"]')).toHaveLength(1)
  })

  describe('accessibility', () => {
    it('has no violations with the chip idle', async () => {
      const { container } = render(<Chips ids={[TARGET]} />)
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    it('has no violations with the chip focused', async () => {
      const user = userEvent.setup()
      const { container } = render(<Chips ids={[TARGET]} />)
      await user.tab()
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    it('has no violations with the peek open', async () => {
      const user = userEvent.setup()
      const { container } = render(<Chips ids={[TARGET, OTHER]} />)
      await hoverOpen(user, TARGET)
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    it('has no violations for a deleted-target chip', async () => {
      const { container } = render(
        <div>
          {renderRichContent(`((${TARGET}))`, {
            interactive: true,
            onNavigate: () => {},
            resolveBlockTitle: () => 'Removed block',
            resolveBlockStatus: () => 'deleted',
          })}
        </div>,
      )
      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })

    // WCAG 2.5.3 — the accessible name of a control must CONTAIN its visible
    // label, so the deleted marker is a visually-hidden child rather than an
    // `aria-label` that reformats the title.
    it("keeps the deleted chip's visible label inside its accessible name", () => {
      render(
        <>
          {renderRichContent(`((${TARGET}))`, {
            interactive: true,
            onNavigate: () => {},
            resolveBlockTitle: () => 'Removed block',
            resolveBlockStatus: () => 'deleted',
          })}
        </>,
      )
      const chip = screen.getByTestId('block-ref-chip')
      expect(chip).not.toHaveAttribute('aria-label')
      expect(chip.textContent).toContain('Removed block')
      expect(chip.textContent).toContain('(deleted)')
    })
  })
})
