/**
 * Tests for the AlertDialog component.
 *
 * Validates:
 *  - displayName is set on all exported components
 *  - ref forwarding for styled sub-components (Header, Footer)
 */

import { render } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '../alert-dialog'

// ---------------------------------------------------------------------------
// displayName
// ---------------------------------------------------------------------------

describe('AlertDialog displayName', () => {
  it.each([
    ['AlertDialog', AlertDialog],
    ['AlertDialogTrigger', AlertDialogTrigger],
    ['AlertDialogPortal', AlertDialogPortal],
    ['AlertDialogOverlay', AlertDialogOverlay],
    ['AlertDialogContent', AlertDialogContent],
    ['AlertDialogHeader', AlertDialogHeader],
    ['AlertDialogFooter', AlertDialogFooter],
    ['AlertDialogTitle', AlertDialogTitle],
    ['AlertDialogDescription', AlertDialogDescription],
    ['AlertDialogAction', AlertDialogAction],
    ['AlertDialogCancel', AlertDialogCancel],
  ])('%s has displayName', (name, Component) => {
    expect(Component.displayName).toBe(name)
  })
})

// ---------------------------------------------------------------------------
// ref forwarding — simple HTML sub-components
// ---------------------------------------------------------------------------

describe('AlertDialog ref forwarding', () => {
  it('AlertDialogHeader forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<AlertDialogHeader ref={ref}>Header</AlertDialogHeader>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('alert-dialog-header')
  })

  it('AlertDialogFooter forwards ref to div', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<AlertDialogFooter ref={ref}>Footer</AlertDialogFooter>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
    expect(ref.current?.getAttribute('data-slot')).toBe('alert-dialog-footer')
  })
})

// ---------------------------------------------------------------------------
// a11y
// ---------------------------------------------------------------------------

describe('AlertDialog a11y', () => {
  it('has no accessibility violations', async () => {
    const { baseElement } = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Are you sure?</AlertDialogTitle>
            <AlertDialogDescription>This action cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction>Continue</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>,
    )
    const results = await axe(baseElement, {
      rules: { region: { enabled: false } },
    })
    expect(results).toHaveNoViolations()
  })
})
