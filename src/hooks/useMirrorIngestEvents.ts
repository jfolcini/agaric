/**
 * useMirrorIngestEvents — a page file edited outside Agaric and read back
 * into its page by the Markdown mirror (#5363) lands on that page's undo
 * stack, so one Ctrl+Z reverts it, and a save that kept something other than
 * as written says so.
 */
import { useTranslation } from 'react-i18next'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import type { OpRef, PageSourceReport } from '@/lib/bindings'
import { notify } from '@/lib/notify'
import { notifyUndoNewAction } from '@/stores/page-blocks-reducers'

/** Emitted by `mirror::ingest` once an ingest's save has committed. */
export const MIRROR_INGESTED_EVENT = 'mirror:ingested'

export interface MirrorIngested {
  page_id: string
  path: string
  op_refs: OpRef[]
  report: PageSourceReport
}

export function useMirrorIngestEvents(): void {
  const { t } = useTranslation()
  useTauriEventListener<MirrorIngested>(MIRROR_INGESTED_EVENT, ({ payload }) => {
    const { page_id, path, op_refs, report } = payload
    if (op_refs.length > 0) notifyUndoNewAction(page_id, op_refs, undefined, { merge: false })
    const [first] = report.warnings
    if (first !== undefined) {
      notify.warning(
        t('data.mirrorIngestedWarnings', { path, first, count: report.warnings.length }),
      )
    }
  })
}
