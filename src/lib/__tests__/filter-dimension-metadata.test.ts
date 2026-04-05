import { afterEach, describe, expect, it } from 'vitest'
import type { AgendaFilterDimension } from '../filter-dimension-metadata'
import {
  ALL_DIMENSIONS,
  DIMENSION_OPTIONS,
  dimensionLabel,
  getTaskStates,
} from '../filter-dimension-metadata'

describe('filter-dimension-metadata', () => {
  // -----------------------------------------------------------------------
  // getTaskStates
  // -----------------------------------------------------------------------
  describe('getTaskStates', () => {
    afterEach(() => {
      localStorage.removeItem('task_cycle')
    })

    it('returns default states when localStorage is empty', () => {
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE'])
    })

    it('reads custom states from localStorage, filtering out nulls', () => {
      localStorage.setItem(
        'task_cycle',
        JSON.stringify([null, 'TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED']),
      )
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE', 'WAITING', 'CANCELLED'])
    })

    it('falls back to defaults on invalid JSON', () => {
      localStorage.setItem('task_cycle', 'not-json')
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE'])
    })

    it('falls back to defaults when stored value is not an array', () => {
      localStorage.setItem('task_cycle', JSON.stringify('TODO'))
      expect(getTaskStates()).toEqual(['TODO', 'DOING', 'DONE'])
    })

    it('filters out empty strings', () => {
      localStorage.setItem('task_cycle', JSON.stringify(['TODO', '', 'DONE']))
      expect(getTaskStates()).toEqual(['TODO', 'DONE'])
    })

    it('filters out non-string values', () => {
      localStorage.setItem('task_cycle', JSON.stringify([42, 'TODO', true, 'DONE']))
      expect(getTaskStates()).toEqual(['TODO', 'DONE'])
    })
  })

  // -----------------------------------------------------------------------
  // DIMENSION_OPTIONS
  // -----------------------------------------------------------------------
  describe('DIMENSION_OPTIONS', () => {
    it('contains entries for all 8 dimensions', () => {
      const keys = Object.keys(DIMENSION_OPTIONS)
      expect(keys).toHaveLength(8)
      expect(keys).toContain('status')
      expect(keys).toContain('priority')
      expect(keys).toContain('dueDate')
      expect(keys).toContain('scheduledDate')
      expect(keys).toContain('completedDate')
      expect(keys).toContain('createdDate')
      expect(keys).toContain('tag')
      expect(keys).toContain('property')
    })

    it('status choices is a function returning task states', () => {
      const meta = DIMENSION_OPTIONS.status
      expect(typeof meta.choices).toBe('function')
      const choices = (meta.choices as () => string[])()
      expect(choices).toEqual(['TODO', 'DOING', 'DONE'])
    })

    it('priority choices are fixed strings', () => {
      expect(DIMENSION_OPTIONS.priority.choices).toEqual(['1', '2', '3'])
    })

    it('dueDate has 7 choices including Overdue and Next N days', () => {
      const choices = DIMENSION_OPTIONS.dueDate.choices as string[]
      expect(choices).toContain('Today')
      expect(choices).toContain('This week')
      expect(choices).toContain('Overdue')
      expect(choices).toContain('Next 7 days')
      expect(choices).toContain('Next 14 days')
      expect(choices).toContain('Next 30 days')
      expect(choices).toHaveLength(7)
    })

    it('completedDate has past-oriented choices without Overdue', () => {
      const choices = DIMENSION_OPTIONS.completedDate.choices as string[]
      expect(choices).toContain('Last 7 days')
      expect(choices).toContain('Last 30 days')
      expect(choices).not.toContain('Overdue')
      expect(choices).not.toContain('Next 7 days')
    })

    it('tag has null choices (free-text)', () => {
      expect(DIMENSION_OPTIONS.tag.choices).toBeNull()
    })

    it('property has null choices (dynamic picker)', () => {
      expect(DIMENSION_OPTIONS.property.choices).toBeNull()
    })

    it('each dimension has a labelKey', () => {
      for (const dim of ALL_DIMENSIONS) {
        expect(DIMENSION_OPTIONS[dim].labelKey).toBeTruthy()
        expect(typeof DIMENSION_OPTIONS[dim].labelKey).toBe('string')
      }
    })
  })

  // -----------------------------------------------------------------------
  // ALL_DIMENSIONS
  // -----------------------------------------------------------------------
  describe('ALL_DIMENSIONS', () => {
    it('lists all 8 dimensions in order', () => {
      expect(ALL_DIMENSIONS).toEqual([
        'status',
        'priority',
        'dueDate',
        'scheduledDate',
        'completedDate',
        'createdDate',
        'tag',
        'property',
      ])
    })

    it('matches the keys of DIMENSION_OPTIONS', () => {
      const optionKeys = Object.keys(DIMENSION_OPTIONS).sort()
      const allDimsSorted = [...ALL_DIMENSIONS].sort()
      expect(allDimsSorted).toEqual(optionKeys)
    })
  })

  // -----------------------------------------------------------------------
  // dimensionLabel
  // -----------------------------------------------------------------------
  describe('dimensionLabel', () => {
    it('returns a translated label for status', () => {
      expect(dimensionLabel('status')).toBe('Status')
    })

    it('returns a translated label for priority', () => {
      expect(dimensionLabel('priority')).toBe('Priority')
    })

    it('returns a translated label for dueDate', () => {
      expect(dimensionLabel('dueDate')).toBe('Due date')
    })

    it('returns a translated label for tag', () => {
      expect(dimensionLabel('tag')).toBe('Tag')
    })

    it('returns a translated label for property', () => {
      expect(dimensionLabel('property')).toBe('Property')
    })

    it('returns translated labels for all dimensions', () => {
      for (const dim of ALL_DIMENSIONS) {
        const label = dimensionLabel(dim)
        expect(typeof label).toBe('string')
        expect(label.length).toBeGreaterThan(0)
      }
    })
  })

  // -----------------------------------------------------------------------
  // AgendaFilterDimension type (compile-time check via runtime assertion)
  // -----------------------------------------------------------------------
  describe('AgendaFilterDimension type', () => {
    it('all ALL_DIMENSIONS entries satisfy the type', () => {
      const dims: AgendaFilterDimension[] = ALL_DIMENSIONS
      expect(dims).toHaveLength(8)
    })
  })
})
