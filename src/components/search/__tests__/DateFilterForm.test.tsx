/**
 * CR-MINOR — dedicated tests for `<DateFilterForm>`.
 *
 * Previously covered only transitively via `FilterHelperPopover.test.tsx`.
 * The form builds a `due` / `scheduled` `FilterToken` (no not- variant) in
 * one of two shapes:
 *  - named bucket → `{ value: { kind: 'named', name }, raw: name }`
 *  - comparison   → `{ value: { kind: 'op', op, date }, raw: `${op}${date}` }`
 *
 * The emitted `raw` mirrors the parser/serialiser canonical form exactly.
 *
 * `@/components/ui/select` is globally mocked as a native `<select>` (see
 * `src/test-setup.ts`), so `userEvent.selectOptions` drives the selects.
 *
 * Coverage:
 *  - renders with the kind-specific category label + bucket default
 *  - bucket shape + Add emits a `named` token (both `due` and `scheduled`)
 *  - op shape: Add disabled until a date is entered, then emits an `op` token
 *  - Back fires onBack
 *  - axe(container) clean in both shapes
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { t } from '@/lib/i18n'

import { DateFilterForm, type DateFilterFormProps } from '../filter-forms/DateFilterForm'

function setup(kind: DateFilterFormProps['kind'] = 'due'): {
  onAddFilter: ReturnType<typeof vi.fn>
  onBack: ReturnType<typeof vi.fn>
  container: HTMLElement
} {
  const onAddFilter = vi.fn()
  const onBack = vi.fn()
  const { container } = render(
    <DateFilterForm kind={kind} onAddFilter={onAddFilter} onBack={onBack} />,
  )
  return { onAddFilter, onBack, container }
}

const shapeSelect = (): HTMLElement =>
  screen.getByLabelText(t('search.filterHelper.dateShapeLabel'))
const bucketSelect = (): HTMLElement =>
  screen.getByLabelText(t('search.filterHelper.dateBucketLabel'))
const opSelect = (): HTMLElement => screen.getByLabelText(t('search.filterHelper.dateOpLabel'))
const dateInput = (): HTMLElement => screen.getByLabelText(t('search.filterHelper.dateValueLabel'))
const addButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.add') })
const backButton = (): HTMLElement =>
  screen.getByRole('button', { name: t('search.filterHelper.back') })

describe('DateFilterForm — render', () => {
  it('renders the `due` category label and bucket shape by default', () => {
    setup('due')
    expect(screen.getByTestId('date-filter-form')).toBeInTheDocument()
    expect(screen.getByText(t('search.filterCategory.due'))).toBeInTheDocument()
    expect(shapeSelect()).toBeInTheDocument()
    expect(bucketSelect()).toBeInTheDocument()
    expect(addButton()).toBeEnabled()
  })

  it('renders the `scheduled` category label when kind is scheduled', () => {
    setup('scheduled')
    expect(screen.getByText(t('search.filterCategory.scheduled'))).toBeInTheDocument()
  })
})

describe('DateFilterForm — bucket shape', () => {
  it('emits a `due` named-bucket token for the selected bucket', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup('due')
    await user.selectOptions(bucketSelect(), 'overdue')
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'due',
      value: { kind: 'named', name: 'overdue' },
      raw: 'overdue',
      span: [0, 0],
    })
  })

  it('emits a `scheduled` named-bucket token defaulting to `today`', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup('scheduled')
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'scheduled',
      value: { kind: 'named', name: 'today' },
      raw: 'today',
      span: [0, 0],
    })
  })
})

describe('DateFilterForm — op shape', () => {
  it('disables Add until a date is entered', async () => {
    const user = userEvent.setup()
    setup('due')
    await user.selectOptions(shapeSelect(), 'op')
    expect(addButton()).toBeDisabled()
  })

  it('emits an `op` token once an operator and date are chosen', async () => {
    const user = userEvent.setup()
    const { onAddFilter } = setup('scheduled')
    await user.selectOptions(shapeSelect(), 'op')
    await user.selectOptions(opSelect(), '>=')
    await user.type(dateInput(), '2026-01-01')
    expect(addButton()).toBeEnabled()
    await user.click(addButton())
    expect(onAddFilter).toHaveBeenCalledWith({
      kind: 'scheduled',
      value: { kind: 'op', op: '>=', date: '2026-01-01' },
      raw: '>=2026-01-01',
      span: [0, 0],
    })
  })
})

describe('DateFilterForm — Back', () => {
  it('calls onBack without emitting a token', async () => {
    const user = userEvent.setup()
    const { onBack, onAddFilter } = setup('due')
    await user.click(backButton())
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onAddFilter).not.toHaveBeenCalled()
  })
})

describe('DateFilterForm — a11y', () => {
  it('has no axe violations in bucket shape', async () => {
    const { container } = setup('due')
    expect(await axe(container as any)).toHaveNoViolations()
  })

  it('has no axe violations in op shape', async () => {
    const user = userEvent.setup()
    const { container } = setup('scheduled')
    await user.selectOptions(shapeSelect(), 'op')
    expect(await axe(container as any)).toHaveNoViolations()
  })
})
