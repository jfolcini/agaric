/**
 * Tests for the Card family of components.
 *
 * Validates:
 *  - Each sub-component renders correctly
 *  - Ref forwarding for all sub-components
 *  - a11y compliance via axe audit
 */

import { render, screen } from '@testing-library/react'
import * as React from 'react'
import { describe, expect, it } from 'vitest'
import { axe } from 'vitest-axe'

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../card'

describe('Card', () => {
  it('renders with data-slot="card"', () => {
    render(<Card data-testid="card">Content</Card>)
    const el = screen.getByTestId('card')
    expect(el).toBeInTheDocument()
    expect(el).toHaveAttribute('data-slot', 'card')
  })

  // #1010: radius-by-prominence — in-flow cards sit at the lg tier, below
  // the modal xl tier (dialog/alert-dialog/sheet) so a card never reads
  // rounder than the modal floating above it.
  it('uses the in-flow card radius tier (rounded-lg)', () => {
    render(<Card data-testid="card">Content</Card>)
    const el = screen.getByTestId('card')
    expect(el).toHaveClass('rounded-lg')
    expect(el).not.toHaveClass('rounded-xl')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<Card ref={ref}>Content</Card>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardHeader', () => {
  it('renders with data-slot="card-header"', () => {
    render(<CardHeader data-testid="header">Header</CardHeader>)
    const el = screen.getByTestId('header')
    expect(el).toHaveAttribute('data-slot', 'card-header')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<CardHeader ref={ref}>Header</CardHeader>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardTitle', () => {
  it('renders with data-slot="card-title"', () => {
    render(<CardTitle data-testid="title">Title</CardTitle>)
    const el = screen.getByTestId('title')
    expect(el).toHaveAttribute('data-slot', 'card-title')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<CardTitle ref={ref}>Title</CardTitle>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })

  // #1011: CardTitle codifies the de-facto convention as the primitive
  // default — text-base (a smaller sibling of the text-lg modal titles),
  // leading-none, font-semibold, tracking-tight — so call sites no longer
  // re-state `text-base`.
  it('applies the default title recipe (text-base, no override needed)', () => {
    render(<CardTitle data-testid="title">Title</CardTitle>)
    const el = screen.getByTestId('title')
    expect(el).toHaveClass('text-base', 'leading-none', 'font-semibold', 'tracking-tight')
  })
})

describe('CardDescription', () => {
  it('renders with data-slot="card-description"', () => {
    render(<CardDescription data-testid="desc">Desc</CardDescription>)
    const el = screen.getByTestId('desc')
    expect(el).toHaveAttribute('data-slot', 'card-description')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<CardDescription ref={ref}>Desc</CardDescription>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardAction', () => {
  it('renders with data-slot="card-action"', () => {
    render(<CardAction data-testid="action">Action</CardAction>)
    const el = screen.getByTestId('action')
    expect(el).toHaveAttribute('data-slot', 'card-action')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<CardAction ref={ref}>Action</CardAction>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardContent', () => {
  it('renders with data-slot="card-content"', () => {
    render(<CardContent data-testid="content">Body</CardContent>)
    const el = screen.getByTestId('content')
    expect(el).toHaveAttribute('data-slot', 'card-content')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<CardContent ref={ref}>Body</CardContent>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('CardFooter', () => {
  it('renders with data-slot="card-footer"', () => {
    render(<CardFooter data-testid="footer">Footer</CardFooter>)
    const el = screen.getByTestId('footer')
    expect(el).toHaveAttribute('data-slot', 'card-footer')
  })

  it('forwards ref', () => {
    const ref = React.createRef<HTMLDivElement>()
    render(<CardFooter ref={ref}>Footer</CardFooter>)
    expect(ref.current).toBeInstanceOf(HTMLDivElement)
  })
})

describe('Card a11y', () => {
  it('has no a11y violations with full card composition', async () => {
    const { container } = render(
      <Card>
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Description</CardDescription>
          <CardAction>Action</CardAction>
        </CardHeader>
        <CardContent>Body content</CardContent>
        <CardFooter>Footer content</CardFooter>
      </Card>,
    )
    const results = await axe(container)
    expect(results).toHaveNoViolations()
  })
})
