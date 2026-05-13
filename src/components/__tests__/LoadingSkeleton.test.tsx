import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { LoadingSkeleton } from '../LoadingSkeleton'

describe('LoadingSkeleton', () => {
  it('renders default count of 3 skeletons', () => {
    const { container } = render(<LoadingSkeleton />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons).toHaveLength(3)
  })

  it('renders custom count', () => {
    const { container } = render(<LoadingSkeleton count={5} />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons).toHaveLength(5)
  })

  it('renders count of 1', () => {
    const { container } = render(<LoadingSkeleton count={1} />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons).toHaveLength(1)
  })

  it('applies default h-4 height class', () => {
    const { container } = render(<LoadingSkeleton />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons).toHaveLength(3)
    for (const s of skeletons) {
      expect(s.className).toContain('h-4')
      expect(s.className).toContain('w-full')
      expect(s.className).toContain('rounded-lg')
    }
  })

  it('applies custom height class', () => {
    const { container } = render(<LoadingSkeleton height="h-8" />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    for (const s of skeletons) {
      expect(s.className).toContain('h-8')
      expect(s.className).not.toContain('h-4')
    }
  })

  // PEND-23 L4 — variant prop maps to sensible default heights.
  it.each([
    ['text', 'h-4'],
    ['heading', 'h-6'],
    ['button', 'h-9'],
    ['list-row', 'h-11'],
  ] as const)('PEND-23 L4: variant=%s applies %s', (variant, expectedHeight) => {
    const { container } = render(<LoadingSkeleton variant={variant} />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    expect(skeletons.length).toBeGreaterThan(0)
    for (const s of skeletons) {
      expect(s.className).toContain(expectedHeight)
    }
  })

  it('PEND-23 L4: explicit height prop overrides variant', () => {
    const { container } = render(<LoadingSkeleton variant="list-row" height="h-2" />)
    const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
    for (const s of skeletons) {
      expect(s.className).toContain('h-2')
      expect(s.className).not.toContain('h-11')
    }
  })

  it('wrapper has space-y-2 class', () => {
    const { container } = render(<LoadingSkeleton />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('space-y-2')
  })

  it('forwards className to wrapper div', () => {
    const { container } = render(<LoadingSkeleton className="my-custom-class" />)
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.className).toContain('space-y-2')
    expect(wrapper.className).toContain('my-custom-class')
  })

  it('forwards extra HTML attributes to wrapper', () => {
    const { container } = render(
      <LoadingSkeleton data-testid="test-skeleton" aria-busy="true" role="status" />,
    )
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.getAttribute('data-testid')).toBe('test-skeleton')
    expect(wrapper.getAttribute('aria-busy')).toBe('true')
    expect(wrapper.getAttribute('role')).toBe('status')
  })

  // PEND-? — the `loading` prop (default `true`) opts the primitive into
  // an a11y-compliant wrapper so callers no longer have to wrap it in
  // their own `<div aria-busy="true">`.
  describe('loading prop (a11y wrapper)', () => {
    it('defaults to loading=true and wraps in role="status" + aria-busy="true"', () => {
      const { container } = render(<LoadingSkeleton />)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.getAttribute('aria-busy')).toBe('true')
      expect(wrapper.getAttribute('role')).toBe('status')
      expect(wrapper.getAttribute('aria-label')).toBe('Loading')
    })

    it('uses the provided ariaLabel when loading=true', () => {
      const { container } = render(<LoadingSkeleton ariaLabel="Loading pages" />)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.getAttribute('aria-label')).toBe('Loading pages')
    })

    it('omits the a11y wrapper attributes when loading=false', () => {
      const { container } = render(<LoadingSkeleton loading={false} />)
      const wrapper = container.firstElementChild as HTMLElement
      expect(wrapper.getAttribute('aria-busy')).toBeNull()
      expect(wrapper.getAttribute('role')).toBeNull()
      expect(wrapper.getAttribute('aria-label')).toBeNull()
    })

    it('still renders the skeleton rows when loading=false', () => {
      const { container } = render(<LoadingSkeleton loading={false} count={4} />)
      const skeletons = container.querySelectorAll('[data-slot="skeleton"]')
      expect(skeletons).toHaveLength(4)
    })

    it('lets explicit aria attributes override the loading defaults', () => {
      const { container } = render(<LoadingSkeleton aria-label="Custom" role="alert" />)
      const wrapper = container.firstElementChild as HTMLElement
      // Explicit caller props win over the loading-default wrapper attrs.
      expect(wrapper.getAttribute('aria-label')).toBe('Custom')
      expect(wrapper.getAttribute('role')).toBe('alert')
    })
  })

  it('has no a11y violations', async () => {
    const { container } = render(<LoadingSkeleton />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with custom props', async () => {
    const { container } = render(<LoadingSkeleton count={2} height="h-10" className="custom" />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations when loading=false', async () => {
    const { container } = render(<LoadingSkeleton loading={false} />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
