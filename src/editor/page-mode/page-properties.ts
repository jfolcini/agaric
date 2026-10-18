/**
 * Page mode's block properties (#5743). A block's properties are the property
 * commands', not the document's, as its task is (`page-tasks.ts`): page mode
 * reads them with the page (`readPageFit`) and again each time it brings the
 * page in, and each block's row draws them as block mode's does: the property
 * chips and the repeat rule (`BlockMetadataRow`). A chip opens block mode's
 * property editor, and the `+N` pill its property drawer.
 *
 * A `key:: value` line typed into a block becomes the property once the caret
 * has left the block, through block mode's own commit
 * (`commitInlineProperties`): only a line whose key the block did not hold as
 * text before it was edited, as block mode's `classifyUnmountFlush` decides.
 */

import type { Node as PMNode } from '@tiptap/pm/model'

import { serialize } from '@/editor/markdown-serializer'
import { blockDocJson } from '@/editor/page-mode/page-document'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import { extraPropertiesOf, type InlineProperty } from '@/hooks/useExtraBlockProperties'
import type { OpRef, PropertyRow } from '@/lib/bindings'
import { bumpFlushSeq, commitInlineProperties } from '@/stores/inline-property-commit'
import { addedInlineProperties } from '@/stores/unmount-flush'

const NONE: InlineProperty[] = []

/** The page's block properties as block mode's row draws them, by block id. */
export class PageProperties {
  private shown = new Map<string, InlineProperty[]>()
  private readonly listeners = new Set<() => void>()

  constructor(rows: Record<string, PropertyRow[]>) {
    this.take(rows)
  }

  of(id: string): InlineProperty[] {
    return this.shown.get(id) ?? NONE
  }

  /** Hold what a read of the page found, and tell the listeners. */
  take(rows: Record<string, PropertyRow[]>): void {
    this.shown = new Map()
    for (const [id, list] of Object.entries(rows)) {
      const shown = extraPropertiesOf(list)
      if (shown.length > 0) this.shown.set(id, shown)
    }
    for (const listener of this.listeners) listener()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/**
 * Make the `key:: value` lines block `id` holds as text, as last saved or as
 * `markdown` when a commit wrote it since, its properties, through block
 * mode's commit: each property, then the text without the lines written. Only
 * a line whose key `loaded`, the block before it was edited (none for a new
 * block), did not hold counts. Resolves the edit's refs, and the block's text
 * as it now stands.
 */
export async function commitPageProperties(
  id: string,
  loaded: PMNode | null,
  save: PageSaveState,
  api: PageSaveApi,
  markdown = save.saved.get(id)?.markdown,
): Promise<{ refs: OpRef[]; markdown: string | undefined }> {
  if (markdown === undefined) return { refs: [], markdown }
  const before = loaded === null ? '' : serialize(blockDocJson(loaded))
  const inlineProps = addedInlineProperties(before, markdown)
  if (inlineProps.length === 0) return { refs: [], markdown }
  const refs: OpRef[] = []
  let written = markdown
  await commitInlineProperties({
    blockId: id,
    content: markdown,
    inlineProps,
    mySeq: bumpFlushSeq(id),
    edit: async (_, text) => {
      // Every line refused: the text stays as it is saved.
      if (text === written) return true
      refs.push(...(await api.edit(id, text)))
      save.writes += 1
      written = text
      return true
    },
    rootParentId: save.pageId,
  })
  return { refs, markdown: written }
}
