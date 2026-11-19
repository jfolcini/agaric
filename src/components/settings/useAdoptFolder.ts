/**
 * useAdoptFolder — *Open a folder of notes* (#6540): one folder pick, its
 * notes imported into a new space named after it by the folder import, which
 * reads each file from disk as it goes, then a preview of what the mirror
 * would write, and on the user's word the folder adopted in place as that
 * space's mirror folder. A Logseq graph is refused before anything is
 * written: Logseq is import-only.
 */

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { folderGroup } from '@/components/settings/folder-group'
import { type UseImportRunner, useImportRunner } from '@/components/settings/useImportRunner'
import { unwrap } from '@/lib/app-error'
import { type AdoptionPreview, type FolderFile, type MirrorStatus, commands } from '@/lib/bindings'
import { formatErrorForDisplay } from '@/lib/error-display'
import { logger } from '@/lib/logger'
import { isLogseqGraph } from '@/lib/logseq-import'
import { notify } from '@/lib/notify'
import type { VaultEntry } from '@/lib/vault-import'
import { useSpaceStore } from '@/stores/space'

/** A folder imported and waiting on the user's word to be adopted. */
export interface AdoptionQuestion {
  folder: string
  /** The folder's own name, which the new space takes. */
  name: string
  spaceId: string
  files: { path: string; page_id: string }[]
  preview: AdoptionPreview
}

/** The folder's last segment, by either separator. */
export function folderName(folder: string): string {
  return (
    folder
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? folder
  )
}

/** `base64` as UTF-8 text. */
function decodeBase64(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (c) => c.codePointAt(0) ?? 0)
  return new TextDecoder().decode(bytes)
}

/** `file` of `folder` as the folder import reads a picked file, its bytes read on demand. */
export function diskEntry(folder: string, name: string, file: FolderFile): VaultEntry {
  const base64 = async () => unwrap(await commands.readAdoptionFile(folder, file.path))
  return {
    name: file.path.split('/').pop() ?? file.path,
    webkitRelativePath: `${name}/${file.path}`,
    size: file.size_bytes,
    base64,
    text: async () => decodeBase64(await base64()),
  }
}

export interface UseAdoptFolder {
  runner: UseImportRunner
  question: AdoptionQuestion | null
  /** Pick a folder, import it and ask; nothing when the pick is cancelled. */
  start: () => Promise<void>
  /** Adopt the folder asked about, `onAdopted` given the mirror's status. */
  confirm: () => Promise<void>
  /** Close the question; declined, the notes stay in their new space, as it said. */
  dismiss: () => void
}

export function useAdoptFolder(onAdopted: (status: MirrorStatus) => void): UseAdoptFolder {
  const { t } = useTranslation()
  const runner = useImportRunner()
  const [question, setQuestion] = useState<AdoptionQuestion | null>(null)
  const { begin, run } = runner

  const start = useCallback(async () => {
    try {
      const folder = unwrap(await commands.pickMirrorFolder())
      if (folder === null) return
      const listed = unwrap(await commands.listAdoptionFolder(folder))
      if (isLogseqGraph(listed.map((file) => file.path))) {
        notify.error(t('data.mirrorAdoptLogseq'))
        return
      }
      const name = folderName(folder)
      const spaceId = unwrap(await commands.createSpace(name, null))
      await useSpaceStore.getState().refreshAvailableSpaces()
      begin()
      const entries = listed.map((file) => diskEntry(folder, name, file))
      const { spaceId: target, ...group } = await folderGroup(entries, spaceId)
      const outcome = await run({
        activeSpaceId: target,
        ...group,
        notes: false,
        loggerFailLabel: 'adopt import failed',
      })
      if (outcome.cancelled) return
      // The mirror keeps Markdown files only: another note format stays left alone.
      const files = outcome.imported
        .filter((note) => note.path.endsWith('.md'))
        .map((note) => ({ path: note.path, page_id: note.pageId }))
      const preview = unwrap(await commands.previewMirrorAdoption(folder, spaceId, files))
      setQuestion({ folder, name, spaceId, files, preview })
    } catch (err) {
      logger.error('MirrorSection', 'opening a folder of notes failed', undefined, err)
      notify.error(t('data.mirrorAdoptFailed', { reason: formatErrorForDisplay(err) }))
    }
  }, [t, begin, run])

  const confirm = useCallback(async () => {
    if (question === null) return
    const { folder, name, spaceId, files } = question
    setQuestion(null)
    try {
      onAdopted(unwrap(await commands.adoptMirrorFolder(folder, spaceId, files, true)))
      notify.success(t('data.mirrorAdopted', { name }))
    } catch (err) {
      logger.error('MirrorSection', 'adopting a folder failed', undefined, err)
      notify.error(t('data.mirrorAdoptFailed', { reason: formatErrorForDisplay(err) }))
    }
  }, [t, question, onAdopted])

  const dismiss = useCallback(() => setQuestion(null), [])

  return { runner, question, start, confirm, dismiss }
}
