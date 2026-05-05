/**
 * Tests for the MenuPopoverContent wrapper (PEND-23 L9).
 *
 * Validates:
 *  - displayName is set
 *  - Renders the canonical menu width + viewport clamp by default
 *  - Caller-supplied className flows through (e.g., padding overrides)
 *  - Preserves the underlying `data-slot="popover-content"` attribute so
 *    e2e selectors that target Radix popovers continue to match
 *  - Forwards ref to the underlying PopoverContent
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { MenuPopoverContent } from '../menu-popover-content'
import { Popover, PopoverTrigger } from '../popover'

describe('MenuPopoverContent', () => {
  it('has displayName', () => {
    expect(MenuPopoverContent.displayName).toBe('MenuPopoverContent')
  })

  it('applies the canonical menu width + viewport clamp', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <MenuPopoverContent>Menu body</MenuPopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Menu body')
    const root = content.closest('[data-slot="popover-content"]')
    expect(root).not.toBeNull()
    expect(root?.className).toContain('w-64')
    expect(root?.className).toContain('max-w-[calc(100vw-1.5rem)]')
  })

  it('forwards caller className alongside the canonical width', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <MenuPopoverContent className="p-1">Padded menu</MenuPopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Padded menu')
    const root = content.closest('[data-slot="popover-content"]')
    expect(root?.className).toContain('w-64')
    expect(root?.className).toContain('p-1')
  })

  it('forwards ref to the underlying content element', async () => {
    const ref = React.createRef<HTMLDivElement>()

    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <MenuPopoverContent ref={ref}>Ref menu</MenuPopoverContent>
      </Popover>,
    )

    await screen.findByText('Ref menu')
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('popover-content')
  })
})
