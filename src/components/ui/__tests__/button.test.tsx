/**
 * Tests for the Button component.
 *
 * Validates:
 *  - Each size variant renders correctly
 *  - On a coarse pointer every text size paints one height with a 44 px hit
 *    area, and every icon size a 44 px box (#759, #7040)
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import { Plus, Star } from 'lucide-react'
import type * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import { paletteIconsOf } from '@/__tests__/helpers/palette-icons'
import { Button } from '@/components/ui/button'

/** Helper: render a Button with a given size and return the DOM element. */
function renderButton(
  size: 'default' | 'xs' | 'sm' | 'icon' | 'icon-xs' | 'icon-sm',
  label = 'Click',
) {
  render(<Button size={size}>{label}</Button>)
  return screen.getByRole('button', { name: label })
}

describe('Button', () => {
  // -- Size variant rendering -------------------------------------------------

  it('renders default size variant', () => {
    const btn = renderButton('default')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-9')
  })

  it('renders xs size variant', () => {
    const btn = renderButton('xs')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-7')
  })

  it('renders sm size variant', () => {
    const btn = renderButton('sm')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('h-8')
  })

  it('renders icon size variant', () => {
    const btn = renderButton('icon')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-9')
  })

  it('renders icon-xs size variant', () => {
    const btn = renderButton('icon-xs')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-6')
  })

  it('renders icon-sm size variant', () => {
    const btn = renderButton('icon-sm')
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('size-8')
  })

  // -- Coarse pointer media query overrides -----------------------------------

  // Below lg, a coarse pointer grows the label one step and the 44 px target
  // is an invisible hit area, so a row of buttons does not paint 44 px tall.
  // One height on a coarse pointer, the default's 36 px; the 44 px target is
  // an invisible hit area, so a row of buttons does not paint 44 px tall.
  it.each(['xs', 'sm'] as const)(
    '%s size paints 36 px on a coarse pointer, with a hit area',
    (size) => {
      const btn = renderButton(size)
      expect(btn.className).toContain('coarse:h-9')
      expect(btn.className).toContain('coarse:text-sm')
      expect(btn.className).toContain('touch-hit-area')
    },
  )

  it('default size is 36 px everywhere, with a hit area on a coarse pointer', () => {
    const btn = renderButton('default')
    expect(btn.className).toContain('h-9')
    expect(btn.className).not.toMatch(/coarse:h-/)
    expect(btn.className).toContain('touch-hit-area')
  })

  it('icon size includes coarse pointer size override', () => {
    const btn = renderButton('icon')
    expect(btn.className).toContain('coarse:size-(--touch-target)')
  })

  it('icon-xs size includes coarse pointer size override', () => {
    const btn = renderButton('icon-xs')
    expect(btn.className).toContain('coarse:size-(--touch-target)')
  })

  it('icon-sm size includes coarse pointer size override', () => {
    const btn = renderButton('icon-sm')
    expect(btn.className).toContain('coarse:size-(--touch-target)')
  })

  // -- active-press scale (#1012) ---------------------------------------------

  // #1012: the press-compress scale lives once in the cva base; icon
  // variants no longer re-declare it.
  it('applies active:scale-[0.97] from the base on every size', () => {
    for (const size of ['default', 'sm', 'icon', 'icon-sm'] as const) {
      render(<Button size={size}>{`press-${size}`}</Button>)
      const btn = screen.getByRole('button', { name: `press-${size}` })
      expect(btn.className).toContain('active:scale-[0.97]')
      expect(btn.className).not.toContain('active:scale-95')
    }
  })

  // -- transition + icon sizing ----------------------------------------------

  // Tailwind v4 emits `active:scale-*` as the standalone `scale` property, which
  // `transform` does not transition, so the narrowed list must name it.
  it('transitions only paint properties plus the press scale, not `all`', () => {
    const btn = renderButton('default')
    expect(btn.className).not.toContain('transition-all')
    expect(btn.className).toContain(
      'transition-[color,background-color,border-color,box-shadow,opacity,transform,scale]',
    )
  })

  // The `xs` size keeps its own `size-3`; tailwind-merge must drop the base
  // `size-4` for them.
  it('sizes icons at size-4, and size-3 on the xs text button on a fine pointer', () => {
    const iconRule = '[:where(&)_svg]:size-'
    for (const size of ['default', 'icon-xs'] as const) {
      const btn = renderButton(size, `icons-${size}`)
      expect(btn.className).toContain(`${iconRule}4`)
      expect(btn.className).not.toContain(`${iconRule}3`)
    }
    const xs = renderButton('xs', 'icons-xs')
    expect(xs.className).toContain(`${iconRule}3`)
    // On a coarse pointer the xs button is the others' height, so its icon is too.
    expect(xs.className).toContain(`coarse:${iconRule}4`)
  })

  // -- palette icons (#5368) ---------------------------------------------------

  it('paints ghost and outline icons with text-icon', () => {
    for (const variant of ['ghost', 'outline'] as const) {
      render(
        <Button variant={variant}>
          <Plus data-testid={`${variant}-icon`} />
          {variant}
        </Button>,
      )
      const btn = screen.getByRole('button', { name: variant })
      expect(paletteIconsOf(btn)).toEqual([screen.getByTestId(`${variant}-icon`)])
    }
  })

  it('leaves filled and link variants on their own text color', () => {
    for (const variant of ['default', 'destructive', 'secondary', 'link'] as const) {
      render(
        <Button variant={variant}>
          <Plus />
          {variant}
        </Button>,
      )
      expect(paletteIconsOf(screen.getByRole('button', { name: variant }))).toEqual([])
    }
  })

  it('lets a text-* class on the icon win over text-icon', () => {
    render(
      <Button variant="ghost">
        <Plus data-testid="plain" />
        <Star className="text-star" />
        Both
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Both' })
    expect(paletteIconsOf(btn)).toEqual([screen.getByTestId('plain')])
  })

  it('lets a text-* class on the button reach its icons', () => {
    render(
      <Button variant="ghost" className="text-muted-foreground hover:text-destructive">
        <Plus />
        Delete
      </Button>,
    )
    expect(paletteIconsOf(screen.getByRole('button', { name: 'Delete' }))).toEqual([])
  })

  it('keeps the tint when the button sets only a text size or alignment', () => {
    render(
      <Button variant="outline" className="text-xs text-left">
        <Plus data-testid="sized-icon" />
        Add filter
      </Button>,
    )
    const btn = screen.getByRole('button', { name: 'Add filter' })
    expect(paletteIconsOf(btn)).toEqual([screen.getByTestId('sized-icon')])
  })

  it('has no a11y violations with a palette icon', async () => {
    const { container } = render(
      <Button variant="ghost">
        <Plus />
        Add
      </Button>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })

  // -- children (#1030) -------------------------------------------------------

  it('renders text children', () => {
    render(<Button>Save</Button>)
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('renders element/fragment children', () => {
    render(
      <Button>
        <span aria-hidden="true">+</span>
        <span>Add item</span>
      </Button>,
    )
    // The aria-hidden icon span is excluded from the accessible name.
    expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument()
  })

  it('accepts children typed as React.ReactNode (type-level)', () => {
    // `children` is explicit in the prop type, so any ReactNode is accepted.
    const node: React.ReactNode = <span>typed</span>
    render(<Button>{node}</Button>)
    expect(screen.getByRole('button', { name: 'typed' })).toBeInTheDocument()
  })

  // -- a11y -------------------------------------------------------------------

  it('has no a11y violations with default variant', async () => {
    const { container } = render(<Button>Accessible Button</Button>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with icon size variant', async () => {
    const { container } = render(
      <Button size="icon" aria-label="Icon action">
        <span aria-hidden="true">X</span>
      </Button>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  // #1680: destructive surface uses the semantic --destructive-foreground
  // token (per-theme) rather than a hardcoded text-white literal.
  it('destructive variant uses the destructive-foreground token, not text-white', () => {
    render(<Button variant="destructive">Delete</Button>)
    const btn = screen.getByRole('button', { name: 'Delete' })
    expect(btn.className).toContain('text-destructive-foreground')
    expect(btn.className).not.toContain('text-white')
  })

  it('has no a11y violations with destructive variant', async () => {
    const { container } = render(<Button variant="destructive">Delete</Button>)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
