/**
 * #2656 — mock `set_property` value validation.
 *
 * Locks the tauri-mock's `set_property` handler to the real backend's op-log
 * validation (`op.rs::validate_property_value` + the select-membership check in
 * `block_ops.rs`). Before this, the mock stored an empty `value_text` silently,
 * so the `::` picker and the custom `/assignee` · `/location` · `/effort` slash
 * flows — which used to fire `setProperty({ valueText: '' })` — passed every
 * e2e/unit suite while failing on the shipped app. These tests pin the two
 * rules so that class of contract drift fails in the mock too:
 *   1. a `Some` `value_text` that trims to empty is rejected
 *      (`set_property.value_text.empty`);
 *   2. a select-typed key rejects any value outside its seeded options.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { isValidation } from '@/lib/app-error'
import { dispatch } from '@/lib/tauri-mock/handlers'
import { blocks, makeBlock, properties, propertyDefs, seedBlocks } from '@/lib/tauri-mock/seed'

const BLOCK = '0000000000000000000000000A'

function reset(): void {
  seedBlocks()
  blocks.set(BLOCK, makeBlock(BLOCK, 'block', 'a', null, 0))
}

/** Run a `set_property` dispatch and return the thrown value (or undefined). */
function setPropertyError(key: string, valueText: string): unknown {
  try {
    dispatch('set_property', { blockId: BLOCK, key, value: { value_text: valueText } })
  } catch (e) {
    return e
  }
  return undefined
}

describe('tauri-mock set_property validation (#2656)', () => {
  beforeEach(reset)

  it('rejects an empty value_text with set_property.value_text.empty', () => {
    const err = setPropertyError('assignee', '')
    expect(isValidation(err)).toBe(true)
    expect((err as Error).message).toContain('set_property.value_text.empty')
    // Nothing was stored.
    expect(properties.get(BLOCK)?.get('assignee')).toBeUndefined()
  })

  it('rejects a whitespace-only value_text (mirrors op.rs trim check)', () => {
    const err = setPropertyError('assignee', '   ')
    expect(isValidation(err)).toBe(true)
    expect((err as Error).message).toContain('set_property.value_text.empty')
  })

  it('accepts a non-empty value_text for a free-text key', () => {
    const res = dispatch('set_property', {
      blockId: BLOCK,
      key: 'assignee',
      value: { value_text: 'Ada' },
    })
    expect(res).not.toBeNull()
    expect(properties.get(BLOCK)?.get('assignee')?.['value_text']).toBe('Ada')
  })

  it('rejects a select value outside the definition options', () => {
    // `project` is seeded as a select with options alpha/beta/gamma.
    const err = setPropertyError('project', 'delta')
    expect(isValidation(err)).toBe(true)
    expect((err as Error).message).toContain('invalid_option')
    expect(properties.get(BLOCK)?.get('project')).toBeUndefined()
  })

  it('accepts a select value that IS one of the definition options', () => {
    const res = dispatch('set_property', {
      blockId: BLOCK,
      key: 'project',
      value: { value_text: 'alpha' },
    })
    expect(res).not.toBeNull()
    expect(properties.get(BLOCK)?.get('project')?.['value_text']).toBe('alpha')
  })

  it('accepts any value for a select definition with NULL options (no restriction)', () => {
    // The real backend (`block_ops.rs`) skips the membership check when the
    // options column is NULL, keeping custom select keys flexible. The mock
    // must not be stricter, or it is a false gate.
    propertyDefs.set('stage', { key: 'stage', value_type: 'select', options: null })
    const res = dispatch('set_property', {
      blockId: BLOCK,
      key: 'stage',
      value: { value_text: 'anything-goes' },
    })
    expect(res).not.toBeNull()
    expect(properties.get(BLOCK)?.get('stage')?.['value_text']).toBe('anything-goes')
  })
})
