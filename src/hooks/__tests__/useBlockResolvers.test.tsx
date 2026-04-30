/**
 * Tests for useBlockResolvers / BlockResolversProvider.
 *
 * Validates:
 *  - Returns `null` outside a provider (so consumers can fall back to props)
 *  - Provider publishes the resolver bag to descendants
 *  - Multiple consumers see the same identity
 */

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  type BlockResolvers,
  BlockResolversProvider,
  useBlockResolvers,
} from '../useBlockResolvers'

function Probe({ onResult }: { onResult: (resolvers: BlockResolvers | null) => void }) {
  const resolvers = useBlockResolvers()
  onResult(resolvers)
  return null
}

describe('useBlockResolvers', () => {
  it('returns null outside a provider', () => {
    const observed: Array<BlockResolvers | null> = []
    render(<Probe onResult={(r) => observed.push(r)} />)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toBeNull()
  })

  it('publishes the provided resolver bag to descendants', () => {
    const value: BlockResolvers = {
      resolveBlockTitle: (id: string) => `title:${id}`,
      resolveTagName: (id: string) => `tag:${id}`,
      resolveBlockStatus: (id: string) => (id === 'BLK_DEAD' ? 'deleted' : 'active'),
      resolveTagStatus: () => 'deleted' as const,
    }

    const observed: Array<BlockResolvers | null> = []
    render(
      <BlockResolversProvider value={value}>
        <Probe onResult={(r) => observed.push(r)} />
      </BlockResolversProvider>,
    )

    expect(observed).toHaveLength(1)
    const captured = observed[0]
    expect(captured?.resolveBlockTitle('BLK001')).toBe('title:BLK001')
    expect(captured?.resolveTagName('TAG_X')).toBe('tag:TAG_X')
    expect(captured?.resolveBlockStatus('BLK_DEAD')).toBe('deleted')
    expect(captured?.resolveBlockStatus('BLK001')).toBe('active')
    expect(captured?.resolveTagStatus('TAG_X')).toBe('deleted')
  })

  it('multiple consumers see the same published reference', () => {
    const value: BlockResolvers = {
      resolveBlockTitle: () => 't',
      resolveTagName: () => 'n',
      resolveBlockStatus: () => 'active' as const,
      resolveTagStatus: () => 'active' as const,
    }
    const observed: Array<BlockResolvers | null> = []

    render(
      <BlockResolversProvider value={value}>
        <Probe onResult={(r) => observed.push(r)} />
        <Probe onResult={(r) => observed.push(r)} />
      </BlockResolversProvider>,
    )

    expect(observed).toHaveLength(2)
    expect(observed[0]).toBe(observed[1])
    expect(observed[0]?.resolveBlockTitle).toBe(value.resolveBlockTitle)
  })
})
