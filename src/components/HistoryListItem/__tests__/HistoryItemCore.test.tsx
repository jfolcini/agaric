/**
 * Tests for HistoryItemCore — the shared visual element rendered by both
 * `HistoryListItem` (global history grid) and `BlockHistoryItem` (per-block
 * history sheet).
 *
 * Coverage:
 *  - Renders the op label badge, timestamp, device name, content preview.
 *  - Diff toggle button is hidden when `onToggleDiff` is not supplied.
 *  - Diff toggle button appears for `edit_block` when `onToggleDiff` is supplied.
 *  - Property-payload preview formats key with optional value arrow.
 *  - a11y audit (axe) on a representative render.
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { HistoryItemCore } from '@/components/HistoryListItem/HistoryItemCore'
import { truncateId } from '@/lib/format'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useSyncStore } from '@/stores/sync'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/hooks/useRichContentCallbacks', () => ({
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
  createdAt = 1736942400000,
  deviceId = 'DEVICE01XXXXXXXX',
  isReplicated = false,
) {
  return {
    device_id: deviceId,
    seq,
    op_type: opType,
    payload: JSON.stringify(payload),
    created_at: createdAt,
    is_replicated: isReplicated,
  }
}

// HistoryItemCore returns a fragment, so wrap in a flex container to give
// it a stable parent for axe — matches the production callers' layout.
function renderCore(children: React.ReactNode) {
  return render(<div className="flex items-center gap-3 w-full">{children}</div>)
}

beforeEach(() => {
  vi.clearAllMocks()
  useSyncStore.setState({ peers: [] })
})

describe('HistoryItemCore', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('labels the op type badge in words, keeping the raw op type in data-op-type', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'hi' })} />)
    const badge = screen.getByTestId('history-type-badge')
    expect(badge).toHaveTextContent(t('history.opTypeEdit'))
    expect(badge).not.toHaveTextContent('edit_block')
    expect(badge).toHaveAttribute('data-op-type', 'edit_block')
  })

  it('shows an op type with no label as itself and warns', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'future_op', {})} />)
    expect(screen.getByTestId('history-type-badge')).toHaveTextContent('future_op')
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('history-utils', 'no label for op type', {
      opType: 'future_op',
    })
  })

  it('lets the badge/time/device meta row wrap instead of overflowing into the Diff button', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'hi' })} />)
    const metaRow = screen.getByTestId('history-type-badge').parentElement
    expect(metaRow).toHaveClass('flex', 'flex-wrap', 'items-center', 'gap-x-2', 'gap-y-0.5')
  })

  it('names a local op\'s device "This device", not its id', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'hi' })} />)
    expect(document.querySelector('.history-item-device')).toHaveTextContent(t('device.thisDevice'))
    expect(screen.queryByText(/DEVICE01/)).not.toBeInTheDocument()
  })

  it("names a synced op's device by its paired-device name", () => {
    useSyncStore.setState({
      peers: [{ peerId: 'PEER0001XXXXXXXX', lastSyncedAt: null, resetCount: 0, name: 'Pixel 8' }],
    })
    renderCore(
      <HistoryItemCore
        entry={makeEntry(
          1,
          'edit_block',
          { to_text: 'hi' },
          1736942400000,
          'PEER0001XXXXXXXX',
          true,
        )}
      />,
    )
    expect(document.querySelector('.history-item-device')).toHaveTextContent('Pixel 8')
  })

  it('falls back to the truncated id for a synced op from an unnamed device', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(
          1,
          'edit_block',
          { to_text: 'hi' },
          1736942400000,
          'PEER0001XXXXXXXX',
          true,
        )}
      />,
    )
    expect(document.querySelector('.history-item-device')).toHaveTextContent(
      truncateId('PEER0001XXXXXXXX'),
    )
    expect(screen.queryByText(/dev:/)).not.toBeInTheDocument()
  })

  it('renders raw-content preview for non-property ops', () => {
    renderCore(<HistoryItemCore entry={makeEntry(1, 'edit_block', { to_text: 'Hello world' })} />)
    expect(screen.getByText(/Hello world/)).toBeInTheDocument()
  })

  it('shows a created journal page in the journal date format (#6544)', () => {
    localStorage.setItem('journal-date-format', 'dd/MM/yyyy')
    const entry = makeEntry(1, 'create_block', { block_type: 'page', content: '2026-11-11' })
    renderCore(<HistoryItemCore entry={entry} />)
    expect(screen.getByText('11/11/2026')).toBeInTheDocument()
    expect(screen.queryByText('2026-11-11')).not.toBeInTheDocument()
  })

  it('renders property-payload preview with key and value', () => {
    renderCore(
      <HistoryItemCore entry={makeEntry(1, 'set_property', { key: 'priority', value: 'high' })} />,
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

  // -- #4335 review items 4 & 5: attachment rows show a filename, as plain
  // text (not run through renderRichContent's tag/link chip parsing) --

  it('renders the filename for an add_attachment row', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'add_attachment', {
          attachment_id: 'ATT1',
          block_id: 'BLK1',
          mime_type: 'application/pdf',
          filename: 'notes.pdf',
          size_bytes: 100,
          fs_path: 'attachments/x',
        })}
      />,
    )
    expect(screen.getByText('notes.pdf')).toBeInTheDocument()
  })

  it('renders the old → new transition for a rename_attachment row', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'rename_attachment', {
          attachment_id: 'ATT1',
          old_filename: 'draft.txt',
          new_filename: 'final.txt',
        })}
      />,
    )
    expect(screen.getByText('draft.txt → final.txt')).toBeInTheDocument()
  })

  it('renders an attachment filename as plain text, not a clickable tag chip, even when it looks like a token', () => {
    // The markdown grammar's tag token is a bracket-wrapped 26-char ULID
    // (`#[ULID]`) — an attachment filename that happens to contain that
    // exact shape must still render as inert text, matching how property
    // VALUES (also arbitrary user data) are deliberately rendered plain via
    // `formatPropertyName` rather than through `renderRichContent`.
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'delete_attachment', {
          attachment_id: 'ATT1',
          fs_path: 'attachments/x',
          filename: '#[01ARZ3NDEKTSV4RRFFQ69G5FAV]-report.pdf',
        })}
      />,
    )
    expect(screen.getByText('#[01ARZ3NDEKTSV4RRFFQ69G5FAV]-report.pdf')).toBeInTheDocument()
    expect(screen.queryByTestId('tag-ref-chip')).not.toBeInTheDocument()
  })

  it('renders a set_property_def row as its key, in plain text and the property tone', () => {
    // `_` is a legal key character and also markdown emphasis.
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'set_property_def', {
          space_id: 'SP1',
          key: '_draft_',
          def: { value_type: 'text', options: null },
          prior: null,
        })}
      />,
    )
    expect(screen.getByText('_draft_')).toBeInTheDocument()
    expect(screen.getByTestId('history-type-badge')).toHaveClass('bg-op-tag')
  })

  it('renders a rename_property_key row as old → new, in plain text and the property tone', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'rename_property_key', {
          space_id: 'SP1',
          old_key: '_draft_',
          new_key: 'final',
        })}
      />,
    )
    expect(screen.getByText('_draft_ → final')).toBeInTheDocument()
    expect(screen.getByTestId('history-type-badge')).toHaveClass('bg-op-tag')
  })

  it('renders a rename_property_option row as key: old → new, in plain text and the property tone', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'rename_property_option', {
          space_id: 'SP1',
          key: '_stage_',
          old_option: 'review',
          new_option: 'in_review',
        })}
      />,
    )
    expect(screen.getByText('_stage_: review → in_review')).toBeInTheDocument()
    expect(screen.getByTestId('history-type-badge')).toHaveClass('bg-op-tag')
  })

  it('renders a rewrite_properties row as from → into, in plain text and the property tone', () => {
    const def = { value_type: 'text', options: null }
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'rewrite_properties', {
          space_id: 'SP1',
          reason: 'merge',
          defs: [
            { key: '_stage_', def: null, prior: def },
            { key: 'phase', def, prior: def },
          ],
          values: [],
        })}
      />,
    )
    expect(screen.getByText('_stage_ → phase')).toBeInTheDocument()
    expect(screen.getByTestId('history-type-badge')).toHaveClass('bg-op-tag')
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

  it('renders the foreign-op indicator for a replicated entry', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'edit_block', { to_text: 'hi' }, undefined, undefined, true)}
      />,
    )
    expect(screen.getByTestId('history-foreign-badge')).toBeInTheDocument()
  })

  it('does not render the foreign-op indicator for a local entry', () => {
    renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'edit_block', { to_text: 'hi' }, undefined, undefined, false)}
      />,
    )
    expect(screen.queryByTestId('history-foreign-badge')).not.toBeInTheDocument()
  })

  it('has no a11y violations when rendering a replicated (foreign) entry', async () => {
    const { container } = renderCore(
      <HistoryItemCore
        entry={makeEntry(1, 'edit_block', { to_text: 'Hello world' }, undefined, undefined, true)}
        onToggleDiff={vi.fn()}
      />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
