/**
 * useMirrorIngestEvents — a page file edited outside Agaric and read back
 * into its page by the Markdown mirror (#5363) lands on that page's undo
 * stack, so one Ctrl+Z reverts it, and a save that kept something other than
 * as written says so: one toast, naming a single file and counting several,
 * so an autosaving editor or a folder synced in at once updates it (#6870).
 */
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import type { OpRef, PageSourceReport } from '@/lib/bindings'
import { notify } from '@/lib/notify'
import { clampText } from '@/lib/text-utils'
import { notifyUndoNewAction } from '@/stores/page-blocks-reducers'

/** Emitted by `mirror::ingest` once an ingest's save has committed. */
export const MIRROR_INGESTED_EVENT = 'mirror:ingested'

export interface MirrorIngested {
  page_id: string
  path: string
  op_refs: OpRef[]
  report: PageSourceReport
}

const MIRROR_WARNINGS_TOAST_ID = 'mirror-ingest-warnings'

export function useMirrorIngestEvents(): void {
  const { t } = useTranslation()
  // The files the warnings toast is up for; empty while it is not.
  const shownPaths = useRef(new Set<string>())
  useTauriEventListener<MirrorIngested>(MIRROR_INGESTED_EVENT, ({ payload }) => {
    const { page_id, path, op_refs, report } = payload
    if (op_refs.length > 0) notifyUndoNewAction(page_id, op_refs, undefined, { merge: false })
    const [first] = report.warnings
    if (first !== undefined) {
      shownPaths.current.add(path)
      const closed = () => {
        shownPaths.current.clear()
      }
      notify.warning(
        shownPaths.current.size === 1
          ? t('data.mirrorIngestedWarnings', {
              path: clampText(path, 60),
              first: clampText(first, 80),
              count: report.warnings.length,
            })
          : t('data.mirrorIngestedWarningsFiles', { count: shownPaths.current.size }),
        { id: MIRROR_WARNINGS_TOAST_ID, onDismiss: closed, onAutoClose: closed },
      )
    }
  })
}
