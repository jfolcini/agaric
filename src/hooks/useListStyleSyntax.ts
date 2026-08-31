/**
 * List-style syntax handler (#4552) — invoked when the block-level `1. ` /
 * `- ` input rule (`list-style-input-rule.ts`) detects a marker typed at the
 * start of a block and strips it. Persists the block's `listStyle` property,
 * mirroring `useCheckboxSyntax`'s shape (checkbox syntax is the existing
 * precedent for "a typed markdown-ish prefix commits an immediate property
 * write, not a content edit").
 */

import { useCallback, useRef } from 'react'

import { setListStyle } from '@/lib/list-style'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'

export interface UseListStyleSyntaxParams {
  focusedBlockId: string | null
  t: (key: string) => string
}

export type ListStyleSyntaxHandler = (style: 'bullet' | 'ordered') => void

export function useListStyleSyntax({
  focusedBlockId,
  t,
}: UseListStyleSyntaxParams): ListStyleSyntaxHandler {
  // Re-entrancy guard, mirroring `useCheckboxSyntax`: prevents a rapid
  // double-fire on the same block from queueing two in-flight writes.
  const inProgress = useRef(false)

  return useCallback(
    (style: 'bullet' | 'ordered') => {
      if (!focusedBlockId) return
      if (inProgress.current) return
      inProgress.current = true
      setListStyle(focusedBlockId, style)
        .catch((err: unknown) => {
          logger.error('useListStyleSyntax', 'setListStyle failed', { focusedBlockId, style }, err)
          notify.error(t('blockTree.setListStyleFailed'))
        })
        .finally(() => {
          inProgress.current = false
        })
    },
    [focusedBlockId, t],
  )
}
