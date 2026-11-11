/**
 * Tauri mock handler -- `add_meeting` (#5364), the twin of `add_meeting_inner`
 * (`src-tauri/src/commands/meeting_attachments.rs`).
 *
 * Composed from the domain handlers so each step appends the op the backend's
 * does, in its order: the page and its space, `meeting_date`, the `#meeting`
 * tag, the template copy, the recording block, the link, the summary, the
 * files. The backend writes it all in one transaction; the mock has no
 * rollback, so every refusal is checked before the first write.
 *
 * DELIBERATE APPROXIMATIONS: the template copy is content and nesting only (as
 * the journal template's), and a summary given as text is one block, where the
 * backend reads it as a Markdown outline.
 */

import type { AddMeetingInput, MeetingFileInput } from '@/lib/bindings'
import { withoutEvents } from '@/lib/tauri-mock/events'
import {
  attachmentsHandlers,
  isMimeAllowed,
  validateAttachmentFilename,
} from '@/lib/tauri-mock/handlers/attachments'
import { blocksHandlers } from '@/lib/tauri-mock/handlers/blocks'
import { propertiesHandlers } from '@/lib/tauri-mock/handlers/properties'
import {
  assertValidDateFormat,
  comparePositionThenId,
  copyTemplateBlocks,
  isRecordingPlaceholder,
  createPageInSpace,
  definitionSpaceOf,
  expandJournalTemplateVariables,
  findLivePageByTitle,
  isLiveSpace,
  notFoundRejection,
  type TypedHandlers,
  validationRejection,
} from '@/lib/tauri-mock/handlers/shared'
import { tagsHandlers } from '@/lib/tauri-mock/handlers/tags'
import { pageNameHolder } from '@/lib/tauri-mock/page-names'
import { blocks, opLog, properties } from '@/lib/tauri-mock/seed'

/** The audio rows of the backend's `ATTACHMENT_EXTENSIONS`. */
const AUDIO_TYPES: Readonly<Record<string, string>> = {
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  webm: 'audio/webm',
  flac: 'audio/flac',
}

type Role = 'audio' | 'transcript' | 'summary'

/** `role_filename`: a transcript is `<name>.transcript.md`, a summary `<name>.summary.md`. */
function roleFilename(filename: string, role: Role): string {
  const name = filename.trim()
  if (role === 'audio') return name
  const suffix = role === 'transcript' ? '.transcript.md' : '.summary.md'
  const lower = name.toLowerCase()
  if (lower.endsWith(suffix)) return name
  const ext = ['.markdown', '.md', '.txt'].find((e) => lower.endsWith(e))
  return `${ext === undefined ? name : name.slice(0, name.length - ext.length)}${suffix}`
}

/** `file_identity`: the stored name and type, audio refused unless it is audio. */
function fileIdentity(file: MeetingFileInput, role: Role): { filename: string; mimeType: string } {
  const filename = roleFilename(file.filename, role)
  if (role !== 'audio') return { filename, mimeType: 'text/markdown' }
  const ext = filename.includes('.') ? (filename.split('.').pop() ?? '') : ''
  const mimeType = AUDIO_TYPES[ext.toLowerCase()]
  if (mimeType === undefined) {
    throw validationRejection(
      `the audio '${filename}' is not an audio file; its extension must be an audio type`,
    )
  }
  return { filename, mimeType }
}

/** The live block `blockId` of `spaceId`, as `require_block_in_space_in_tx` reads it. */
function assertLiveBlockInSpace(blockId: string, spaceId: string): void {
  const b = blocks.get(blockId)
  if (!b || b['deleted_at'] != null) throw notFoundRejection(`block '${blockId}'`)
  if (definitionSpaceOf(blockId) !== spaceId) {
    throw validationRejection(`block '${blockId}' is not in space '${spaceId}'`)
  }
}

/** `require_template_in_tx`: a live template page of the space. */
function assertTemplatePage(templateId: string, spaceId: string): void {
  const b = blocks.get(templateId)
  const isTemplate = properties.get(templateId)?.get('template')?.['value_text'] === 'true'
  if (
    !b ||
    b['deleted_at'] != null ||
    b['block_type'] !== 'page' ||
    !isTemplate ||
    definitionSpaceOf(templateId) !== spaceId
  ) {
    throw validationRejection(`'${templateId}' is not a template page of the space`)
  }
}

/** The files to attach, checked before any write: audio, transcript, summary. */
function checkedFiles(
  input: AddMeetingInput,
): { filename: string; mimeType: string; bytes: number[] }[] {
  const files: [Role, MeetingFileInput | null][] = [
    ['audio', input.audio ?? null],
    ['transcript', input.transcript ?? null],
    ['summary', input.summary_file ?? null],
  ]
  return files.flatMap(([role, file]) => {
    if (file === null) return []
    const { filename, mimeType } = fileIdentity(file, role)
    if (!isMimeAllowed(mimeType))
      throw validationRejection(`MIME type '${mimeType}' is not allowed`)
    return [{ filename: validateAttachmentFilename(filename), mimeType, bytes: file.bytes }]
  })
}

/** The 0-based slot of `blockId` among its live siblings. */
function siblingSlot(blockId: string, parentId: string): number {
  const siblings = [...blocks.values()]
    .filter((b) => b['parent_id'] === parentId && b['deleted_at'] == null)
    .toSorted(comparePositionThenId)
  return siblings.findIndex((b) => b['id'] === blockId)
}

function scope(spaceId: string) {
  return { kind: 'active', space_id: spaceId }
}

export const meetingsHandlers = {
  add_meeting: (args) => {
    const input = (args as { input: AddMeetingInput }).input
    const spaceId = input.space_id.toUpperCase()
    assertValidDateFormat(input.date)
    if (input.summary_text != null && input.summary_file != null) {
      throw validationRejection('a summary is text or a file, not both')
    }
    if (!isLiveSpace(spaceId)) throw validationRejection(`'${spaceId}' is not a live space`)
    const title = (input.title ?? '').trim() || 'Meeting'
    const pageTitle = `${title} ${input.date}`
    if (pageNameHolder(pageTitle, spaceId) !== null) {
      throw validationRejection(`a page named '${pageTitle}' already exists in the space`)
    }
    if (input.template_id != null) assertTemplatePage(input.template_id, spaceId)
    const linkBlock = input.link_block_id ?? null
    if (linkBlock !== null) assertLiveBlockInSpace(linkBlock, spaceId)
    const files = checkedFiles(input)

    const firstOp = opLog.length
    const pageId = createPageInSpace(null, pageTitle, spaceId)
    // The backend's command emits no property event; the meeting page is new.
    withoutEvents(() =>
      propertiesHandlers.set_property({
        blockId: pageId,
        key: 'meeting_date',
        value: {
          value_text: null,
          value_num: null,
          value_date: input.date,
          value_ref: null,
          value_bool: null,
        },
      }),
    )
    const tag = blocksHandlers.create_block({
      blockType: 'tag',
      content: 'meeting',
      parentId: null,
      scope: scope(spaceId),
    }) as { id: string }
    tagsHandlers.add_tag({ blockId: pageId, tagId: tag.id })

    const copied =
      input.template_id == null
        ? []
        : copyTemplateBlocks(input.template_id, pageId, (content) =>
            expandJournalTemplateVariables(content, input.date, pageTitle),
          )
    const placeholder = copied.find((b) => isRecordingPlaceholder((b['content'] as string) ?? ''))
    let recordingId: string
    if (placeholder === undefined) {
      const created = blocksHandlers.create_block({
        blockType: 'content',
        content: '',
        parentId: pageId,
        index: 0,
        scope: scope(spaceId),
      }) as { id: string }
      recordingId = created.id
    } else {
      recordingId = placeholder['id'] as string
      blocksHandlers.edit_block({ blockId: recordingId, toText: '' })
    }

    const pageLink = `[[${pageId}]]`
    let linkBlockId: string
    if (linkBlock !== null) {
      const content = ((blocks.get(linkBlock)?.['content'] as string | null) ?? '').trimEnd()
      blocksHandlers.edit_block({
        blockId: linkBlock,
        toText: content === '' ? pageLink : `${content} ${pageLink}`,
      })
      linkBlockId = linkBlock
    } else {
      const journal =
        findLivePageByTitle(input.date, spaceId) ?? createPageInSpace(null, input.date, spaceId)
      const created = blocksHandlers.create_block({
        blockType: 'content',
        content: pageLink,
        parentId: journal,
        scope: scope(spaceId),
      }) as { id: string }
      linkBlockId = created.id
    }

    if (input.summary_text != null) {
      const parent = blocks.get(recordingId)?.['parent_id'] as string
      blocksHandlers.create_block({
        blockType: 'content',
        content: input.summary_text.trim(),
        parentId: parent,
        index: siblingSlot(recordingId, parent),
        scope: scope(spaceId),
      })
    }

    const rows = files.map((file) =>
      attachmentsHandlers.add_attachment_with_bytes({
        blockId: recordingId,
        filename: file.filename,
        mimeType: file.mimeType,
        bytes: file.bytes,
      }),
    )
    return {
      page_id: pageId,
      recording_block_id: recordingId,
      link_block_id: linkBlockId,
      attachments: rows,
      op_refs: opLog.slice(firstOp).map((op) => ({ device_id: op.device_id, seq: op.seq })),
    }
  },
} satisfies Pick<
  TypedHandlers,
  // A slice of one: `add_meeting_inner` has no other command.
  'add_meeting'
>
