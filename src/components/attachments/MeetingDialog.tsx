/**
 * MeetingDialog — the `/meeting` dialog (#5364).
 *
 * Makes a meeting page through `add_meeting`: the title and date, a template
 * of the space, and the recording's audio, transcript and summary, each
 * optional, the summary written as page content or attached as a file. The
 * page is linked from the block the command ran in, in one transaction, so
 * the success toast's Undo reverts the whole meeting.
 */

import { format } from 'date-fns'
import type React from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { invalidateDerivedCaches } from '@/hooks/derived-caches'
import { unwrap } from '@/lib/app-error'
import type {
  AddMeetingInput,
  BlockRow,
  MeetingFileInput,
  MeetingResult,
  WithOps,
} from '@/lib/bindings'
import { commands } from '@/lib/bindings'
import { logger } from '@/lib/logger'
import { notify } from '@/lib/notify'
import { PREFERENCES, readPreference, writePreference } from '@/lib/preferences'
import { reportIpcError, reportIpcErrorWithReason } from '@/lib/report-ipc-error'
import { loadTemplatePages } from '@/lib/template-utils'
import { useSpaceStore } from '@/stores/space'

const NO_TEMPLATE = 'none'
const JOURNAL_DAY = /^\d{4}-\d{2}-\d{2}$/

type SummaryMode = 'text' | 'file'

/**
 * The day the meeting defaults to: the journal day the block is on, else
 * today.
 */
async function defaultMeetingDate(blockId: string | undefined): Promise<string> {
  if (blockId === undefined) return format(new Date(), 'yyyy-MM-dd')
  const block = unwrap(await commands.getBlock(blockId))
  const pageId = block.page_id ?? block.id
  const page = pageId === block.id ? block : unwrap(await commands.getBlock(pageId))
  const title = page.content ?? ''
  return JOURNAL_DAY.test(title) ? title : format(new Date(), 'yyyy-MM-dd')
}

async function fileInput(file: File | null): Promise<MeetingFileInput | null> {
  if (file === null) return null
  return { filename: file.name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())) }
}

export interface MeetingDialogProps {
  /** The block the meeting is linked from; without one, its day's journal. */
  linkBlockId?: string
  onClose: () => void
  /** Called once the meeting exists, and again after its Undo, so the link's page reloads. */
  onCreated: (created: MeetingResult) => void
}

export function MeetingDialog({
  linkBlockId,
  onClose,
  onCreated,
}: MeetingDialogProps): React.ReactElement {
  const { t } = useTranslation()
  const spaceId = useSpaceStore((s) => s.currentSpaceId)
  const id = useId()
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(() => format(new Date(), 'yyyy-MM-dd'))
  // The block's day lands a round trip after mount; a date picked by then wins.
  const dateTouched = useRef(false)
  const [templates, setTemplates] = useState<BlockRow[]>([])
  const [templateId, setTemplateId] = useState(NO_TEMPLATE)
  const [audio, setAudio] = useState<File | null>(null)
  const [transcript, setTranscript] = useState<File | null>(null)
  const [summaryMode, setSummaryMode] = useState<SummaryMode>('text')
  const [summaryText, setSummaryText] = useState('')
  const [summaryFile, setSummaryFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let live = true
    defaultMeetingDate(linkBlockId).then(
      (day) => {
        if (live && !dateTouched.current) setDate(day)
      },
      (err: unknown) =>
        logger.warn('MeetingDialog', 'could not read the block’s day', undefined, err),
    )
    loadTemplatePages(spaceId).then(
      (pages) => {
        if (!live) return
        setTemplates(pages)
        // The last template made from here, unless it is no longer a template.
        const last = spaceId === null ? '' : readPreference(PREFERENCES.meetingTemplate, spaceId)
        if (pages.some((page) => page.id === last)) setTemplateId(last)
      },
      (err: unknown) =>
        logger.warn('MeetingDialog', 'could not list the templates', undefined, err),
    )
    return () => {
      live = false
    }
  }, [linkBlockId, spaceId])

  const undo = async (created: WithOps<MeetingResult>) => {
    try {
      unwrap(await commands.revertOps(created.op_refs))
      invalidateDerivedCaches()
      onCreated(created)
    } catch (err) {
      reportIpcError('MeetingDialog', 'meeting.undoFailed', err, t)
    }
  }

  const create = async () => {
    if (spaceId === null) return
    setSaving(true)
    try {
      const input: AddMeetingInput = {
        space_id: spaceId,
        title: title.trim(),
        date,
        template_id: templateId === NO_TEMPLATE ? null : templateId,
        link_block_id: linkBlockId ?? null,
        audio: await fileInput(audio),
        transcript: await fileInput(transcript),
        summary_text: summaryMode === 'text' && summaryText.trim() !== '' ? summaryText : null,
        summary_file: summaryMode === 'file' ? await fileInput(summaryFile) : null,
      }
      const created = unwrap(await commands.addMeeting(input))
      // The meeting's page, tag and files reached the backend past every page
      // store, so the name lists and attachment caches drop what they hold.
      invalidateDerivedCaches()
      onCreated(created)
      writePreference(
        PREFERENCES.meetingTemplate,
        templateId === NO_TEMPLATE ? '' : templateId,
        spaceId,
      )
      notify.success(
        t('meeting.created', { title: `${input.title || t('meeting.defaultTitle')} ${date}` }),
        { action: { label: t('action.undo'), onClick: () => void undo(created) } },
      )
      onClose()
    } catch (err) {
      reportIpcErrorWithReason('MeetingDialog', 'meeting.createFailed', err, t, { linkBlockId })
      setSaving(false)
    }
  }

  const field = (name: string) => `${id}-${name}`

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent data-testid="meeting-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('meeting.title')}</DialogTitle>
          <DialogDescription>{t('meeting.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={field('title')}>{t('meeting.titleLabel')}</Label>
            <Input
              id={field('title')}
              value={title}
              placeholder={t('meeting.defaultTitle')}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={field('date')}>{t('meeting.dateLabel')}</Label>
            <Input
              id={field('date')}
              type="date"
              required
              value={date}
              onChange={(e) => {
                dateTouched.current = true
                setDate(e.target.value)
              }}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={field('template')}>{t('meeting.templateLabel')}</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger id={field('template')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEMPLATE}>{t('meeting.noTemplate')}</SelectItem>
                {templates.map((page) => (
                  <SelectItem key={page.id} value={page.id}>
                    {page.content}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={field('audio')}>{t('meeting.audioLabel')}</Label>
            <Input
              id={field('audio')}
              type="file"
              accept="audio/*,.opus,.oga,.m4a"
              onChange={(e) => setAudio(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={field('transcript')}>{t('meeting.transcriptLabel')}</Label>
            <Input
              id={field('transcript')}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              onChange={(e) => setTranscript(e.target.files?.[0] ?? null)}
            />
          </div>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{t('meeting.summaryLabel')}</legend>
            <ToggleGroup
              type="single"
              aria-label={t('meeting.summaryLabel')}
              value={summaryMode}
              onValueChange={(value) => {
                if (value === 'text' || value === 'file') setSummaryMode(value)
              }}
            >
              <ToggleGroupItem value="text">{t('meeting.summaryAsText')}</ToggleGroupItem>
              <ToggleGroupItem value="file">{t('meeting.summaryAsFile')}</ToggleGroupItem>
            </ToggleGroup>
            {summaryMode === 'text' ? (
              <Textarea
                aria-label={t('meeting.summaryTextLabel')}
                value={summaryText}
                onChange={(e) => setSummaryText(e.target.value)}
              />
            ) : (
              <Input
                aria-label={t('meeting.summaryFileLabel')}
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={(e) => setSummaryFile(e.target.files?.[0] ?? null)}
              />
            )}
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              {t('action.cancel')}
            </Button>
            <Button type="submit" disabled={saving || spaceId === null}>
              {saving && <Spinner />}
              {saving ? t('meeting.creating') : t('meeting.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
