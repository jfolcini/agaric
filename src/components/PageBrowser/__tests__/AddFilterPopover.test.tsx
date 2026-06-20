/**
 * Phase 4 + (T-F3 / D24) — AddFilterPopover tests.
 *
 * T-F3 mandates exercising the REAL component: the Radix Popover is NOT
 * mocked here (it was in the original Phase-4 test). We open the popover by
 * clicking the trigger and assert against the portalled content, so the
 * focus-restore-on-close, reset-on-onOpenChange(false), the predicate emit
 * paths (Eq/Ne/Exists/NotExists), the D24 path-exclude toggle, and the
 * D14 (Apply disabled when required input empty) / D21 (autoFocus + Enter)
 * behaviour are all covered end-to-end.
 */

import { invoke } from '@tauri-apps/api/core'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { FilterGroup } from '@/components/AdvancedQuery/FilterGroup'
import {
  HasParentMatchingEditor,
  type HasParentMatchingEditorProps,
} from '@/components/AdvancedQuery/HasParentMatchingEditor'
import {
  __resetPriorityLevelsForTests,
  DEFAULT_PRIORITY_LEVELS,
  setPriorityLevels,
} from '@/lib/priority-levels'
import type { FilterPrimitive } from '@/lib/tauri'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

import { AddFilterPopover } from '../AddFilterPopover'

const mockedInvoke = vi.mocked(invoke)

// #1478 — the has-parent facet's editor (and its recursive sub-builder) is
// dependency-injected: `AddFilterPopover` imports neither `HasParentMatchingEditor`
// nor `FilterGroup`, to keep the import graph acyclic. Production (FilterGroup)
// injects this exact closure; mirror it here so the has-parent tests exercise the
// same nested-builder UX they always did.
const renderHasParentEditor = (props: {
  onApply: HasParentMatchingEditorProps['onApply']
  onBack: HasParentMatchingEditorProps['onBack']
}) => <HasParentMatchingEditor {...props} renderBuilder={(b) => <FilterGroup {...b} />} />

/** Opens the popover via its trigger and resolves once the dialog is mounted. */
async function openPopover(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  const trigger = screen.getByRole('button', { name: 'Add filter' })
  await user.click(trigger)
  await screen.findByRole('dialog', { name: 'Add a filter' })
  return trigger
}

describe('AddFilterPopover', () => {
  // E1 — Priority values are driven by the user-configurable priority levels;
  // reset the module-level store before/after each test so a custom-level test
  // can't leak into the default-level assertions.
  beforeEach(() => {
    __resetPriorityLevelsForTests()
  })
  afterEach(() => {
    __resetPriorityLevelsForTests()
  })

  it('renders both filter category groups when opened', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    expect(screen.getByText('Filters')).toBeInTheDocument()
    expect(screen.getByText('Pages')).toBeInTheDocument()
  })

  it('exposes role="dialog" on the popover content (matches aria-haspopup)', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    expect(screen.getByRole('dialog', { name: 'Add a filter' })).toBeInTheDocument()
  })

  it('renders the muted helper descriptions for the pages-only facets', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    expect(
      screen.getByText('Fully isolated — no inbound links and no outbound links.'),
    ).toBeInTheDocument()
    expect(screen.getByText('A titled page with no content blocks.')).toBeInTheDocument()
    expect(
      screen.getByText('Nothing links to this page (it may still link out).'),
    ).toBeInTheDocument()
  })

  // E19 — the value-bearing facets (Tag / Page path / Has property /
  // Last-edited / Priority) carry short descriptions too, not just the three
  // boolean facets.
  it('renders the helper descriptions for the value-bearing facets', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    expect(screen.getByText('Pages tagged with a specific tag id.')).toBeInTheDocument()
    expect(screen.getByText('Pages whose path matches a glob pattern.')).toBeInTheDocument()
    expect(screen.getByText('Pages with a property matching a condition.')).toBeInTheDocument()
    expect(screen.getByText('Pages edited within the chosen window.')).toBeInTheDocument()
    expect(screen.getByText('Pages set to a priority level.')).toBeInTheDocument()
  })

  it('renders the "Last edited" group label before the bucket buttons', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    expect(screen.getByText('Last edited')).toBeInTheDocument()
  })

  it('adds a boolean Pages primitive immediately on click', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Orphan'))
    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Orphan' })
  })

  it('maps the "Edited this week" bucket to Rolling { days: 7 }', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Edited this week'))
    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'LastEdited',
      spec: { type: 'Rolling', days: 7 },
    })
  })

  it('maps "Edited long ago" to OlderThan { days: 30 }', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Edited long ago'))
    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'LastEdited',
      spec: { type: 'OlderThan', days: 30 },
    })
  })

  // E1 — the offered Priority values are driven by `usePriorityLevels()` (the
  // user-configurable levels), NOT a hardcoded `A/B/C`. Out of the box the
  // levels are `1/2/3` (`DEFAULT_PRIORITY_LEVELS`); a level button emits that
  // exact string so the backend `b.priority = ?` match succeeds.
  it('offers exactly the configured priority levels (default 1/2/3)', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)

    for (const level of DEFAULT_PRIORITY_LEVELS) {
      expect(screen.getByRole('button', { name: level })).toBeInTheDocument()
    }
    // The legacy hardcoded A/B/C must no longer be offered.
    expect(screen.queryByRole('button', { name: 'A' })).not.toBeInTheDocument()
  })

  it('reflects custom priority levels when reconfigured', async () => {
    setPriorityLevels(['P0', 'P1'])
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)

    expect(screen.getByRole('button', { name: 'P0' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'P1' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '3' })).not.toBeInTheDocument()
  })

  it('emits a Priority primitive carrying the configured level value', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByRole('button', { name: '1' }))
    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Priority', priority: '1' })
  })

  it('emits a Tag primitive through the inline editor', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Tag'))
    const input = screen.getByLabelText('Tag id')
    await user.type(input, 'urgent')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({ type: 'Tag', tag: 'urgent' })
  })

  it('emits a PathGlob primitive (exclude=false) from the path editor', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Page path'))
    await user.type(screen.getByLabelText('e.g. Projects/*'), 'Projects/*')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'PathGlob',
      pattern: 'Projects/*',
      exclude: false,
    })
  })

  // D24: the path-exclude toggle emits PathGlob{exclude:true} ("not path:").
  it('emits a PathGlob primitive (exclude=true) when the Exclude toggle is on', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Page path'))
    await user.type(screen.getByLabelText('e.g. Projects/*'), 'Projects/*')
    await user.click(screen.getByRole('checkbox', { name: 'Exclude matching pages' }))
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'PathGlob',
      pattern: 'Projects/*',
      exclude: true,
    })
  })

  // D24: the default op is Eq; key + value → Eq with a Text payload.
  it('emits HasProperty with an Eq predicate when a value is given (default op)', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    await user.type(screen.getByLabelText('Property key'), 'status')
    await user.type(screen.getByLabelText('Value'), 'done')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'Eq', value: { type: 'Text', value: 'done' } },
    })
  })

  // D24: selecting "is not" emits an Ne predicate.
  it('emits HasProperty with an Ne predicate when "is not" is chosen', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    await user.type(screen.getByLabelText('Property key'), 'status')
    await user.selectOptions(screen.getByLabelText('Comparison'), 'Ne')
    await user.type(screen.getByLabelText('Value'), 'done')
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'Ne', value: { type: 'Text', value: 'done' } },
    })
  })

  // D24: "exists" hides the value input and emits an Exists predicate on the
  // key alone (Apply enabled with no value).
  it('emits HasProperty with an Exists predicate and hides the value input', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    await user.type(screen.getByLabelText('Property key'), 'status')
    await user.selectOptions(screen.getByLabelText('Comparison'), 'Exists')
    // Value input is gone for Exists.
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument()
    // Apply is enabled on the key alone.
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeEnabled()
    await user.click(apply)

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'Exists' },
    })
  })

  // D24: "doesn't exist" emits a NotExists predicate, value input hidden.
  it('emits HasProperty with a NotExists predicate (value input hidden)', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    await user.type(screen.getByLabelText('Property key'), 'status')
    await user.selectOptions(screen.getByLabelText('Comparison'), 'NotExists')
    expect(screen.queryByLabelText('Value')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Apply' }))

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'NotExists' },
    })
  })

  it('does not offer Search-only primitives', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    expect(screen.queryByText(/regex/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/whole word/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/snippet/i)).not.toBeInTheDocument()
  })

  it('shows the many-filters warning when warnManyFilters is set', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} warnManyFilters />)
    await openPopover(user)
    expect(screen.getByText('Many filters can slow the view.')).toBeInTheDocument()
  })

  // --- T-F3: focus-restore on close ---
  it('restores focus to the trigger when the popover is dismissed via Escape', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    const trigger = await openPopover(user)

    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  it('restores focus to the trigger after a filter is added (close path)', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    const trigger = await openPopover(user)

    await user.click(screen.getByText('Orphan'))
    expect(trigger).toHaveFocus()
  })

  // --- T-F3: reset on onOpenChange(false) (close discards editor state) ---
  it('resets the inline editor to the category menu when reopened after close', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    const trigger = await openPopover(user)

    await user.click(screen.getByText('Tag'))
    await user.type(screen.getByLabelText('Tag id'), 'urgent')

    // Close (onOpenChange(false)) then reopen — the editor + value must reset.
    await user.keyboard('{Escape}')
    await user.click(trigger)
    await screen.findByRole('dialog', { name: 'Add a filter' })

    expect(screen.queryByLabelText('Tag id')).not.toBeInTheDocument()
    expect(screen.getByText('Filters')).toBeInTheDocument()
  })

  // --- D14: Apply disabled while the required input is empty ---
  it('disables Apply while the tag input is empty and enables it once filled', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)

    await user.click(screen.getByText('Tag'))
    const apply = screen.getByRole('button', { name: 'Apply' })
    expect(apply).toBeDisabled()
    expect(apply).toHaveAttribute('aria-disabled', 'true')

    await user.type(screen.getByLabelText('Tag id'), 'urgent')
    expect(apply).toBeEnabled()
    expect(apply).toHaveAttribute('aria-disabled', 'false')
  })

  it('does not emit on Enter while the tag input is empty (D14)', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Tag'))
    const input = screen.getByLabelText('Tag id')
    input.focus()
    await user.keyboard('{Enter}')
    expect(onAddFilter).not.toHaveBeenCalled()
  })

  it('disables Apply in the property editor while the key is empty (D14)', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    const apply = screen.getByRole('button', { name: 'Apply' })
    // Value alone (no key) keeps Apply disabled — key is always required.
    await user.type(screen.getByLabelText('Value'), 'done')
    expect(apply).toBeDisabled()
    expect(apply).toHaveAttribute('aria-disabled', 'true')

    await user.type(screen.getByLabelText('Property key'), 'status')
    expect(apply).toBeEnabled()
  })

  // D24: for Eq/Ne the value is required too — key alone keeps Apply disabled.
  it('keeps Apply disabled for Eq while the value is empty (D24)', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    await user.type(screen.getByLabelText('Property key'), 'status')
    const apply = screen.getByRole('button', { name: 'Apply' })
    // Default op is Eq → value still required.
    expect(apply).toBeDisabled()
    await user.type(screen.getByLabelText('Value'), 'done')
    expect(apply).toBeEnabled()
  })

  // --- D21: HasProperty editor autoFocus + Enter-to-apply ---
  it('autofocuses the property key input when the editor opens (D21)', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    expect(screen.getByLabelText('Property key')).toHaveFocus()
  })

  it('applies the property filter on Enter from the value input (D21)', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    await user.type(screen.getByLabelText('Property key'), 'status')
    await user.type(screen.getByLabelText('Value'), 'done{Enter}')

    expect(onAddFilter).toHaveBeenCalledWith({
      type: 'HasProperty',
      key: 'status',
      predicate: { type: 'Eq', value: { type: 'Text', value: 'done' } },
    })
  })

  it('does not emit on Enter in the property editor while the key is empty (D14)', async () => {
    const user = userEvent.setup()
    const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
    render(<AddFilterPopover onAddFilter={onAddFilter} />)
    await openPopover(user)

    await user.click(screen.getByText('Has property'))
    const keyInput = screen.getByLabelText('Property key')
    keyInput.focus()
    await user.keyboard('{Enter}')
    expect(onAddFilter).not.toHaveBeenCalled()
  })

  it('has no a11y violations with the popover open', async () => {
    const user = userEvent.setup()
    render(<AddFilterPopover onAddFilter={vi.fn()} />)
    await openPopover(user)
    // Radix portals PopoverContent to document.body (outside the render
    // container), so scan the whole body to actually include the open dialog.
    expect(await axe(document.body)).toHaveNoViolations()
  })

  // ── #1280 D2 — advanced-only facets (State / Block type / Due / Scheduled /
  // Created), gated on `showAdvancedFacets`. ───────────────────────────────
  describe('advanced facets (#1280 D2)', () => {
    it('does NOT offer the advanced facets by default (Pages surface unchanged)', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} />)
      await openPopover(user)
      expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
      expect(screen.queryByText('State')).not.toBeInTheDocument()
      expect(screen.queryByText('Block type')).not.toBeInTheDocument()
      expect(screen.queryByText('Due date')).not.toBeInTheDocument()
      expect(screen.queryByText('Scheduled')).not.toBeInTheDocument()
      expect(screen.queryByText('Created')).not.toBeInTheDocument()
    })

    it('offers the advanced facets when showAdvancedFacets is set', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} showAdvancedFacets />)
      await openPopover(user)
      expect(screen.getByText('Advanced')).toBeInTheDocument()
      expect(screen.getByText('State')).toBeInTheDocument()
      expect(screen.getByText('Block type')).toBeInTheDocument()
      expect(screen.getByText('Due date')).toBeInTheDocument()
      expect(screen.getByText('Scheduled')).toBeInTheDocument()
      expect(screen.getByText('Created')).toBeInTheDocument()
      // The shared facets are still offered alongside them.
      expect(screen.getByText('Tag')).toBeInTheDocument()
    })

    it('emits a State primitive with the exact { values, is_null, exclude } shape', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('State'))
      await user.click(screen.getByRole('checkbox', { name: 'TODO' }))
      await user.click(screen.getByRole('checkbox', { name: 'DOING' }))
      await user.click(screen.getByRole('checkbox', { name: 'Exclude matching blocks' }))
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'State',
        values: ['TODO', 'DOING'],
        is_null: false,
        exclude: true,
      })
    })

    it('emits a State primitive with is_null when the "no state" toggle is on', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('State'))
      await user.click(screen.getByRole('checkbox', { name: 'No state (unset)' }))
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'State',
        values: [],
        is_null: true,
        exclude: false,
      })
    })

    it('disables State Apply until a value or the is-null toggle is set', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('State'))
      const apply = screen.getByRole('button', { name: 'Apply' })
      expect(apply).toBeDisabled()
      await user.click(screen.getByRole('checkbox', { name: 'TODO' }))
      expect(apply).toBeEnabled()
    })

    it('emits a BlockType primitive with the exact { values, exclude } shape', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Block type'))
      await user.click(screen.getByRole('checkbox', { name: 'Content' }))
      await user.click(screen.getByRole('checkbox', { name: 'Page' }))
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'BlockType',
        values: ['content', 'page'],
        exclude: false,
      })
    })

    it('emits a DueDate primitive with an OnOrBefore date predicate', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Due date'))
      // Default op is OnOrBefore; supply the single date.
      await user.type(screen.getByLabelText('Date'), '2026-04-01')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'DueDate',
        predicate: { type: 'OnOrBefore', date: '2026-04-01' },
      })
    })

    it('emits a DueDate IsNull predicate with no date input shown', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Due date'))
      await user.selectOptions(screen.getByLabelText('Condition'), 'IsNull')
      expect(screen.queryByLabelText('Date')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'DueDate',
        predicate: { type: 'IsNull' },
      })
    })

    it('emits a Scheduled Between predicate with two dates', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Scheduled'))
      await user.selectOptions(screen.getByLabelText('Condition'), 'Between')
      await user.type(screen.getByLabelText('From date'), '2026-01-01')
      await user.type(screen.getByLabelText('To date'), '2026-03-31')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'Scheduled',
        predicate: { type: 'Between', from: '2026-01-01', to: '2026-03-31' },
      })
    })

    it('disables date Apply until the required date(s) are supplied', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Due date'))
      const apply = screen.getByRole('button', { name: 'Apply' })
      expect(apply).toBeDisabled()
      await user.type(screen.getByLabelText('Date'), '2026-04-01')
      expect(apply).toBeEnabled()
    })

    it('emits a Created primitive with the exact { after, before } shape (after only)', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Created'))
      await user.type(screen.getByLabelText('Created after'), '2026-01-01')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'Created',
        after: '2026-01-01',
        before: null,
      })
    })

    it('emits a Created primitive with both bounds', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Created'))
      await user.type(screen.getByLabelText('Created after'), '2026-01-01')
      await user.type(screen.getByLabelText('Created before'), '2026-06-01')
      await user.click(screen.getByRole('button', { name: 'Apply' }))

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'Created',
        after: '2026-01-01',
        before: '2026-06-01',
      })
    })

    it('disables Created Apply until at least one bound is set', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Created'))
      const apply = screen.getByRole('button', { name: 'Apply' })
      expect(apply).toBeDisabled()
      await user.type(screen.getByLabelText('Created before'), '2026-06-01')
      expect(apply).toBeEnabled()
    })

    it('has no a11y violations with each advanced editor open', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} showAdvancedFacets />)
      await openPopover(user)

      for (const facet of ['State', 'Block type', 'Due date', 'Created']) {
        await user.click(screen.getByText(facet))
        expect(await axe(document.body)).toHaveNoViolations()
        await user.click(screen.getByRole('button', { name: 'Back' }))
      }
    })
  })

  // ── #1478 — relational facets (links-to / linked-from / has-parent-matching),
  // gated on `showAdvancedFacets` alongside the other advanced facets. ─────────
  describe('relational facets (#1478)', () => {
    const SPACE = 'SPACE_REL'

    beforeEach(() => {
      vi.clearAllMocks()
      useSpaceStore.setState({ currentSpaceId: SPACE })
      useResolveStore.setState({ cache: new Map(), version: 0 })
      // The link picker loads the space's pages via `list_all_pages_in_space`.
      mockedInvoke.mockImplementation(async (cmd: string) => {
        if (cmd === 'list_all_pages_in_space')
          return [
            { id: 'PAGE_A', content: 'Roadmap' },
            { id: 'PAGE_B', content: 'Backlog' },
          ]
        return null
      })
    })

    it('offers the three relational facets when showAdvancedFacets is set', async () => {
      const user = userEvent.setup()
      render(
        <AddFilterPopover
          onAddFilter={vi.fn()}
          showAdvancedFacets
          renderHasParentEditor={renderHasParentEditor}
        />,
      )
      await openPopover(user)
      expect(screen.getByText('Links to')).toBeInTheDocument()
      expect(screen.getByText('Linked from')).toBeInTheDocument()
      expect(screen.getByText('Has parent matching')).toBeInTheDocument()
    })

    it('the link picker stores the ULID and emits a LinksTo primitive', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Links to'))
      // The picker shows page titles; clicking one stores its id, not its title.
      await screen.findByText('Roadmap')
      await user.click(screen.getByText('Roadmap'))

      expect(onAddFilter).toHaveBeenCalledWith({ type: 'LinksTo', target: 'PAGE_A' })
    })

    it('filters the picker by folded title search', async () => {
      const user = userEvent.setup()
      render(<AddFilterPopover onAddFilter={vi.fn()} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Linked from'))
      await screen.findByText('Roadmap')
      await user.type(screen.getByLabelText('Search pages'), 'back')
      expect(screen.queryByText('Roadmap')).not.toBeInTheDocument()
      expect(screen.getByText('Backlog')).toBeInTheDocument()
    })

    it('the linked-from picker emits a LinkedFrom primitive storing the ULID', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(<AddFilterPopover onAddFilter={onAddFilter} showAdvancedFacets />)
      await openPopover(user)

      await user.click(screen.getByText('Linked from'))
      await screen.findByText('Backlog')
      await user.click(screen.getByText('Backlog'))

      expect(onAddFilter).toHaveBeenCalledWith({ type: 'LinkedFrom', source: 'PAGE_B' })
    })

    it('has-parent-matching nests a sub-expr and compiles to { HasParentMatching, matcher }', async () => {
      const user = userEvent.setup()
      const onAddFilter = vi.fn<(f: FilterPrimitive) => void>()
      render(
        <AddFilterPopover
          onAddFilter={onAddFilter}
          showAdvancedFacets
          renderHasParentEditor={renderHasParentEditor}
        />,
      )
      await openPopover(user)

      await user.click(screen.getByText('Has parent matching'))
      const editor = await screen.findByTestId('has-parent-matching-editor')
      // Apply is gated until the matcher has at least one condition.
      expect(within(editor).getByRole('button', { name: 'Apply' })).toBeDisabled()

      // Add a Tag leaf into the nested mini-builder (its own Add-filter popover).
      await user.click(within(editor).getByRole('button', { name: 'Add filter' }))
      // The inner popover is a SECOND dialog (the mini-builder's own AddFilter);
      // scope to the most-recently-opened one.
      const dialogs = await waitFor(() => {
        const all = screen.getAllByRole('dialog', { name: 'Add a filter' })
        if (all.length < 2) throw new Error('inner popover not yet open')
        return all
      })
      const inner = dialogs[dialogs.length - 1] as HTMLElement
      await user.click(within(inner).getByText('Tag'))
      await user.type(within(inner).getByLabelText('Tag id'), 'urgent')
      await user.click(within(inner).getByRole('button', { name: 'Apply' }))

      // Now the matcher is non-empty; Apply the has-parent leaf.
      await waitFor(() =>
        expect(
          within(screen.getByTestId('has-parent-matching-editor')).getByRole('button', {
            name: 'Apply',
          }),
        ).toBeEnabled(),
      )
      await user.click(
        within(screen.getByTestId('has-parent-matching-editor')).getByRole('button', {
          name: 'Apply',
        }),
      )

      expect(onAddFilter).toHaveBeenCalledWith({
        type: 'HasParentMatching',
        matcher: {
          type: 'And',
          children: [{ type: 'Leaf', primitive: { type: 'Tag', tag: 'urgent' } }],
        },
      })
    })

    it('disables has-parent Apply on an empty matcher', async () => {
      const user = userEvent.setup()
      render(
        <AddFilterPopover
          onAddFilter={vi.fn()}
          showAdvancedFacets
          renderHasParentEditor={renderHasParentEditor}
        />,
      )
      await openPopover(user)

      await user.click(screen.getByText('Has parent matching'))
      const editor = await screen.findByTestId('has-parent-matching-editor')
      expect(within(editor).getByRole('button', { name: 'Apply' })).toBeDisabled()
      expect(within(editor).getByTestId('has-parent-empty-hint')).toBeInTheDocument()
    })

    it('has no a11y violations with each relational editor open', async () => {
      const user = userEvent.setup()
      render(
        <AddFilterPopover
          onAddFilter={vi.fn()}
          showAdvancedFacets
          renderHasParentEditor={renderHasParentEditor}
        />,
      )
      await openPopover(user)

      await user.click(screen.getByText('Links to'))
      await screen.findByText('Roadmap')
      expect(await axe(document.body)).toHaveNoViolations()
      await user.click(screen.getByRole('button', { name: 'Back' }))

      await user.click(screen.getByText('Has parent matching'))
      await screen.findByTestId('has-parent-matching-editor')
      expect(await axe(document.body)).toHaveNoViolations()
    })
  })
})
