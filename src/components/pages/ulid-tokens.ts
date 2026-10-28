/**
 * The ULIDs *Edit as Markdown* leaves in its text (#5686): `[[ULID]]`,
 * `[[ULID|label]]`, `#[ULID]` and `((ULID))`, and a `key:: ULID` property value.
 * The render writes a title wherever the save reads it back to the same id, so
 * what stays an id is a block ref, a ref property, or a link or tag whose title
 * would not (a duplicate, another space's, a deleted one). The buffer shows each
 * one's title beside it and keeps it whole (`@/editor/source-buffer-ulids`);
 * this module has no editor in it, so the save path reaches it without loading
 * TipTap.
 */

import { fetchAndCacheLinks } from '@/components/block-tree/use-block-link-resolve'
import {
  unresolvedBlockLabel,
  unresolvedBlockRefLabel,
  unresolvedTagLabel,
} from '@/lib/block-title'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

export type UlidTokenKind = 'link' | 'tag' | 'ref' | 'property'

export interface UlidToken {
  kind: UlidTokenKind
  id: string
  /** Offset of the token's first character in the text it was found in. */
  from: number
  /** Offset just past its last character. */
  to: number
}

/** A ULID's shape, as the link scanner (`use-block-link-resolve`) reads it. */
const ULID = '[0-9A-Z]{26}'
/** A link's label runs to the first `]`, which must close it, as `tryConsumeBlockLink` reads it. */
const BRACKET_TOKEN_RE = new RegExp(
  String.raw`\[\[(${ULID})(?:\|[^\]\n]*)?\]\]|#\[(${ULID})\]|\(\((${ULID})\)\)`,
  'g',
)
/** A property line (`split_property_line` in `import.rs`) whose value is one ULID. */
const PROPERTY_TOKEN_RE = new RegExp(
  String.raw`^([ \t]*[A-Za-z0-9_-]{1,64}::[ \t]+)(${ULID})[ \t]*$`,
  'gm',
)

/** The ULID tokens in `text`, in order. A token never spans a line break. */
export function findUlidTokens(text: string): UlidToken[] {
  const tokens: UlidToken[] = []
  for (const m of text.matchAll(BRACKET_TOKEN_RE)) {
    const [whole, link, tag, ref] = m
    const kind: UlidTokenKind = link !== undefined ? 'link' : tag !== undefined ? 'tag' : 'ref'
    const id = (link ?? tag ?? ref) as string
    tokens.push({ kind, id, from: m.index, to: m.index + whole.length })
  }
  for (const m of text.matchAll(PROPERTY_TOKEN_RE)) {
    const from = m.index + (m[1] as string).length
    const id = m[2] as string
    tokens.push({ kind: 'property', id, from, to: from + id.length })
  }
  return tokens.toSorted((a, b) => a.from - b.from)
}

/**
 * Ask the backend, in one `batch_resolve`, for the tokens' ids the resolve
 * store has no answer for. A malformed id is asked too: the backend reads it
 * leniently and returns nothing for it.
 */
export async function resolveUlidTokens(tokens: readonly UlidToken[]): Promise<void> {
  const store = useResolveStore.getState()
  const ids = new Set(tokens.flatMap((t) => (store.has(t.id) ? [] : [t.id])))
  if (ids.size === 0) return
  const spaceId = useSpaceStore.getState().currentSpaceId
  await fetchAndCacheLinks(ids, spaceId, () => useSpaceStore.getState().currentSpaceId !== spaceId)
}

export interface UlidTokenHint {
  label: string
  deleted: boolean
}

function fallbackLabel(token: UlidToken): string {
  if (token.kind === 'tag') return unresolvedTagLabel(token.id)
  if (token.kind === 'ref') return unresolvedBlockRefLabel(token.id)
  return unresolvedBlockLabel(token.id)
}

/**
 * What the buffer shows beside `token`: its target's title, or the chip's
 * fallback label for a target nothing resolves, both marked deleted as a chip
 * is. `null` while its id has not been asked about yet.
 */
export function ulidTokenHint(token: UlidToken): UlidTokenHint | null {
  const store = useResolveStore.getState()
  if (store.isResolved(token.id)) {
    return {
      label: store.resolveTitle(token.id),
      deleted: store.resolveStatus(token.id) === 'deleted',
    }
  }
  if (!store.has(token.id)) return null
  return { label: fallbackLabel(token), deleted: true }
}

/**
 * The tokens in `text` whose id resolves to nothing, unknown or malformed: the
 * backend returned nothing for it. A deleted target still resolves. An id the
 * store could not ask about (no space, a failed request) is not reported.
 */
export async function findUnresolvedUlidTokens(text: string): Promise<UlidToken[]> {
  const tokens = findUlidTokens(text)
  await resolveUlidTokens(tokens)
  const store = useResolveStore.getState()
  return tokens.filter((t) => store.has(t.id) && !store.isResolved(t.id))
}
