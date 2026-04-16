/**
 * Tests for the Toaster (sonner) component.
 *
 * Validates:
 *  - displayName is set
 *  - Ref forwarding
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import { Toaster } from '../sonner'

describe('Toaster', () => {
  it('has displayName', () => {
    expect(Toaster.displayName).toBe('Toaster')
  })

  it('renders without errors', () => {
    const { container } = render(<Toaster />)
    // Sonner renders a section or list element as the toaster root
    expect(container).toBeTruthy()
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLElement>()
    render(<Toaster ref={ref} />)
    expect(ref.current).toBeInstanceOf(HTMLElement)
  })

  it('has no accessibility violations', async () => {
    const { container } = render(<Toaster />)
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
