/**
 * ImportMergeDialog — asks before an import updates existing pages: a file
 * whose title names a page with blocks merges into it (#6277 decision 7), so
 * the run lists those pages and waits on {@link MergeQuestion.answer}.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ConfirmDialog } from '@/components/dialogs/ConfirmDialog'
import type { MergeQuestion } from '@/components/settings/useImportRunner'

export function ImportMergeDialog({
  question,
}: {
  question: MergeQuestion | null
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <ConfirmDialog
      open={question !== null}
      // Closing declines, unless a confirm answered first: the run takes the first answer.
      onOpenChange={(open) => {
        if (!open) question?.answer(false)
      }}
      titleKey="data.importMergeTitle"
      descriptionKey="data.importMergeDescription"
      confirmKey="data.importMergeConfirm"
      values={{ count: question?.pages.length ?? 0 }}
      onConfirm={() => question?.answer(true)}
      contentTestId="import-merge-dialog"
      actionTestId="import-merge-confirm"
      cancelTestId="import-merge-cancel"
    >
      {question?.spaceName !== undefined && (
        <p className="text-sm">{t('data.importMergeSpace', { name: question.spaceName })}</p>
      )}
      <ul className="list-disc pl-5 text-sm" data-testid="import-merge-pages">
        {question?.pages.map((page) => (
          <li key={page.page_id}>{page.title}</li>
        ))}
      </ul>
    </ConfirmDialog>
  )
}
