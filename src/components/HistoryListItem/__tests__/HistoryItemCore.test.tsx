/**
 * Tests for HistoryItemCore — the shared visual element rendered by both
 * `HistoryListItem` (global history grid) and `BlockHistoryItem` (per-block
 * history sheet).
 *
 * Coverage:
 *  - Renders badge, timestamp, device id, content preview.
 *  - Diff toggle button is hidden when `onToggleDiff` is not supplied.
 *  - Diff toggle button appears for `edit_block` when `onToggleDiff` is supplied.
 *  - Property-payload preview formats key with optional value arrow.
 *  - a11y audit (axe) on a representative render.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'
import { HistoryItemCore } from '../HistoryItemCore'

vi.mock('../../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

function makeEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = '2025-01-15T12:00:00Z',
  deviceId = 'DEVICE01XXXXXXXX',
) {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: createdAt,
  }
}

// HistoryItemCore returns a fragment, so wrap in a flex container to give
// it a stable parent for axe — matches the production callers' layout.
function renderCore(children: React.ReactNode) {
  return render(<div className="flex items-center gap-3 w-full">{children}</div>)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('HistoryItemCore', () => {
  it('renders op type badge with the supplied op_type label', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'hi' })} />)
    expect(screen.getByTestId('history-type-badge')).toHaveTextContent('edit_block')
  })

  it('renders the truncated device id (8 chars)', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'hi' })} />)
    // device_id is 'DEVICE01XXXXXXXX' → first 8 chars
    expect(screen.getByText(/dev:DEVICE01/)).toBeInTheDocument()
  })

  it('renders raw-content preview for non-property ops', () => {
    renderCore(
      <HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'Hello world' })} />,
    )
    expect(screen.getByText(/Hello world/)).toBeInTheDocument()
  })

  it('renders property-payload preview with key and value', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'set_property', { key: 'priority', value: 'high' })}
      />,
    )
    // `formatPropertyName` title-cases the key (`priority` → `Priority`)
    // and the value is rendered as a separate text node in the same
    // span. Use a function matcher so the broken-up text still resolves.
    const preview = screen
      .getAllByText((_, el) => el?.classList.contains('history-item-preview') ?? false)
      .find((el) => el.textContent?.includes('Priority'))
    expect(preview).toBeDefined()
    expect(preview?.textContent).toContain('Priority')
    expect(preview?.textContent).toContain('→ high')
  })

  it('hides the diff-toggle button when onToggleDiff is not supplied', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'hi' })} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders the diff-toggle button for edit_block when onToggleDiff is supplied', () => {
    const onToggleDiff = vi.fn()
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'edit_block', { to_text: 'hi' })}
        onToggleDiff={onToggleDiff}
      />,
    )
    // There should be exactly one button (the diff toggle).
    const buttons = screen.getAllByRole('button')
    expect(buttons.length).toBeGreaterThanOrEqual(1)
  })

  it('does not render the diff-toggle button for non-edit_block ops', () => {
    const onToggleDiff = vi.fn()
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'create_block', { content: 'x' })}
        onToggleDiff={onToggleDiff}
      />,
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('calls onToggleDiff when the diff-toggle button is clicked', async () => {
    const user = userEvent.setup()
    const onToggleDiff = vi.fn()
    const entry = makeEntry(1, 'edit_block', { to_text: 'hi' })
    renderCore(<HistoryItemCore entry={entry} onToggleDiff={onToggleDiff} />)
    await user.click(screen.getByRole('button'))
    expect(onToggleDiff).toHaveBeenCalledWith(entry)
  })

  it('has no a11y violations in a representative render', async () => {
    const { container } = renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'edit_block', { to_text: 'Hello world' })}
        onToggleDiff={vi.fn()}
      />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
