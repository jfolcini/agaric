import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { axe } from '@/__tests__/helpers/axe'
import { SectionCount } from '@/components/ui/section-count'

describe('SectionCount', () => {
  it('reads its label, then its number in the muted count tone', () => {
    render(
      <h2>
        <SectionCount label="Completed" count={2} />
      </h2>,
    )
    const heading = screen.getByRole('heading', { name: 'Completed 2' })
    const count = screen.getByText('2')
    expect(count).toHaveAttribute('data-variant', 'metadata')
    expect(heading.lastElementChild).toBe(count)
  })

  it('takes the header’s type size, not the badge’s own', () => {
    render(<SectionCount label="Due" count={1} />)
    const count = screen.getByText('1')
    expect(count).toHaveClass('text-[length:inherit]')
    expect(count).not.toHaveClass('text-xs')
  })

  it('has no a11y violations', async () => {
    const { container } = render(
      <h2>
        <SectionCount label="Overdue" count={0} />
      </h2>,
    )
    expect(await axe(container)).toHaveNoViolations()
  })
})
