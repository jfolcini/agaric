/**
 * Shared helpers + types for PropertyRowEditor decomposition.
 *
 * Pure functions and shared types that the orchestrator, typed editors, and
 * the containing hook depend on. Kept lib-style (no React imports) so the
 * unit-test surface is just data → data.
 */

import { logger } from '@/lib/logger'

import type { PropertyDefinition, PropertyRow } from '../../lib/tauri'

/**
 * Extract the canonical string value for the current property, picking the
 * first non-null typed slot. Lifted out of the component body so the main
 * function stays under oxlint's eslint/complexity budget.
 */
export function readCurrentValue(prop: PropertyRow): string {
  if (prop.value_ref != null) return prop.value_ref
  if (prop.value_text != null) return prop.value_text
  if (prop.value_num != null) return String(prop.value_num)
  if (prop.value_date != null) return prop.value_date
  return ''
}

/**
 * Parse the JSON-encoded `options` field from a select-type property def.
 * Returns an empty array on missing / malformed JSON / non-array payloads.
 */
export function parseSelectOptions(def: PropertyDefinition | undefined): string[] {
  if (def?.value_type !== 'select' || !def.options) return []
  try {
    const parsed = JSON.parse(def.options)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    logger.warn(
      'PropertyRowEditor',
      'failed to parse select options JSON',
      { key: def.key, options: def.options },
      err,
    )
    return []
  }
}
