import { ULID_RE } from '@/editor/markdown-common'
import type { BlockRow } from '@/lib/bindings'
import { untitledOr } from '@/lib/block-title'
import { truncateContent } from '@/lib/text-utils'

/**
 * Detects the `[[ULID...]]` cache-miss fallback a `resolveBlockTitle` can
 * hand back for an id it has no real title for.
 *
 * Since #4238 there is exactly ONE producer of this shape, and it is a
 * DISPLAY label derived from `ResolveEntry.resolved` (`@/stores/resolve`)
 * rather than a string any writer stores as a row's title:
 * `unresolvedBlockLabel` (`@/lib/block-title`), returned by
 * `useBlockResolve`'s `resolveBlockTitle`
 * (`@/components/block-tree/use-block-resolve.ts`),
 * `useResolveStore.resolveTitle` (`@/stores/resolve.ts`) and
 * `useBacklinkResolution.resolveBlockTitle` (`@/hooks/...`) for an id that is
 * absent from the cache OR present with `resolved: false` — the
 * `fetchAndCacheLinks` unreturned-target placeholder. The two are deliberately
 * indistinguishable here: both mean "the backend never handed us this row".
 *
 * Before #4238 there was a second producer, and it is why this pattern was
 * fragile: `useBacklinkResolution` STORED this shape as the title of a
 * resolved-but-BLANK row, purely so that this test would keep firing for it.
 * The title was therefore answering two questions at once, and blank was the
 * input on which they disagreed — that row is resolved, it just has no name.
 * It now stores "Untitled" like its three sibling writers, and reaches the
 * fallback below through {@link isSyntheticTitle}'s placeholder arm instead.
 * Keep this pattern in step with `unresolvedBlockLabel`'s shape (both are
 * anchored on its 8-of-26-character id prefix); nothing else may emit it.
 */
const CACHE_MISS_FALLBACK_PATTERN = /^\[\[[0-9A-Z]{1,12}\.{3}\]\]$/

/**
 * Whether `resolved` is a SYNTHETIC label — a stand-in the resolver produced
 * because it had no real title — rather than a block's actual text.
 *
 * #4239 — this used to test only {@link CACHE_MISS_FALLBACK_PATTERN}, which
 * was complete while the seeders stored raw content. Since #4228 moved
 * normalisation to the seed, `normalizeBlockRefTitle` also SUBSTITUTES the
 * "Untitled" placeholder — for blank content, and (deliberately, because a
 * chip shows one line) for content whose FIRST line is blank, i.e. anything
 * starting with `"\n"`. Those rows resolve to a real cache hit carrying a
 * placeholder, so the cache-miss test no longer recognised them and a query
 * row that used to show the block's own text showed "Untitled" instead.
 *
 * That is a genuine cross-surface consequence of the seed move, and it is
 * NOT acceptable here: a query row is not a chip. It has its own 80-char
 * budget, no one-line constraint, and its whole job is to show enough of the
 * block to identify it — showing "Untitled" for a block with real text on
 * line 2 loses the only information the row carries. The chip still shows
 * "Untitled" for the same block, which is correct FOR A CHIP; the two
 * surfaces are allowed to differ because they read the same stored title
 * with different budgets. Treating the placeholder as synthetic restores the
 * pre-#4228 row for both shapes without reintroducing a second normaliser.
 *
 * A page genuinely TITLED "Untitled" is unaffected: its content fallback
 * truncates to the same word.
 */
function isSyntheticTitle(resolved: string): boolean {
  return CACHE_MISS_FALLBACK_PATTERN.test(resolved) || resolved === untitledOr(null)
}

/**
 * Scan pattern for the three inline reference shapes the markdown vocabulary
 * recognises — `[[id]]` (block link), `((id))` (block ref) and `#[id]` (tag
 * ref), each carrying a bare 26-character ULID
 * (`@/editor/markdown-parse/vocab.ts`, `tryConsumeToken`).
 *
 * The id is captured loosely here and validated with the canonical
 * {@link ULID_RE} at substitution time, so this pattern cannot drift from the
 * parser's idea of a ULID — the length is the only thing stated twice, and a
 * wrong length simply fails to match, leaving the text alone.
 *
 * It is a SCAN, not the parser, and the one place the two disagree is a
 * reference inside a code span: `` `[[<ulid>]]` `` renders as literal text in
 * the row and is substituted in the name. Left as-is deliberately — matching
 * the parser here means running it, and the divergence needs a ULID typed
 * inside backticks to reach. Anything cheaper (counting backticks) would be a
 * second, differently-wrong parser.
 */
const INLINE_REF_PATTERN = /\[\[([^\]]{26})\]\]|\(\(([^)]{26})\)\)|#\[([^\]]{26})\]/g

/**
 * Replace each inline reference in `content` with the title its target
 * resolves to, for the PLAIN-TEXT name (see {@link resolveBlockDisplay}).
 *
 * #4719 — without this the row's accessible name carries the raw ULID that
 * the rendered chips no longer show: `truncateContent` strips a `[[…]]`'s
 * brackets and leaves the id, so `follow up on [[01KP36…]]` names the row
 * "follow up on 01KP36KDG2ABCDEFGHJKMNPQRS" while the visible row reads
 * "follow up on Quarterly Plan". That is the reported bug moved into the
 * accessible name rather than fixed, and it breaks WCAG 2.5.3 (the visible
 * label is not contained in the name).
 *
 * `resolveRefTitle` is the resolver the CHIPS render from — both components
 * pass `useRichContentCallbacks().resolveBlockTitle` (see
 * {@link resolveBlockDisplay}'s note on why it is a separate parameter), so
 * the two agree by construction: on a hit the name carries the resolved
 * title, and on a miss it carries `renderBlockLink`'s own `[[id…]]` label,
 * which `truncateContent` then shortens to the same 8-character prefix the
 * chip displays.
 *
 * A namespaced page is the one deliberate difference: the chip shows the LEAF
 * (`renderBlockLink` → `getPageDisplayName(…, 'leaf')`) while the name keeps
 * the full path. A superset satisfies 2.5.3 and tells a screen-reader user
 * more, not less.
 */
function resolveInlineRefs(
  content: string,
  resolveRefTitle: ((id: string) => string) | undefined,
): string {
  if (!resolveRefTitle) return content
  return content.replace(
    INLINE_REF_PATTERN,
    (match: string, link?: string, ref?: string, tag?: string): string => {
      const id = link ?? ref ?? tag
      if (id === undefined || !ULID_RE.test(id)) return match
      return resolveRefTitle(id) || match
    },
  )
}

/**
 * Resolve the display title and page title for a block row.
 *
 * Centralises the title-resolution logic shared by QueryResultList and
 * QueryResultTable so the two components stay in sync.
 *
 * When `resolveBlockTitle` hands back a synthetic label (see
 * {@link isSyntheticTitle} — the `[[ULID...]]` cache-miss fallback, or the
 * "Untitled" placeholder a seeder stored), we fall back to the block's own
 * content. The resolve store only preloads pages + tags + links from the
 * current page — query results often include blocks from other pages that
 * are never populated, so the cache miss is the normal case for cross-page
 * query results.
 *
 * # The 80-char budget applies to the FALLBACK, not to a cache hit
 *
 * `truncateContent(…, 80)` bounds the fallback. A cache HIT is rendered
 * verbatim, and since #4228 a stored title is already capped at 60 (57 +
 * ellipsis, first line only) — so a resolved content block renders at most
 * 60 here, not 80. That is a real narrowing for rows whose target happened
 * to be seeded: before #4228 `useBacklinkResolution` stored raw content, so
 * such a row rendered the full 80.
 *
 * It is the cost of the store having ONE title rather than one per surface,
 * which is what #4228 bought. A row that wants more than the stored title
 * would have to re-read the block — a different design, and still an open
 * trade-off: #4238 settled who OWNS the title (and moved the cache-miss
 * signal off it), not how wide it is. Stated here because the budget in the
 * line below is otherwise read as the row's, and it is not.
 *
 * # A null-content page or tag renders the empty marker HERE only
 *
 * `preload` stores such a row as "Untitled", which `isSyntheticTitle` now
 * classes synthetic, so it takes the fallback and `truncateContent(null, 80)`
 * yields the empty marker — while every other surface shows the placeholder.
 * Pinned by test, so it is a decision rather than a surprise; it agrees with
 * the UNCACHED blank row, which already rendered the marker.
 *
 * # `title` is a PLAIN string; `displayMarkdown` is what the row renders
 *
 * #4719 — on the fallback arm the row must render the block's content as
 * rich content (a `[[ULID]]` is a titled chip, a leading `- ` or `# ` is
 * downgraded by `inline`), not as the bracket-stripped plain text `title`
 * carries. But `title` is still needed as a string: it is the row's
 * accessible name in `QueryResultList` and the content cell's in
 * `QueryResultTable`, and an element tree cannot serve there.
 *
 * So this returns both, and they are not two spellings of one value:
 *  - `title` — plain, capped at 80, inline references resolved to their
 *    titles ({@link resolveInlineRefs}). This is the row's / cell's
 *    accessible name, and the only thing a string is still needed for.
 *  - `displayMarkdown` — the block's RAW content markdown when the fallback
 *    arm was taken and there is content to show, else `null`. `null` means
 *    "render `title` as text": either the resolver hit (the stored title is
 *    already a normalised one-line title, not markdown) or the block has no
 *    content (`title` is then the empty marker).
 *
 * The 80-char budget documented above is therefore the NAME's, not the
 * rendered row's: the rich body renders the whole content string and the
 * row's own `truncate` clamps it, exactly as the agenda alert rows do
 * (`AlertSection`, #4705).
 *
 * # `resolveRefTitle` is a SEPARATE resolver from `resolveBlockTitle`
 *
 * The two answer different questions and one of them is optional. This row's
 * OWN title comes from `resolveBlockTitle`, which only the editor call path
 * passes (`StaticQueryBlock` / `EditableBlock` → `QueryResult`);
 * `AdvancedQueryView` and `GroupedResults` render the same list with no such
 * prop, and always take the content-fallback arm. But the row BODY resolves
 * its chips through `useRichContentCallbacks` in every one of those callers,
 * so with a single resolver the name of an AdvancedQuery row went back to
 * carrying the raw ULID while the chip beside it read "Quarterly Plan" —
 * the exact 2.5.3 break this function's `resolveInlineRefs` exists to
 * prevent, on half the call sites.
 *
 * So the reference substitution takes its own resolver, and both components
 * pass the CHIP's one (`useRichContentCallbacks().resolveBlockTitle`, with
 * `renderBlockLink`'s own `unresolvedBlockLabel` fallback for a miss).
 * It defaults to `resolveBlockTitle` so a caller that has only the one — the
 * unit tests, and any future caller with a single resolver — keeps the old
 * behaviour.
 */
export function resolveBlockDisplay(
  block: BlockRow,
  pageTitles: Map<string, string>,
  resolveBlockTitle?: ((id: string) => string) | undefined,
  resolveRefTitle: ((id: string) => string) | undefined = resolveBlockTitle,
): { title: string; displayMarkdown: string | null; pageTitle: string | undefined } {
  const resolved = resolveBlockTitle ? resolveBlockTitle(block.id) : ''
  const useResolved = Boolean(resolved) && !isSyntheticTitle(resolved)
  const contentFallback = truncateContent(
    block.content ? resolveInlineRefs(block.content, resolveRefTitle) : block.content,
    80,
  )
  const title = useResolved ? resolved : contentFallback
  // Empty content collapses to `null` (not `''`) so the caller has ONE test
  // for "render `title` as text": `renderRichContent('')` returns null and
  // would leave the row with no body at all.
  const displayMarkdown = useResolved || !block.content ? null : block.content

  const pageTitle = block.page_id ? pageTitles.get(block.page_id) : undefined

  return { title, displayMarkdown, pageTitle }
}

/**
 * Navigate to the parent page of a block, if the block has a page_id and an
 * onNavigate callback is provided.
 */
export function handleBlockNavigation(
  block: BlockRow,
  onNavigate?: ((pageId: string) => void) | undefined,
): void {
  if (block.page_id && onNavigate) {
    onNavigate(block.page_id)
  }
}
