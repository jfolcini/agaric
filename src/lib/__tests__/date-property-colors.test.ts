import { describe, expect, it } from 'vitest'
import { getSourceColor, getSourceLabel } from '../date-property-colors'

describe('getSourceColor', () => {
  it('returns date-due token for column:due_date', () => {
    const color = getSourceColor('column:due_date')
    expect(color.light).toContain('date-due')
    expect(color.label).toBe('Due')
  })

  it('returns date-scheduled token for column:scheduled_date', () => {
    const color = getSourceColor('column:scheduled_date')
    expect(color.light).toContain('date-scheduled')
    expect(color.label).toBe('Scheduled')
  })

  it('returns date-property token for property:* sources', () => {
    const color = getSourceColor('property:deadline')
    expect(color.light).toContain('date-property')
  })

  it('returns muted token for unknown sources', () => {
    const color = getSourceColor('something:unknown')
    expect(color.light).toContain('muted')
  })
})

describe('getSourceLabel', () => {
  it('returns "Due" for column:due_date', () => {
    expect(getSourceLabel('column:due_date')).toBe('Due')
  })

  it('returns "Scheduled" for column:scheduled_date', () => {
    expect(getSourceLabel('column:scheduled_date')).toBe('Scheduled')
  })

  it('extracts and title-cases property names', () => {
    expect(getSourceLabel('property:created_at')).toBe('Created at')
    expect(getSourceLabel('property:deadline')).toBe('Deadline')
  })
})
