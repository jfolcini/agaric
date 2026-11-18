/**
 * `invalidateDerivedCaches` drops every derived cache (#6049), and
 * `invalidateDomains` the ones a change domain names (#6545). Each cache is
 * read back here; the callers' own tests assert they go through these
 * functions, so a cache added to them reaches sync, MCP, import and undo at once.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { invalidateDerivedCaches, invalidateDomains } from '@/hooks/derived-caches'
import { getAttachmentInvalidationKey } from '@/lib/attachment-invalidation'
import type { ChangeDomain } from '@/lib/bindings'
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

const PROPERTY_CACHES = [
  'the property key list',
  'the property value list',
  "the open page's properties",
] as const

const DOMAINS: Array<[ChangeDomain, readonly string[]]> = [
  ['structure', ['the graph-structure counter', 'the Pages list', "the journal's day-to-page map"]],
  ['properties', ['the block-property counter', ...PROPERTY_CACHES, 'the Pages list']],
  ['property_defs', PROPERTY_CACHES],
  ['names', ['the page and tag name caches', 'the Pages list', "the journal's day-to-page map"]],
  ['attachments', ['the attachment lists', 'the Pages list']],
]

describe('invalidateDomains', () => {
  it.each(DOMAINS)('%s drops exactly its caches', (domain, expected) => {
    const probes = CACHES.map(([name, probe]) => [name, probe()] as const)

    invalidateDomains([domain])
    vi.advanceTimersByTime(PROPERTY_DEBOUNCE_MS + 1)

    const dropped = probes.filter(([, check]) => check()).map(([name]) => name)
    expect(dropped.toSorted()).toEqual([...expected].toSorted())
  })

  it('drops every cache for an absent domain list', () => {
    const probes = CACHES.map(([name, probe]) => [name, probe()] as const)

    invalidateDomains(null)
    vi.advanceTimersByTime(PROPERTY_DEBOUNCE_MS + 1)

    expect(probes.filter(([, check]) => !check()).map(([name]) => name)).toEqual([])
  })
})
