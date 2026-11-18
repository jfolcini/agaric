/**
 * useMirrorIngestEvents — a page file edited outside Agaric and read back
 * into its page by the Markdown mirror (#5363) lands on that page's undo
 * stack, so Undo on that page reverts it, and a save that kept something
 * other than as written says so: one toast, naming a single file and counting
 * several, so an autosaving editor or a folder synced in at once updates it
 * (#6870).
 *
 * A page the folder trashed, renamed or created is said the same way, in a
 * notice of its own (#6887): one page is named, several are counted by what
 * happened to them, and one trashed offers to open the Trash, where it is
 * restored, and keeps the notice up until closed: the folder changes while the
 * user works in another app. Its Undo sits on that page's own stack, which a
 * trashed page no longer shows.
 */
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { useTauriEventListener } from '@/hooks/useTauriEventListener'
import type { OpRef, PageSourceReport } from '@/lib/bindings'
import { notify } from '@/lib/notify'
import { clampText, clampTextEnd } from '@/lib/text-utils'
import { useNavigationStore } from '@/stores/navigation'
import { notifyUndoNewAction } from '@/stores/page-blocks-reducers'

/** Emitted by `mirror::ingest` once an ingest's save has committed. */
export const MIRROR_INGESTED_EVENT = 'mirror:ingested'

/** `mirror::ingest::IngestKind`: what the change in the folder did to its page. */
export type MirrorIngestKind = 'edited' | 'created' | 'renamed' | 'trashed'

export interface MirrorIngested {
  kind: MirrorIngestKind
  page_id: string
  path: string
  op_refs: OpRef[]
  report: PageSourceReport
}

type FolderChange = Exclude<MirrorIngestKind, 'edited'>

const MIRROR_WARNINGS_TOAST_ID = 'mirror-ingest-warnings'
const MIRROR_READ_BACK_TOAST_ID = 'mirror-read-back'

const NAMED_KEY = {
  trashed: 'data.mirrorReadBackTrashed',
  renamed: 'data.mirrorReadBackRenamed',
  created: 'data.mirrorReadBackCreated',
} as const satisfies Record<FolderChange, string>

const COUNT_KEY = {
  trashed: 'data.mirrorReadBackTrashedCount',
  renamed: 'data.mirrorReadBackRenamedCount',
  created: 'data.mirrorReadBackCreatedCount',
} as const satisfies Record<FolderChange, string>

export function useMirrorIngestEvents(): void {
  const { t, i18n } = useTranslation()
  // The files the warnings toast is up for; empty while it is not.
  const shownPaths = useRef(new Set<string>())
  // The pages the read-back notice is up for, by id; empty while it is not.
  const shownPages = useRef(new Map<string, { kind: FolderChange; path: string }>())

  const sayFolderChange = (kind: FolderChange, pageId: string, path: string): void => {
    shownPages.current.set(pageId, { kind, path })
    // sonner's action button closes the toast without calling `onDismiss`.
    const closed = () => {
      shownPages.current.clear()
    }
    const pages = [...shownPages.current.values()]
    const [only] = pages
    const message =
      pages.length === 1 && only !== undefined
        ? t(NAMED_KEY[only.kind], { path: clampTextEnd(only.path, 60) })
        : t('data.mirrorReadBackSeveral', {
            changes: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
              (['trashed', 'renamed', 'created'] as const)
                .map((each) => [each, pages.filter((page) => page.kind === each).length] as const)
                .filter(([, count]) => count > 0)
                .map(([each, count]) => t(COUNT_KEY[each], { count })),
            ),
          })
    const opts = { id: MIRROR_READ_BACK_TOAST_ID, onDismiss: closed, onAutoClose: closed }
    if (pages.some((page) => page.kind === 'trashed')) {
      notify.warning(message, {
        ...opts,
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: t('palette.cmdGoTrash'),
          onClick: () => {
            closed()
            useNavigationStore.getState().setView('trash')
          },
        },
      })
    } else {
      notify.info(message, opts)
    }
  }

  useTauriEventListener<MirrorIngested>(MIRROR_INGESTED_EVENT, ({ payload }) => {
    const { kind, page_id, path, op_refs, report } = payload
    if (op_refs.length > 0) notifyUndoNewAction(page_id, op_refs, undefined, { merge: false })
    if (kind !== 'edited') sayFolderChange(kind, page_id, path)
    const [first] = report.warnings
    if (first !== undefined) {
      shownPaths.current.add(path)
      const closed = () => {
        shownPaths.current.clear()
      }
      notify.warning(
        shownPaths.current.size === 1
          ? t('data.mirrorIngestedWarnings', {
              path: clampTextEnd(path, 60),
              first: clampText(first, 80),
              count: report.warnings.length,
            })
          : t('data.mirrorIngestedWarningsFiles', { count: shownPaths.current.size }),
        { id: MIRROR_WARNINGS_TOAST_ID, onDismiss: closed, onAutoClose: closed },
      )
    }
  })
}
