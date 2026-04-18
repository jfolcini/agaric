/**
 * Template-picker state + selection handler for slash commands.
 *
 * Owns the `templatePickerOpen` / `templatePages` state so the main
 * `useBlockSlashCommands` orchestrator can stay focused on command dispatch.
 * `openTemplatePicker` is called from `/template` slash command; the returned
 * `handleTemplateSelect` is passed to the template picker UI for user clicks.
 */

import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { insertTemplateBlocks, loadTemplatePagesWithPreview } from '../lib/template-utils'
import { useResolveStore } from '../stores/resolve'

export type TemplatePagePreview = { id: string; content: string; preview: string | null }

export interface UseTemplateSelectionParams {
  focusedBlockId: string | null
  rootParentId: string | null
  blocks: Array<{ id: string; parent_id: string | null; content: string | null }>
  load: () => Promise<void>
  // biome-ignore lint/suspicious/noExplicitAny: TFunction overload set is too complex
  t: (...args: any[]) => any
}

export interface UseTemplateSelectionReturn {
  templatePickerOpen: boolean
  templatePages: TemplatePagePreview[]
  setTemplatePickerOpen: (open: boolean) => void
  /** Called from /template slash command — loads previews and opens picker. */
  openTemplatePicker: () => Promise<void>
  /** Called when user chooses a template from the picker UI. */
  handleTemplateSelect: (templatePageId: string) => Promise<void>
}

export function useTemplateSelection({
  focusedBlockId,
  rootParentId,
  blocks,
  load,
  t,
}: UseTemplateSelectionParams): UseTemplateSelectionReturn {
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templatePages, setTemplatePages] = useState<TemplatePagePreview[]>([])

  const openTemplatePicker = useCallback(async () => {
    try {
      const pages = await loadTemplatePagesWithPreview()
      if (pages.length === 0) {
        toast.error(t('slash.noTemplates'))
        return
      }
      setTemplatePages(pages)
      setTemplatePickerOpen(true)
    } catch {
      toast.error(t('slash.templateLoadFailed'))
    }
  }, [t])

  const handleTemplateSelect = useCallback(
    async (templatePageId: string) => {
      setTemplatePickerOpen(false)
      if (!focusedBlockId) return
      const block = blocks.find((b) => b.id === focusedBlockId)
      if (!block) return
      try {
        const parentId = block.parent_id ?? rootParentId
        if (!parentId) return
        const pageTitle = useResolveStore.getState().cache.get(rootParentId ?? '')?.title ?? ''
        const ids = await insertTemplateBlocks(templatePageId, parentId, {
          pageTitle,
        })
        if (ids.length > 0) {
          await load()
          toast.success(t('slash.templateInserted'))
        }
      } catch {
        toast.error(t('slash.templateInsertFailed'))
      }
    },
    [focusedBlockId, blocks, rootParentId, load, t],
  )

  return {
    templatePickerOpen,
    templatePages,
    setTemplatePickerOpen,
    openTemplatePicker,
    handleTemplateSelect,
  }
}
