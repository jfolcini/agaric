/**
 * Tests for `view-toolbar` — the view's one formatting toolbar (#6562): the
 * edited block's surface hands its bar to the slot, the bar stays one mounted
 * element while the edit moves to another block, and it goes once no block is
 * edited.
 */

import { render, screen } from '@testing-library/react'
import type React from 'react'
import { memo, useEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { useViewToolbar, ViewToolbarSlot } from '@/components/FormattingToolbar/view-toolbar'

const mounts = vi.fn()
const blurs = vi.fn()

function Bar({ blockId }: { blockId: string }): React.ReactElement {
  useEffect(() => {
    mounts()
  }, [])
  return (
    <div role="toolbar" aria-label="Formatting" data-block-id={blockId}>
      <button type="button">Bold</button>
    </div>
  )
}

// Memoised as a block row is: a row that stays edited does not re-render when another leaves.
const Surface = memo(({ blockId }: { blockId: string }): React.ReactElement => {
  useViewToolbar(<Bar blockId={blockId} />, blurs)
  return <p>{blockId}</p>
})

/** A view whose edited block is `edited`, or none; `alsoMounted` keeps another block's surface. */
function View({
  edited,
  alsoMounted = null,
}: {
  edited: string | null
  alsoMounted?: string | null
}): React.ReactElement {
  return (
    <main>
      <ViewToolbarSlot room />
      {['A', 'B', 'C'].map((id) =>
        id === edited || id === alsoMounted ? <Surface key={id} blockId={id} /> : null,
      )}
    </main>
  )
}

describe('ViewToolbarSlot', () => {
  it('shows no bar while no block is edited', async () => {
    const { container } = render(<View edited={null} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    expect(await axe(container)).toHaveNoViolations()
  })

  it('shows the edited block bar outside the block, and drops it once the edit ends', async () => {
    const { container, rerender } = render(<View edited="A" />)
    const bar = screen.getByRole('toolbar', { name: 'Formatting' })
    expect(bar).toHaveAttribute('data-block-id', 'A')
    expect(bar.closest('[data-view-toolbar]')).not.toBeNull()
    expect(screen.getByText('A', { selector: 'p' }).contains(bar)).toBe(false)
    expect(await axe(container)).toHaveNoViolations()

    rerender(<View edited={null} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it('keeps one mounted bar while the edit moves from block to block', () => {
    mounts.mockClear()
    const { rerender } = render(<View edited="A" />)
    const bar = screen.getByRole('toolbar')

    rerender(<View edited="B" />)
    rerender(<View edited="C" />)

    expect(screen.getByRole('toolbar')).toBe(bar)
    expect(bar).toHaveAttribute('data-block-id', 'C')
    expect(mounts).toHaveBeenCalledTimes(1)
  })

  it('keeps the bar when a surface leaves after another one took it', () => {
    const { rerender } = render(<View edited="A" />)
    rerender(<View edited="B" alsoMounted="A" />)
    rerender(<View edited="B" />)

    expect(screen.getByRole('toolbar')).toHaveAttribute('data-block-id', 'B')
  })

  it('hands focus leaving the bar to the edited block, with where it went', () => {
    blurs.mockClear()
    render(
      <>
        <View edited="A" />
        <input aria-label="Elsewhere" />
      </>,
    )
    screen.getByRole('button', { name: 'Bold' }).focus()
    const elsewhere = screen.getByRole('textbox', { name: 'Elsewhere' })
    elsewhere.focus()

    expect(blurs).toHaveBeenCalledOnce()
    expect(blurs).toHaveBeenCalledWith(elsewhere)
  })
})
