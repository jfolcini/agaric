/**
 * Tests for the MenuPopoverContent wrapper.
 *
 * Validates:
 *  - displayName is set
 *  - Renders the canonical menu width + viewport clamp by default
 *  - Defaults to the floating-menu `p-1`, not PopoverContent's form `p-4`
 *  - Caller-supplied className flows through (e.g., padding overrides)
 *  - Preserves the underlying `data-slot="popover-content"` attribute so
 *    e2e selectors that target Radix popovers continue to match
 *  - Forwards ref to the underlying PopoverContent
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'

import { MenuPopoverContent } from '@/components/ui/menu-popover-content'
import { Popover, PopoverTrigger } from '@/components/ui/popover'

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

  it('defaults to the floating-menu p-1 instead of the popover p-4', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <MenuPopoverContent>Default padding</MenuPopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Default padding')
    const root = content.closest('[data-slot="popover-content"]')
    expect(root?.classList.contains('p-1')).toBe(true)
    expect(root?.classList.contains('p-4')).toBe(false)
  })

  it('lets a caller className override the default padding but keep the width', async () => {
    render(
      <Popover defaultOpen>
        <PopoverTrigger>Open</PopoverTrigger>
        <MenuPopoverContent className="p-3">Padded menu</MenuPopoverContent>
      </Popover>,
    )

    const content = await screen.findByText('Padded menu')
    const root = content.closest('[data-slot="popover-content"]')
    expect(root?.className).toContain('w-64')
    expect(root?.classList.contains('p-3')).toBe(true)
    expect(root?.classList.contains('p-1')).toBe(false)
    expect(root?.classList.contains('p-4')).toBe(false)
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
