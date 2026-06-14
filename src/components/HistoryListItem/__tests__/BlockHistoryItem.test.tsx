/**
 * Tests for BlockHistoryItem — per-block history row with restore-with-preview
 * panel. The parent test file (`src/components/__tests__/HistoryListItem.test.tsx`)
 * already covers the major behaviour matrix; this file adds the
 * Phase-3b extraction's render + axe smoke coverage so the sibling
 * file is independently audited.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import type { BlockHistoryItemProps } from '../BlockHistoryItem'
import { BlockHistoryItem } from '../BlockHistoryItem'

vi.mock('../../../hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

// The compared-to-current diff fetch is invoked lazily on expand; stub
// the IPC so the effect doesn't fire a real Tauri call during the axe
// audit. The render-only tests don't expand, so this is defensive.
vi.mock('../../../lib/tauri', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/tauri')>('../../../lib/tauri')
  return {
    ...actual,
    computeBlockVsCurrentDiff: vi.fn(async () => []),
  }
})

function makeEntry(
  seq: number,
  opType: string,
  payload: Record<string, unknown>,
  createdAt = 1736942400000,
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

function defaultProps(overrides: Partial<BlockHistoryItemProps> = {}): BlockHistoryItemProps {
  return {
    blockId: 'BLOCK01',
    entry: makeEntry(1, 'edit_block', { to_text: 'Hello world' }),
    index: 0,
    isExpanded: false,
    isLoadingDiff: false,
    diffSpans: undefined,
    onExpandToggle: vi.fn(),
    onRestore: vi.fn(),
    ...overrides,
  }
}

function renderInList(props: BlockHistoryItemProps) {
  return render(
    <ul aria-label="Block history">
      <BlockHistoryItem {...props} />
    </ul>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('BlockHistoryItem (extracted sibling)', () => {
  it('renders as an <li> with the test id derived from index', () => {
    renderInList(defaultProps({ index: 7 }))
    const li = screen.getByTestId('block-history-item-7')
    expect(li.tagName).toBe('LI')
  })

  it('renders the op-type badge for the entry', () => {
    renderInList(defaultProps())
    expect(screen.getByTestId('history-type-badge')).toHaveTextContent('edit_block')
  })

  it('exposes the restorable row as a button (collapsed)', () => {
    renderInList(defaultProps())
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
  })

  it('renders a non-restorable row (create_block) without a button affordance', () => {
    renderInList(defaultProps({ entry: makeEntry(1, 'create_block', { content: 'x' }) }))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  // #1092: the restorable row uses the canonical focus-ring-visible utility,
  // not the legacy 2px ring.
  it('#1092: restorable row uses focus-ring-visible (no legacy 2px ring)', () => {
    renderInList(defaultProps())
    const row = screen.getByRole('button', { expanded: false })
    expect(row.className).toContain('focus-ring-visible')
    expect(row.className).not.toContain('focus-visible:ring-2')
    expect(row.className).not.toContain('focus-visible:ring-ring')
  })

  it('has no a11y violations when collapsed (restorable)', async () => {
    const { container } = renderInList(defaultProps())
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when collapsed (non-restorable)', async () => {
    const { container } = renderInList(
      defaultProps({ entry: makeEntry(1, 'create_block', { content: 'x' }) }),
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
