/**
 * The one reset for every cache derived from block data, for a write that
 * reached the backend without going through a page store: a sync or MCP write
 * (`reloadChangedPageStores`), an import (`useImportRunner`), an undo or redo
 * (`refreshAfterUndoRedo`). No event names what such a write touched, so all
 * of them are dropped; a cache added later goes here, and every caller gets it.
 *
 * Not here: the page stores and the resolve store, which each caller reloads
 * for the pages it can name, and the space list, which only a peer changes.
 */

import { invalidatePageBrowserData } from '@/hooks/usePageBrowserData'
import { recordAttachmentInvalidation } from '@/lib/attachment-invalidation'
import { recordBlockPropertyChange } from '@/lib/block-property-events'
import { invalidateCalendarPageDates } from '@/lib/calendar-page-dates-cache'
import { recordGraphStructureChange } from '@/lib/graph-structure-events'
import { invalidateNameCaches } from '@/lib/name-change-bus'
import { invalidatePropertyCaches } from '@/lib/property-caches'

export function invalidateDerivedCaches(): void {
  // Links: the Graph, the references panels and query blocks.
  recordGraphStructureChange()
  // Task state and dates: the agenda, Due, Done and Unfinished panels, search.
  recordBlockPropertyChange()
  // Property key and value lists, and the open page's own properties.
  invalidatePropertyCaches()
  // Page and tag names: the `[[` and `#` pickers, tag views.
  invalidateNameCaches()
  // Attachment lists and badges, which re-read only on this signal.
  recordAttachmentInvalidation()
  // The Pages list, and the journal's day-to-page map.
  invalidatePageBrowserData()
  invalidateCalendarPageDates()
}
