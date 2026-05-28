/**
 * PEND-58? — tests for `<FilterHelperPopover>` hardening.
 *
 * Coverage:
 *  - UX-A3: every visible string renders via `t()` (no hardcoded English).
 *  - FE-A20: out-of-order `listTagsByPrefix` responses never paint stale
 *    suggestions (latest-wins sequence guard) + debounce coalescing.
 *  - UX-A6: the tag picker is an ARIA combobox/listbox — role/aria attrs,
 *    ArrowUp/Down to move the active option, Enter to select, Escape to
 *    close.
 *  - error path: a rejected fetch is logged and clears suggestions.
 *  - axe audit on the menu and tag-picker states.
 */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'
import { logger } from '@/lib/logger'
import { type FilterToken, tokenSource } from '@/lib/search-query'
import type { TagCacheRow } from '@/lib/tauri'
import { listTagsByPrefix } from '@/lib/tauri'

import { FilterHelperPopover, type FilterHelperPopoverProps } from '../FilterHelperPopover'

vi.mock('@/lib/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tauri')>()
  return { ...actual, listTagsByPrefix: vi.fn() }
})

const mockedListTags = vi.mocked(listTagsByPrefix)

function tag(id: string, name: string): TagCacheRow {
  return { tag_id: id, name, usage_count: 0, updated_at: '' }
}

function renderPopover(props: Partial<FilterHelperPopoverProps> = {}): {
  onAddTag: ReturnType<typeof vi.fn>
  onAddPathInclude: ReturnType<typeof vi.fn>
  onAddPathExclude: ReturnType<typeof vi.fn>
  onAddFilter: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onAddTag = vi.fn()
  const onAddPathInclude = vi.fn()
  const onAddPathExclude = vi.fn()
  const onAddFilter = vi.fn()
  const { container } = render(
    <FilterHelperPopover
      onAddTag={onAddTag}
      onAddPathInclude={onAddPathInclude}
      onAddPathExclude={onAddPathExclude}
      onAddFilter={onAddFilter}
      {...props}
    />,
  )
  return { onAddTag, onAddPathInclude, onAddPathExclude, onAddFilter, container }
}

beforeEach(() => {
  // `resetAllMocks` (not `clearAllMocks`) so any `mockResolvedValueOnce`
  // queue left by a prior test is dropped — otherwise an unconsumed
  // one-shot value leaks into the next test and starves its suggestions.
  vi.resetAllMocks()
  mockedListTags.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// UX-A3 — i18n
// ---------------------------------------------------------------------------

describe('FilterHelperPopover — i18n (UX-A3)', () => {
  it('renders the trigger and menu category labels via t()', async () => {
    const user = userEvent.setup()
    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    expect(screen.getByText(t('search.filterCategory.tag'))).toBeInTheDocument()
    expect(screen.getByText(t('search.filterCategory.pathInclude'))).toBeInTheDocument()
    expect(screen.getByText(t('search.filterCategory.pathExclude'))).toBeInTheDocument()
    expect(screen.getByText(t('search.filterCategoryTip'))).toBeInTheDocument()
  })

  it('renders the tag-picker "Back" button via t()', async () => {
    const user = userEvent.setup()
    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    expect(screen.getByRole('button', { name: t('search.filterHelper.back') })).toBeInTheDocument()
  })

  it('renders the path form "Back" + "Add" buttons via t()', async () => {
    const user = userEvent.setup()
    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.pathInclude')))
    expect(screen.getByRole('button', { name: t('search.filterHelper.back') })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: t('search.filterHelper.add') })).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// FE-A20 — race / out-of-order guard
// ---------------------------------------------------------------------------

describe('FilterHelperPopover — tag fetch race guard (FE-A20)', () => {
  it('drops a slow earlier response when a later one already resolved', async () => {
    // The un-debounced open prefill ('') resolves LATE; the debounced typed
    // query ('x') resolves FIRST. The stale prefill must not overwrite the
    // newer typed result (FE-A20 latest-wins sequence guard).
    const user = userEvent.setup()

    let resolveSlow: (rows: TagCacheRow[]) => void = () => {}
    const slow = new Promise<TagCacheRow[]>((res) => {
      resolveSlow = res
    })
    mockedListTags
      .mockReturnValueOnce(slow) // open prefill ('') — resolves later
      .mockResolvedValueOnce([tag('TAG_AB', 'able')]) // typed 'x' — resolves now

    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    // Prefill (seq 1) is in-flight (slow).

    await user.type(screen.getByRole('combobox'), 'x')
    // The debounced 'x' fetch (seq 2) resolves fast → '#able' paints.
    expect(await screen.findByRole('option', { name: '#able' })).toBeInTheDocument()

    // The stale prefill now resolves — seq 1 < current seq 2, so it's dropped.
    resolveSlow([tag('TAG_A', 'apple')])
    await waitFor(() => {
      expect(screen.queryByRole('option', { name: '#apple' })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('option', { name: '#able' })).toBeInTheDocument()
  })

  it('debounces keystrokes — only the final prefix hits the backend', async () => {
    // Real timers: userEvent's near-instant key delay types 'work' well
    // inside the 150 ms debounce window, so the per-keystroke schedules
    // coalesce into a single trailing fetch with the final prefix.
    const user = userEvent.setup()
    mockedListTags.mockResolvedValue([])

    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    // prefill on open is immediate (un-debounced).
    expect(mockedListTags).toHaveBeenCalledWith({ prefix: '', limit: 20 })
    mockedListTags.mockClear()

    await user.type(screen.getByRole('combobox'), 'work')
    await waitFor(() => {
      expect(mockedListTags).toHaveBeenCalledWith({ prefix: 'work', limit: 20 })
    })
    // Coalesced: exactly one typed-query fetch, not one per keystroke.
    expect(mockedListTags).toHaveBeenCalledTimes(1)
  })

  it('logs a warn and clears suggestions when the fetch rejects', async () => {
    const user = userEvent.setup()
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockedListTags
      .mockResolvedValueOnce([tag('TAG_X', 'xeno')]) // prefill OK
      .mockRejectedValueOnce(new Error('backend down')) // typed query fails

    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    expect(await screen.findByRole('option', { name: '#xeno' })).toBeInTheDocument()

    await user.type(screen.getByRole('combobox'), 'z')
    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        'FilterHelperPopover',
        'failed to search tags',
        { prefix: 'z' },
        expect.any(Error),
      )
    })
    expect(screen.queryByRole('option', { name: '#xeno' })).not.toBeInTheDocument()
    expect(screen.getByText(t('search.noTagsFound'))).toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// UX-A6 — combobox / listbox a11y
// ---------------------------------------------------------------------------

describe('FilterHelperPopover — combobox a11y (UX-A6)', () => {
  async function openTagPicker(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup()
    mockedListTags.mockResolvedValue([
      tag('TAG_1', 'alpha'),
      tag('TAG_2', 'beta'),
      tag('TAG_3', 'gamma'),
    ])
    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    await screen.findByRole('option', { name: '#alpha' })
    return user
  }

  it('exposes combobox + listbox roles wired by aria-controls', async () => {
    await openTagPicker()
    const input = screen.getByRole('combobox')
    const listbox = screen.getByRole('listbox')
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).toHaveAttribute('aria-controls', listbox.id)
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(within(listbox).getAllByRole('option')).toHaveLength(3)
  })

  it('ArrowDown / ArrowUp move aria-activedescendant + aria-selected', async () => {
    const user = await openTagPicker()
    const input = screen.getByRole('combobox')
    const options = screen.getAllByRole('option')

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')

    await user.keyboard('{ArrowDown}')
    expect(input).toHaveAttribute('aria-activedescendant', options[1]?.id)
    expect(options[1]).toHaveAttribute('aria-selected', 'true')
    expect(options[0]).toHaveAttribute('aria-selected', 'false')

    await user.keyboard('{ArrowUp}')
    expect(input).toHaveAttribute('aria-activedescendant', options[0]?.id)
    expect(options[0]).toHaveAttribute('aria-selected', 'true')
  })

  it('Enter on the active option selects it via onAddTag', async () => {
    const onAddTag = vi.fn()
    const user = userEvent.setup()
    mockedListTags.mockResolvedValue([tag('TAG_1', 'alpha'), tag('TAG_2', 'beta')])
    renderPopover({ onAddTag })
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    await screen.findByRole('option', { name: '#alpha' })

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}')
    expect(onAddTag).toHaveBeenCalledWith('beta')
    // Selection closes the popover.
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })
  })

  it('Enter with no active option does nothing', async () => {
    const onAddTag = vi.fn()
    const user = userEvent.setup()
    mockedListTags.mockResolvedValue([tag('TAG_1', 'alpha')])
    renderPopover({ onAddTag })
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    await screen.findByRole('option', { name: '#alpha' })

    await user.keyboard('{Enter}')
    expect(onAddTag).not.toHaveBeenCalled()
  })

  it('clicking an option selects it via onAddTag', async () => {
    const onAddTag = vi.fn()
    const user = userEvent.setup()
    mockedListTags.mockResolvedValue([tag('TAG_1', 'alpha')])
    renderPopover({ onAddTag })
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    expect(onAddTag).toHaveBeenCalledWith('alpha')
  })

  it('Escape closes the popover', async () => {
    const user = await openTagPicker()
    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    })
  })
})

// ---------------------------------------------------------------------------
// Path-filter form (callback contract unchanged)
// ---------------------------------------------------------------------------

describe('FilterHelperPopover — path filters', () => {
  it('include form calls onAddPathInclude with the trimmed glob', async () => {
    const user = userEvent.setup()
    const { onAddPathInclude } = renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.pathInclude')))
    await user.type(screen.getByLabelText(t('search.filterCategory.pathInclude')), '  Journal/*  ')
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddPathInclude).toHaveBeenCalledWith('Journal/*')
  })

  it('exclude form calls onAddPathExclude', async () => {
    const user = userEvent.setup()
    const { onAddPathExclude } = renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.pathExclude')))
    await user.type(screen.getByLabelText(t('search.filterCategory.pathExclude')), 'Archive/**')
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddPathExclude).toHaveBeenCalledWith('Archive/**')
  })
})

// ---------------------------------------------------------------------------
// PEND-58g UX-A5 — structural filter builder categories
// ---------------------------------------------------------------------------

async function openCategory(categoryKey: string): Promise<{
  user: ReturnType<typeof userEvent.setup>
  onAddFilter: ReturnType<typeof vi.fn>
}> {
  const user = userEvent.setup()
  const { onAddFilter } = renderPopover()
  await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
  await user.click(screen.getByText(t(categoryKey)))
  return { user, onAddFilter }
}

describe('FilterHelperPopover — state filter (UX-A5)', () => {
  it('emits a `state` token for the default include + selected value', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.state')
    await user.selectOptions(
      screen.getByLabelText(t('search.filterHelper.stateValueLabel')),
      'TODO',
    )
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'state', value: 'TODO', span: [0, 0] })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('state:TODO')
  })

  it('emits a `notState` token when exclude is toggled', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.state')
    await user.selectOptions(
      screen.getByLabelText(t('search.filterHelper.stateValueLabel')),
      'DONE',
    )
    await user.click(screen.getByRole('radio', { name: t('search.filterHelper.exclude') }))
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'notState', value: 'DONE', span: [0, 0] })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('not-state:DONE')
  })

  it('closes the popover after adding', async () => {
    const { user } = await openCategory('search.filterCategory.state')
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    await waitFor(() => {
      expect(screen.queryByTestId('state-filter-form')).not.toBeInTheDocument()
    })
  })

  it('moves focus to the state value control on open', async () => {
    await openCategory('search.filterCategory.state')
    // Focus must land on the form's primary control (not orphaned on
    // document.body when the clicked menu item unmounts), matching the
    // tag/path pattern.
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute(
        'aria-label',
        t('search.filterHelper.stateValueLabel'),
      )
    })
  })

  it('has no axe violations', async () => {
    await openCategory('search.filterCategory.state')
    await waitFor(
      async () => {
        // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
        expect(await axe(document.body as any)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

describe('FilterHelperPopover — priority filter (UX-A5)', () => {
  it('emits a `priority` token for the selected value', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.priority')
    await user.selectOptions(
      screen.getByLabelText(t('search.filterHelper.priorityValueLabel')),
      '2',
    )
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({ kind: 'priority', value: '2', span: [0, 0] })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('priority:2')
  })

  it('emits a `notPriority` token (with `none`) when exclude is toggled', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.priority')
    await user.selectOptions(
      screen.getByLabelText(t('search.filterHelper.priorityValueLabel')),
      'none',
    )
    await user.click(screen.getByRole('radio', { name: t('search.filterHelper.exclude') }))
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'notPriority',
      value: 'none',
      span: [0, 0],
    })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('not-priority:none')
  })

  it('has no axe violations', async () => {
    await openCategory('search.filterCategory.priority')
    await waitFor(
      async () => {
        // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
        expect(await axe(document.body as any)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

describe('FilterHelperPopover — due / scheduled filter (UX-A5)', () => {
  it('emits a `due` named-bucket token round-tripping to `due:today`', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.due')
    await user.selectOptions(
      screen.getByLabelText(t('search.filterHelper.dateBucketLabel')),
      'today',
    )
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'due',
      value: { kind: 'named', name: 'today' },
      raw: 'today',
      span: [0, 0],
    })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('due:today')
  })

  it('emits a `scheduled` op token round-tripping to `scheduled:>=2026-01-01`', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.scheduled')
    await user.selectOptions(screen.getByLabelText(t('search.filterHelper.dateShapeLabel')), 'op')
    await user.selectOptions(screen.getByLabelText(t('search.filterHelper.dateOpLabel')), '>=')
    const dateInput = screen.getByLabelText(t('search.filterHelper.dateValueLabel'))
    await user.type(dateInput, '2026-01-01')
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'scheduled',
      value: { kind: 'op', op: '>=', date: '2026-01-01' },
      raw: '>=2026-01-01',
      span: [0, 0],
    })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe(
      'scheduled:>=2026-01-01',
    )
  })

  it('disables Add in op mode until a date is entered', async () => {
    const { user } = await openCategory('search.filterCategory.due')
    await user.selectOptions(screen.getByLabelText(t('search.filterHelper.dateShapeLabel')), 'op')
    expect(screen.getByRole('button', { name: t('search.filterHelper.add') })).toBeDisabled()
  })

  it('moves focus to the date-shape control on open', async () => {
    await openCategory('search.filterCategory.due')
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute(
        'aria-label',
        t('search.filterHelper.dateShapeLabel'),
      )
    })
  })

  it('has no axe violations', async () => {
    await openCategory('search.filterCategory.due')
    await waitFor(
      async () => {
        // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
        expect(await axe(document.body as any)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

describe('FilterHelperPopover — property filter (UX-A5)', () => {
  it('emits a `prop` token with key + value', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.prop')
    await user.type(screen.getByLabelText(t('search.filterHelper.propKeyLabel')), 'area')
    await user.type(screen.getByLabelText(t('search.filterHelper.propValueLabel')), 'x')
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'prop',
      key: 'area',
      value: 'x',
      span: [0, 0],
    })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('prop:area=x')
  })

  it('emits a `notProp` token when exclude is toggled', async () => {
    const { user, onAddFilter } = await openCategory('search.filterCategory.prop')
    await user.click(screen.getByRole('radio', { name: t('search.filterHelper.exclude') }))
    await user.type(screen.getByLabelText(t('search.filterHelper.propKeyLabel')), 'area')
    await user.type(screen.getByLabelText(t('search.filterHelper.propValueLabel')), 'x')
    await user.click(screen.getByRole('button', { name: t('search.filterHelper.add') }))
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'notProp',
      key: 'area',
      value: 'x',
      span: [0, 0],
    })
    expect(tokenSource(onAddFilter.mock.calls[0]?.[0] as FilterToken)).toBe('not-prop:area=x')
  })

  it('keeps Add disabled until both key and value are filled', async () => {
    const { user } = await openCategory('search.filterCategory.prop')
    const add = screen.getByRole('button', { name: t('search.filterHelper.add') })
    expect(add).toBeDisabled()
    await user.type(screen.getByLabelText(t('search.filterHelper.propKeyLabel')), 'area')
    expect(add).toBeDisabled()
    await user.type(screen.getByLabelText(t('search.filterHelper.propValueLabel')), 'x')
    expect(add).toBeEnabled()
  })

  it('has no axe violations', async () => {
    await openCategory('search.filterCategory.prop')
    await waitFor(
      async () => {
        // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
        expect(await axe(document.body as any)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})

// ---------------------------------------------------------------------------
// axe audits
// ---------------------------------------------------------------------------

describe('FilterHelperPopover — a11y', () => {
  it('has no axe violations in the category menu', async () => {
    const user = userEvent.setup()
    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await screen.findByRole('menu')
    await waitFor(
      async () => {
        // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
        expect(await axe(document.body as any)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })

  it('has no axe violations in the tag picker with results', async () => {
    const user = userEvent.setup()
    mockedListTags.mockResolvedValue([tag('TAG_1', 'alpha'), tag('TAG_2', 'beta')])
    renderPopover()
    await user.click(screen.getByRole('button', { name: t('search.addFilter') }))
    await user.click(screen.getByText(t('search.filterCategory.tag')))
    await screen.findByRole('option', { name: '#alpha' })
    await waitFor(
      async () => {
        // oxlint-disable-next-line typescript/no-explicit-any -- vitest-axe loose typing.
        expect(await axe(document.body as any)).toHaveNoViolations()
      },
      { timeout: 5000 },
    )
  })
})
