/**
 * #6206 — a block's property chips mark a value that doesn't fit its key's
 * definition, read from the active space's definitions: the real chips, not
 * the mock `BlockInlineControls.test.tsx` renders.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { BlockMetadataRow } from '@/components/editor/BlockInlineControls'
import type { PageResponse, PropertyDefinition } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { useSpaceStore } from '@/stores/space'

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const mockedInvoke = vi.mocked(invoke)

const PROJECT: PropertyDefinition = {
  key: 'project',
  value_type: 'select',
  options: '["alpha"]',
  created_at: '2026-01-01',
  builtin: false,
}

function defsPage(): PageResponse<PropertyDefinition> {
  return { items: [PROJECT], next_cursor: null, has_more: false, total_count: null }
}

function markOf(value: string): string {
  return t('property.unfitReview', { key: 'Project', value })
}

function renderRows() {
  return render(
    <>
      {[
        ['BLOCK_A', 'alpha'],
        ['BLOCK_B', 'beta'],
      ].map(([blockId, value]) => (
        <BlockMetadataRow
          key={blockId}
          blockId={blockId as string}
          filteredProperties={[{ key: 'project', value: value as string }]}
          attachmentCount={0}
          showAttachments={false}
          onToggleAttachments={vi.fn()}
          onEditProp={vi.fn()}
          onEditKey={vi.fn()}
        />
      ))}
    </>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({ currentSpaceId: 'SPACE_1' })
  mockedInvoke.mockImplementation(mockInvokeCommands({ list_property_defs: defsPage }))
})

describe('BlockMetadataRow marks a value that does not fit (#6206)', () => {
  it('marks beta, which is not one of the options, and not alpha', async () => {
    renderRows()

    expect(await screen.findByRole('button', { name: markOf('beta') })).toBeInTheDocument()
    expect(
      screen.getByRole('group', {
        name: t('property.unfitChipLabel', { key: 'Project', value: 'beta' }),
      }),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: markOf('alpha') })).not.toBeInTheDocument()
    expect(
      screen.getByRole('group', {
        name: t('property.selectValue', { key: 'Project', value: 'alpha' }),
      }),
    ).toBeInTheDocument()
  })

  it('marks nothing when the definitions fail to load', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_property_defs: () => Promise.reject(new Error('defs failed')),
      }),
    )
    renderRows()

    await waitFor(() => {
      expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('button', { name: markOf('beta') })).not.toBeInTheDocument()
    expect(screen.getAllByTestId('property-chip')).toHaveLength(2)
  })

  it('has no a11y violations with a marked chip', async () => {
    const { container } = renderRows()
    expect(await screen.findByRole('button', { name: markOf('beta') })).toBeInTheDocument()

    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
