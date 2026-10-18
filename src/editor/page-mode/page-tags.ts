/**
 * Page mode's typed tags (#5743): a `#name` a block holds as text becomes the
 * tag it names through block mode's own commit (`commitTypedTags`): the
 * existing tag of that name in any case, else a new one, in the active space.
 * The editor runs it for a block once its text is saved and the caret has left
 * it, block mode's moment. The edit goes through the block commands; bringing
 * the page in afterwards patches the block's text in place, outside undo
 * history, as a change from elsewhere is (`remote-patch.ts`).
 */

import type { Node as PMNode } from '@tiptap/pm/model'

import { commitPageProperties } from '@/editor/page-mode/page-properties'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import { commitPageTask } from '@/editor/page-mode/page-tasks'
import type { OpRef } from '@/lib/bindings'
import {
  bumpFlushSeq,
  commitTypedTags,
  type PageBlockStoreLike,
} from '@/stores/inline-property-commit'
import { tagsWrittenAsText } from '@/stores/unmount-flush'

/**
 * Write the tags block `id` holds as text, as last saved or as `markdown` when
 * a commit wrote it since, as the tags they name. Resolves the edit's refs,
 * none when nothing was written.
 */
export async function commitPageTags(
  id: string,
  save: PageSaveState,
  api: PageSaveApi,
  markdown = save.saved.get(id)?.markdown,
): Promise<OpRef[]> {
  if (markdown === undefined) return []
  const tags = tagsWrittenAsText(markdown)
  if (tags.length === 0) return []
  const refs: OpRef[] = []
  await commitTypedTags({
    blockId: id,
    content: markdown,
    tags,
    textSaved: Promise.resolve(true),
    mySeq: bumpFlushSeq(id),
    edit: async (_, named) => {
      refs.push(...(await api.edit(id, named)))
      save.writes += 1
      return true
    },
  })
  return refs
}

/**
 * Commit what block `id`, left since it was `loaded`, holds as text: its task
 * marker, then its `key:: value` lines, then its tags, each on the text the
 * one before it wrote, as block mode's `runUnmountFlush` does. Resolves the
 * edits' refs.
 */
export async function commitPageTyped(
  id: string,
  loaded: PMNode | null,
  save: PageSaveState,
  api: PageSaveApi,
  pageStore: PageBlockStoreLike,
): Promise<OpRef[]> {
  const task = await commitPageTask(id, loaded, save, api, pageStore)
  const lines = await commitPageProperties(id, loaded, save, api, task.markdown)
  return [...task.refs, ...lines.refs, ...(await commitPageTags(id, save, api, lines.markdown))]
}
