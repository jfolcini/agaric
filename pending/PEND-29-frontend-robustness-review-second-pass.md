# PEND-29 — Frontend robustness review (second pass): confirmed non-nit findings

> **Status (session 660):** B-2 / B-3 / B-4 / B-5 / B-6 / B-7 / B-8 / B-10 closed in commit landing this session. **Only B-1 (BulletList extension data-loss path) remains open** — skipped per user decision; needs explicit product signal on Option A (remove the extension; current default recommendation) vs Option B (implement full bullet-list round-trip) before it can land. The toast-warned data-loss path on `bulletList` nodes is documented but not closed. The "Out of scope (intentionally)" + "Hallucinations rejected by Round 2 validation" sections remain authoritative for future reviewers.

## Origin

Two-round JS/TS robustness review run 2026-05-04 over the production
TypeScript/TSX under `src/` (~75 600 LOC across 440 files; tests, fixtures,
mocks excluded). **Round 1**: six parallel discovery subagents covering
disjoint slices —

1. `src/stores/` + `src/hooks/` (Zustand + custom hooks)
2. `src/editor/` (TipTap, markdown serializer, custom extensions)
3. Top-level `src/App.tsx`, `src/main.tsx`, journal, PageBrowser, TrashView
4. `src/components/block-tree/`, `agent-access/`, `backlink-filter/`,
   `ConflictList/`, `settings/`, `ui/`
5. `src/lib/` (logger, i18n, keyboard-config, tauri-mock, date / ULID utilities)
6. Cross-cutting IPC / `listen()` / Web-Worker surfaces

**Round 2**: four parallel validation subagents that re-read every cited
`file:line` against the actual source, looking for hallucinations,
exaggerations, missing context, mitigations the original reviewer missed,
and threat-model carve-outs (single-user, local-first, no malicious peers).
The most consequential claim — silent serialization data loss from the
`BulletList` extension — was additionally hand-verified before being
accepted.

Round 1 produced ~78 raw findings. Round 2 rejected ~30 outright as
hallucinations or threat-model violations, demoted ~20 to nits, and confirmed
the **9 non-nit items below**. Two further confirmed items (`ULID`
normalization comment, logger rate-limit colon collision) are pure
documentation / theoretical concerns and are explicitly excluded from this
plan; they are listed in "Out of scope" at the bottom.

> **Relationship to PEND-22** (session 659, also a frontend robustness
> review): scope and methodology were identical but the two sessions
> independently surfaced different findings — there is **zero overlap**.
> PEND-22 closed two items (`graph-worker` error envelope +
> `useQueryExecution` stale-fetch guard); both validation passes for this
> session confirmed those fixes are correctly in place at `HEAD`. The pickers
> finding (B-4 below) does *not* recur in PEND-22's `useQueryExecution`
> path — it is a separate, narrower consistency gap in three picker
> extensions. The findings here are net-new.

Per-bucket review and validation reports are kept under `/tmp/agaric-review/`
for audit if needed.

## TL;DR

| ID | Severity | Title | Cost | Risk | Impact | Status |
| --- | --- | --- | --- | --- | --- | --- |
| **B-1** | MEDIUM | `BulletList` extension registered but no serializer / parser support — content is lost on unmount (toast warns, but `bulletList` nodes are silently dropped from the markdown payload) | S (1.5–3 h) | low | medium | ready |
| **B-2** | LOW | `PageBrowser` alias resolution effect has no debounce and no stale-response guard (out-of-order `setAliasMatchId`, cosmetic-only) | trivial (~15 min) | low | low | ready |
| **B-3** | LOW | `formatCompactDate` `(m ?? 1) - 1` does not catch `m === 0` — silently masks malformed dates | trivial (~5 min) | low | low | ready |
| **B-4** | LOW | At-tag / block-link / block-ref picker-command `.then()` callbacks call `editor.chain()` without the `editor.view.isDestroyed` guard the rest of the codebase uses | trivial (~15 min) | low | low | ready |
| **B-5** | LOW | `runWithTimeout`'s timeout `setTimeout` is never cleared on race resolution — bounded leak (one 60 s timer per sync attempt) | trivial (~10 min) | low | low | ready |
| **B-6** | LOW | `UnlinkedReferences` + `LinkedReferences` mount-once effects call `setTags` without an `active` flag — React 19 strict-mode warnings on rapid mount/unmount | trivial (~10 min) | low | low | ready |
| **B-7** | LOW | `SpaceManageDialog`'s two `void async` IIFEs inside `useEffect` write to React state without an `active` flag — same React 19 warning shape as B-6 | trivial (~15 min) | low | low | ready |
| **B-8** | LOW | `JournalPage` + `DailyView` `requestAnimationFrame` ids not captured / cancelled — diverges from the correct pattern at `App.tsx:154-163` | trivial (~10 min) | low | low | ready |
| **B-10** | LOW | `tauri-mock` is included in the production Vite bundle because the dynamic import is gated at runtime, not at build time | trivial (~5 min) | low | low | ready |

(B-9 and B-11 from the discovery output are documentation-only / theoretical
and intentionally not bundled — see "Out of scope" at the bottom.)

**Total cost ≈ 3–5 h.** B-2 through B-10 are each ≤15-min one-line/one-block
fixes — bundle them as a single commit "frontend robustness misc — picker
guards + cleanup hygiene + cancel hygiene". B-1 is the only one that needs
real product input (decide whether to *support* bullet lists or *remove* the
extension) before it can land; treat it as the headline of this batch.

None of these require schema migrations, new op types, new stores, or any
architectural change.

---

## MEDIUM

### B-1 — `BulletList` extension registered but no serializer / parser support → data loss on unmount

**Files:**

* Extension registration: <ref_snippet file="/home/javier/dev/agaric/src/editor/use-roving-editor.ts" lines="11-11" />
  * <ref_snippet file="/home/javier/dev/agaric/src/editor/use-roving-editor.ts" lines="306-306" />
* Markdown serializer (handles `orderedList`, *not* `bulletList`):
  <ref_snippet file="/home/javier/dev/agaric/src/editor/markdown-serialize.ts" lines="338-342" />
  * <ref_snippet file="/home/javier/dev/agaric/src/editor/markdown-serialize.ts" lines="415-421" />
* `BlockLevelNode` schema union (no `BulletListNode` member):
  <ref_snippet file="/home/javier/dev/agaric/src/editor/types.ts" lines="125-132" />
* Parser has no bullet-list parser either — `grep -n bulletList src/editor/markdown-parse.ts` returns nothing
* Production unknown-node sink: <ref_snippet file="/home/javier/dev/agaric/src/editor/markdown-serialize-toast.ts" lines="38-46" />

**Problem:** `BulletList` from `@tiptap/extension-bullet-list` is imported and
added to the extensions array (line 306, no `.configure()`, so default
behaviour). The TipTap default ships an input rule that fires on
`^\s*([-+*])\s$`, so the user typing `- foo`, `* foo`, or `+ foo` at the
start of a line (or pasting HTML containing `<ul>`) creates a `bulletList`
node in the document. On unmount the roving editor calls `serialize(json,
notifyUnknownNodeTypeToast)` (`use-roving-editor.ts:506`). The serializer's
top-level `switch` (lines 415-421) recognises `paragraph`, `heading`,
`codeBlock`, `blockquote`, `table`, `orderedList`, `horizontalRule` — but
**not `bulletList`** — and falls through to the unknown-node branch, which
calls the supplied callback (`notifyUnknownNodeTypeToast`) and emits the
empty string. The list, including all its `listItem` children, is dropped
from the persisted markdown.

This is **not strictly silent** — the user gets a one-shot toast
("Some content (type: bulletList) couldn't be saved as Markdown and was
dropped.") via the rate-limited dedup in `markdown-serialize-toast.ts`. But
the content is gone, and there is no undo path through the markdown payload
the editor just wrote. On the next mount the parser will not reproduce a
bullet list either (markdown-parse.ts has only `parseOrderedList`), so even
manually-authored markdown like `- foo\n- bar` will not round-trip into a
`bulletList` node — meaning the asymmetry runs in both directions:

* **Editor → markdown:** `bulletList` produced (e.g. by input rule, paste,
  programmatic insertion) is dropped on serialize.
* **Markdown → editor:** `- foo` in a markdown source is currently parsed
  as plain text, not as a list.

The same gap recurs in `serializeBlockquote` (lines 338-342): a blockquote
containing a bullet list would also drop the inner list, but this is moot
because `BlockLevelNode` does not include `BulletListNode` so the type
system already forbids it.

**Failure scenario:** a returning user types `- groceries`, sees TipTap
auto-format it as a bullet list, blocks it out, navigates away. The block's
markdown is now `''`. The toast fires once, then the user keeps working and
forgets it. On reload the bullet item is gone. **Real, observable data
loss.**

**Fix — choose one:**

**Option A — Remove the extension (preferred unless bullet-list support is a
near-term requirement).**

```ts
// src/editor/use-roving-editor.ts
- import BulletList from '@tiptap/extension-bullet-list'
…
  extensions: [
    Document,
    Paragraph,
    Text,
    …
    Blockquote,
    OrderedList,
-   BulletList,
    ListItem,
    …
  ],
```

Then drop the `@tiptap/extension-bullet-list` package and the
`@tiptap/extension-list-item` retains only its `OrderedList` parent (verify
the package is still needed by something else; `ListItem` is still in the
extensions array per line 307). One commit, ~3 LOC + a `package.json` edit

* a regression test that types `- foo` and asserts the result remains a
plain paragraph (not a list).

**Option B — Implement full round-trip support.** Adds:

1. `BulletListNode` to `types.ts` `BlockLevelNode` union.
2. `serializeBulletList(node: BulletListNode): string` mirroring
   `serializeOrderedList` (use `-` instead of `1.`, indent with two spaces).
3. `parseBulletList` in `markdown-parse.ts` mirroring `parseOrderedList`,
   matching `^(\s*)[-+*]\s` at line start.
4. Recursion arm in `serializeBlockquote` for the new `bulletList` child.

~80–120 LOC and the round-trip test matrix in
`markdown-serializer.test.ts` needs to be doubled (every `orderedList` test
needs a `bulletList` analogue). Cost: M (3-5 h).

**Recommendation:** Option A. The product surface today has no UI for
bullet-list creation (no slash command, no toolbar button, no keybinding),
and the parser cannot read bullet lists from imported markdown — so the
extension is *only* a footgun. If bullet-list support becomes a real
requirement, ship Option B as a follow-up with the same care as the existing
`orderedList` round-trip work.

**Test (Option A):**

```ts
// src/editor/__tests__/markdown-serializer.test.ts (new case)
it('typed `- foo` does not silently drop content (BulletList not registered)', () => {
  // ProseMirror json that the editor would produce *without* the
  // BulletList extension: a plain paragraph.
  const json = doc(paragraph(text('- foo')))
  expect(serialize(json, notifyUnknownNodeTypeToast)).toBe('- foo')
})
```

Plus an editor-level regression test that types `- foo` and asserts the
result is a paragraph (rather than a `bulletList`), to lock down that the
extension was actually removed.

---

## LOW — bundle as a single commit

The remaining items are individually each ≤15 min and share a theme
(cleanup / cancellation / consistency). Group them into one commit
"frontend robustness misc — picker guards + cleanup hygiene + cancel hygiene".

### B-2 — `PageBrowser` alias resolution lacks stale-response guard

**File:** <ref_snippet file="/home/javier/dev/agaric/src/components/PageBrowser.tsx" lines="136-149" />

**Problem:** the effect calls `resolvePageByAlias(filterText.trim())` on
every keystroke (no debounce in `PageBrowserHeader.tsx:95` either). Rapid
typing `foo` → `foobar` → `foo` can cause the `foo` promise to resolve
*after* the `foobar` promise, overwriting `aliasMatchId` with stale data.
Impact is cosmetic — the user's typed `filterText` remains the source of
truth for the list filter, so the wrong page is highlighted briefly before
the next keystroke or promise resolves.

**Fix — request-id pattern (mirrors `useQueryExecution.ts` post-PEND-22):**

```ts
const aliasReqIdRef = useRef(0)

useEffect(() => {
  if (!filterText.trim()) {
    setAliasMatchId(null)
    return
  }
  const myReqId = ++aliasReqIdRef.current
  const query = filterText.trim()
  resolvePageByAlias(query)
    .then((result) => {
      if (myReqId !== aliasReqIdRef.current) return
      setAliasMatchId(result ? result[0] : null)
    })
    .catch((err) => {
      if (myReqId !== aliasReqIdRef.current) return
      logger.warn('PageBrowser', 'alias resolution failed', { query }, err)
      setAliasMatchId(null)
    })
}, [filterText])
```

A 200-300 ms debounce on the upstream `filterText` change would also work
and would reduce IPC traffic, but the request-id pattern is consistent with
the rest of the codebase post-PEND-22 and protects against any future
caller too.

### B-3 — `formatCompactDate` does not reject `m === 0`

**File:** <ref_snippet file="/home/javier/dev/agaric/src/lib/date-utils.ts" lines="82-92" />

**Problem:** `const month = MONTH_SHORT[(m ?? 1) - 1] ?? 'Jan'` — `Number('0')`
is `0`, not `NaN`, so the prior `Number.isNaN` check passes. `(0 ?? 1) - 1`
is `-1`, `MONTH_SHORT[-1]` is `undefined`, the `?? 'Jan'` fallback kicks in.
A malformed input like `'2026-00-15'` silently renders as `'Jan 1, 2026'`
instead of falling back to the original `dateStr` (which is what every
other branch in the function does).

**Fix:**

```ts
const [y, m, d] = parts.map(Number)
if (
  Number.isNaN(y) ||
  Number.isNaN(m) ||
  Number.isNaN(d) ||
  m < 1 || m > 12 ||
  d < 1 || d > 31
) return dateStr
```

Plus a unit test covering `'2026-00-15'` and `'2026-13-15'`.

### B-4 — Picker-command `.then()` callbacks lack the `editor.view.isDestroyed` guard

**Files:**

* <ref_snippet file="/home/javier/dev/agaric/src/editor/extensions/at-tag-picker.ts" lines="156-170" />
* <ref_snippet file="/home/javier/dev/agaric/src/editor/extensions/block-link-picker.ts" lines="207-227" />
* <ref_snippet file="/home/javier/dev/agaric/src/editor/extensions/block-ref-picker.ts" lines="54-110" /> (relevant `.then()` callbacks in this file)
* Established correct pattern for comparison: <ref_snippet file="/home/javier/dev/agaric/src/editor/extensions/slash-command.ts" lines="98-105" />

**Problem:** in the roving-editor architecture, the editor instance can be
destroyed (or transitioned, plugin tear-down) between an async `onCreate` /
search promise being awaited and the `.then()` callback running
`editor.chain().focus().…`. The input-rule path of these extensions has a
defensive `isStale(insertPos > editor.state.doc.content.size)` proxy check;
the picker-command path does not. `slash-command.ts` already establishes
the explicit `if (editor.view?.isDestroyed) return` pattern.

In practice TipTap's `editor.chain()` no-ops on a destroyed view, so the
worst case is a logged-but-confusing `.catch()` instead of a clean early
return. This is a low-impact consistency fix.

**Fix:** add `if (editor.view?.isDestroyed) return` at the top of each
picker-command `.then()` callback (three sites total).

### B-5 — `runWithTimeout` leaks a `setTimeout` per call

**File:** <ref_snippet file="/home/javier/dev/agaric/src/hooks/useSyncTrigger.ts" lines="48-50" />

**Problem:** `Promise.race([p, new Promise<T>((_, reject) => setTimeout(() =>
reject(err), ms))])` — when the first promise wins the race, the inner
`setTimeout` is still scheduled and fires `ms` ms later (the rejection just
goes nowhere because nothing is awaiting it). Bounded leak: one timer per
sync attempt, throttled by exponential backoff (`intervalRef.current`,
2 s → 60 s).

**Fix:**

```ts
function runWithTimeout<T>(p: Promise<T>, ms: number, err: Error): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(err), ms)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timeoutId !== null) clearTimeout(timeoutId)
  })
}
```

### B-6 — `UnlinkedReferences` + `LinkedReferences` mount-once effects lack a cancellation flag

**Files:**

* <ref_snippet file="/home/javier/dev/agaric/src/components/UnlinkedReferences.tsx" lines="142-149" />
* <ref_snippet file="/home/javier/dev/agaric/src/components/LinkedReferences.tsx" lines="155-163" />
* Correct pattern for comparison: <ref_snippet file="/home/javier/dev/agaric/src/components/GraphView.tsx" lines="101-152" />

**Problem:** both effects run `listTagsByPrefix({ prefix: '' }).then(setTags)`
with no `cancelled` flag and no cleanup. If the component unmounts before
the IPC resolves, React 19 strict mode emits a "state update on unmounted
component" warning. Not a functional bug — `setTags` is stable, no listener
leak — but it is noise that obscures real warnings, and the codebase already
has the correct pattern in `GraphView.tsx`.

**Fix (each file):**

```ts
useEffect(() => {
  let cancelled = false
  listTagsByPrefix({ prefix: '' })
    .then((result) => {
      if (cancelled) return
      setTags((result ?? []).map((t) => ({ id: t.tag_id, name: t.name })))
    })
    .catch((e) => {
      if (cancelled) return
      logger.error('<module>', 'Failed to load tags', undefined, e)
    })
  return () => { cancelled = true }
}, [])
```

### B-7 — `SpaceManageDialog` `void async` IIFEs lack a cancellation flag

**File:** <ref_snippet file="/home/javier/dev/agaric/src/components/SpaceManageDialog.tsx" lines="700-748" />

**Problem:** two `void (async () => { … setEmptinessBySpace(...) … })()` IIFEs
inside the `useEffect` body. The dialog is portaled by Radix, and closing
the dialog unmounts the content. `emptinessFetchedRef` partially protects
against double-fetch but does **not** prevent the `setState` calls from
firing post-unmount. Same React 19 warning surface as B-6.

**Fix:**

```ts
useEffect(() => {
  let active = true
  for (const space of availableSpaces) {
    const id = space.id
    if (emptinessFetchedRef.current.has(id)) continue
    emptinessFetchedRef.current.add(id)
    void (async () => {
      try {
        const result = await listBlocks({ blockType: 'page', spaceId: id, limit: 1 })
        if (!active) return
        setEmptinessBySpace((prev) => ({ ...prev, [id]: result.items.length === 0 }))
      } catch (err) {
        if (active) emptinessFetchedRef.current.delete(id)
        logger.warn(LOG_MODULE, 'failed to probe space emptiness', { spaceId: id }, err)
      }
    })()
  }
  // Mirror the same `active` guard for the second IIFE on lines 730-745.
  return () => { active = false }
}, [availableSpaces])
```

### B-8 — `JournalPage` + `DailyView` `requestAnimationFrame` not cancelled

**Files:**

* <ref_snippet file="/home/javier/dev/agaric/src/components/JournalPage.tsx" lines="82-103" />
* <ref_snippet file="/home/javier/dev/agaric/src/components/journal/DailyView.tsx" lines="35-43" />
* Correct pattern for comparison: <ref_snippet file="/home/javier/dev/agaric/src/App.tsx" lines="153-163" />

**Problem:** rAF id is not captured and the cleanup function does not call
`cancelAnimationFrame`. The leak is **almost** theoretical because the
target store value is cleared inside the rAF callback, so subsequent renders
see `null` and the effect returns early; `scrollIntoView` is idempotent.
But the pattern diverges from the correct one at `App.tsx:153-163` and is
trivially brought into line.

**Fix (each effect):**

```ts
useEffect(() => {
  if (!scrollToDate) return
  const id = requestAnimationFrame(() => {
    document.getElementById(`journal-${scrollToDate}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    clearScrollTarget()
  })
  return () => cancelAnimationFrame(id)
}, [scrollToDate, clearScrollTarget])
```

### B-10 — `tauri-mock` ships in the production bundle

**Files:**

* <ref_snippet file="/home/javier/dev/agaric/src/main.tsx" lines="28-34" />
* `src/lib/tauri-mock/` (~50 KB total across handlers / seed / inject)

**Problem:** the dynamic import is gated at runtime on
`!window.__TAURI_INTERNALS__`. In a Tauri webview that flag is always
truthy, so the chunk is *never executed* in production, but Vite cannot
prove that statically and includes the chunk in the build output anyway.
Local-asset protocol means bundle size is a soft concern, but stripping the
mock at build time is a one-line change.

**Fix:**

```ts
async function main() {
  if (!import.meta.env.PROD && !window.__TAURI_INTERNALS__) {
    const { setupMock } = await import('./lib/tauri-mock')
    setupMock()
  }
  …
}
```

`import.meta.env.PROD` is a Vite compile-time constant, so the entire branch
is eliminated by tree-shaking in `vite build` output.

---

## Out of scope (intentionally)

### Confirmed but excluded as nits

* **B-9 — ULID normalization documented as "every entry point" but only
  `ulidToDate` actually normalizes in JS/TS.** The threat model and the
  actual wire format protect this: ULIDs come from the Rust backend always
  uppercase, and the frontend treats them as opaque routing/lookup keys
  (no case-sensitive comparisons or hashes in TS code). Comment-only
  change; not worth a commit on its own. Fold a one-line invariant comment
  at the top of `src/lib/format.ts` into any nearby edit when one happens.

* **B-11 — Logger rate-limit key uses `${module}:${message}`, theoretically
  collidable if a module name ever contained `:`.** Verified all current
  module names are alphanumeric/hyphen — no collision possible.
  Theoretical-only; do not bundle.

### Hallucinations rejected by Round 2 validation

Listed here for audit completeness; do not re-litigate:

* **`usePollingQuery` focus-listener stale `load` cleanup.** False — the
  `useEffect` deps include `load`, so React calls cleanup with the *current*
  `load` reference *before* re-running. No leak.
* **`usePropertyKeysCache` module-level `listen()` never unlistens.** False
  — process-lifetime listener is *intentional* and explicitly documented in
  the file comment block (lines 20-22).
* **`main.tsx` global error handlers register before logger init / leak
  under HMR.** False — ESM imports run before module body, and Vite
  full-reloads on `main.tsx` changes (HMR does not apply to entry points).
* **`date-utils.ts` next/last-N-days `parseInt` could be `NaN`** (originally
  flagged High). False — the regex `/^(?:next|last)-(\d+)-days$/` makes
  `NaN` unreachable; `parseInt` of a digit-only string cannot be `NaN`.
* **`markdown-serialize.ts` blockquote serializer doesn't recurse into
  bulletList.** Moot — `BlockLevelNode` excludes `BulletListNode`; the type
  system already forbids it. Subsumed by B-1.
* **`AddFilterRow` `formRef` captures stale form state across category
  changes.** False — `AddFilterRow.tsx:253-266` renders **different React
  component types** per category (`TypeFilterForm` / `StatusFilterForm` /
  `PropertyFilterForm` / …). React unmounts the old component and mounts
  the new one when the component type changes; the imperative ref is
  re-bound and the form's internal state is freshly initialised. The
  finding misunderstood React reconciliation.

### Other excluded items

* **`useSyncTrigger.scheduleNext` chain has no `.catch()`.** Confirmed
  syntactically but mitigated: `syncAll()` (lines 112-154) catches all
  errors internally and never rejects, so the recursive scheduling chain
  cannot break. Adding `.catch(() => {})` would be redundant; document the
  invariant if anyone refactors this code. Do not bundle.
* **`useBlockPropertyEvents` debounce timer fires after unmount.** The
  `useEffect` cleanup already clears the timer (lines 62-66). Theoretical
  edge case; not real.
* **`ActivityFeed` `Fragment key` includes `idx`.** The `biome-ignore`
  comment is justified — `entry.timestamp` and `entry.toolName` already
  dominate uniqueness, and the entries array is capped at 100 with
  newest-first prepending, so any index reshuffle is bounded and harmless.
* **`ConflictDiscardDialog` opens with no preview when `blockId` is set
  but the block is missing from `blocks`.** Real but extremely rare
  multi-device race; `onAction` already guards with `if (discardBlock)`,
  so the worst case is an empty dialog the user dismisses. Acceptable
  graceful degradation. Do not bundle.
* **`TemplatePicker` mount-only focus `useEffect`.** `templatePages` is
  stable for the dialog's lifetime; dialog is unmounted on close.
  No bug.
* **`AppearanceTab` font-size DOM mutation via
  `document.documentElement.style.setProperty`.** Intentional and correct
  pattern for CSS custom properties; React doesn't track CSS vars.

## Step-by-step plan

**Phase 1 — B-1 (decide first, then ship):**

1. **Decision point** — confirm with the user whether to remove `BulletList`
   (Option A) or implement full bullet-list round-trip (Option B). Default
   recommendation: Option A.
2. (Option A) Drop the import + the extensions-array entry. Add the
   regression test that types `- foo` and asserts it stays a plain paragraph
   in the editor. Drop the `@tiptap/extension-bullet-list` package. Run
   `npm run test` and `prek run --all-files`.
3. (Option B — only if explicitly chosen) Add `BulletListNode` to
   `types.ts`, implement `serializeBulletList` + `parseBulletList`, recurse
   into bulletList children in `serializeBlockquote`, double the round-trip
   test matrix in `markdown-serializer.test.ts`. Significantly larger; do
   not begin without explicit user signal.
4. Commit: `fix: close PEND-29 — remove unsupported BulletList extension`
   (Option A) or `feat: close PEND-29 — full BulletList round-trip support`
   (Option B).

**Phase 2 — B-2 through B-10 bundle:**

1. Apply each LOW fix in its own surgical edit (request-id, range guard,
   isDestroyed guard, timeout cleanup, cancelled flag x2, rAF cancel x2,
   build-time mock gate). ~80–120 LOC across 9 files.
2. Add the focused tests:
   * B-2: race test — old promise resolves after new one, assert
     `aliasMatchId` matches new query.
   * B-3: `'2026-00-15'` and `'2026-13-15'` cases.
   * B-5: assert no pending timer after `runWithTimeout` resolves
     (use vitest fake timers).
   * B-8: assert `cancelAnimationFrame` is called on cleanup.
3. Run `npm run test` (vitest, 7300+ tests) — all green.
4. Run `prek run --all-files` — Biome + parity hooks clean.
5. Commit: `fix: frontend robustness misc — picker guards + cleanup hygiene
   * cancel hygiene (PEND-29 LOW bundle)`.

## Cost / risk / impact

| Dimension | B-1 (medium) | B-2..B-10 (low bundle) |
| --- | --- | --- |
| Cost | S (1.5–3 h, Option A) / M (3-5 h, Option B) | S (1.5–2.5 h total) |
| Risk | low (Option A removes an unused extension; Option B is additive new code) | low (each fix is surgical and additive) |
| Impact | medium — closes a real-but-toast-warned data-loss path | low — eliminates React 19 warnings, tightens consistency, removes a bounded leak |

## Provenance

Two-round JS/TS robustness review run 2026-05-04 over ~75 600 LOC of
production TS/TSX. Round 1: 6 parallel reviewers, ~78 raw findings. Round 2:
4 parallel validators re-checked all substantive findings against actual
source; the most consequential claim (B-1) was additionally hand-verified.
Final verdict distribution: **30 hallucinations / threat-model violations
(38%) / 20 nits (26%) / 11 confirmed (14%) / 17 demoted to mitigated edge
cases or comment-only (22%)**. Of the 11 confirmed, **9 (this file)** are
worth fixing; 2 (B-9, B-11) are documentation/theoretical and listed in
"Out of scope".
