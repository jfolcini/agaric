/**
 * #6741 — a property whose definition holds several values: PropertyRowEditor
 * shows its items as removable chips with an add control of the item type, and
 * writes the whole list (`value_list`), or deletes the property once the last
 * item goes.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeBlockRow, makePageHeading, makePropertyRow, withOps } from '@/__tests__/fixtures'
import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands, type TypedInvokeHandlers } from '@/__tests__/helpers/invoke'
import { PropertyRowEditor } from '@/components/properties/PropertyRowEditor'
import type { PropertyDefinition, PropertyList } from '@/lib/bindings'
import { t } from '@/lib/i18n'
import { keyFor, useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

const mockedInvoke = vi.mocked(invoke)

function stubInvoke(handlers: Readonly<TypedInvokeHandlers>): void {
  mockedInvoke.mockImplementation(mockInvokeCommands(handlers))
}

const written = withOps(makeBlockRow({ id: 'BLOCK_1' }))

function listDef(valueType: string, options: string | null = null): PropertyDefinition {
  return {
    key: 'tags',
    value_type: valueType,
    options,
    created_at: '2026-01-01T00:00:00Z',
    builtin: false,
    multiple: true,
  }
}

function renderList(def: PropertyDefinition, items: PropertyList | null, onWritten = vi.fn()) {
  const onSave = vi.fn()
  const view = render(
    <PropertyRowEditor
      blockId="BLOCK_1"
      prop={makePropertyRow({ key: 'tags', value_list: items })}
      def={def}
      onSave={onSave}
      onRefSaved={onWritten}
    />,
  )
  return { ...view, onSave, onWritten }
}

/** The list `set_property` was last asked to write. */
function writtenList(): unknown {
  const call = mockedInvoke.mock.calls.findLast(([cmd]) => cmd === 'set_property')
  return (call?.[1] as { value?: { value_list?: unknown } } | undefined)?.value?.value_list
}

const addInput = () => screen.getByLabelText(t('property.addListItem', { key: 'tags' }))

beforeEach(() => {
  vi.clearAllMocks()
  useSpaceStore.setState({
    currentSpaceId: 'SPACE_TEST',
    availableSpaces: [{ id: 'SPACE_TEST', name: 'Test', accent_color: null }],
    isReady: true,
  })
})

describe('ListEditor', () => {
  it('shows each item as a chip with its own remove button, and no scalar editor', () => {
    renderList(listDef('text'), ['alpha', 'b, c'])

    const group = screen.getByRole('group', { name: t('pageProperty.valueLabel', { key: 'tags' }) })
    expect(within(group).getByText('alpha')).toBeInTheDocument()
    expect(within(group).getByText('b, c')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('property.removeListItem', { item: 'b, c' }) }),
    ).toBeInTheDocument()
    expect(screen.queryByDisplayValue(/alpha/)).not.toBeInTheDocument()
  })

  it('removing an item writes the others, and hears the ops', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => written })
    const { onWritten, onSave } = renderList(listDef('text'), ['alpha', 'beta', 'gamma'])

    await user.click(
      screen.getByRole('button', { name: t('property.removeListItem', { item: 'beta' }) }),
    )

    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1))
    expect(mockedInvoke).toHaveBeenCalledWith('set_property', {
      blockId: 'BLOCK_1',
      key: 'tags',
      value: {
        value_text: null,
        value_num: null,
        value_date: null,
        value_ref: null,
        value_bool: null,
        value_list: ['alpha', 'gamma'],
      },
    })
    expect(onSave).not.toHaveBeenCalled()
  })

  it('removing the last item deletes the property', async () => {
    const user = userEvent.setup()
    stubInvoke({ delete_property: () => withOps({ block_id: 'BLOCK_1', key: 'tags' }) })
    const { onWritten } = renderList(listDef('text'), ['only'])

    await user.click(
      screen.getByRole('button', { name: t('property.removeListItem', { item: 'only' }) }),
    )

    await waitFor(() => expect(onWritten).toHaveBeenCalledTimes(1))
    expect(mockedInvoke).toHaveBeenCalledWith('delete_property', {
      blockId: 'BLOCK_1',
      key: 'tags',
    })
    expect(mockedInvoke).not.toHaveBeenCalledWith('set_property', expect.anything())
  })

  it('Enter in a text list adds the typed item after the others and clears the input', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => written })
    renderList(listDef('text'), ['alpha'])

    await user.type(addInput(), '  beta  {Enter}')

    await waitFor(() => expect(writtenList()).toEqual(['alpha', 'beta']))
    expect(addInput()).toHaveValue('')
  })

  it('a blank item adds nothing', async () => {
    const user = userEvent.setup()
    renderList(listDef('url'), ['https://a.example'])

    await user.type(addInput(), '   {Enter}')

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('the first item of a draft list writes a one-item list', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => written })
    renderList(listDef('text'), null)

    await user.type(addInput(), 'first{Enter}')

    await waitFor(() => expect(writtenList()).toEqual(['first']))
  })

  it('a number list adds a number', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => written })
    renderList(listDef('number'), [1])
    expect(addInput()).toHaveAttribute('type', 'number')

    await user.type(addInput(), '2.5{Enter}')
    await waitFor(() => expect(writtenList()).toEqual([1, 2.5]))
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  it('a date list adds the day a date input reads', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => written })
    renderList(listDef('date'), ['2026-01-02'])

    await user.type(addInput(), '2026-05-01{Enter}')

    await waitFor(() => expect(writtenList()).toEqual(['2026-01-02', '2026-05-01']))
    expect(addInput()).toHaveValue('')
  })

  it('a date list refuses text that names no day', async () => {
    const user = userEvent.setup()
    renderList(listDef('date'), ['2026-01-02'])

    await user.type(addInput(), 'someday soon{Enter}')

    expect(mockedInvoke).not.toHaveBeenCalled()
  })

  it('a select list offers only the options not yet in it, and adds the one picked', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => written })
    renderList(listDef('select', '["red","green","blue"]'), ['green'])

    const picker = addInput()
    expect(within(picker).queryByRole('option', { name: 'green' })).not.toBeInTheDocument()
    await user.selectOptions(picker, 'blue')

    await waitFor(() => expect(writtenList()).toEqual(['green', 'blue']))
  })

  it('a ref list shows each target by title and adds the page picked', async () => {
    const user = userEvent.setup()
    useResolveStore.setState({
      cache: new Map([
        [keyFor('SPACE_TEST', 'PAGE_A'), { title: 'Alpha page', deleted: false, resolved: true }],
      ]),
      version: useResolveStore.getState().version + 1,
    })
    stubInvoke({
      list_all_pages_in_space: () => [
        makePageHeading({ id: 'PAGE_A', content: 'Alpha page' }),
        makePageHeading({ id: 'PAGE_B', content: 'Beta page' }),
      ],
      set_property: () => written,
    })
    const { onWritten } = renderList(listDef('ref'), ['PAGE_A'])

    expect(screen.getByText('Alpha page')).toBeInTheDocument()
    await user.click(addInput())
    const beta = await screen.findByRole('button', { name: 'Beta page' })
    // The picker offers only the pages the list does not hold yet.
    expect(screen.queryByRole('button', { name: 'Alpha page' })).not.toBeInTheDocument()
    await user.click(beta)

    await waitFor(() => expect(writtenList()).toEqual(['PAGE_A', 'PAGE_B']))
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('a refused write says so, and hears no ops', async () => {
    const user = userEvent.setup()
    stubInvoke({ set_property: () => Promise.reject(new Error('refused')) })
    const { onWritten } = renderList(listDef('text'), ['alpha'])

    await user.type(addInput(), 'beta{Enter}')

    await waitFor(() =>
      expect(vi.mocked(toast.error)).toHaveBeenCalledWith(t('pageProperty.saveFailed')),
    )
    expect(onWritten).not.toHaveBeenCalled()
  })

  // A list a definition of one value does not take still shows, as one line.
  it('a list under a definition of one value shows in the scalar editor as its text', () => {
    renderList({ ...listDef('text'), multiple: false }, ['alpha', 'b, c'])

    expect(screen.getByLabelText(t('pageProperty.valueLabel', { key: 'tags' }))).toHaveValue(
      'alpha, "b, c"',
    )
  })

  it('marks a list only when an item does not fit the definition', () => {
    const unfitMark = (value: string) =>
      screen.queryByRole('button', { name: t('property.unfitReview', { key: 'Tags', value }) })
    const { unmount } = renderList(listDef('select', '["red","green"]'), ['red', 'green'])
    expect(unfitMark('red, green')).not.toBeInTheDocument()
    unmount()

    renderList(listDef('select', '["red","green"]'), ['red', 'blue'])
    expect(unfitMark('red, blue')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { container } = renderList(listDef('select', '["red","green"]'), ['red'])
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations()
    })
  })
})
