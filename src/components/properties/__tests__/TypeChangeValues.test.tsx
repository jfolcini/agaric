/**
 * The values a type change previews (#5841, #6741): a tab of each kind, each value with what it
 * becomes, and a failed read said in place.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { type Preview, TypeChangeTabs } from '@/components/properties/TypeChangeValues'
import type { PageResponse, PropertyTypeChangeValue } from '@/lib/bindings'
import { t } from '@/lib/i18n'

const mockedInvoke = vi.mocked(invoke)

const preview: Preview = {
  target: { valueType: 'text', options: null, multiple: true, separator: 'comma' },
  counts: { converted: 1, unfit: 0 },
  seq: 1,
}

function renderTabs(): ReturnType<typeof render> {
  return render(
    <TypeChangeTabs
      spaceId="SPACE_PERSONAL"
      propertyKey="authors"
      fromType="text"
      preview={preview}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('TypeChangeTabs', () => {
  it('lists each converted value with what it becomes', async () => {
    const page: PageResponse<PropertyTypeChangeValue> = {
      items: [
        {
          block_id: 'BLOCK_A',
          page_id: 'PAGE_A',
          page_title: 'Reading',
          content: 'A book',
          deleted: false,
          value: 'Ann, Bob',
          converted: 'Ann, Bob',
        },
      ],
      next_cursor: null,
      has_more: false,
      total_count: null,
    }
    mockedInvoke.mockImplementation(
      mockInvokeCommands({ list_property_type_change_values: () => Promise.resolve(page) }),
    )
    const { container } = renderTabs()
    expect(await screen.findByText('Ann, Bob → Ann, Bob')).toBeInTheDocument()
    expect(mockedInvoke).toHaveBeenCalledWith(
      'list_property_type_change_values',
      expect.objectContaining({ multiple: true, separator: 'comma', kind: 'converted' }),
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  it('says so in place when the values cannot be read', async () => {
    mockedInvoke.mockImplementation(
      mockInvokeCommands({
        list_property_type_change_values: () =>
          Promise.reject({ kind: 'database', message: 'boom' }),
      }),
    )
    renderTabs()
    expect(await screen.findByRole('alert')).toHaveTextContent(t('spaceMove.valuesFailed'))
  })
})
