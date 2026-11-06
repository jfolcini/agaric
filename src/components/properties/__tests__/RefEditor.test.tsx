import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { RefEditor } from '@/components/properties/PropertyRowEditor/RefEditor'
import type { RefPickerEditorState } from '@/components/properties/PropertyRowEditor/usePropertyRowEditor'
import type { PropertyRow } from '@/lib/bindings'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const TARGET = '00000000000000000000PAGE02'

const prop: PropertyRow = {
  key: 'owner',
  value_text: null,
  value_num: null,
  value_date: null,
  value_ref: TARGET,
  value_bool: null,
}

const state: RefPickerEditorState = {
  open: false,
  setOpen: vi.fn(),
  search: '',
  setSearch: vi.fn(),
  filteredPages: [],
  savingRefPageId: null,
  handleOpen: vi.fn(),
  handleSelectPage: vi.fn(),
  handleCreateNewPage: vi.fn(),
}

function cacheTitle(title: string) {
  useResolveStore.setState({
    cache: new Map([[keyFor(null, TARGET), { title, deleted: false, resolved: true }]]),
    version: useResolveStore.getState().version + 1,
  })
}

beforeEach(() => {
  useSpaceStore.setState({ currentSpaceId: null })
  cacheTitle('Old title')
})

describe('RefEditor', () => {
  it("follows the target's title when the resolve cache changes it", async () => {
    const { container } = render(
      <RefEditor prop={prop} state={state} ariaLabel="owner value" hasCreateNewPage={false} />,
    )
    const trigger = screen.getByRole('button', { name: 'owner value' })
    expect(trigger).toHaveTextContent('Old title')

    act(() => cacheTitle('New title'))

    expect(trigger).toHaveTextContent('New title')
    expect(await axe(container)).toHaveNoViolations()
  })
})
