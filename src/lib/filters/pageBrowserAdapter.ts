/**
 * PageBrowser ⇄ canonical filter adapter — Issue #1646, surface 2.
 *
 * The Pages browser's Add-Filter popover builds `FilterPrimitive` leaves (its
 * UI and gestures are unchanged). This module is the single seam through which
 * those leaves are projected onto the canonical `FilterPredicate` model and
 * back, so the Pages surface "projects from one source of truth" like the
 * already-migrated graph + search surfaces — WITHOUT changing the emitted wire
 * shape.
 *
 * The contract that makes the migration safe: for every category the popover
 * can build, the round-trip
 * `filterPrimitiveToCanonical` → `canonicalToFilterPrimitive` is LOSSLESS, so
 * `projectPageFilterThroughCanonical(p)` is deep-equal to `p`. The emitted
 * backend filter is therefore byte-identical to the pre-migration direct-emit
 * path (proven by `__tests__/pageBrowserAdapter.test.ts`).
 *
 * The only leaf the Pages popover builds that has no flat canonical category
 * yet is the recursive `HasParentMatching` (a nested `FilterExpr`); the
 * compound `And`/`Or`/`Not` layer is deliberately deferred to a later PR (see
 * `docs/filters/CANONICAL-MODEL-MIGRATION.md`). For any such leaf
 * `filterPrimitiveToCanonical` returns `null`, and this adapter passes the
 * original `FilterPrimitive` through UNCHANGED so no deferred category is
 * mis-mapped or dropped.
 */

import type { FilterPrimitive } from '@/lib/bindings'

import { canonicalToFilterPrimitive, filterPrimitiveToCanonical } from './model'

/**
 * Project a Pages `FilterPrimitive` through the canonical model and back.
 *
 * Returns the canonical projection when the leaf is representable in the
 * canonical model (which is byte-identical to the input for every Pages
 * category); otherwise returns the input unchanged (the deferred recursive /
 * windowed leaves that have no flat canonical category yet).
 */
export function projectPageFilterThroughCanonical(filter: FilterPrimitive): FilterPrimitive {
  const canonical = filterPrimitiveToCanonical(filter)
  if (canonical === null) return filter
  // The canonical predicate is guaranteed by construction to round-trip back to
  // a Pages wire leaf (every Pages-built category is in the inverse's domain),
  // but guard against `null` so a future canonical-only kind can never silently
  // erase a chip — fall back to the original leaf.
  return canonicalToFilterPrimitive(canonical) ?? filter
}
