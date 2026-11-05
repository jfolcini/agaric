import { describe, expect, it } from 'vitest'

import { propertySortFields } from '@/lib/backlink-sort'
import type { PropertyDefinition } from '@/lib/bindings'

function def(key: string, value_type: string, builtin: boolean): PropertyDefinition {
  return { key, value_type, options: null, created_at: '2026-01-01T00:00:00Z', builtin }
}

describe('propertySortFields', () => {
  it('offers a user-set built-in (meeting_date, #5364) and a user key, not an app-managed built-in', () => {
    const fields = propertySortFields([
      def('meeting_date', 'date', true),
      def('repeat-until', 'date', true),
      def('deadline', 'date', false),
    ])
    expect(fields.map((field) => field.key)).toEqual(['meeting_date', 'deadline'])
  })
})
