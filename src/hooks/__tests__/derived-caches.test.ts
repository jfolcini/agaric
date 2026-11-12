/**
 * `invalidateDerivedCaches` drops every derived cache (#6049). Each cache is
 * read back here; the callers' own tests assert they go through this function,
 * so a cache added to it reaches sync, MCP, import and undo at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateDerivedCaches } from '@/hooks/derived-caches'
import { getAttachmentInvalidationKey } from '@/lib/attachment-invalidation'
import {
  DEBOUNCE_MS as PROPERTY_DEBOUNCE_MS,
  getBlockPropertyInvalidationKey,
} from '@/lib/block-property-events'
import { getCalendarPageDatesEpoch } from '@/lib/calendar-page-dates-cache'
import { getRecordedGraphStructureChanges } from '@/lib/graph-structure-events'
import { type NameChange, subscribeToNameChanges } from '@/lib/name-change-bus'
import { pagePropertiesQueryKey } from '@/lib/property-caches'
import { propertyKeysQueryKey } from '@/lib/property-keys-cache'
import { propertyValuesQueryKey } from '@/lib/property-values-cache'
import { queryClient } from '@/lib/query-client'

const cleanups: Array<() => void> = []

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.useRealTimers()
})

/** Arms a probe on one cache; the returned check says whether it was dropped since. */
type Probe = () => () => boolean

function counter(read: () => number): Probe {
  return () => {
    const before = read()
    return () => read() === before + 1
  }
}

function query(key: readonly unknown[]): Probe {
  return () => {
    queryClient.setQueryData(key, ['cached'])
    return () => queryClient.getQueryState(key)?.isInvalidated === true
  }
}

const nameCaches: Probe = () => {
  const changes: NameChange[] = []
  cleanups.push(subscribeToNameChanges((change) => changes.push(change)))
  return () => changes.length === 1 && changes[0]?.kind === 'invalidated'
}

const CACHES: Array<[string, Probe]> = [
  ['the graph-structure counter', counter(getRecordedGraphStructureChanges)],
  ['the block-property counter', counter(getBlockPropertyInvalidationKey)],
  ['the property key list', query(propertyKeysQueryKey('SPACE'))],
  ['the property value list', query(propertyValuesQueryKey('status'))],
  ["the open page's properties", query(pagePropertiesQueryKey('PAGE'))],
  ['the page and tag name caches', nameCaches],
  ['the attachment lists', counter(getAttachmentInvalidationKey)],
  ['the Pages list', query(['pageBrowserData', 'SPACE', 'default', []])],
  ["the journal's day-to-page map", counter(getCalendarPageDatesEpoch)],
]

describe('invalidateDerivedCaches', () => {
  it.each(CACHES)('drops %s', (_name, probe) => {
    const dropped = probe()

    invalidateDerivedCaches()
    vi.advanceTimersByTime(PROPERTY_DEBOUNCE_MS + 1)

    expect(dropped()).toBe(true)
  })
})
