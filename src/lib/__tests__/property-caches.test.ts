import { describe, expect, it } from 'vitest'

import { invalidatePropertyCaches } from '@/lib/property-caches'
import { propertyKeysQueryKey } from '@/lib/property-keys-cache'
import { propertyValuesQueryKey } from '@/lib/property-values-cache'
import { queryClient } from '@/lib/query-client'

describe('invalidatePropertyCaches', () => {
  it('marks both the key list and every value list stale (#5296)', () => {
    queryClient.setQueryData(propertyKeysQueryKey('SPACE_A'), ['status'])
    queryClient.setQueryData(propertyValuesQueryKey('status'), ['active'])

    invalidatePropertyCaches()

    expect(queryClient.getQueryState(propertyKeysQueryKey('SPACE_A'))?.isInvalidated).toBe(true)
    expect(queryClient.getQueryState(propertyValuesQueryKey('status'))?.isInvalidated).toBe(true)
  })
})
