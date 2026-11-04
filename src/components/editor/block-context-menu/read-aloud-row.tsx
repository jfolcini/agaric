/**
 * BlockContextMenu — the *Read aloud* row (#5745), reading from the page store that holds the
 * block: on a block selection the selected blocks with their descendants; on the block being
 * edited with text selected, that text; otherwise the block with its descendants. Absent where
 * *Read aloud* cannot speak, and outside a page store (nothing to read from).
 */

import { Volume2 } from 'lucide-react'
import { useContext, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import type { MenuItem } from '@/components/editor/block-context-menu/types'
import {
  editorSelectionMarkdown,
  readSelectionAloud,
  readSubtreesAloud,
  useReadAloudSupported,
} from '@/hooks/useReadAloud'
import { computeSelectionRoots, type FlatBlock } from '@/lib/tree-utils'
import { PageBlockContext } from '@/stores/page-blocks'

export function useReadAloudRow(
  blockId: string,
  bulkIds: string[] | null,
  blocks: FlatBlock[],
  onClose: () => void,
): MenuItem | null {
  const { t } = useTranslation()
  const supported = useReadAloudSupported()
  const store = useContext(PageBlockContext)
  // As the menu opens: its rows take focus, which leaves the editor's selection where it is.
  const selection = useMemo(() => editorSelectionMarkdown(blockId), [blockId])
  if (!supported || store === null) return null
  const read = (): void => {
    if (bulkIds) readSubtreesAloud(blocks, computeSelectionRoots(blocks, bulkIds), store)
    else if (selection !== null) readSelectionAloud(blockId, selection, store)
    else readSubtreesAloud(blocks, [blockId], store)
  }
  return {
    id: 'readAloud',
    label: t(
      bulkIds
        ? 'readAloud.readSelected'
        : selection !== null
          ? 'readAloud.readSelection'
          : 'readAloud.read',
    ),
    icon: <Volume2 className="h-3.5 w-3.5" />,
    action: () => {
      read()
      onClose()
    },
  }
}
