/**
 * The one reset for every cache derived from block data, for a write that
 * reached the backend without going through a page store: a sync or MCP write
 * (`reloadChangedPageStores`), an import (`useImportRunner`), an undo or redo
 * (`refreshAfterUndoRedo`), a rebuild of the caches themselves
 * (`useReconciliationReport`). No event names what such a write touched, so all
 * of them are dropped; a cache added later goes here, and every caller gets it.
 * The change feed's event for local commits names its domains, and drops only
 * their caches (`invalidateDomains`).
 *
 * Not here: the page stores and the resolve store, which each caller reloads
 * for the pages it can name (a tree reads its rows' properties again on each
 * load of its store), and the space list, which only a peer changes.
 */

import { invalidatePageBrowserData } from '@/hooks/usePageBrowserData'
import { recordAttachmentInvalidation } from '@/lib/attachment-invalidation'
import type { ChangeDomain } from '@/lib/bindings'
import { recordBlockPropertyChange } from '@/lib/block-property-events'
import { invalidateCalendarPageDates } from '@/lib/calendar-page-dates-cache'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { invalidatePropertyCaches } from '@/lib/property-caches'

/**
 * The caches each change domain can stale (#6545), for the change feed's
 * `blocks:changed`, which names the domains of the local commits it covers.
 * The Pages list is in every domain an op can carry: a row shows its page's
 * own task fields and the time of the newest op on any block of the page.
 */
const DOMAIN_INVALIDATIONS: Record<ChangeDomain, ReadonlyArray<() => void>> = {
  // Links: the Graph, the references panels and query blocks. Pages: the Pages
  // list, and the journal's day-to-page map.
  structure: [recordGraphStructureChange, invalidatePageBrowserData, invalidateCalendarPageDates],
  // Task state and dates: the agenda, Due, Done and Unfinished panels, search;
  // and the property key and value lists, and the open page's own properties.
  properties: [recordBlockPropertyChange, invalidatePropertyCaches, invalidatePageBrowserData],
  // The space's definitions, which `invalidatePropertyCaches` also drops.
  property_defs: [invalidatePropertyCaches],
  // Page and tag names: the `[[` and `#` pickers, tag views, and the bookmark
  // list (`src/lib/starred-pages.ts`); a title is also a journal date.
  names: [invalidateNameCaches, invalidatePageBrowserData, invalidateCalendarPageDates],
  // Attachment lists and badges, which re-read only on this signal.
  attachments: [recordAttachmentInvalidation, invalidatePageBrowserData],
}

const ALL_DOMAINS = Object.keys(DOMAIN_INVALIDATIONS) as ChangeDomain[]

/** Drop the caches `domains` can have staled; `null` or absent means every domain. */
export function invalidateDomains(domains?: readonly ChangeDomain[] | null): void {
  const invalidations = new Set((domains ?? ALL_DOMAINS).flatMap((d) => DOMAIN_INVALIDATIONS[d]))
  for (const invalidate of invalidations) invalidate()
}

export function invalidateDerivedCaches(): void {
  invalidateDomains(null)
}
