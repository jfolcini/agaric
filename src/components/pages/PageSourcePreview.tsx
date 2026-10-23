/**
 * PageSourcePreview — the *Edit as Markdown* buffer as the page shows its
 * blocks (#5160): each block the buffer's toolbar reads (`readBlocks`) at its
 * depth, with its task checkbox, its text through the static block renderer
 * and its property lines as chips; the front matter's lines as the page's
 * property chips. A `[[Name]]` or `#name` (`scanNameTokens`) shows as the chip
 * of the page or tag the save would link: one the resolve cache holds by that
 * title, or else one the save would create.
 *
 * The save reads the buffer with the backend's grammar, so where the two
 * readers differ (a heading typed without a bullet owning what follows it,
 * aliases, the property values a definition refuses) the saved page can
 * differ from this.
 */

import type React from 'react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { EmptyState } from '@/components/common/EmptyState'
import { TaskCheckbox } from '@/components/editor/BlockInlineControls'
import { ListMarker } from '@/components/editor/ListMarker'
import { PropertyChip } from '@/components/properties/PropertyChip'
import { renderRichContent } from '@/components/RichContentRenderer'
import type { SourceLines } from '@/editor/source-buffer'
import { frontMatterProperties, readBlocks } from '@/editor/source-buffer-blocks'
import { useRichContentCallbacks } from '@/hooks/useRichContentCallbacks'
import { linkBodyReadings, normalizeTagName, scanNameTokens } from '@/lib/name-tokens'
import { useResolveStore } from '@/stores/resolve'
import { useSpaceStore } from '@/stores/space'

/** Ids for the names the save would create: no ULID starts above `7`. */
const NEW_NAME_ID_PREFIX = 'ZZZZZZZZZZZZZZZZ'

/** The names the save would create, each with the id it shows under, and back. */
interface NewNames {
  ids: Map<string, string>
  titles: Map<string, string>
}

export function emptyNewNames(): NewNames {
  return { ids: new Map(), titles: new Map() }
}

/**
 * `content` with each `[[Name]]` and `#name` written as the stored token of
 * the id `idOf` gives its name, or else of its id in `newNames`: `[[ID]]`
 * (`[[ID|label]]` with a label) and `#[ID]`. A link tries each reading of its
 * body (`linkBodyReadings`) in turn.
 */
export function withNameIds(
  content: string,
  idOf: (name: string) => string | null,
  newNames: NewNames,
): string {
  let out = ''
  let at = 0
  for (const token of scanNameTokens(content)) {
    out += content.slice(at, token.start)
    at = token.end
    if (token.kind === 'tag') {
      out += `#[${idOf(token.name) ?? newNameId(newNames, token.name)}]`
      continue
    }
    const reading = linkBodyReadings(token.body).find(({ name }) => idOf(name) !== null)
    const name = reading?.name ?? token.name
    const label = reading === undefined ? token.label : reading.label
    const id = idOf(name) ?? newNameId(newNames, name)
    out += label === undefined ? `[[${id}]]` : `[[${id}|${label}]]`
  }
  return out + content.slice(at)
}

/** The id a name the save would create shows under, the same one each time. */
function newNameId({ ids, titles }: NewNames, name: string): string {
  const known = ids.get(name)
  if (known !== undefined) return known
  const id = NEW_NAME_ID_PREFIX + String(ids.size).padStart(10, '0')
  ids.set(name, id)
  titles.set(id, name)
  return id
}

/** Titles the resolve cache holds in the active space, exact first, then folded as a tag name is. */
function useTitleIds(): (name: string) => string | null {
  const cache = useResolveStore((s) => s.cache)
  const version = useResolveStore((s) => s.version)
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  return useMemo(() => {
    const prefix = `${spaceId ?? '__global__'}::`
    const exact = new Map<string, string>()
    const folded = new Map<string, string>()
    for (const [key, entry] of cache) {
      if (!key.startsWith(prefix) || entry.deleted) continue
      const id = key.slice(prefix.length)
      if (!exact.has(entry.title)) exact.set(entry.title, id)
      const fold = normalizeTagName(entry.title)
      if (!folded.has(fold)) folded.set(fold, id)
    }
    return (name: string) => exact.get(name) ?? folded.get(normalizeTagName(name)) ?? null
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the cache Map is mutated in place; `version` is what changes when it does.
  }, [cache, version, spaceId])
}

export function PageSourcePreview({ lines }: { lines: SourceLines }): React.ReactElement {
  const { t } = useTranslation()
  const callbacks = useRichContentCallbacks()
  const idOf = useTitleIds()
  const [newNames] = useState(emptyNewNames)
  const { blocks, pageProperties } = useMemo(() => {
    const texts = lines.text.split('\n')
    return {
      blocks: readBlocks(texts, lines.lineIds),
      pageProperties: frontMatterProperties(texts),
    }
  }, [lines])

  const options = {
    interactive: false,
    resolveBlockTitle: (id: string) => newNames.titles.get(id) ?? callbacks.resolveBlockTitle(id),
    resolveTagName: (id: string) => newNames.titles.get(id) ?? callbacks.resolveTagName(id),
    resolveBlockStatus: (id: string) =>
      newNames.titles.has(id) ? ('active' as const) : callbacks.resolveBlockStatus(id),
    resolveTagStatus: (id: string) =>
      newNames.titles.has(id) ? ('active' as const) : callbacks.resolveTagStatus(id),
  }
  const ordinals: number[] = []

  return (
    <section
      aria-label={t('pageSource.preview')}
      data-testid="page-source-preview"
      className="flex min-h-[50vh] flex-col gap-0.5 rounded-md border border-input px-1 py-2"
    >
      {pageProperties.length > 0 && (
        <div className="flex flex-wrap gap-1 px-3 pb-2">
          {pageProperties.map(([key, value], i) => (
            // oxlint-disable-next-line react/no-array-index-key -- a key may be written twice; the save refuses it, the preview shows both
            <PropertyChip key={`${key}-${i}`} propKey={key} value={value} />
          ))}
        </div>
      )}
      {blocks.length === 0 && (
        <EmptyState compact headingLevel="p" message={t('pageSource.previewEmpty')} />
      )}
      {blocks.map((block, i) => {
        ordinals.length = block.depth + 1
        const ordinal = block.listStyle === 'ordered' ? (ordinals[block.depth] ?? 0) + 1 : 0
        ordinals[block.depth] = ordinal
        return (
          <div
            // oxlint-disable-next-line react/no-array-index-key -- a preview row has no id of its own; it is rebuilt with the text
            key={i}
            data-testid="page-source-preview-block"
            className="flex flex-wrap items-baseline gap-x-2 rounded-md px-3 py-1 leading-normal"
            style={{ marginInlineStart: `${block.depth * 1.5}rem` }}
          >
            {block.taskState !== null && (
              <span className="self-center">
                <TaskCheckbox state={block.taskState} />
              </span>
            )}
            <div className="block-static min-w-0 flex-1">
              <ListMarker style={block.listStyle} ordinal={ordinal} />
              {renderRichContent(withNameIds(block.text, idOf, newNames), options)}
            </div>
            {block.properties.map(([key, value], j) => (
              // oxlint-disable-next-line react/no-array-index-key -- a key may be written twice on a block
              <PropertyChip key={`${key}-${j}`} propKey={key} value={value} />
            ))}
          </div>
        )
      })}
    </section>
  )
}
