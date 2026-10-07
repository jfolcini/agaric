import { invalidatePropertyKeysCache } from '@/lib/property-keys-cache'
import { invalidatePropertyValuesCache } from '@/lib/property-values-cache'

/**
 * Mark the property key and value lists stale after a write that can change
 * `block_properties` without a `block:properties-changed` event: sync, MCP,
 * import, page source, undo and History revert (#5296).
 */
export function invalidatePropertyCaches(): void {
  invalidatePropertyKeysCache()
  invalidatePropertyValuesCache()
}
