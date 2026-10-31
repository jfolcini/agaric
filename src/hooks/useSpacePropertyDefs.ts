/**
 * useSpacePropertyDefs — the active space's property definitions by key, the
 * built-ins' included (#6206), read once per space and shared by every mark on
 * a value that doesn't fit its key. Read again on `invalidatePropertyCaches()`,
 * which every definition write and every write that reached the backend
 * without a page store calls. Unread, or failed to read, it answers
 * `undefined`, and no value is marked.
 */

import { skipToken, useQuery } from '@tanstack/react-query'

import type { PropertyDefinition } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { propertyDefsQueryKey } from '@/lib/property-caches'
import { queryClient } from '@/lib/query-client'
import { listAllPropertyDefs } from '@/stores/inline-property-commit'
import { useSpaceStore } from '@/stores/space'

async function loadDefs(spaceId: string): Promise<PropertyDefinition[]> {
  try {
    return await listAllPropertyDefs(spaceId)
  } catch (err) {
    logger.warn('useSpacePropertyDefs', 'failed to load property definitions', { spaceId }, err)
    throw err
  }
}

function byKey(defs: PropertyDefinition[]): ReadonlyMap<string, PropertyDefinition> {
  return new Map(defs.map((def) => [def.key, def]))
}

export function useSpacePropertyDefs(): ReadonlyMap<string, PropertyDefinition> | undefined {
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const { data } = useQuery(
    {
      queryKey: propertyDefsQueryKey(spaceId),
      queryFn: spaceId === null ? skipToken : () => loadDefs(spaceId),
      select: byKey,
    },
    queryClient,
  )
  return data
}
