/**
 * What a folder of notes imports as: the folder import's units for a picked
 * folder, from the browser's folder pick or from a folder the desktop app
 * reads to adopt in place (#6540).
 */

import type { RunGroup } from '@/components/settings/useImportRunner'
import { i18n } from '@/lib/i18n'
import {
  type VaultEntry,
  indexVaultFiles,
  isNotionPick,
  mdFilesToUnits,
  restoreSpaceFile,
  skippedFiles,
} from '@/lib/vault-import'

/**
 * #1925 — only a folder/vault pick (`webkitdirectory`) carries sibling assets:
 * the browser populates `webkitRelativePath` for folder picks and leaves it
 * empty for the plain `.md` multi-file pick. A single-file (non-folder) import
 * has no siblings — documented limitation — so it ships no `vaultFiles`.
 */
function isFolderPick(files: readonly VaultEntry[]): boolean {
  return files.some(
    (f) => typeof f.webkitRelativePath === 'string' && f.webkitRelativePath.length > 0,
  )
}

/**
 * What a folder or file pick imports into `spaceId`. An export's definitions
 * exist before its first note imports (#6277 decision 8), and a file that is
 * no note and no attachment is said, not dropped (#6032).
 */
export async function folderGroup(files: VaultEntry[], spaceId: string): Promise<RunGroup> {
  // A folder pick's whole FileList is indexed, so each note's referenced
  // attachments can be matched and shipped.
  const vaultIndex = isFolderPick(files) ? indexVaultFiles(files) : null
  const notion = isNotionPick(files)
  const restored = await restoreSpaceFile(files, spaceId)
  const keptQueries = { count: 0 }
  return {
    spaceId,
    units: mdFilesToUnits(files, vaultIndex, notion, restored.titles, keptQueries),
    initialWarnings: restored.warnings,
    finalWarnings: (attached) => {
      const skipped = skippedFiles(files, notion, attached)
      const warnings: string[] = []
      if (skipped.other > 0) {
        warnings.push(i18n.t('data.importFolderSkipped', { count: skipped.other }))
      }
      if (skipped.databases > 0) {
        warnings.push(i18n.t('data.importNotionDatabases', { count: skipped.databases }))
      }
      if (keptQueries.count > 0) {
        warnings.push(i18n.t('data.importLogseqQueriesKept', { count: keptQueries.count }))
      }
      return warnings
    },
  }
}
