/**
 * The agent badge on a history row (#6535): an op an MCP agent wrote names
 * that agent; the user's own op carries no badge.
 */

import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { HistoryItemCore } from '@/components/HistoryListItem/HistoryItemCore'
import type { HistoryEntry } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { useSyncStore } from '@/stores/sync'

vi.mock('@/hooks/useRichContentCallbacks', () => ({
  useRichContentCallbacks: vi.fn(() => ({
    resolveBlockTitle: vi.fn(() => undefined),
    resolveBlockStatus: vi.fn(() => 'active' as const),
    resolveTagName: vi.fn(() => undefined),
    resolveTagStatus: vi.fn(() => 'active' as const),
  })),
  useTagClickHandler: vi.fn(() => vi.fn()),
}))

function editEntry(agent?: string): HistoryEntry {
  return {
    device_id: 'DEVICE01XXXXXXXX',
    seq: 1,
    op_type: 'edit_block',
    payload: JSON.stringify({ to_text: 'hi' }),
    created_at: 1736942400000,
    is_replicated: false,
    ...(agent === undefined ? {} : { agent }),
  }
}

function renderCore(entry: HistoryEntry) {
  return render(
    <div className="flex items-center gap-3 w-full">
      <HistoryItemCore entry={entry} />
    </div>,
  )
}

beforeEach(() => {
  useSyncStore.setState({ peers: [] })
})

describe('HistoryItemCore agent badge', () => {
  it('names the agent that wrote the op, for sight and for a screen reader', () => {
    renderCore(editEntry('Claude Desktop'))
    const badge = screen.getByTestId('history-agent-badge')
    expect(badge).toHaveTextContent('Claude Desktop')
    expect(screen.getByText(t('history.agentOp', { name: 'Claude Desktop' }))).toBeInTheDocument()
  })

  it("shows no badge on the user's own op", () => {
    renderCore(editEntry())
    expect(screen.queryByTestId('history-agent-badge')).not.toBeInTheDocument()
  })

  it('has no a11y violations with the badge', async () => {
    const { container } = renderCore(editEntry('Claude Desktop'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
