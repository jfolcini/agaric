/**
 * ImportVaultDialog — asks before a folder pick of an unzipped *Export all
 * spaces* ZIP restores its spaces (#6554): it lists each space, the existing
 * ones imported into and the others created, and waits on
 * {@link VaultQuestion.answer}.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'

/** The spaces a vault restore would import into, asked before anything is written. */
export interface VaultQuestion {
  spaces: { name: string; exists: boolean }[]
  answer: (go: boolean) => void
}

export function ImportVaultDialog({
  question,
}: {
  question: VaultQuestion | null
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={question !== null}
      // Closing declines, unless a confirm answered first: the restore takes the first answer.
      onOpenChange={(open) => {
        if (!open) question?.answer(false)
      }}
      titleKey="data.importVaultTitle"
      descriptionKey="data.importVaultDescription"
      confirmKey="data.importVaultConfirm"
      values={{ count: question?.spaces.length ?? 0 }}
      onConfirm={() => question?.answer(true)}
      contentTestId="import-vault-dialog"
      actionTestId="import-vault-confirm"
      cancelTestId="import-vault-cancel"
    >
      <ul className="list-disc pl-5 text-sm" data-testid="import-vault-spaces">
        {question?.spaces.map(({ name, exists }, i) => (
          // oxlint-disable-next-line react/no-array-index-key -- two spaces can share a name, and the list never reorders
          <li key={`${i}-${name}`}>
            {t(exists ? 'data.importVaultExisting' : 'data.importVaultNew', { name })}
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}
