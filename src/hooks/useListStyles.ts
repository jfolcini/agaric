/**
 * useListStyles — derives the per-block {@link ListStyle} map (#3000) from the
 * shared `BatchPropertiesProvider` (see `useBatchPropertyRows`).
 *
 * Like {@link useExtraBlockProperties}, this is a pure PROJECTION of the single
 * page-wide `getBatchProperties` batch the provider already fetches — it fires
 * no IPC of its own and MUST be called inside a `BatchPropertiesProvider`.
 * Outside one it returns an empty map. It inherits the provider's invalidation:
 * the map refreshes on every `block:properties-changed` event and on space
 * switch, so toggling a block's list style updates the markers.
 *
 * Only `bullet` / `ordered` blocks appear in the map; a `none` block (no
 * `listStyle` property row) is absent — consumers treat "absent" as `'none'`.
 *
 * Identity invariant: the returned map keeps its reference when the projected
 * styles are unchanged, so a no-op refetch (or a drag/reorder that does not
 * refetch) does not bust downstream `React.memo` short-circuits.
 *
 * The reuse cache (`prevRef`) is written during render, not in an effect —
 * see the comment at the write site for the content-equality argument that
 * makes this safe (#4012, issuecomment-5416944047).
 */

import { useMemo, useRef } from 'react'

import { useBatchPropertyRows } from '@/hooks/useBatchPropertyRows'
import { listStyleFromRows } from '@/lib/list-style'
import type { ListStyle } from '@/lib/list-style'

/** True iff two id→style maps have identical entries. */
function mapsEqual(a: Map<string, ListStyle>, b: Map<string, ListStyle>): boolean {
  if (a === b) return true
  if (a.size !== b.size) return false
  for (const [id, style] of a) {
    if (b.get(id) !== style) return false
  }
  return true
}

export function useListStyles(blocks: ReadonlyArray<{ id: string }>): Map<string, ListStyle> {
  const batch = useBatchPropertyRows()
  const get = batch?.get

  const { idSignature, ids } = useMemo(() => {
    const blockIds = blocks.map((b) => b.id)
    return { idSignature: blockIds.join('\0'), ids: blockIds }
  }, [blocks])

  const prevRef = useRef<Map<string, ListStyle>>(new Map())

  return useMemo(() => {
    const next = new Map<string, ListStyle>()
    for (const id of ids) {
      const rows = get?.(id)
      if (rows == null) continue
      const style = listStyleFromRows(rows)
      if (style !== 'none') next.set(id, style)
    }
    // #4012 (maintainer follow-up, issuecomment-5416944047) — this is "the
    // same pattern, one hop upstream" of BlockListRenderer.tsx's
    // `listMarkerValue`, whose render-time ref write #4067 moved into a
    // `useLayoutEffect`. This site is DELIBERATELY left writing
    // `prevRef.current` here, during render, because the argument that makes
    // it safe is stronger than "it works today":
    //
    //   `next` is a PURE function of this call's `(ids, get)` — no randomness,
    //   no reads outside those two closed-over values. `mapsEqual` then
    //   compares `prevRef.current` against `next` by FULL CONTENT (every key
    //   in one is checked against the other; see above), not by which render
    //   produced either side. So whatever ends up cached can only ever be a
    //   Map whose content is a valid `listStyleFromRows` projection of SOME
    //   `(ids, get)` pair this hook was actually asked to compute — a
    //   concurrent render React discards never commits its effects, but its
    //   `next` is not thereby "wrong data", only an allocation nobody
    //   observed; caching its reference cannot make a later read see content
    //   that doesn't match that later read's OWN freshly recomputed `next`,
    //   because that later read redoes the full comparison against its own
    //   current `(ids, get)` before ever reusing `prev`. A stale reuse would
    //   require `mapsEqual` to return true for maps that actually differ,
    //   which it cannot (it checks size and every entry). Unlike
    //   `listMarkerValue` (which bundles two maps plus a closure `value`
    //   behind a REFERENCE check on one field), the thing cached here IS the
    //   thing compared — there is no proxy field whose equality could
    //   diverge from the cached payload's own.
    //
    // Moving the write to a `useLayoutEffect` (mirroring #4067) would trade
    // this for a regression: between mount and the first effect flush the
    // ref would read as empty, so a drag/reorder or no-op refetch landing in
    // that window would mint a fresh Map where this code already has one to
    // reuse — directly defeating the identity invariant this hook exists to
    // provide (see the docblock above), which `BlockListRenderer.tsx`'s own
    // `listMarkerValue` gate depends on via `prev.listStyles === listStyles`.
    // That would compound one extra-render regression on top of another for
    // a purity benefit this hook doesn't get for free either way: oxlint's
    // `react/refs` (error, #4406) DOES flag this exact read/write pair on
    // its own merits (confirmed directly — same shape as the two suppressed
    // sites in `use-block-zoom.ts`, another plain `.ts` build-and-compare-
    // within-one-`useMemo` cache). `npx oxlint src/hooks/useListStyles.ts`
    // nonetheless reports zero findings on THIS file as it stands, but that
    // is not evidence the rule considers this site exempt: it is an artifact
    // of the `react-hooks/exhaustive-deps` suppression a few lines down —
    // removing that one line alone (leaving everything else untouched) makes
    // the `react/refs` findings on the read and write above reappear, and
    // conversely adding this site's own `react/refs` disable directives back
    // in gets THEM flagged unused by
    // `--report-unused-disable-directives-severity=error` (the flag `npm run
    // lint` and the prek `oxlint` hook both run), i.e. the exhaustive-deps
    // directive is already eating the diagnostic first. So: do not cite this
    // file's lint output as corroboration, in either direction — the
    // safety argument rests entirely on `mapsEqual`'s content-equality
    // check above, not on the linter's silence.
    const prev = prevRef.current
    const result = mapsEqual(prev, next) ? prev : next
    prevRef.current = result
    return result
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `ids` is recomputed in the same memo as `idSignature` (the listed dep), so it changes iff the signature changes; `get` re-derives when the shared batch refetches. Mirrors useExtraBlockProperties.
  }, [idSignature, get])
}
