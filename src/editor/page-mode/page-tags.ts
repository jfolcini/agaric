/**
 * Page mode's typed tags (#5743): a `#name` a block holds as text becomes the
 * tag it names through block mode's own commit (`commitTypedTags`): the
 * existing tag of that name in any case, else a new one, in the active space.
 * The editor runs it for a block once its text is saved and the caret has left
 * it, block mode's moment. The edit goes through the block commands; bringing
 * the page in afterwards patches the block's text in place, outside undo
 * history, as a change from elsewhere is (`remote-patch.ts`).
 */

import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import type { OpRef } from '@/lib/bindings'
import { bumpFlushSeq, commitTypedTags } from '@/stores/inline-property-commit'
import { tagsWrittenAsText } from '@/stores/unmount-flush'

/**
 * Write the tags block `id` holds as text, as last saved, as the tags they
 * name. Resolves the edit's refs, none when nothing was written.
 */
export async function commitPageTags(
  id: string,
  save: PageSaveState,
  api: PageSaveApi,
): Promise<OpRef[]> {
  const saved = save.saved.get(id)
  if (saved === undefined) return []
  const tags = tagsWrittenAsText(saved.markdown)
  if (tags.length === 0) return []
  const refs: OpRef[] = []
  await commitTypedTags({
    blockId: id,
    content: saved.markdown,
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
