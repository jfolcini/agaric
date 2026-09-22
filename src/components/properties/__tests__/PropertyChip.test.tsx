import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { axe } from 'vitest-axe'

import { PropertyChip } from '@/components/properties/PropertyChip'
import { openUrl } from '@/lib/open-url'

vi.mock('@/lib/open-url', () => ({ openUrl: vi.fn().mockResolvedValue(true) }))
const mockedOpenUrl = vi.mocked(openUrl)

describe('PropertyChip', () => {
  it('renders key and value text', () => {
    render(<PropertyChip propKey="effort" value="2h" />)

    expect(screen.getByText('Effort:')).toBeInTheDocument()
    expect(screen.getByText('2h')).toBeInTheDocument()
  })

  it('applies custom className', () => {
    const { container } = render(
      <PropertyChip propKey="assignee" value="Alice" className="custom-class" />,
    )

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('custom-class')
  })

  it('has property-chip class on the root element', () => {
    const { container } = render(<PropertyChip propKey="location" value="Office" />)

    const chip = container.querySelector('.property-chip')
    expect(chip).toBeInTheDocument()
  })

  it('uses bg-muted and text-muted-foreground default styling', () => {
    const { container } = render(<PropertyChip propKey="effort" value="1h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('bg-muted')
    expect(chip?.className).toContain('text-muted-foreground')
  })

  // #1678: the wrapper composes the shared Badge primitive's pill chrome via
  // badgeVariants() (rounded-full shape + base flex layout) so it stays in the
  // pill family, while keeping the chip-specific muted tone and tighter padding.
  it('composes the shared Badge pill chrome (rounded-full + base layout)', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    const chip = container.querySelector('.property-chip')
    // Pill shape comes from the Badge `shape="pill"` recipe.
    expect(chip?.className).toContain('rounded-full')
    // Base flex layout from the Badge primitive.
    expect(chip?.className).toContain('inline-flex')
    expect(chip?.className).toContain('items-center')
    expect(chip?.className).toContain('font-medium')
    expect(chip?.className).toContain('text-xs')
  })

  // #1678: PropertyChip overrides the Badge default padding/gap with its own
  // tighter tokens (twMerge resolves the conflict so only the override remains).
  it('keeps the chip-specific tighter padding and gap', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).toContain('px-1.5')
    expect(chip?.className).toContain('gap-0.5')
    // The Badge default `px-2`/`gap-1` must not survive the twMerge override.
    expect(chip?.className).not.toMatch(/(^|\s)px-2(\s|$)/)
    expect(chip?.className).not.toMatch(/(^|\s)gap-1(\s|$)/)
  })

  it('does not have mt-1 (alignment handled by parent container pt-1)', () => {
    const { container } = render(<PropertyChip propKey="effort" value="1h" />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.className).not.toContain('mt-1')
  })

  it('key label has opacity-60 class', () => {
    render(<PropertyChip propKey="repeat" value="weekly" />)

    const keySpan = screen.getByText('Repeat:')
    expect(keySpan.className).toContain('opacity-60')
  })

  it('has no a11y violations (default, non-interactive)', async () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('has no a11y violations (both zones interactive)', async () => {
    const { container } = render(
      <PropertyChip propKey="effort" value="2h" onClick={() => {}} onKeyClick={() => {}} />,
    )

    await waitFor(async () => {
      const results = await axe(container)
      expect(results).toHaveNoViolations()
    })
  })

  it('root is a non-button <div role="group">', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" onClick={() => {}} />)

    const chip = container.querySelector('.property-chip')
    expect(chip?.tagName.toLowerCase()).toBe('div')
    expect(chip).toHaveAttribute('role', 'group')
  })

  it('renders the value as a button when onClick is provided', () => {
    render(<PropertyChip propKey="effort" value="2h" onClick={() => {}} />)

    const valueButton = screen.getByRole('button', { name: 'Effort: 2h' })
    expect(valueButton.tagName.toLowerCase()).toBe('button')
    expect(valueButton.textContent).toBe('2h')
  })

  it('renders the value as a static span when onClick is not provided', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    // No value-zone button exists without onClick
    expect(screen.queryByRole('button', { name: 'Effort: 2h' })).not.toBeInTheDocument()
    const valueSpan = container.querySelector('.property-chip-value')
    expect(valueSpan?.tagName.toLowerCase()).toBe('span')
    expect(valueSpan?.textContent).toBe('2h')
  })

  it('renders no nested <button> elements', () => {
    const { container } = render(
      <PropertyChip propKey="effort" value="2h" onClick={() => {}} onKeyClick={() => {}} />,
    )

    for (const button of container.querySelectorAll('button')) {
      expect(button.querySelector('button')).toBeNull()
    }
  })

  it('calls onClick when the value zone is clicked', async () => {
    const user = userEvent.setup()
    const handleClick = vi.fn()

    render(<PropertyChip propKey="effort" value="2h" onClick={handleClick} />)

    const valueButton = screen.getByRole('button', { name: 'Effort: 2h' })
    await user.click(valueButton)

    expect(handleClick).toHaveBeenCalledOnce()
  })

  // #1498: the chip lives outside the contenteditable. With the block's editor
  // focused, an un-prevented mousedown on either inner button blurs the editor
  // first (flush → re-mount) and swallows the click. preventDefault on mousedown
  // keeps the editor focused so the edit flow opens and the caret stays put.
  describe('focus retention (#1498)', () => {
    function fireMouseDownAndAssertPrevented(el: HTMLElement) {
      const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      const prevented = vi.spyOn(ev, 'preventDefault')
      el.dispatchEvent(ev)
      expect(prevented).toHaveBeenCalled()
    }

    it('value button: prevents default on mousedown and still fires onClick', async () => {
      const user = userEvent.setup()
      const handleClick = vi.fn()
      render(<PropertyChip propKey="effort" value="2h" onClick={handleClick} />)
      const valueButton = screen.getByRole('button', { name: 'Effort: 2h' })
      fireMouseDownAndAssertPrevented(valueButton)
      await user.click(valueButton)
      expect(handleClick).toHaveBeenCalledOnce()
    })

    it('key button: prevents default on mousedown and still fires onKeyClick', async () => {
      const user = userEvent.setup()
      const handleKeyClick = vi.fn()
      render(<PropertyChip propKey="effort" value="2h" onKeyClick={handleKeyClick} />)
      const keyButton = screen.getByRole('button', { name: /Edit property/ })
      fireMouseDownAndAssertPrevented(keyButton)
      await user.click(keyButton)
      expect(handleKeyClick).toHaveBeenCalledOnce()
    })
  })

  it('adds hover styles on the wrapper only when onClick is provided', () => {
    const { container: withClick } = render(
      <PropertyChip propKey="effort" value="2h" onClick={() => {}} />,
    )
    const { container: withoutClick } = render(<PropertyChip propKey="effort" value="2h" />)

    const chipWithClick = withClick.querySelector('.property-chip')
    const chipWithoutClick = withoutClick.querySelector('.property-chip')

    expect(chipWithClick?.className).toContain('hover:bg-accent/50')
    expect(chipWithClick?.className).toContain('active:bg-accent/70')
    expect(chipWithoutClick?.className).not.toContain('hover:bg-accent/50')
    expect(chipWithoutClick?.className).not.toContain('active:bg-accent/70')
  })

  it('fires only onKeyClick when the key label is clicked (event isolation)', async () => {
    const user = userEvent.setup()
    const handleKeyClick = vi.fn()
    const handleClick = vi.fn()

    render(
      <PropertyChip
        propKey="effort"
        value="2h"
        onClick={handleClick}
        onKeyClick={handleKeyClick}
      />,
    )

    const keyButton = screen.getByRole('button', { name: /Edit property/ })
    await user.click(keyButton)

    expect(handleKeyClick).toHaveBeenCalledOnce()
    // Sibling buttons inside a non-interactive wrapper — no bubble to value handler.
    expect(handleClick).not.toHaveBeenCalled()
  })

  it('fires only onClick when the value zone is clicked (event isolation)', async () => {
    const user = userEvent.setup()
    const handleKeyClick = vi.fn()
    const handleClick = vi.fn()

    render(
      <PropertyChip
        propKey="effort"
        value="2h"
        onClick={handleClick}
        onKeyClick={handleKeyClick}
      />,
    )

    const valueButton = screen.getByRole('button', { name: 'Effort: 2h' })
    await user.click(valueButton)

    expect(handleClick).toHaveBeenCalledOnce()
    expect(handleKeyClick).not.toHaveBeenCalled()
  })

  it('key label has hover:underline class when onKeyClick is provided', () => {
    render(<PropertyChip propKey="effort" value="2h" onKeyClick={() => {}} />)

    const keyLabel = screen.getByText('Effort:')
    expect(keyLabel.className).toContain('hover:underline')
    expect(keyLabel.className).toContain('cursor-pointer')
  })

  it('key label does not have hover:underline class when onKeyClick is not provided', () => {
    render(<PropertyChip propKey="effort" value="2h" />)

    const keyLabel = screen.getByText('Effort:')
    expect(keyLabel.className).not.toContain('hover:underline')
  })

  it('renders built-in property with formatted name and icon', () => {
    const { container } = render(<PropertyChip propKey="due_date" value="2025-01-01" />)

    expect(screen.getByText('Due Date:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.querySelector('svg')).toBeInTheDocument()
  })

  it('renders custom property with formatted name and no icon', () => {
    const { container } = render(<PropertyChip propKey="my_prop" value="hello" />)

    expect(screen.getByText('My Prop:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.querySelector('svg')).toBeNull()
  })

  it('renders formatted name and icon for clickable built-in key', () => {
    const { container } = render(
      <PropertyChip propKey="due_date" value="2025-01-01" onKeyClick={() => {}} />,
    )

    expect(screen.getByText('Due Date:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.tagName.toLowerCase()).toBe('button')
    expect(keyLabel?.querySelector('svg')).toBeInTheDocument()
  })

  it('renders formatted name without icon for clickable custom key', () => {
    const { container } = render(
      <PropertyChip propKey="my_prop" value="hello" onKeyClick={() => {}} />,
    )

    expect(screen.getByText('My Prop:')).toBeInTheDocument()
    const keyLabel = container.querySelector('.property-key-label')
    expect(keyLabel?.tagName.toLowerCase()).toBe('button')
    expect(keyLabel?.querySelector('svg')).toBeNull()
  })

  it('wrapper always has aria-label summarising the chip (B-19)', () => {
    // Non-interactive chip — the group label still describes the key/value
    // pair for assistive tech that walks groupings.
    const { container: nonInteractive } = render(<PropertyChip propKey="effort" value="2h" />)
    const chipNonInteractive = nonInteractive.querySelector('.property-chip')
    expect(chipNonInteractive).toHaveAttribute('aria-label', 'Effort: 2h')

    // Interactive chip — same grouping label.
    const { container: interactive } = render(
      <PropertyChip propKey="effort" value="2h" onClick={() => {}} />,
    )
    const chipInteractive = interactive.querySelector('.property-chip')
    expect(chipInteractive).toHaveAttribute('aria-label', 'Effort: 2h')
  })

  it('wrapper shows a focus ring when either inner button has focus', () => {
    const { container } = render(<PropertyChip propKey="effort" value="2h" />)

    const chip = container.querySelector('.property-chip')
    // Wrapper carries the focus-within ring so tabbing into either sibling
    // button lights up the whole pill — no double rings on individual buttons.
    expect(chip?.className).toContain('focus-within:ring-[3px]')
    expect(chip?.className).toContain('focus-within:ring-ring/50')
  })

  // Each inner button now also paints the standard focus-visible ring
  // alongside `focus-visible:outline-hidden`, so keyboard users see a clear
  // indicator on whichever zone is focused. The wrapper still carries a
  // focus-within ring; the per-button ring sits inside it (not a true
  // double ring because the wrapper one is `focus-within`, the inner one
  // is `focus-visible` — they target different states).
  it('inner buttons paint the standard focus-visible ring', () => {
    render(<PropertyChip propKey="effort" value="2h" onClick={() => {}} onKeyClick={() => {}} />)

    const keyButton = screen.getByRole('button', { name: /Edit property/ })
    const valueButton = screen.getByRole('button', { name: 'Effort: 2h' })
    expect(keyButton.className).toContain('focus-ring-visible')
    expect(valueButton.className).toContain('focus-ring-visible')
  })

  // #4710 — a property value that parses as http/https/mailto gets a trailing
  // open-link control. The decision is made on the VALUE: chips carry no
  // property definition, so the declared `url` type is not visible here.
  describe('open-link control', () => {
    beforeEach(() => {
      mockedOpenUrl.mockClear()
    })

    it('opens the url and leaves the value editor closed', async () => {
      const user = userEvent.setup()
      const onClick = vi.fn()
      render(<PropertyChip propKey="homepage" value="https://example.com" onClick={onClick} />)

      await user.click(screen.getByRole('button', { name: 'Open https://example.com' }))

      expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com')
      expect(onClick).not.toHaveBeenCalled()
    })

    it('keeps the value zone itself as the edit trigger', async () => {
      const user = userEvent.setup()
      const onClick = vi.fn()
      render(<PropertyChip propKey="homepage" value="https://example.com" onClick={onClick} />)

      await user.click(screen.getByRole('button', { name: 'Homepage: https://example.com' }))

      expect(onClick).toHaveBeenCalledTimes(1)
      expect(mockedOpenUrl).not.toHaveBeenCalled()
    })

    it('opens the url from the keyboard', async () => {
      const user = userEvent.setup()
      render(<PropertyChip propKey="homepage" value="https://example.com" />)

      const control = screen.getByRole('button', { name: 'Open https://example.com' })
      control.focus()
      await user.keyboard('{Enter}')

      expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com')
    })

    it('does not let the open-link click reach the surrounding row', async () => {
      const user = userEvent.setup()
      const onRowClick = vi.fn()
      render(
        // oxlint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- stand-in for the block row's click surface; the assertion is about propagation, not this wrapper's own a11y
        <div onClick={onRowClick}>
          <PropertyChip propKey="homepage" value="https://example.com" />
        </div>,
      )

      await user.click(screen.getByRole('button', { name: 'Open https://example.com' }))

      expect(mockedOpenUrl).toHaveBeenCalledWith('https://example.com')
      expect(onRowClick).not.toHaveBeenCalled()
    })

    it.each([['notaurl'], ['javascript:alert(1)'], ['example.com']])(
      'renders no open-link control for %s',
      (value) => {
        render(<PropertyChip propKey="homepage" value={value} onClick={vi.fn()} />)

        expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument()
        expect(screen.getByText(value)).toBeInTheDocument()
      },
    )

    it('has no a11y violations rendering the open-link control', async () => {
      const { container } = render(
        <PropertyChip propKey="homepage" value="https://example.com" onClick={vi.fn()} />,
      )

      await waitFor(async () => {
        expect(await axe(container)).toHaveNoViolations()
      })
    })
  })
})
