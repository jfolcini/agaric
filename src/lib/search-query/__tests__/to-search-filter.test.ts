/**
 * PEND-54 + PEND-53 — Tests for `astToFilterProjection`.
 *
 * Guards the AST → IPC contract every search surface depends on:
 * given a parsed query, what does the wire-side `SearchFilter` look
 * like? The projection is order-preserving for ordered fields and
 * dedups tags / states / priorities the same way the SQL composition
 * does.
 */

import { describe, expect, it } from 'vitest'
import { parse } from '../classify'
import { astToFilterProjection } from '../to-search-filter'

function project(s: string) {
  return astToFilterProjection(parse(s))
}

describe('astToFilterProjection — PEND-54 (tag / path)', () => {
  it('projects an empty AST to empty arrays', () => {
    const p = project('')
    expect(p.tagNames).toEqual([])
    expect(p.includePageGlobs).toEqual([])
    expect(p.excludePageGlobs).toEqual([])
  })

  it('dedups tag names', () => {
    const p = project('tag:#a tag:#a tag:#b')
    expect(p.tagNames).toEqual(['a', 'b'])
  })

  it('splits comma-separated path globs', () => {
    const p = project('path:Journal/*,Notes/*')
    expect(p.includePageGlobs).toEqual(['Journal/*', 'Notes/*'])
  })
})

describe('astToFilterProjection — PEND-53 (metadata)', () => {
  it('projects state tokens into stateFilter', () => {
    const p = project('state:TODO state:DOING')
    expect(p.stateFilter).toEqual(['TODO', 'DOING'])
  })

  it('dedups state values', () => {
    const p = project('state:TODO state:TODO')
    expect(p.stateFilter).toEqual(['TODO'])
  })

  it('projects not-state tokens into excludedStateFilter (PEND-63)', () => {
    const p = project('not-state:DONE state:TODO')
    // `state:TODO` still populates stateFilter; `not-state:DONE` is a
    // separate field the backend uses to emit the NULL-inclusive
    // `(todo_state IS NULL OR todo_state NOT IN (...))` inversion.
    expect(p.stateFilter).toEqual(['TODO'])
    expect(p.excludedStateFilter).toEqual(['DONE'])
  })

  it('dedups excluded state values (PEND-63)', () => {
    const p = project('not-state:DONE not-state:DONE not-state:CANCELLED')
    expect(p.excludedStateFilter).toEqual(['DONE', 'CANCELLED'])
  })

  it('projects not-priority into excludedPriorityFilter (PEND-63)', () => {
    const p = project('not-priority:1 priority:2')
    expect(p.priorityFilter).toEqual(['2'])
    expect(p.excludedPriorityFilter).toEqual(['1'])
  })

  it('projects priority tokens into priorityFilter', () => {
    const p = project('priority:1 priority:none')
    expect(p.priorityFilter).toEqual(['1', 'none'])
  })

  it('projects due: named bucket', () => {
    const p = project('due:today')
    expect(p.dueFilter).toEqual({ kind: 'named', name: 'today' })
  })

  it('projects due: comparison form', () => {
    const p = project('due:>=2026-01-01')
    expect(p.dueFilter).toEqual({ kind: 'op', op: '>=', date: '2026-01-01' })
  })

  it('projects scheduled: separately from due:', () => {
    const p = project('due:today scheduled:>=2026-01-01')
    expect(p.dueFilter).toEqual({ kind: 'named', name: 'today' })
    expect(p.scheduledFilter).toEqual({
      kind: 'op',
      op: '>=',
      date: '2026-01-01',
    })
  })

  it('last due: token wins when two are present', () => {
    const p = project('due:today due:this-week')
    expect(p.dueFilter).toEqual({ kind: 'named', name: 'this-week' })
  })

  it('projects prop: tokens into propertyFilters (AND fan-out)', () => {
    const p = project('prop:status=done prop:assignee=me')
    expect(p.propertyFilters).toEqual([
      { key: 'status', value: 'done' },
      { key: 'assignee', value: 'me' },
    ])
  })

  it('projects not-prop: tokens into excludedPropertyFilters', () => {
    const p = project('not-prop:archived=true')
    expect(p.excludedPropertyFilters).toEqual([{ key: 'archived', value: 'true' }])
  })

  it('prop:key= projects as empty value (key-presence-only)', () => {
    const p = project('prop:status=')
    expect(p.propertyFilters).toEqual([{ key: 'status', value: '' }])
  })

  it('drops invalid tokens from every projection field', () => {
    const p = project('due:tomorrowish state:TODO prop:status')
    // Only `state:TODO` survives — the other two are invalid.
    expect(p.stateFilter).toEqual(['TODO'])
    expect(p.dueFilter).toBeNull()
    expect(p.propertyFilters).toEqual([])
  })

  it('compound query — every metadata field populated', () => {
    const p = project(
      'state:TODO state:DOING priority:1 not-state:DONE not-priority:3 due:this-week scheduled:>=2026-05-01 prop:status=blocked not-prop:archived=true hello',
    )
    expect(p.stateFilter).toEqual(['TODO', 'DOING'])
    expect(p.priorityFilter).toEqual(['1'])
    expect(p.excludedStateFilter).toEqual(['DONE'])
    expect(p.excludedPriorityFilter).toEqual(['3'])
    expect(p.dueFilter).toEqual({ kind: 'named', name: 'this-week' })
    expect(p.scheduledFilter).toEqual({
      kind: 'op',
      op: '>=',
      date: '2026-05-01',
    })
    expect(p.propertyFilters).toEqual([{ key: 'status', value: 'blocked' }])
    expect(p.excludedPropertyFilters).toEqual([{ key: 'archived', value: 'true' }])
  })
})
