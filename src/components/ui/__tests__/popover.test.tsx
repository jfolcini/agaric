/**
 * Tests for the Popover components.
 *
 * Validates:
 *  - displayName is set on all exports
 *  - PopoverContent forwards ref
 *  - Render output and a11y compliance
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../popover'

describe('Popover displayNames', () => {
  it('Popover has displayName', () => {
    expect(Popover.displayName).toBe('Popover')
  })

  it('PopoverTrigger has displayName', () => {
    expect(PopoverTrigger.displayName).toBe('PopoverTrigger')
  })

  it('PopoverAnchor has displayName', () => {
    expect(PopoverAnchor.displayName).toBe('PopoverAnchor')
  })

  it('PopoverContent has displayName', () => {
    expect(PopoverContent.displayName).toBe('PopoverContent')
  })
})

describe('PopoverContent', () => {
  it('forwards ref to the content element', async () => {
    const ref = React.createRef<HTMLDivElement>()

    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent ref={ref}>Popover body</PopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Popover body')
    expect(content).toBeInTheDocument()
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('popover-content')
  })

  it('renders with data-slot="popover-content"', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent>Content here</PopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Content here')
    expect(content.closest('[data-slot="popover-content"]')).toBeInTheDocument()
  })

  it('has no a11y violations', async () => {
    const { baseElement } = render(
      <Popover defaultOpen>
        <PopoverTrigger>Open popover</PopoverTrigger>
        <PopoverContent aria-label="Popover content">Accessible popover content</PopoverContent>
      </Popover>,
    )
    const results = await axe(baseElement)
    expect(results).toHaveNoViolations()
  })
})
