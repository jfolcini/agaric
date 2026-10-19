/**
 * Tests for the Tabs primitive (Radix Tabs wrapper, #5920).
 */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

const VALUES = ['one', 'two', 'three'] as const

function Harness({
  variant,
  activationMode,
}: {
  variant?: 'underline' | 'vertical'
  activationMode?: 'automatic' | 'manual'
}) {
  const [value, setValue] = useState('one')
  return (
    <Tabs
      value={value}
      onValueChange={setValue}
      {...(variant === undefined ? {} : { variant })}
      {...(activationMode === undefined ? {} : { activationMode })}
    >
      <TabsList aria-label="Numbers">
        {VALUES.map((v) => (
          <TabsTrigger key={v} value={v}>
            {v}
          </TabsTrigger>
        ))}
      </TabsList>
      {VALUES.map((v) => (
        <TabsContent key={v} value={v}>
          Panel {v}
        </TabsContent>
      ))}
    </Tabs>
  )
}

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name })
}

describe('Tabs', () => {
  it('renders a labelled tablist with the selected tab and only its panel', () => {
    render(<Harness />)

    expect(screen.getByRole('tablist', { name: 'Numbers' })).toHaveAttribute(
      'aria-orientation',
      'horizontal',
    )
    expect(tab('one')).toHaveAttribute('aria-selected', 'true')
    expect(tab('two')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel one')
    expect(screen.queryByText('Panel two')).not.toBeInTheDocument()
  })

  it('points only the selected tab at its panel', () => {
    render(<Harness />)

    const panel = screen.getByRole('tabpanel')
    expect(tab('one')).toHaveAttribute('aria-controls', panel.id)
    expect(tab('two')).not.toHaveAttribute('aria-controls')
    expect(tab('three')).not.toHaveAttribute('aria-controls')
  })

  it('clicking a tab selects it and shows its panel', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(tab('two'))

    expect(tab('two')).toHaveAttribute('aria-selected', 'true')
    expect(tab('one')).toHaveAttribute('aria-selected', 'false')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel two')
  })

  it('the underline variant draws the selected bar in the tab-indicator token', () => {
    render(<Harness />)

    expect(screen.getByRole('tablist')).toHaveClass('border-b', 'border-border')
    expect(tab('one')).toHaveClass(
      'border-b-2',
      '-mb-px',
      'data-[state=active]:border-tab-indicator',
    )
    expect(tab('one')).toHaveAttribute('data-state', 'active')
    expect(tab('one')).not.toHaveClass('rounded-md')
  })

  it('is one tab stop, entered on the selected tab', async () => {
    const user = userEvent.setup()
    render(
      <>
        <button type="button">before</button>
        <Harness />
      </>,
    )
    tab('one').focus()
    await user.keyboard('{ArrowRight}')
    screen.getByRole('button', { name: 'before' }).focus()

    await user.tab()
    expect(tab('two')).toHaveFocus()
    // The next Tab leaves the tablist for the panel; no other tab is a stop.
    await user.tab()
    expect(document.activeElement).toHaveAttribute('role', 'tabpanel')
  })

  it('the tab stop follows a selection made outside the tablist', async () => {
    // Like the Journal's mode tabs: the panel and a second way to pick a tab sit outside.
    function OutsidePicker() {
      const [value, setValue] = useState('one')
      return (
        <>
          <button type="button">before</button>
          <Tabs value={value} onValueChange={setValue}>
            <TabsList aria-label="Numbers">
              {VALUES.map((v) => (
                <TabsTrigger key={v} value={v}>
                  {v}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <button type="button" onClick={() => setValue('three')}>
            pick three
          </button>
        </>
      )
    }
    const user = userEvent.setup()
    render(<OutsidePicker />)
    tab('one').focus()
    await user.click(screen.getByRole('button', { name: 'pick three' }))

    await user.tab({ shift: true })
    expect(tab('three')).toHaveFocus()
    screen.getByRole('button', { name: 'before' }).focus()
    await user.tab()
    expect(tab('three')).toHaveFocus()
  })

  it('ArrowRight and ArrowLeft move between tabs and wrap; Home and End reach the ends', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    tab('one').focus()

    await user.keyboard('{ArrowRight}')
    expect(tab('two')).toHaveFocus()
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(tab('three')).toHaveFocus()
    await user.keyboard('{Home}')
    expect(tab('one')).toHaveFocus()
    await user.keyboard('{End}')
    expect(tab('three')).toHaveFocus()
    // A horizontal tablist ignores Up and Down.
    await user.keyboard('{ArrowDown}')
    expect(tab('three')).toHaveFocus()
  })

  it('manual activation moves focus without selecting; Enter selects', async () => {
    const user = userEvent.setup()
    render(<Harness activationMode="manual" />)
    tab('one').focus()

    await user.keyboard('{ArrowRight}')

    expect(tab('two')).toHaveFocus()
    expect(tab('one')).toHaveAttribute('aria-selected', 'true')
    expect(tab('two')).toHaveAttribute('aria-selected', 'false')

    await user.keyboard('{Enter}')
    expect(tab('two')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel two')
  })

  it('the vertical variant is a vertical tablist moved with Up and Down', async () => {
    const user = userEvent.setup()
    render(<Harness variant="vertical" />)
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical')
    tab('one').focus()

    await user.keyboard('{ArrowRight}')
    expect(tab('one')).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(tab('two')).toHaveFocus()
    expect(tab('two')).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowUp}')
    expect(tab('one')).toHaveFocus()
  })

  it.each(['underline', 'vertical'] as const)('has no a11y violations (%s)', async (variant) => {
    const { container } = render(<Harness variant={variant} />)
    expect(await axe(container)).toHaveNoViolations()
  })
})
