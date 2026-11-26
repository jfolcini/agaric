import { describe, expect, it } from 'vitest'

import { cn } from '@/lib/utils'

describe('cn', () => {
  it('keeps a block text size beside a colour', () => {
    expect(cn('font-semibold text-block-sm', 'text-alert-info-foreground')).toBe(
      'font-semibold text-block-sm text-alert-info-foreground',
    )
    expect(cn('text-block-chip', 'text-muted-foreground')).toBe(
      'text-block-chip text-muted-foreground',
    )
  })

  it('lets a block text size replace another font size', () => {
    expect(cn('px-2 py-0.5 text-xs', 'text-block-chip')).toBe('px-2 py-0.5 text-block-chip')
  })
})
