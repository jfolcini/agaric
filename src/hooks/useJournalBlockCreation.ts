/**
 * useJournalBlockCreation — orchestrates the daily-journal page-create +
 * template-load + block-insert flow used by JournalPage's "add block"
 * affordances and the auto-create-on-mount path.
 *
 * MAINT-119: previously inlined as `handleAddBlock` in `JournalPage.tsx`.
 * Extracted to keep the page component slim while preserving the
 * single-function ordering that handles atomic create-page-then-block,
 * optimistic state propagation, error rollback and per-space template
 * seeding.
 *
 * Inputs:
 *  - `pageMap` — the `dateStr→pageId` lookup owned by the caller (so the
 *    hook can avoid creating a duplicate page when one already exists).
 *  - `onPageCreated` — called when a new page is inserted, so the
 *    caller's pageMap state can include the new entry without waiting
 *    for a refetch.
 *
 * Returns:
 *  - `createdPages` — locally-tracked dateStr→pageId for pages this
 *    hook just created (so `JournalPage.makeDayEntry` can render the
 *    BlockTree immediately, before any refetch lands).
 *  - `handleAddBlock(dateStr)` — the orchestrator; idempotent against
 *    `pageMap`/`createdPages`, surface-level error reporting via toast.
 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { createBlock, createPageInSpace } from '../lib/tauri'
import {
  insertTemplateBlocks,
  insertTemplateBlocksFromString,
  loadJournalTemplate,
  loadJournalTemplateForSpace,
} from '../lib/template-utils'
import { useBlockStore } from '../stores/blocks'
import { pageBlockRegistry } from '../stores/page-blocks'
import { useResolveStore } from '../stores/resolve'
import { useSpaceStore } from '../stores/space'

interface UseJournalBlockCreationOpts {
  pageMap: Map<string, string>
  /** Called when a new page is inserted into the database. */
  onPageCreated: (dateStr: string, pageId: string) => void
}

export interface UseJournalBlockCreationResult {
  /** dateStr→pageId for pages created locally (not yet in pageMap). */
  createdPages: Map<string, string>
  /** Add a new block under `dateStr`'s page, creating the page if needed. */
  handleAddBlock: (dateStr: string) => Promise<void>
}

export function useJournalBlockCreation({
  pageMap,
  onPageCreated,
}: UseJournalBlockCreationOpts): UseJournalBlockCreationResult {
  const { t } = useTranslation()
  const [createdPages, setCreatedPages] = useState<Map<string, string>>(new Map())

  const handleAddBlock = useCallback(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: orchestrates atomic create-page-then-block flow with optimistic state, error rollback, retry, and per-space template seeding; splitting it would scatter the rollback paths across helpers and obscure ordering.
    async (dateStr: string) => {
      try {
        let pageId = createdPages.get(dateStr) ?? pageMap.get(dateStr) ?? null
        const isNewPage = !pageId

        if (!pageId) {
          // BUG-1 / H-3b — route page creation through `createPageInSpace`
          // so the new daily journal page lands with its `space` ref
          // property set atomically (CreateBlock + SetProperty in one tx).
          // The legacy `createBlock({ blockType: 'page' })` path leaked
          // unscoped pages that disappeared from the PageBrowser list.
          const currentSpaceId = useSpaceStore.getState().currentSpaceId
          if (currentSpaceId == null) {
            // SpaceStore not yet hydrated — surface the failure instead
            // of silently creating an unscoped page (the symptom we are
            // fixing). The boot path normally hydrates space store
            // before Journal mounts; this branch is a defence-in-depth.
            throw new Error('No active space; cannot create journal page')
          }
          const newId = await createPageInSpace({ content: dateStr, spaceId: currentSpaceId })
          // Defensive: if the IPC returned a non-string (mock leak, schema
          // drift, …) treat it as a failure so we don't seed `createdPages`
          // with a non-string and render a phantom page.
          if (typeof newId !== 'string' || newId.length === 0) {
            throw new Error('createPageInSpace returned no page ULID')
          }
          pageId = newId
          setCreatedPages((prev) => new Map(prev).set(dateStr, pageId as string))
          onPageCreated(dateStr, pageId)
          useResolveStore.getState().set(newId, dateStr, false)
        }

        if (isNewPage) {
          // FEAT-3p5b — per-space `journal_template` text property on the
          // space block takes precedence over the legacy global
          // `journal-template` page. Falls through to the legacy path on
          // any failure (defensive: a broken per-space property must not
          // strand the user with no journal blocks at all).
          let perSpaceTemplate: string | null = null
          const currentSpaceId = useSpaceStore.getState().currentSpaceId
          if (currentSpaceId != null) {
            try {
              perSpaceTemplate = await loadJournalTemplateForSpace(currentSpaceId)
            } catch (err) {
              logger.warn(
                'useJournalBlockCreation',
                'per-space journal template load failed; falling back to legacy',
                { spaceId: currentSpaceId },
                err,
              )
            }
          }

          if (perSpaceTemplate != null && perSpaceTemplate.trim() !== '') {
            const ids = await insertTemplateBlocksFromString(perSpaceTemplate, pageId, {
              pageTitle: dateStr,
            })
            await pageBlockRegistry.get(pageId)?.getState().load()
            if (ids.length > 0) {
              useBlockStore.setState({ focusedBlockId: ids[0] ?? null })
            }
          } else {
            const { template: journalTemplate, duplicateWarning } =
              await loadJournalTemplate(currentSpaceId)
            if (duplicateWarning) {
              toast.warning(duplicateWarning)
            }
            if (journalTemplate) {
              const ids = await insertTemplateBlocks(journalTemplate.id, pageId, currentSpaceId, {
                pageTitle: dateStr,
              })
              await pageBlockRegistry.get(pageId)?.getState().load()
              if (ids.length > 0) {
                useBlockStore.setState({ focusedBlockId: ids[0] ?? null })
              }
            } else {
              const block = await createBlock({
                blockType: 'content',
                content: '',
                parentId: pageId,
              })
              await pageBlockRegistry.get(pageId)?.getState().load()
              useBlockStore.setState({ focusedBlockId: block.id })
            }
          }
        } else {
          const block = await createBlock({
            blockType: 'content',
            content: '',
            parentId: pageId,
          })
          await pageBlockRegistry.get(pageId)?.getState().load()
          useBlockStore.setState({ focusedBlockId: block.id })
        }
      } catch (err) {
        logger.warn('useJournalBlockCreation', 'addBlock failed', undefined, err)
        toast.error(t('journal.addBlockFailed'))
      }
    },
    [createdPages, pageMap, onPageCreated, t],
  )

  return { createdPages, handleAddBlock }
}
