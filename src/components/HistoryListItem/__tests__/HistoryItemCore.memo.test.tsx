/**
 * Tests for HistoryItemCore content-preview memoization (#1623).
 *
 * The raw-content preview used to call `renderRichContent` → `parse`
 * (recursive-descent markdown parser) inline on every render. A parent
 * re-render (selection / focus churn in the history list) re-ran the full
 * parse for every visible row's preview.
 *
 * This suite verifies:
 *  - The parse runs exactly once and is NOT re-run when the parent re-renders
 *    with the same `entry` — the `useMemo` reuses the parsed nodes.
 *  - The parse re-runs when the underlying content actually changes.
 *  - Property-payload rows never invoke the parser (plain formatted text).
 *  - Output is unchanged (preview text still renders).
 *  - a11y audit (axe) on a representative render.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { HistoryEntry } from '@/lib/tauri'

// Return STABLE callback identities across renders (the real hooks use
// `useCallback` with empty deps), so the component's content-preview memo
// only recomputes on real content / resolve-version changes.
vi.mock('../../../hooks/useRichContentCallbacks', () => {
  const stableCallbacks = {
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  }
  const stableTagClick = vi.fn()
  return {
    useRichContentCallbacks: vi.fn(() => stableCallbacks),
    useTagClickHandler: vi.fn(() => stableTagClick),
  }
})

// Render rich content as plain text so the parse is queryable AND countable.
vi.mock('@/components/RichContentRenderer', () => ({
  renderRichContent: vi.fn((markdown: string) => markdown),
}))

import { renderRichContent } from '@/components/RichContentRenderer'

import { HistoryItemCore } from '../HistoryItemCore'

function makeEntry(seq: number, opType: string, payload: Record<string, unknown>): HistoryEntry {
  return {
    device_id: 'DEVICE01XXXXXXXX',
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: 1736942400000,
  } as unknown as HistoryEntry
}

function wrap(children: React.ReactNode) {
  return <div className="flex items-center gap-3 w-full">{children}</div>
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('HistoryItemCore preview memoization (#1623)', () => {
  it('parses the content preview exactly once on initial render', () => {
    render(wrap(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'Hello world' })} />))
    expect(renderRichContent).toHaveBeenCalledTimes(1)
    expect(renderRichContent).toHaveBeenCalledWith('Hello world', expect.any(Object))
    expect(screen.getByText('Hello world')).toBeInTheDocument()
  })

  it('does not re-parse when the parent re-renders with the same entry', async () => {
    const user = userEvent.setup()
    const entry = makeEntry(1, 'edit_block', { to_text: 'Hello world' })

    function Harness() {
      const [, setTick] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            bump
          </button>
          {wrap(<HistoryItemCore entry={entry} />)}
        </>
      )
    }

    render(<Harness />)
    expect(renderRichContent).toHaveBeenCalledTimes(1)

    // Parent re-render with an identical `entry` reference → memo reuses the
    // parsed nodes, so renderRichContent must NOT run again.
    await user.click(screen.getByRole('button', { name: 'bump' }))
    expect(renderRichContent).toHaveBeenCalledTimes(1)
  })

  it('re-parses when the entry content actually changes', () => {
    const { rerender } = render(
      wrap(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'first' })} />),
    )
    expect(renderRichContent).toHaveBeenCalledTimes(1)

    rerender(wrap(<HistoryItemCore entry={makeEntry(2, 'edit_block', { to_text: 'second' })} />))
    expect(renderRichContent).toHaveBeenCalledTimes(2)
    expect(renderRichContent).toHaveBeenLastCalledWith('second', expect.any(Object))
  })

  it('does not invoke the parser for property-payload rows', () => {
    render(
      wrap(
        <HistoryItemCore
          entry={makeEntry(1, 'set_property', { key: 'priority', value: 'high' })}
        />,
      ),
    )
    expect(renderRichContent).not.toHaveBeenCalled()
  })

  it('has no a11y violations in a representative render', async () => {
    const { container } = render(
      wrap(
        <HistoryItemCore
          entry={makeEntry(1, 'edit_block', { to_text: 'Hello world' })}
          onToggleDiff={vi.fn()}
        />,
      ),
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
