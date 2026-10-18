/**
 * The commits page mode runs for a block the caret has left (#5743), in block
 * mode's order.
 */

import type { Node as PMNode } from '@tiptap/pm/model'

import { commitPageProperties } from '@/editor/page-mode/page-properties'
import type { PageSaveApi, PageSaveState } from '@/editor/page-mode/page-save'
import { commitPageTags } from '@/editor/page-mode/page-tags'
import { commitPageTask } from '@/editor/page-mode/page-tasks'
import type { OpRef } from '@/lib/bindings'
import type { PageBlockStoreLike } from '@/stores/inline-property-commit'

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
