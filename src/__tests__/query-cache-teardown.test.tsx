/**
 * A test that ends with a query still mounted must not leave that query cached
 * for the next test: the next test with the same key would render the leftover
 * page instead of its own fetch (#6352). Unmounting flushes the tree's pending
 * passive effects, and TanStack's observer effect rebuilds the query it is
 * subscribed to, so the shared `afterEach` in `src/test-setup.ts` clears the
 * read-path cache after `cleanup()`, not before.
 *
 * The `afterAll` below runs after every `afterEach` and reads what is left.
 */

import { useQuery } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterAll, expect, it } from 'vitest'

import { queryClient } from '@/lib/query-client'

let bump: () => void = () => {}

function Leftover(): React.ReactElement {
  const [renders, setRenders] = useState(0)
  useEffect(() => {
    bump = () => setRenders((n) => n + 1)
  }, [])
  const { data } = useQuery({ queryKey: ['teardown'], queryFn: async () => 'loaded' }, queryClient)
  return <span data-renders={renders}>{data ?? 'pending'}</span>
}

afterAll(() => {
  expect(queryClient.getQueryCache().getAll()).toEqual([])
})

it('leaves no cached query behind once the test ends', async () => {
  render(<Leftover />)
  expect(await screen.findByText('loaded')).toBeInTheDocument()
  // An update outside `act`, as TanStack's batched notify delivers a late IPC
  // result: one task commits it and the test ends before its passive effects run.
  bump()
  await new Promise((resolve) => setTimeout(resolve, 0))
})
