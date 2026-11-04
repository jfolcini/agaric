/**
 * The Markdown the editor reads, one entry per construct, from
 * `MARKDOWN_REFERENCE`: what you type and what it becomes.
 */

import type React from 'react'
import { useTranslation } from 'react-i18next'

import { ReferenceSheet } from '@/components/editor/ReferenceSheet'
import {
  MARKDOWN_REFERENCE,
  MARKDOWN_REFERENCE_GROUPS,
  markdownReferenceGroupKey,
  markdownReferenceKey,
} from '@/editor/markdown-reference'

interface MarkdownReferenceSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MarkdownReferenceSheet({
  open,
  onOpenChange,
}: MarkdownReferenceSheetProps): React.ReactElement {
  const { t } = useTranslation()
  const sections = MARKDOWN_REFERENCE_GROUPS.map((group) => ({
    id: group,
    heading: t(markdownReferenceGroupKey(group)),
    entries: MARKDOWN_REFERENCE.filter((entry) => entry.group === group).map((entry) => ({
      id: entry.id,
      name: t(markdownReferenceKey(entry.id, 'title')),
      syntax: entry.typed,
      description: t(markdownReferenceKey(entry.id, 'description')),
    })),
  }))
  return (
    <ReferenceSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('referenceSheet.markdown.title')}
      description={t('referenceSheet.markdown.description')}
      filterLabel={t('referenceSheet.markdown.filter')}
      sections={sections}
    />
  )
}
