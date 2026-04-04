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

  it('has no a11y violations', async () => {
    const { container } = render(<LoadingSkeleton />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })

  it('has no a11y violations with custom props', async () => {
    const { container } = render(
      <LoadingSkeleton count={2} height="h-10" className="custom" />,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
