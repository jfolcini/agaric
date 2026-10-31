import { invalidatePropertyKeysCache } from '@/lib/property-keys-cache'
import { invalidatePropertyValuesCache } from '@/lib/property-values-cache'
import { queryClient } from '@/lib/query-client'

export const PAGE_PROPERTIES_QUERY_ROOT = 'pageProperties' as const

export function pagePropertiesQueryKey(
  pageId: string,
): readonly [typeof PAGE_PROPERTIES_QUERY_ROOT, string] {
  return [PAGE_PROPERTIES_QUERY_ROOT, pageId]
}

export const PROPERTY_DEFS_QUERY_ROOT = 'propertyDefs' as const

export function propertyDefsQueryKey(
  spaceId: string | null,
): readonly [typeof PROPERTY_DEFS_QUERY_ROOT, string | null] {
  return [PROPERTY_DEFS_QUERY_ROOT, spaceId]
}

export function invalidatePageProperties(): void {
  void queryClient.invalidateQueries({ queryKey: [PAGE_PROPERTIES_QUERY_ROOT] })
}

/**
 * Mark the property key and value lists, the open page's own properties and
 * the space's definitions stale after a write that can change
 * `block_properties` without a `block:properties-changed` event (sync, MCP,
 * import, page source, undo and History revert, #5296) or a definition (#6206).
 */
export function invalidatePropertyCaches(): void {
  invalidatePropertyKeysCache()
  invalidatePropertyValuesCache()
  invalidatePageProperties()
  void queryClient.invalidateQueries({ queryKey: [PROPERTY_DEFS_QUERY_ROOT] })
}
