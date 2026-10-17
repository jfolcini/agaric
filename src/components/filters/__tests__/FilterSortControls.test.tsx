/**
 * FilterSortControls — the References sort field picker and its direction
 * toggle. The re-queried row order is pinned end to end in
 * `src/components/backlinks/__tests__/LinkedReferences.sort.test.tsx`.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { mockInvokeCommands } from '@/__tests__/helpers/invoke'
import { FilterSortControls } from '@/components/filters/FilterSortControls'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BacklinkSort, PropertyDefinition } from '@/lib/bindings'
import { INTERNAL_PROPERTY_KEYS } from '@/lib/block-utils'
import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { queryClient } from '@/lib/query-client'

const mockedInvoke = vi.mocked(invoke)

function def(key: string, value_type: string): PropertyDefinition {
  return { key, value_type, options: null, created_at: '2026-01-01T00:00:00Z' }
}

const DEFS: PropertyDefinition[] = [
  def('estimate', 'number'),
  def('deadline', 'date'),
  def('effort', 'select'),
  def('notes', 'text'),
  def('homepage', 'url'),
  def('owner', 'ref'),
  def('reviewed', 'boolean'),
  // Built-in: offered under its own label in the built-in group, never twice.
  def('due_date', 'date'),
  def('repeat-count', 'number'),
  // Every bookkeeping key, as a sortable type, so the shared list alone hides it.
  ...[...INTERNAL_PROPERTY_KEYS].map((key) => def(key, 'select')),
]

const BUILTIN_VALUES = ['created', 'due', 'scheduled', 'priority', 'completed']

function stubDefs(defs: PropertyDefinition[] = DEFS) {
  mockedInvoke.mockImplementation(
    mockInvokeCommands({
      list_property_defs: () => ({
        items: defs,
        next_cursor: null,
        has_more: false,
        total_count: null,
      }),
    }),
  )
}

function renderControls(props: Partial<Parameters<typeof FilterSortControls>[0]> = {}) {
  const onSortChange = vi.fn<(sort: BacklinkSort) => void>()
  const utils = render(
    <TooltipProvider>
      <FilterSortControls sort={null} onSortChange={onSortChange} {...props} />
    </TooltipProvider>,
  )
  return { ...utils, onSortChange }
}

const picker = () => screen.getByLabelText(t('backlink.sortByLabel'))
const optionValues = () => [...picker().querySelectorAll('option')].map((o) => o.value)
const directionButton = (dir: 'ascending' | 'descending') =>
  screen.getByRole('button', {
    name: t('backlink.sortDirectionLabel', { direction: t(`common.${dir}`) }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  queryClient.clear()
  stubDefs()
})

describe('FilterSortControls', () => {
  it('offers the built-in fields, then only the properties whose type has an order', async () => {
    renderControls()

    await waitFor(() => expect(optionValues()).toContain('prop:estimate'))
    expect(optionValues()).toEqual([
      ...BUILTIN_VALUES,
      'prop:estimate',
      'prop:deadline',
      'prop:effort',
    ])
    expect(within(picker()).getByText('estimate')).toBeInTheDocument()
  })

  it('never offers a url, ref, boolean or text property', async () => {
    renderControls()

    await waitFor(() => expect(optionValues()).toContain('prop:estimate'))
    for (const key of ['homepage', 'owner', 'reviewed', 'notes']) {
      expect(optionValues()).not.toContain(`prop:${key}`)
    }
  })

  it('hides every key on the shared bookkeeping list', async () => {
    renderControls()

    await waitFor(() => expect(optionValues()).toContain('prop:estimate'))
    for (const key of INTERNAL_PROPERTY_KEYS) {
      expect(optionValues()).not.toContain(`prop:${key}`)
    }
  })

  it('sorts a number property numerically and a date property by date', async () => {
    const user = userEvent.setup()
    const { onSortChange } = renderControls({ sort: { type: 'Created', dir: 'Desc' } })
    await waitFor(() => expect(optionValues()).toContain('prop:estimate'))

    await user.selectOptions(picker(), 'prop:estimate')
    expect(onSortChange).toHaveBeenLastCalledWith({
      type: 'PropertyNum',
      key: 'estimate',
      dir: 'Desc',
    })
    await user.selectOptions(picker(), 'prop:deadline')
    expect(onSortChange).toHaveBeenLastCalledWith({
      type: 'PropertyDate',
      key: 'deadline',
      dir: 'Desc',
    })
  })

  it('maps the built-in due date onto its column key, keeping the direction', async () => {
    const user = userEvent.setup()
    const { onSortChange } = renderControls({ sort: { type: 'Created', dir: 'Asc' } })

    await user.selectOptions(picker(), 'due')
    expect(onSortChange).toHaveBeenCalledWith({ type: 'PropertyDate', key: 'due_date', dir: 'Asc' })
  })

  it('shows the default order as Created, ascending', () => {
    renderControls()

    expect(picker()).toHaveValue('created')
    expect(directionButton('ascending')).toBeEnabled()
  })

  it('shows a property sort as its option', async () => {
    renderControls({ sort: { type: 'PropertyNum', key: 'estimate', dir: 'Desc' } })

    await waitFor(() => expect(picker()).toHaveValue('prop:estimate'))
    expect(directionButton('descending')).toBeInTheDocument()
  })

  it('reverses the default order from the toggle', async () => {
    const user = userEvent.setup()
    const { onSortChange } = renderControls()

    await user.click(directionButton('ascending'))
    expect(onSortChange).toHaveBeenCalledWith({ type: 'Created', dir: 'Desc' })
  })

  it('reverses a property sort from the keyboard', async () => {
    const user = userEvent.setup()
    const { onSortChange } = renderControls({
      sort: { type: 'PropertyDate', key: 'due_date', dir: 'Desc' },
    })

    directionButton('descending').focus()
    await user.keyboard('{Enter}')
    expect(onSortChange).toHaveBeenCalledWith({ type: 'PropertyDate', key: 'due_date', dir: 'Asc' })
  })

  it('keeps a 44 px touch target on the toggle', () => {
    renderControls()

    expect(directionButton('ascending').className).toContain('[@media(pointer:coarse)]:size-11')
  })

  it('loads no property definitions until asked', () => {
    renderControls({ loadProperties: false })

    expect(mockedInvoke).not.toHaveBeenCalled()
    expect(optionValues()).toEqual(BUILTIN_VALUES)
  })

  it('falls back to the built-in fields when the definitions fail to load', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockedInvoke.mockRejectedValue(new Error('ipc down'))
    renderControls()

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(optionValues()).toEqual(BUILTIN_VALUES)
  })

  it('has no a11y violations', async () => {
    const { container } = renderControls({ sort: { type: 'Created', dir: 'Desc' } })

    await waitFor(() => expect(optionValues()).toContain('prop:estimate'))
    expect(await axe(container)).toHaveNoViolations()
  })
})
