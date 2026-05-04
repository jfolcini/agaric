# PEND-27 — Frontend perf review (2026-05-04): JS / TS findings

## TL;DR

Multi-pass performance review of the frontend (`src/`, ~75 K LOC across 442 TS/TSX files), focused exclusively on JS/TS perf. **Pass 1**: five parallel investigation subagents partitioned the codebase by area (components / editor / stores+hooks / lib+IPC / ui-primitives+workers+entry). **Pass 2**: two parallel skeptical-validator subagents re-opened every finding against the actual code, framework source (`@tiptap/react/dist/index.js`, `@tiptap/core/dist/index.js`), and call sites; my own pass-3 manual spot-check then caught two validator hallucinations (notably the sidebar-deps "HIGH" call, where the missing items are guaranteed-stable `useState` setters).

Of ~50 raw findings, this file logs the **8 that survived all three passes as ≥ LOW severity**. The first review pass had a ~50% false-positive rate; the most common failure modes were:

- **Framework hallucinations**: claims about TipTap re-initialising plugins, regex literals being recompiled per `.replace()`, and React `useState` setters being unstable — all wrong, all caught by reading the upstream source.
- **Severity inflation on small-N loops**: "O(N×M)" / "linear search" claims where realistic N ≤ 30 and the operation runs once per event.
- **Inert "missing memoization" claims**: inline arrow functions / unmemoized context values flagged as defeating downstream `memo()` — when the consuming component isn't `memo`-wrapped and never was.

`NIT` (technically true, no measurable impact) and `NON-ISSUE` (false alarm) are tracked in [§ Out of scope](#out-of-scope) below, not as numbered items.

**Scope vs PEND-20 / PEND-25:** this plan is the *frontend / JS-TS* companion to PEND-20's SQL-level findings and PEND-25's Rust allocation/lock/async findings. The three are independent and don't conflict — pick from any.

> **These are findings, not commitments.** Each item is independently approve-able. The highest-leverage win is **P1** (date-range IPC fan-out); everything else is mechanical cleanup.

## Methodology

For each surviving finding the validator subagent (and my pass-3 spot-check) did the following:

1. Re-opened the file at the cited lines with ≥ 30 lines of context.
2. Grepped call sites to estimate realistic call frequency (per-keystroke / per-render / per-event / cold).
3. Checked for `biome-ignore`, `PERF-…`, `MAINT-…`, `FEAT-…` comments that document deliberate choices.
4. Cross-checked framework claims against `node_modules/@tiptap/{react,core}/dist/*.js` and React semantics (e.g. `useState` setter stability).
5. Stated the realistic value of N for any complexity claim.
6. Marked the finding `VALID`, `OVERSTATED`, `INVALID`, or `DOWNGRADED`.

Severity floor for inclusion in this file:

- **MEDIUM**: real perf concern with measurable user-visible impact on a real path.
- **LOW**: real but small impact, or larger impact on a cold path; mechanical fixes welcome, no urgency.

## Summary

| ID  | Severity | Category    | Location                                                                        | Cost     | Risk | Confidence |
|-----|----------|-------------|---------------------------------------------------------------------------------|----------|------|------------|
| P1  | MEDIUM   | ipc         | `src/lib/agenda-filters.ts:251–264` (`queryPropertyDateDimension` per-day await)| S (2–4h) | low  | high       |
| P2  | MEDIUM   | algorithm   | `src/lib/fold-for-search.ts:113–118` (`indexOfFolded` O(n²) prefix-fold)        | S (1–2h) | low  | high       |
| P3  | LOW      | algorithm   | `src/lib/agenda-filters.ts:430–438` (set intersection via spread+filter)        | trivial  | low  | high       |
| P4  | LOW      | closure     | `src/hooks/useDuePanelData.ts:309–348` (mutable state in `fetchBlocks` deps)    | S (1h)   | low  | high       |
| P5  | LOW      | algorithm   | `src/components/LinkedReferences.tsx:95–106` (`.find()` per merged group)       | trivial  | low  | high       |
| P6  | LOW      | leak        | `src/components/AgendaResults.tsx:156` (`propertiesCacheRef` never cleared)     | trivial  | low  | high       |
| P7  | LOW      | rendering   | `src/editor/suggestion-renderer.ts:223–243` (`updatePosition` per keystroke)    | S (1h)   | low  | medium     |
| P8  | LOW      | algorithm   | `src/lib/page-tree.ts:23–26` (`.find()` per segment in tree build)              | trivial  | low  | high       |

---

## MEDIUM

### P1 — `queryPropertyDateDimension` issues one IPC per day in the date range, sequentially

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/lib/agenda-filters.ts" lines="236-264" />

**Evidence:**

```ts
async function queryPropertyDateDimension(
  values: string[],
  propertyKey: string,
  today: Date,
  spaceId: string,
): Promise<Map<string, BlockRow>> {
  const result = new Map<string, BlockRow>()
  for (const value of values) {
    const preset = toPastDatePreset(value)
    if (!preset) continue
    const range = getDateRangeForFilter(preset, today)
    if (!range) continue
    const start = new Date(`${range.start}T00:00:00`)
    const end = new Date(`${range.end}T00:00:00`)
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = formatDate(d)
      const resp = await queryByProperty({
        key: propertyKey,
        valueDate: dateStr,
        limit: AGENDA_QUERY_LIMIT,
        spaceId,
      })
      for (const b of resp.items) {
        result.set(b.id, b)
      }
    }
  }
  return result
}
```

**Hot path:** invoked from agenda filtering whenever a "completed-date" or "created-date" range filter is applied (`Last 7 days` / `Last 30 days` / `Last month` etc.). User-visible latency on every filter apply.

**Realistic N:** 7 / 14 / 30 / 90 days × number of selected presets × number of filter values. Each iteration is a Tauri JSON-encoded round-trip into Rust (typically 1–10 ms each in dev, more on Android). A `Last 30 days` filter alone serializes 30 IPC round-trips one-by-one before any results render.

**Why this is the biggest win:** sequential `await` inside the day loop. Trivially parallelisable today; properly fixable as a backend command tomorrow.

**Fix outline (two tiers, both safe):**

1. **Tier 1 (frontend-only, S, 1–2 h).** Replace the `for` loop with `Promise.all` over the day list so the IPC calls overlap. Each `queryByProperty` is read-only and idempotent; ordering only affects how `result.set(b.id, b)` resolves last-write conflicts on duplicate IDs (which is benign — the rows are equal).

   ```diff
   - for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
   -   const dateStr = formatDate(d)
   -   const resp = await queryByProperty({ key: propertyKey, valueDate: dateStr, limit: AGENDA_QUERY_LIMIT, spaceId })
   -   for (const b of resp.items) result.set(b.id, b)
   - }
   + const dates: string[] = []
   + for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) dates.push(formatDate(d))
   + const responses = await Promise.all(
   +   dates.map((dateStr) => queryByProperty({ key: propertyKey, valueDate: dateStr, limit: AGENDA_QUERY_LIMIT, spaceId })),
   + )
   + for (const resp of responses) for (const b of resp.items) result.set(b.id, b)
   ```

   Cuts wall-clock from `30 × roundtrip` to `~1 × roundtrip + small fan-out overhead`. Risk: backend write-pool contention is unaffected (these are reader-pool commands); the reader pool has 4 connections and SQLite WAL handles concurrent reads fine.

2. **Tier 2 (proper fix, M, 4–7 h).** Add a backend command `query_by_property_date_range` that takes `(key, start, end)` and returns the union in a single query. Mirrors the existing `agendaDateRange` shape. Eliminates fan-out entirely and lets SQLite use one statement instead of N. Recommend filing as a follow-up after Tier 1 lands.

**Cost / Risk / Confidence:** S (Tier 1: 1–2 h; Tier 2: 4–7 h) / low / high. Tier 1 is independently approve-able; Tier 2 is the durable fix.

### P2 — `indexOfFolded` recomputes the Unicode fold of a growing prefix on every iteration

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/lib/fold-for-search.ts" lines="105-125" />

**Evidence:**

```ts
const foldedPrefix = haystackFolded.slice(0, foldedIdx)
let originalCursor = 0
while (originalCursor <= haystack.length) {
  if (foldForSearch(haystack.slice(0, originalCursor)) === foldedPrefix) {
    return originalCursor
  }
  originalCursor++
}
```

**Hot path:** called from <ref_snippet file="/home/javier/dev/agaric/src/components/HighlightMatch.tsx" lines="13-23" /> — once per `<HighlightMatch>` render in search results, filter UIs, and any list that highlights matches. The ASCII fast path at line 96 short-circuits ASCII-only inputs; the slow branch only runs when either `haystack` or `needle` contains non-ASCII (accents, CJK, RTL).

**Validation note:** the file's existing comment at line 102 says `O(n·m) in the worst case; acceptable for the short strings a filter UI works with`. That comment is pre-existing and reflects the author's deliberate choice for short filter strings. The finding survives because (a) "filter UI" strings are short, but `<HighlightMatch>` also runs on full block content lines, which are not, and (b) NFKD normalisation inside `foldForSearch` is itself O(n) per call — so the loop is O(n²) wall-clock with a non-trivial per-character constant.

**Realistic N:** for a 500-character non-ASCII block content with one match near the end, that's ~500 fold-from-scratch calls of growing length — i.e. ~125 000 NFKD-normalisation character ops. Noticeable on Android.

**Fix outline:** build the fold incrementally. Walk `haystack` one code point at a time and accumulate the fold of each new code point onto a running buffer; compare buffer length against `foldedPrefix.length` to decide when to stop.

```ts
let originalCursor = 0
let foldedSoFar = ''
while (originalCursor <= haystack.length) {
  if (foldedSoFar === foldedPrefix) return originalCursor
  if (originalCursor === haystack.length) break
  // Fold one more code point and append.
  const nextChar = haystack[originalCursor]!
  foldedSoFar += foldForSearch(nextChar)
  originalCursor++
}
return foldedIdx // unchanged defensive fallback
```

The defensive fallback at line 124 stays. Add tests covering: ligature → 2-char fold (`ﬁ` → `fi`), combining marks (`é` decomposed), CJK (no fold change), and the existing all-ASCII fast-path. Reduces wall-clock from O(n²) to O(n) on the same input.

**Cost / Risk / Confidence:** S (1–2 h including new fold-correctness tests) / low / high.

---

## LOW

### P3 — Set intersection allocates an intermediate array per dimension

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/lib/agenda-filters.ts" lines="430-438" />

**Evidence:**

```ts
let intersection = resultSets[0] as Set<string>
for (let i = 1; i < resultSets.length; i++) {
  intersection = new Set([...intersection].filter((id) => resultSets[i]?.has(id)))
}
```

**Hot path:** runs once per agenda filter apply with multi-dimensional filters (status + priority + tag + date, etc.). Each iteration spreads the current intersection into a new array, runs `.filter`, allocates a new `Set`. Per-set sizes are bounded by `AGENDA_QUERY_LIMIT = 500` (line 25), so the absolute cost is small — but spreads + filters + Set constructors are the kind of loop that quietly compounds when the user has many filter dimensions or works with a large agenda.

**Fix outline:** build the next set in place by iterating the smaller of the two operands.

```diff
 let intersection = resultSets[0] as Set<string>
 for (let i = 1; i < resultSets.length; i++) {
-  intersection = new Set([...intersection].filter((id) => resultSets[i]?.has(id)))
+  const other = resultSets[i]
+  if (!other) continue
+  const [smaller, larger] = intersection.size <= other.size ? [intersection, other] : [other, intersection]
+  const next = new Set<string>()
+  for (const id of smaller) if (larger.has(id)) next.add(id)
+  intersection = next
 }
```

Halves the allocation count and avoids materialising intermediate arrays. Mechanical, no behaviour change. No new tests required — `agenda-filters` integration tests already cover the multi-dimension paths.

**Cost / Risk / Confidence:** trivial / low / high.

### P4 — `fetchBlocks` deps include mutable state, churning the callback identity

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/hooks/useDuePanelData.ts" lines="309-348" />

**Evidence:**

```ts
const fetchBlocks = useCallback(
  async (cursor?: string) => {
    // ...
    const newBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
    setBlocks(newBlocks)
    setTotalCount(cursor ? totalCount + nonEmptyItems.length : nonEmptyItems.length)
    // ... uses pageTitles inside resolveAndMergeTitles callback
  },
  [date, blocks, totalCount, pageTitles, sourceFilter, currentSpaceId],
)
```

**Hot path / impact:** `fetchBlocks` is consumed only by `loadMore` at line 475 (`[nextCursor, fetchBlocks]`). The original review's "infinite loop" claim is **wrong** — there is no effect that calls `fetchBlocks` directly; the mount effect at line 351 inlines its own fetch. So the *runtime* cost is just an extra callback identity flip on every `setBlocks` / `setTotalCount` / `setPageTitles`, which propagates into `loadMore`'s identity. Real but small.

**The actual issue is correctness-adjacent:** the closure relies on captured `blocks` / `totalCount` / `pageTitles`. Today the deps array keeps the closure fresh, but it's a footgun — any future maintainer who removes one of those deps to "stabilise" the callback will silently introduce a stale-closure bug.

**Validation note:** the comment block at lines 324–326 references MAINT-129 byte-equivalence with the pre-MAINT-129 implementation. That requirement only protects ordering of merged map entries, which functional `setPageTitles` preserves. The `biome-ignore` at line 351 covers the *mount effect*, not `fetchBlocks` itself.

**Fix outline:** switch to functional setters and drop the three mutable deps.

```diff
 const fetchBlocks = useCallback(
   async (cursor?: string) => {
     // ...
-    const newBlocks = cursor ? [...blocks, ...nonEmptyItems] : nonEmptyItems
-    setBlocks(newBlocks)
+    setBlocks((prev) => (cursor ? [...prev, ...nonEmptyItems] : nonEmptyItems))
     setNextCursor(resp.next_cursor)
     setHasMore(resp.has_more)
-    setTotalCount(cursor ? totalCount + nonEmptyItems.length : nonEmptyItems.length)
+    setTotalCount((prev) => (cursor ? prev + nonEmptyItems.length : nonEmptyItems.length))
-    // Resolve parent page titles.
-    const uniqueParentIds = [
-      ...new Set(newBlocks.map((b) => b.page_id).filter((id): id is string => id != null)),
-    ]
-    await resolveAndMergeTitles(
-      uniqueParentIds,
-      () => false,
-      (resolved) => {
-        const titleMap = new Map(pageTitles)
-        for (const r of resolved) titleMap.set(r.id, r.title ?? 'Untitled')
-        setPageTitles(titleMap)
-      },
-    )
+    // Title resolution must read the just-applied blocks; do it after the
+    // setBlocks above by reading from a ref or by computing newBlocks locally.
+    const newBlocks = cursor ? /* prev inaccessible here — see note */ : nonEmptyItems
+    const uniqueParentIds = [
+      ...new Set(newBlocks.map((b) => b.page_id).filter((id): id is string => id != null)),
+    ]
+    await resolveAndMergeTitles(uniqueParentIds, () => false, (resolved) => {
+      setPageTitles((prev) => {
+        const next = new Map(prev)
+        for (const r of resolved) next.set(r.id, r.title ?? 'Untitled')
+        return next
+      })
+    })
   },
-  [date, blocks, totalCount, pageTitles, sourceFilter, currentSpaceId],
+  [date, sourceFilter, currentSpaceId],
 )
```

**Open question for the implementer:** the title-resolution `newBlocks` computation needs the *just-fetched* items plus any existing list. The cleanest answer is a `blocksRef` populated inside the same callback (`blocksRef.current = newBlocks`); the alternative is to pass the freshly-merged list out of the functional `setBlocks` via a closure variable. Both are safe; pick whichever the implementer finds clearer.

**Cost / Risk / Confidence:** S (1 h including verifying MAINT-129 byte equivalence still holds — the existing useDuePanelData tests should catch any regression) / low / high.

### P5 — `LinkedReferences` pagination merge uses `.find()` per new group

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/components/LinkedReferences.tsx" lines="93-106" />

**Evidence:**

```ts
setGroups((prev) => {
  const merged = [...prev]
  for (const newGroup of resp.groups) {
    const existing = merged.find((g) => g.page_id === newGroup.page_id)
    if (existing) {
      existing.blocks = [...existing.blocks, ...newGroup.blocks]
    } else {
      merged.push(newGroup)
    }
  }
  return merged
})
```

**Hot path:** runs only on "Load more" click, not per render. Realistic N: 5–30 accumulated groups, ≤10 new. So the absolute cost is negligible. The reason this is in the file rather than struck through as a nit is that the `Map<page_id, group>` rewrite is the same line count, makes the data structure self-describing, and removes a latent O(N×M) that will quietly degrade if `limit: 50` (line 89) is raised later.

**Fix outline:**

```diff
 setGroups((prev) => {
-  const merged = [...prev]
-  for (const newGroup of resp.groups) {
-    const existing = merged.find((g) => g.page_id === newGroup.page_id)
-    if (existing) {
-      existing.blocks = [...existing.blocks, ...newGroup.blocks]
-    } else {
-      merged.push(newGroup)
-    }
-  }
-  return merged
+  const byPageId = new Map(prev.map((g) => [g.page_id, g]))
+  for (const newGroup of resp.groups) {
+    const existing = byPageId.get(newGroup.page_id)
+    if (existing) {
+      existing.blocks = [...existing.blocks, ...newGroup.blocks]
+    } else {
+      byPageId.set(newGroup.page_id, newGroup)
+    }
+  }
+  return Array.from(byPageId.values())
 })
```

Note: this preserves the existing in-place `existing.blocks = [...]` mutation pattern (which is technically an antipattern but matches the surrounding code). A separate refactor to deep-copy `existing` before mutating would be cleaner but is out of scope.

**Cost / Risk / Confidence:** trivial / low / high.

### P6 — `propertiesCacheRef` Map in `AgendaResults` is never cleared

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/components/AgendaResults.tsx" lines="155-157" /> with the consumer at <ref_snippet file="/home/javier/dev/agaric/src/components/DependencyIndicator.tsx" lines="34-94" />.

**Evidence:**

```ts
// AgendaResults.tsx:156
const propertiesCacheRef = useRef<Map<string, PropertyRow[]>>(new Map())
// ...
<DependencyIndicator blockId={block.id} propertiesCache={propertiesCacheRef} />
```

```ts
// DependencyIndicator.tsx:47–50
let props = propertiesCache.current.get(blockId)
if (!props) {
  props = await getProperties(blockId)
  propertiesCache.current.set(blockId, props)
}
```

**Hot path / impact:** the ref outlives every render of `AgendaResults` and is only freed when the component unmounts (i.e. user navigates away from the agenda). Memory: ~100 bytes / cached block. After loading 5 000 blocks across a long session, ~500 KB. Not a blocker.

**The actual concern is freshness, not memory:** when the user edits a block's properties, the cache returns the stale snapshot for that block. There is no `useEffect` keyed on block-properties events that invalidates entries. This shows up as the dependency indicator (the small chevron / arrow icon next to a block's title) showing the wrong dependency status until the user navigates away and back.

**Validation note:** flagging this as "perf" was the original reviewer's framing. It's mostly a freshness footgun. It belongs in this file because the fix is in the same surface area as the other perf cleanups, and because the cache is in fact a perf accelerator that other reviewers may try to extend.

**Fix outline:** invalidate on block-properties events.

```ts
import { useBlockPropertyEvents } from '@/hooks/useBlockPropertyEvents'

// inside AgendaResults
const propertyInvalidationKey = useBlockPropertyEvents()

useEffect(() => {
  propertiesCacheRef.current.clear()
}, [propertyInvalidationKey, currentSpaceId])
```

Or, more surgically, listen for `setProperty` events and `delete` only the affected `blockId`. The whole-cache-clear is simpler and the absolute cost (re-fetching ~visible blocks' props) is small.

**Cost / Risk / Confidence:** trivial / low / high.

### P7 — Suggestion popup runs `computePosition` on every keystroke

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/editor/suggestion-renderer.ts" lines="223-243" />

**Evidence:**

```ts
onUpdate(props: SuggestionProps) {
  if (!renderer) { /* warn */ return }
  renderer.updateProps(props)
  if (popup) {
    const popupRef = popup
    updatePosition(popupRef, props).catch((err: unknown) => {
      logger.warn('SuggestionRenderer', 'Position update failed', { label }, err)
      applySafePosition(popupRef, null)
    })
  }
},
```

**Hot path:** fires per keystroke whenever any picker is open (slash-command, tag picker, block-link picker, block-ref picker, property picker, at-tag picker). `updatePosition` `await`s a `requestAnimationFrame` then calls floating-ui's `computePosition`, which does a real layout / measurement pass.

**Realistic N:** one per keystroke during pick mode. The popup *must* track the cursor, so we can't drop position updates entirely. But if the user types fast (>1 keystroke per frame), the previous frame's `computePosition` is still in flight when the next `onUpdate` fires.

**Fix outline:** coalesce per-frame via a pending `requestAnimationFrame` handle.

```ts
let pendingPositionFrame: number | null = null
// ...
onUpdate(props) {
  if (!renderer) return
  renderer.updateProps(props)
  if (!popup) return
  if (pendingPositionFrame !== null) cancelAnimationFrame(pendingPositionFrame)
  const popupRef = popup
  pendingPositionFrame = requestAnimationFrame(() => {
    pendingPositionFrame = null
    updatePosition(popupRef, props).catch((err: unknown) => {
      logger.warn('SuggestionRenderer', 'Position update failed', { label }, err)
      applySafePosition(popupRef, null)
    })
  })
}
```

Also remember to `cancelAnimationFrame(pendingPositionFrame)` in the existing teardown paths (`onKeyDown` close, `onExit`, etc.) to avoid a "use after destroy" inside the rAF callback. The existing MAINT-175 safe-position fallback is preserved.

**Validation note:** the original reviewer claimed a "90% reduction in `computePosition` calls". That's optimistic — typists average <10 keystrokes per second so most frames have ≤1 keystroke and rAF coalescing has no effect. The win is real only on burst typing. Keep severity LOW.

**Cost / Risk / Confidence:** S (1 h, including teardown audit) / low / medium.

### P8 — `buildPageTree` uses `.find()` per segment

**Location:** <ref_snippet file="/home/javier/dev/agaric/src/lib/page-tree.ts" lines="15-40" />

**Evidence:**

```ts
for (const page of pages) {
  const segments = (page.content ?? 'Untitled').split('/')
  let current = root
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string
    let node = current.find((n) => n.name === segment)
    // ...
    current = node.children
  }
}
```

**Hot path:** `buildPageTree` is called whenever the sidebar page tree is built (PageBrowser, sidebar nav). Realistic N: ≤500 pages × ≤5 segments × ≤10 siblings per level = ~25 000 string compares; runs once per tree build. Fast in absolute terms; the fix is mechanical.

**Fix outline:** keep a `Map<name, node>` per level alongside the array.

```diff
 for (const page of pages) {
   const segments = (page.content ?? 'Untitled').split('/')
   let current = root
+  let currentByName = rootByName
   for (let i = 0; i < segments.length; i++) {
     const segment = segments[i] as string
     const fullPath = segments.slice(0, i + 1).join('/')
-    let node = current.find((n) => n.name === segment)
+    let node = currentByName.get(segment)
     if (!node) {
       node = { name: segment, fullPath, children: [] }
       current.push(node)
+      currentByName.set(segment, node)
+      ;(node as PageTreeNode & { _byName: Map<string, PageTreeNode> })._byName = new Map()
     }
     if (i === segments.length - 1) node.pageId = page.id
     current = node.children
+    currentByName = (node as PageTreeNode & { _byName: Map<string, PageTreeNode> })._byName
   }
 }
```

The `_byName` carrier stays internal to this function — strip it from the returned tree (`delete (node as { _byName?: unknown })._byName` in a final pass) so consumers don't see it. Or use a parallel `Map<PageTreeNode, Map<string, PageTreeNode>>` to keep `PageTreeNode` clean.

**Cost / Risk / Confidence:** trivial / low / high.

---

## Out of scope

The following surfaced in pass 1 and were dropped during validation. Listed here so they don't get re-discovered next session.

### Hallucinations (factually wrong)

- **`use-roving-editor.ts:294-365` "extensions array recreated each render → critical per-keystroke cost"** — TipTap v3's `useEditor` with default `deps=[]` does NOT destroy/recreate the editor. Verified in `node_modules/@tiptap/react/dist/index.js`: `EditorInstanceManager.compareOptions` reference-checks extensions and, on mismatch, calls `editor.setOptions({...})` — which in `node_modules/@tiptap/core/dist/index.js:4820` is just an options merge plus `view.updateState`. No plugin re-initialisation, no extension manager rebuild.
- **`template-utils.ts:98-101` "inline regex literals are recompiled per call"** — false. Regex literals in JS source are compiled at parse time, not at `.replace()` time. V8 / SpiderMonkey / JSC all behave this way; this is in the language spec.
- **`sidebar.tsx:206-231` "missing `setOpenMobile` / `setIsResizing` from useMemo deps → context staleness"** — both come from `React.useState(false)`. React guarantees `useState` setters are stable references for the lifetime of the component. Missing them from the deps array is a lint-rule deviation, not a runtime bug. (The validator pass actually graded this HIGH; my pass-3 spot-check downgraded it. Logging here so the validator's mistake is not repeated.)
- **`App.tsx:400, 488-491` "inline arrow functions defeat `AppSidebar` / `BugReportDialog` memoization"** — neither component is `React.memo`-wrapped. Inline callbacks are inert.
- **`SuggestionList.tsx:174-225, 137-172` "`renderItem` / `renderItemContent` recreated each render → re-renders all items"** — the items are not rendered through a memoized child; they're inline JSX inside `.map()`. React reconciles them fine.
- **`SearchPanel.tsx:170-190` "rebuilds `pageTitles` map for all parents on every results change"** — the code already only fetches new IDs (Set dedupe + functional `setPageTitles((prev) => new Map(prev).set(...))`).
- **`useDuePanelData.ts:324-340` "stale `pageTitles` closure → correctness bug"** — the closure-captured `pageTitles` is in the deps array (it's not stale); the comment at lines 324–326 documents the byte-equivalence requirement. P4 above addresses the deps-churn separately.
- **`slash-commands.ts:490` "`searchPropertyKeys` lacks caching"** — the editor uses `usePropertyKeysCache` (the actual hot path); `searchPropertyKeys` is a utility called from non-hot paths.
- **`viewHeaderOutlet.tsx:62` "context value not memoized"** — the value *should* update when `outlet` changes; memoizing it would defeat the provider's purpose.
- **`graph-sim-helpers.ts:240-241` "intentional shallow copies for d3"** — already documented as intentional in the existing inline comment.

### Nits (technically true, no measurable impact)

- `markdown-parse.ts:258` (`new RegExp` per code-block fence parse) — parse-time only, not edit-time.
- `markdown-serialize.ts:53-83, 164-183` (`+=` string concat in `escapeText` / `escapeUrl`) — V8 / JSC use rope strings; this is O(n) in practice. File header already documents the linearity claim.
- `BlockListRenderer.tsx:177` (`selectedBlockIds.includes`) — `visibleItems` is viewport-bounded (≤30); `.includes()` on small arrays is fine.
- `BlockListRenderer.tsx:124-154` (two-pass `siblingAriaProps`) — both passes are O(N) over the same data; single-pass is not faster.
- `BlockListRenderer.tsx:86-110` (`new Set<string>()` on empty result) — O(1) allocation; can't return a shared mutable Set.
- `ConflictList.tsx:121` (`[...new Set(parentIds)]`) — runs once per load, tiny N.
- `LinkedReferences.tsx:143-152` (8-dep `fetchGroups` callback) — refetch-on-filter-change is the desired UX behaviour.
- `usePollingQuery.ts:60-95` (effect deps include `load`) — documented as the intended contract in the hook header (`when its reference changes the polling restarts with an immediate fetch`); both callers (`StatusPanel`, `useItemCount`) properly memoise their `queryFn`.
- `useAppKeyboardShortcuts.ts:192-368` (5 separate listeners) — maintainability nit, not perf.
- `useBlockResolve.ts:250, 309, 339` (empty deps with ref/store reads) — correct latest-ref pattern; a clarifying comment would help but no behaviour change is needed.
- `useDuePanelData.ts:188` (`useMemo(() => getTodayString(), [])`) — pure micro-noise.
- `fold-for-search.ts:63-76` (`matchesSearchFolded` re-folds same strings without cache) — adds a cache invalidation surface for marginal gain.
- `graph-sim-helpers.ts:509` (worker re-posts full graph data on resize) — ResizeObserver coalesces; `.map` over typically <100 nodes is trivial.
- `logger.ts:88-126` (rate-limit map sweep at 1 000 entries) — sweep is opportunistic, growth is bounded.
- `searchPanel.tsx:108` (Map vs Record for `pageTitles`) — style preference, no perf delta.

---

## Recommended order

Highest-leverage first:

1. **P1 (date-range IPC fan-out)** — Tier 1 alone (frontend-only `Promise.all`) is the single biggest user-visible win in this file. Tier 2 (backend command) is the durable fix; do it as a follow-up after Tier 1 ships and confirms the win.
2. **P2 (`indexOfFolded` incremental fold)** — only relevant for non-ASCII users / long block content, but the fix is mechanical and adds well-targeted tests.
3. **P3 (set intersection)** — drive-by alongside P1, same file.
4. **P4 (`fetchBlocks` deps)** — closes a maintenance-time footgun; the runtime gain is small.
5. **P5 (LinkedReferences merge)** — drive-by, same effort as the comment that would otherwise explain the `.find()`.
6. **P6 (`propertiesCacheRef` invalidation)** — primarily a freshness fix; the perf framing is incidental.
7. **P7 (suggestion-renderer rAF coalesce)** — only worth doing if profiling shows burst-typing repaint cost.
8. **P8 (page-tree Map)** — only worth doing if a workspace ever exceeds a few thousand pages.

P1 + P3 (same file) + P5 + P8 + P3 are all `trivial`-cost mechanical fixes that could land in a single bundle commit.

## Methodology notes

The original review's first-pass findings had a **~50% false-positive rate**. Patterns to avoid in future passes:

- **Verify framework behaviour from source, not from intuition.** TipTap's re-init semantics, regex compile timing, `useState` setter stability — all caught here only because pass 3 actually opened the upstream files.
- **Demand a concrete realistic N before grading anything ≥ Medium.** "O(N×M) hot path" is meaningless without a number. Most "linear search" findings dissolved at N ≤ 30.
- **`memo` claims must check the consumer.** Inline arrow functions / unmemoized context values are inert if the consumer isn't `React.memo`-wrapped.
- **`useState` setters are stable.** Lint deviations on missing setter deps are not runtime bugs.
- **Read the comments.** A surprising number of hits were already documented as deliberate trade-offs; pass 1 reviewers ignored `biome-ignore`, `MAINT-…`, and `PERF-…` markers.

The validator pass itself produced its own hallucinations (the sidebar deps "HIGH" call). One additional pass-3 spot-check on every confirmed finding was the right cost / quality trade-off; a fourth pass would not have changed the outcome.
