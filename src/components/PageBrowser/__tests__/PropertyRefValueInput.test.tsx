import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { PropertyEditor } from '@/components/PageBrowser/add-filter/editors'
import { propertyOpsForValueKind } from '@/components/PageBrowser/add-filter/vocab'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const TARGET = '00000000000000000000PAGE02'

function cacheTitle(title: string) {
  useResolveStore.setState({
    cache: new Map([[keyFor(null, TARGET), { title, deleted: false, resolved: true }]]),
    version: useResolveStore.getState().version + 1,
  })
}

beforeEach(() => {
  // No active space: the page picker lists nothing and asks for nothing.
  useSpaceStore.setState({ currentSpaceId: null })
  cacheTitle('Old title')
})

describe('PropertyEditor ref value', () => {
  it("follows the selected page's title when the resolve cache changes it", async () => {
    const { container } = render(
      <PropertyEditor
        propKey="owner"
        propValue={TARGET}
        propOp="Eq"
        ops={propertyOpsForValueKind('Ref')}
        valueKind="Ref"
        onKeyChange={vi.fn()}
        onValueChange={vi.fn()}
        onOpChange={vi.fn()}
        onBack={vi.fn()}
        onApply={vi.fn()}
      />,
    )
    const selected = screen.getByTestId('property-ref-selected')
    expect(selected).toHaveTextContent('Old title')

    act(() => cacheTitle('New title'))

    expect(selected).toHaveTextContent('New title')
    expect(await axe(container)).toHaveNoViolations()
  })
})
