/**
 * i18n namespace: editor
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

import { markdownReference } from '@/lib/i18n/markdown-reference'

export const editor: Record<string, string> = {
  ...markdownReference,

  // Translators: aria-label (screen-reader only) of the text area where a block is edited.
  // #4555 — the main block editor surface's aria-label.
  'editor.blockEditorLabel': 'Block editor',

  // Translators: aria-labels (screen-reader only) of the popup lists (SuggestionList) that open
  // while typing in the editor; also read before "No results" when a list is empty.
  // #4555 — suggestion-popup aria-labels (`createSuggestionRenderer`'s
  // `label` param, threaded from each picker extension's `displayName`).
  // Translators: the list of commands that typing / opens.
  'editor.suggestion.slashCommands': 'Slash commands',
  // Translators: the list of tags that typing @ (or #) opens.
  'editor.suggestion.tags': 'Tags',
  // Translators: the list of pages that typing [[ opens, to link to a page.
  'editor.suggestion.blockLinks': 'Page links',
  // Translators: the list of blocks that typing (( opens, to show another block's text here.
  'editor.suggestion.blockReferences': 'Block references',
  // Translators: the list of emoji that typing : and two letters opens.
  'editor.suggestion.emoji': 'Emoji',
  // Translators: the list of property names that typing :: opens.
  'editor.suggestion.properties': 'Properties',
  // Translators: a list for embedding a query (a live list of matching blocks).
  'editor.suggestion.embedQuery': 'Embed query',
  // Translators: used when a popup list has no specific name.
  'editor.suggestion.fallback': 'Suggestions',

  // Translators: attachment list, opened under a block from its attachment badge: the block's
  // attached files. loading and list are aria-labels; empty is an empty-state message. In the
  // summary line, {{count}} = number of files, {{total}} = their total size, like "2.4 MB".
  'attachments.loading': 'Loading attachments…',
  'attachments.empty': 'No attachments yet.',
  'attachments.list': 'Attachments',
  'attachments.summary_one': '{{count}} file · {{total}}',
  'attachments.summary_other': '{{count}} files · {{total}}',

  // Translators: attachment list, deleting a file with two presses of its trash button.
  // {{name}} = the file name. delete and deleteArmed are the button's aria-label before and
  // after the first press; confirmDelete (title) and clickAgain (body) are the toast the first
  // press shows; deleted is the toast after deleting.
  'attachments.delete': 'Delete attachment {{name}}',
  'attachments.deleted': 'Deleted {{name}}',
  'attachments.confirmDelete': 'Delete "{{name}}"?',
  'attachments.clickAgain': 'Click the delete button again to confirm.',
  // #2281 — armed-state accessible name for the double-tap-to-confirm delete.
  'attachments.deleteArmed': 'Click again to confirm deleting {{name}}',

  // Translators: attachments shown under a block's text. openFile = aria-label of the chip of an
  // attached file (not an image); openImageFullscreen = aria-label of an attached image, and of
  // the Open button on a selected image, that opens the full-screen viewer. The loading and
  // failure texts stand in place of the image. {{filename}} = a file name like "photo.png".
  'attachment.openFile': 'Open file {{filename}}',
  'attachment.openImageFullscreen': 'Open image {{filename}} in full screen',
  'attachment.loadingImage': 'Loading image…',
  'attachment.imageLoadFailed': 'Failed to load image',

  // Translators: preview of an attached Markdown or text file, shown under a block's text.
  // collapsePreview, expandPreview and downloadFile are aria-labels of its header buttons;
  // previewTruncated is a note under a preview cut short. {{filename}} = the file name.
  // #1451 — inline rich-text preview for .md / text attachments.
  'attachment.loadingMarkdown': 'Loading preview…',
  'attachment.markdownLoadFailed': 'Failed to load preview',
  'attachment.collapsePreview': 'Collapse preview of {{filename}}',
  'attachment.expandPreview': 'Expand preview of {{filename}}',
  'attachment.downloadFile': 'Download {{filename}}',
  'attachment.previewTruncated': 'Preview truncated — download to view the full file.',

  // Translators: an attached audio file's player under a block's text: a loading placeholder and
  // the player's aria-label; {{filename}} = the file name.
  // #5364 — inline audio player.
  'attachment.loadingAudio': 'Loading audio…',
  'attachment.audioLabel': 'Audio {{filename}}',

  // Translators: an attached transcript of a recording. transcript = toggle button that shows its
  // text, beside the file name; seekTo = aria-label of each timestamp, which plays the recording
  // from there; {{time}} = a timestamp like "01:23".
  // #5410 — a recording's transcript, whose timestamps seek its player.
  'attachment.transcript': 'Transcript',
  'attachment.seekTo': 'Seek to {{time}}',

  // Translators: voice note dialog, opened by the /voice command: records from the microphone and
  // attaches the audio to the block. elapsed = aria-label of the running timer; record, stop and
  // retry = the main button in each state; recording, saving and saveFailed = the status line
  // under the timer (saving is also the button while saving); saved = success toast.
  // #5364 — the /voice recorder dialog.
  'voiceNote.title': 'Record a voice note',
  'voiceNote.description': 'Records from your microphone and attaches the audio to this block.',
  'voiceNote.elapsed': 'Recording time',
  'voiceNote.record': 'Record',
  'voiceNote.stop': 'Stop and save',
  'voiceNote.retry': 'Try saving again',
  'voiceNote.recording': 'Recording…',
  'voiceNote.saving': 'Saving…',
  'voiceNote.saved': 'Voice note attached',
  'voiceNote.saveFailed': 'Could not save the voice note',
  // Translators: toasts from the voice note dialog when recording stops or cannot start.
  'voiceNote.sizeLimitReached': 'Recording stopped at the 50 MB attachment limit',
  'voiceNote.micDenied': 'Microphone access was denied',
  'voiceNote.micNotFound': 'No microphone found',
  'voiceNote.micUnavailable': 'Recording is not available on this device',
  'voiceNote.micError': 'Could not start the microphone',

  // Translators: "New meeting" dialog, opened by the /meeting command: creates a meeting page with
  // its audio, transcript and summary files. Labels are form field labels; create and creating
  // are the submit button; created, createFailed and undoFailed are toasts.
  // #5364 — the /meeting dialog.
  'meeting.title': 'New meeting',
  'meeting.description':
    'Creates the meeting page, links it from this block and attaches the recording. Every file is optional.',
  'meeting.titleLabel': 'Title',
  // Translators: placeholder of the Title field and the page's name when none is typed; the page
  // is named "<title> <date>", like "Meeting 2026-11-18".
  'meeting.defaultTitle': 'Meeting',
  'meeting.dateLabel': 'Date',
  'meeting.templateLabel': 'Template',
  'meeting.noTemplate': 'No template',
  'meeting.audioLabel': 'Audio',
  'meeting.transcriptLabel': 'Transcript',
  'meeting.summaryLabel': 'Summary',
  // Translators: two toggle options under Summary: type the summary, or attach it as a file.
  'meeting.summaryAsText': 'Write it',
  'meeting.summaryAsFile': 'Attach a file',
  'meeting.summaryTextLabel': 'Summary text',
  'meeting.summaryFileLabel': 'Summary file',
  'meeting.create': 'Create meeting',
  'meeting.creating': 'Creating…',
  // Translators: {{title}} = the new page's name, like "Meeting 2026-11-18".
  'meeting.created': 'Meeting {{title}} created',
  'meeting.createFailed': 'Could not create the meeting',
  // Translators: shown when the toast's Undo button fails to remove the new meeting.
  'meeting.undoFailed': 'Could not undo the meeting',

  // Translators: placeholder shown instead of an image from the web that the privacy settings
  // block. loadButton = small button that loads it and allows that website from then on;
  // blockedNote = lowercase note shown instead when it cannot be loaded; externalBlockedAria =
  // the placeholder's aria-label, {{domain}} = the website, like "example.com".
  // #1492 — external-image privacy placeholder (node view + static renderer).
  'editor.image.loadButton': 'Load',
  'editor.image.blockedNote': 'external image blocked',
  'editor.image.externalBlockedAria':
    'External image from {{domain}} (blocked by your privacy settings)',

  // Translators: aria-labels on an image in a block's text: the toggle that hides or shows it and
  // the corner handle dragged to resize it. {{name}} = the image's description or file name.
  // #4711 — per-client collapse toggle on an inline image.
  'editor.image.collapse': 'Collapse image {{name}}',
  'editor.image.expand': 'Expand image {{name}}',
  // #4712 — the editor's resize handle on an inline image.
  'editor.image.resize': 'Resize image {{name}}',

  // Translators: small toolbar over a selected image while editing. actions = its aria-label;
  // editAlt = button tooltip and the popover it opens; altText = that popover's field (the
  // image's description for screen readers); remove = button tooltip.
  // #5691 — the bubble on a selected inline image, in block and page mode.
  'editor.image.actions': 'Image actions',
  'editor.image.editAlt': 'Edit alt text',
  'editor.image.altText': 'Alt text',
  'editor.image.remove': 'Remove image',

  // Translators: toasts after picking a /repeat or /effort option in the slash menu. In
  // repeatSet, {{value}} = how often the task repeats, like "Daily" or "Every 3 days"; in
  // effortSet, {{value}} = an estimate as stored, like "15m", "1h" or "1d".
  'slash.repeatSet': 'Set repeat to {{value}}',
  'slash.repeatFailed': 'Failed to set repeat',
  'slash.repeatRemoved': 'Repeat removed',
  'slash.repeatRemoveFailed': 'Failed to remove repeat',
  'slash.effortSet': 'Set effort to {{value}}',
  'slash.effortFailed': 'Failed to set effort',

  // Translators: inserting a template (a page whose blocks are copied in) with the /template
  // command. Toasts, except templatePicker (aria-label of the popup list of templates) and
  // selectTemplate (heading at its top). templateLoadFailed also shows in the Templates view.
  // Translators: "template" and "true" are a property name and value typed as is: keep them in
  // English.
  'slash.noTemplates':
    'No templates found. To create one: make a page, open its properties (click the page title area), and add a "template" property set to "true".',
  'slash.templateLoadFailed': 'Failed to load templates',
  'slash.templateInserted': 'Template inserted',
  'slash.templateInsertFailed': 'Failed to insert template',
  'slash.templatePicker': 'Select template',
  'slash.selectTemplate': 'Select a template',

  // Translators: error toasts when a slash command or toolbar button fails to change a block.
  // turnIntoFailed covers every change of block type (heading, quote, code language…).
  'slash.calloutFailed': 'Failed to insert callout',
  'slash.numberedListFailed': 'Failed to insert numbered list',
  'slash.bulletListFailed': 'Failed to insert bullet list',
  'slash.dividerFailed': 'Failed to insert divider',
  'slash.turnIntoFailed': 'Failed to change block type',

  // Translators: group headings in the slash (/) command menu and in the Slash commands
  // reference panel. Short. "Queries" = live lists of matching blocks.
  'slashCommand.categories.tasks': 'Tasks',
  'slashCommand.categories.dates': 'Dates',
  'slashCommand.categories.references': 'References',
  'slashCommand.categories.formatting': 'Formatting',
  'slashCommand.categories.structure': 'Structure',
  'slashCommand.categories.properties': 'Properties',
  'slashCommand.categories.templates': 'Templates',
  'slashCommand.categories.queries': 'Queries',
  'slashCommand.categories.repeat': 'Repeat',

  // Translators: slash menu group headings for the commands that make a task repeat. Cadence =
  // how often; Anchoring = what the next date counts from (the due date, the day it is done,
  // or skipping missed dates); End condition = when the repeating stops.
  // #1106 — split the flat 17-item Repeat group into three orthogonal
  // sub-groups so the picker renders a divider/header per family instead of
  // one undifferentiated list: cadence (plain daily/weekly/… + base), anchoring
  // (.+ from-completion / ++ catch-up variants + remove), and end-conditions
  // (until / limit). Dispatch is keyed off item.id, so the new category labels
  // are presentation-only.
  'slashCommand.categories.repeat.cadence': 'Repeat — Cadence',
  'slashCommand.categories.repeat.anchoring': 'Repeat — Anchoring',
  'slashCommand.categories.repeat.endCondition': 'Repeat — End condition',

  // Translators: slash menu group heading for the recently used commands, listed first.
  // #1105 — heading for the "Recent" band the slash menu prepends on an empty
  // query (mirrors the command palette's recents strip).
  'slashCommand.categories.recent': 'Recent',

  // Translators: Slash commands reference, a side panel opened from "Type / for commands" under
  // a page: a one-line description beside each command's name, which stays in English. Short,
  // imperative. "/effort", "/repeat" and "/turn" are commands to type: keep them as written.
  // One line per slash command, shown in the command reference drawer.
  'slashCommand.description.todo': 'Make the block a task to do.',
  'slashCommand.description.doing': 'Mark the task as in progress.',
  'slashCommand.description.cancelled': 'Mark the task as cancelled.',
  'slashCommand.description.done': 'Mark the task as done.',
  'slashCommand.description.date': 'Link to a day’s journal page.',
  'slashCommand.description.due': 'Pick the date the task is due.',
  'slashCommand.description.schedule': 'Pick the date you plan to work on it.',
  'slashCommand.description.link': 'Link to another page.',
  'slashCommand.description.blockRef': 'Show another block’s text here.',
  'slashCommand.description.tag': 'Tag the block.',
  'slashCommand.description.bold': 'Type bold text.',
  'slashCommand.description.italic': 'Type italic text.',
  // Translators: codeMark = code formatting inside a line of text; code = a whole code block.
  'slashCommand.description.codeMark': 'Type text as code.',
  'slashCommand.description.strike': 'Type struck-through text.',
  'slashCommand.description.highlight': 'Type highlighted text.',
  'slashCommand.description.code': 'Turn the block into a code block.',
  // Translators: effort = an estimate of how long a task takes.
  'slashCommand.description.effort': 'Type /effort to pick how long it takes.',
  'slashCommand.description.assignee': 'Say who the task is for.',
  'slashCommand.description.location': 'Say where it happens.',
  'slashCommand.description.repeat': 'Type /repeat to pick how often it comes back.',
  'slashCommand.description.template': 'Insert a saved template.',
  'slashCommand.description.quote': 'Turn the block into a quote.',
  'slashCommand.description.callout': 'Turn the block into an info box.',
  'slashCommand.description.table': 'Insert a table.',
  'slashCommand.description.numberedList': 'Make the block a numbered list item.',
  'slashCommand.description.bulletList': 'Make the block a bulleted list item.',
  'slashCommand.description.divider': 'Replace the block with a horizontal line.',
  'slashCommand.description.turn': 'Type /turn to change the block’s type.',
  'slashCommand.description.duplicate': 'Copy the block and everything under it.',
  'slashCommand.description.query': 'Insert a live list of matching blocks.',
  'slashCommand.description.embed': 'Show a whole block or page inside this one.',
  'slashCommand.description.attach': 'Attach a file to the block.',
  'slashCommand.description.voice': 'Record a voice note.',
  'slashCommand.description.meeting':
    'Create a meeting page with its recording, transcript and summary, linked from this block.',
  'slashCommand.description.emoji': 'Pick an emoji to insert.',

  // Translators: Slash commands reference: descriptions of the priority and heading commands.
  // Heading levels go from 1 (largest) to 6.
  'slashCommand.description.priorityHigh': 'Set the priority to high.',
  'slashCommand.description.priorityMedium': 'Set the priority to medium.',
  'slashCommand.description.priorityLow': 'Set the priority to low.',
  'slashCommand.description.h1': 'Make the block a large heading.',
  'slashCommand.description.h2': 'Make the block a medium heading.',
  'slashCommand.description.h3': 'Make the block a small heading.',
  'slashCommand.description.h4': 'Make the block a level 4 heading.',
  'slashCommand.description.h5': 'Make the block a level 5 heading.',
  'slashCommand.description.h6': 'Make the block a level 6 heading.',

  // Translators: Slash commands reference: descriptions of the commands that make a task repeat.
  // FromDone = the next date counts from the day the task is done; CatchUp = the next date
  // jumps past the dates already missed.
  'slashCommand.description.repeatDaily': 'Repeat every day.',
  'slashCommand.description.repeatWeekly': 'Repeat every week.',
  'slashCommand.description.repeatMonthly': 'Repeat every month.',
  'slashCommand.description.repeatYearly': 'Repeat every year.',
  'slashCommand.description.repeatFromDoneDaily': 'Repeat a day after you finish it.',
  'slashCommand.description.repeatFromDoneWeekly': 'Repeat a week after you finish it.',
  'slashCommand.description.repeatFromDoneMonthly': 'Repeat a month after you finish it.',
  'slashCommand.description.repeatCatchUpDaily': 'Repeat daily, skipping days you missed.',
  'slashCommand.description.repeatCatchUpWeekly': 'Repeat weekly, skipping weeks you missed.',
  'slashCommand.description.repeatCatchUpMonthly': 'Repeat monthly, skipping months you missed.',
  'slashCommand.description.repeatRemove': 'Stop the task repeating.',
  'slashCommand.description.repeatUntil': 'Stop repeating after a date you pick.',
  'slashCommand.description.repeatLimit5': 'Stop repeating after 5 times.',
  'slashCommand.description.repeatLimit10': 'Stop repeating after 10 times.',
  'slashCommand.description.repeatLimit20': 'Stop repeating after 20 times.',
  'slashCommand.description.repeatLimitRemove': 'Remove the repeat’s end.',

  // Translators: Slash commands reference: descriptions of the commands that set a task's effort
  // (an estimate of how long it takes), its assignee (who it is for) and its location.
  // Office, Home and Remote name the preset location each command sets.
  'slashCommand.description.effort15m': 'Set the effort to 15 minutes.',
  'slashCommand.description.effort30m': 'Set the effort to 30 minutes.',
  'slashCommand.description.effort1h': 'Set the effort to 1 hour.',
  'slashCommand.description.effort2h': 'Set the effort to 2 hours.',
  'slashCommand.description.effort4h': 'Set the effort to 4 hours.',
  'slashCommand.description.effort1d': 'Set the effort to 1 day.',
  'slashCommand.description.assigneeMe': 'Assign the task to yourself.',
  'slashCommand.description.assigneeCustom': 'Type who the task is for.',
  'slashCommand.description.locationOffice': 'Set the location to Office.',
  'slashCommand.description.locationHome': 'Set the location to Home.',
  'slashCommand.description.locationRemote': 'Set the location to Remote.',
  'slashCommand.description.locationCustom': 'Type where it happens.',

  // Translators: Slash commands reference: descriptions of the callout commands (a colored box
  // around the block; the color is the box's) and the "turn into" commands, which change a
  // block's type while keeping its text.
  'slashCommand.description.calloutInfo': 'Turn the block into a blue info box.',
  'slashCommand.description.calloutWarning': 'Turn the block into an amber warning box.',
  'slashCommand.description.calloutTip': 'Turn the block into a green tip box.',
  'slashCommand.description.calloutError': 'Turn the block into a red error box.',
  'slashCommand.description.calloutNote': 'Turn the block into a gray note box.',
  'slashCommand.description.turnParagraph': 'Turn the block into plain text.',
  'slashCommand.description.turnH1': 'Turn the block into a large heading.',
  'slashCommand.description.turnH2': 'Turn the block into a medium heading.',
  'slashCommand.description.turnH3': 'Turn the block into a small heading.',
  'slashCommand.description.turnQuote': 'Turn the block into a quote.',
  'slashCommand.description.turnCode': 'Turn the block into a code block.',
  'slashCommand.description.turnNumberedList': 'Turn the block into a numbered list item.',
  'slashCommand.description.turnBulletList': 'Turn the block into a bulleted list item.',
  'slashCommand.description.turnCallout': 'Turn the block into an info box.',

  // Translators: grey placeholder text in an empty block being edited. templatePlaceholder shows
  // in the first block of an empty page; emptyBlockPlaceholder in any other empty block.
  // "/template", "/", "[[", "@", "{{" and "Shift+Enter" are typed as written: keep them.
  'editor.templatePlaceholder': 'Type /template to start from a template, or just start typing...',
  // Discoverability hint for the slash-command palette on empty blocks.
  // #217 D5: also surface the Shift+Enter soft-line-break shortcut, which has
  // no other UI affordance — the empty-block placeholder is the one moment the
  // user is looking at the block before typing, so it doubles as a teach-in.
  'editor.emptyBlockPlaceholder':
    'Type / for commands, [[ to link, @ to tag, {{ for a query · Shift+Enter for a line break',

  // Translators: touch screens, swiping a block to the left to delete it. releaseToDelete =
  // short label on the red strip behind the block once lifting the finger deletes it;
  // deleted = toast with an Undo button.
  // Label shown over the swipe-to-delete overlay on coarse-pointer
  // devices once the auto-delete threshold (200 px) is crossed mid-drag.
  'block.swipe.releaseToDelete': 'Release to delete',
  // #927 f7: Gmail-style undo affordance after a swipe-to-delete. The 200 px
  // swipe deletes immediately (no blocking confirm — worse on mobile), so the
  // toast's Undo action is the recoverability net. Its onClick replays the
  // same page-op undo the keyboard Ctrl+Z uses.
  'block.swipe.deleted': 'Block deleted',

  // Translators: toast when part of a block cannot be saved. {{type}} = a technical name of the
  // content, like "video": keep it as is.
  'editor.unknownNodeType':
    "Some content (type: {{type}}) couldn't be saved as Markdown and was dropped.",

  // Translators: a link to a page that was deleted or is in another space. brokenLinkTooltip =
  // tooltip on it (clicking removes the link); brokenLinkRemoved = toast after removing it;
  // brokenLinkRemoveAction = screen-reader text read after the link's text (keep the
  // parentheses); brokenLinkUndoStale = toast when Undo comes too late.
  'editor.brokenLinkTooltip': 'Broken link or in another space — click to remove',
  'editor.brokenLinkRemoved': 'Broken link removed',
  'editor.brokenLinkRemoveAction': '(remove broken link)',
  'editor.brokenLinkUndoStale':
    'The page changed after the removal, so it can no longer be undone here',
  // Translators: tooltip on a reference to a block that was deleted ("ref" = block reference).
  'editor.brokenRefTooltip': 'Broken ref — target block deleted',

  // Translators: footnote numbers in a block's text. footnoteLink = aria-label of the number,
  // {{number}} = 1, 2, 3…; footnoteMissing = tooltip on a number whose text no block gives.
  // #6033 — a footnote reference `[^label]`, shown as its number on the page.
  'editor.footnoteLink': 'Footnote {{number}}',
  'editor.footnoteMissing': 'No block on this page defines this footnote',

  // Translators: errors about a block's attached files (toasts), and rename = aria-label of the
  // pencil button and of the file-name field in the attachment list, {{name}} = the file name.
  // openFileDialogFailed = toast when the /attach command cannot open the system file picker.
  'attachments.loadFailed': 'Failed to load attachments',
  'attachments.deleteFailed': 'Failed to delete attachment',
  'attachments.renameFailed': 'Failed to rename attachment',
  'attachments.rename': 'Rename attachment {{name}}',
  'attachments.openFileDialogFailed': 'Could not open file picker',

  // Translators: PDF viewer dialog (opened by clicking an attached PDF). Page buttons'
  // aria-labels, screen-reader description, loading and error messages ({{error}} = a technical
  // error text) and the page counter ({{current}} = page shown, {{total}} = number of pages).
  'pdfViewer.previousPageLabel': 'Previous page',
  'pdfViewer.nextPageLabel': 'Next page',
  'pdfViewer.description': 'PDF viewer for {{filename}}',
  'pdfViewer.loading': 'Loading PDF...',
  'pdfViewer.error': 'Error: {{error}}',
  'pdfViewer.pageIndicator': 'Page {{current}} / {{total}}',

  // Translators: PDF viewer toolbar for marking up the PDF. highlight, comment and save are short
  // button texts, each with a longer aria-label (…Label); saving, saved and saveFailed are toasts.
  // #1452 — annotation toolbar (highlight + pinned comments via pdf.js).
  'pdfViewer.highlight': 'Highlight',
  'pdfViewer.highlightLabel': 'Highlight selected text',
  // Translators: "Comment" is a verb on the button: add a note pinned to the page.
  'pdfViewer.comment': 'Comment',
  'pdfViewer.commentLabel': 'Add a pinned comment',
  'pdfViewer.save': 'Save',
  'pdfViewer.saveLabel': 'Save annotated copy',
  'pdfViewer.saving': 'Saving annotated PDF…',
  'pdfViewer.saved': 'Saved annotated copy',
  'pdfViewer.saveFailed': 'Failed to save annotated PDF',

  // Translators: each saved highlight or comment also becomes a block. annotationBlocksFailed is
  // a toast. source and sourceUnknown = chip under such a block naming the PDF and page
  // ("p." = page, abbreviated), when the file name is known or not; …Label = their aria-labels.
  // {{filename}} = the PDF's file name, {{page}} = a page number.
  // #6629 — a highlight becomes a block; its chip opens the reader on its page.
  'pdfViewer.annotationBlocksFailed':
    'Highlights and comments saved in the PDF, but not added as blocks',
  'pdfViewer.source': '{{filename}} · p. {{page}}',
  'pdfViewer.sourceUnknown': 'PDF · p. {{page}}',
  'pdfViewer.sourceLabel': 'Open {{filename}} at page {{page}}',
  'pdfViewer.sourceUnknownLabel': 'Open the PDF at page {{page}}',

  // Translators: popup lists that open while typing in the editor (SuggestionList), when nothing
  // matches. atTag = the tag list (opened by @), blockLink = the page list (opened by [[),
  // blockRef = the block list (opened by ((), emoji = the emoji list; noResults = any other.
  // minChars shows in the block list until 2 characters are typed.
  'suggestion.noResults': 'No results',
  'suggestion.noResults.atTag': 'No results — press Enter to create a new tag',
  'suggestion.noResults.blockLink': 'No results — press Enter to create a new page',
  'suggestion.noResults.blockRef':
    'No results — block references can only point at existing blocks',
  'suggestion.noResults.emoji': 'No emoji match',
  'suggestion.hint.minChars': 'Type at least 2 characters to search',
  // Translators: announcement for screen readers, spoken as the list updates; {{count}} = number
  // of items in the popup list.
  // #1102 — live result-count announcement for the editable-combobox status
  // region. Announced on EVERY update (not just the empty branch) so screen
  // readers hear how many suggestions are available as the query changes.
  'suggestion.results.count_one': '{{count}} result available',
  'suggestion.results.count_other': '{{count}} results available',
  // Translators: verb at the start of the last row of a popup list; the typed name follows in
  // bold, as in "Create Project X".
  'suggestion.create': 'Create',
  // Translators: key hints in the footer of a popup list; very short. Keep the arrows and key
  // symbols (↑↓ ↵ ⇥) and "Esc" as written. touch.select replaces them on touch screens.
  'suggestion.footer.navigate': '↑↓ navigate',
  // D6 (#217): Tab also confirms the highlighted item (suggestion-renderer
  // maps the `suggestionAutocomplete` binding → synthetic Enter), so advertise
  // both keys rather than implying Enter is the only way to select.
  'suggestion.footer.select': '↵ or ⇥ select',
  'suggestion.footer.close': 'Esc to close',
  // #1006 — touch users get no keyboard glyphs; the strip has no
  // dismiss-on-tap-away affordance of its own (the picker closes when the
  // editor selection moves), so the copy stays minimal.
  'suggestion.footer.touch.select': 'Tap to select',

  // Translators: web links. opensInNewTab = screen-reader text read after a link's text (keep
  // the parentheses); notFoundTag = small tag in the preview shown on hovering a link whose web
  // page does not exist.
  'link.opensInNewTab': '(opens in new tab)',
  'linkPreview.notFoundTag': '(not found)',

  // Translators: full-screen image viewer (lightbox). description = screen-reader text,
  // {{filename}} = the image's description or file name; openExternal = button that opens the
  // image in another app; previous and next = aria-labels; counter = position among the
  // images being browsed ({{current}} of {{total}}).
  'lightbox.description': 'Fullscreen preview of {{filename}}',
  'lightbox.openExternal': 'Open externally',
  'lightbox.previous': 'Previous image',
  'lightbox.next': 'Next image',
  'lightbox.counter': '{{current}} of {{total}}',
  // Translators: badge shown while zoomed in; {{percent}} = zoom level. "+", "−", "0" and the
  // arrows are keys to press.
  // #294 item 7 — zoom/pan readout badge (shown only while zoomed in).
  'lightbox.zoom': '{{percent}}% — +/− zoom, 0 reset, drag/arrows to pan',
  // Translators: zoom buttons' tooltips; zoomIn and zoomOut also appear in the full-screen
  // diagram viewer.
  // #1104 — on-screen zoom control cluster (mirrors GraphView's tooltips).
  'lightbox.zoomIn': 'Zoom in',
  'lightbox.zoomOut': 'Zoom out',
  'lightbox.zoomReset': 'Reset zoom',
  // Translators: message in the viewer, and toast, when the image cannot be loaded.
  // #2281 — shown in-dialog when the image fails to load (broken/moved source).
  'lightbox.loadError': "Couldn't load image",

  // Translators: size toolbar over an attached image: its aria-label, then the aria-labels of
  // the preset widths (share of the available width).
  'imageResize.toolbar': 'Image size',
  'imageResize.small': 'Small (25%)',
  'imageResize.medium': 'Medium (50%)',
  'imageResize.large': 'Large (75%)',
  'imageResize.full': 'Full (100%)',

  // Translators: Mermaid diagrams (drawn from text in a "mermaid" code block). label = aria-label
  // of the drawn diagram and the full-screen viewer's title; editSource and showDiagram = the
  // toggle button on a diagram while editing; empty = message in an empty diagram.
  // Translators: error = heading followed by ": " and a technical message; no colon at the end.
  'mermaid.loading': 'Rendering diagram…',
  'mermaid.error': 'Diagram error',
  'mermaid.label': 'Mermaid diagram',
  'mermaid.editSource': 'Edit source',
  'mermaid.showDiagram': 'Show diagram',
  'mermaid.empty': 'Empty diagram — switch to source to add Mermaid code.',

  // Translators: math formulas written in LaTeX ("LaTeX" stays as written). editSource =
  // aria-label of a formula and of its source field; empty = text in an empty formula; label =
  // title of the full-screen viewer for a formula.
  'math.editSource': 'Edit LaTeX',
  'math.empty': 'Empty math — click to add LaTeX.',
  'math.label': 'Math',

  // Translators: full-screen viewer for a diagram or formula. expand = button on the diagram
  // that opens it; description = screen-reader text ("+", "−", "0" and the arrows are keys);
  // fit and actualSize = zoom buttons; zoom = zoom level readout, {{percent}} = a number; copy
  // and download buttons, with their toasts. "SVG" is a file format: keep it.
  // #5638 — full-screen viewer for Mermaid diagrams and display math.
  'diagramViewer.expand': 'Expand',
  'diagramViewer.description': 'Full-screen view: +/− zoom, 0 fits, drag, scroll or arrows to pan.',
  'diagramViewer.fit': 'Fit to screen',
  'diagramViewer.actualSize': 'Actual size (100%)',
  'diagramViewer.zoom': '{{percent}}%',
  'diagramViewer.copySource': 'Copy source',
  'diagramViewer.copyLatex': 'Copy LaTeX',
  'diagramViewer.copied': 'Copied to clipboard',
  'diagramViewer.copyFailed': "Couldn't copy to the clipboard",
  'diagramViewer.downloadSvg': 'Download SVG',
  'diagramViewer.downloadFailed': "Couldn't download the SVG",

  // Translators: rename dialog, shared by devices (Settings › Sync & devices), saved queries,
  // tags and properties. title, deviceName (its description) and placeholder are the texts for
  // renaming a device. cancel is also the Quick capture dialog's button. Errors show under the
  // field; {{max}} = the most characters allowed, like 64.
  'rename.title': 'Rename device',
  'rename.deviceName': 'Enter a name for this device.',
  'rename.placeholder': 'Device name',
  'rename.cancel': 'Cancel',
  'rename.save': 'Save',
  'rename.errorEmpty': 'Name cannot be empty.',
  'rename.errorTooLong': 'Name must be {{max}} characters or fewer.',

  // Translators: LinkEditPopover, the small popup for adding or editing a web link on the
  // selected text (toolbar Link button or Ctrl+K). label and url are field labels; apply is the
  // button when adding, update when editing; remove deletes the link (also a tooltip on a link).
  'linkEdit.label': 'Link text',
  'linkEdit.labelPlaceholder': 'Display text (optional)',
  // Translators: placeholder when the popup edits a page link: the text shown in its place.
  // #5160 D9 — the one field of the popover opened on a [[page]] chip.
  'linkEdit.blockLinkLabelPlaceholder': 'Shown in place of the page title',
  'linkEdit.url': 'URL',
  // Translators: "javascript:" and "data:" are web address prefixes: keep them as written.
  'linkEdit.invalidUrl': 'javascript: and data: URLs are not allowed',
  'linkEdit.apply': 'Apply',
  'linkEdit.update': 'Update',
  'linkEdit.remove': 'Remove',
  // Translators: example web address in the field; keep it as is.
  'linkEdit.urlPlaceholder': 'https://...',

  // Translators: an attached image under a block's text. toggleResizeToolbar = its aria-label
  // (Enter shows its size toolbar); resizeHint = tooltip of a small icon in its corner;
  // resizeHandle = tooltip of the corner grip; saveFailed = toast.
  'attachment.toggleResizeToolbar': 'Toggle resize toolbar',
  // FIL-008 (#218 item 6) — discoverability hint that the image is resizable.
  'attachment.resizeHint': 'Resize image — hover or focus to open the toolbar',
  // #294 item 6 — inline drag-to-resize corner handle.
  'attachment.resizeHandle': 'Drag to resize image',
  'imageResize.saveFailed': 'Could not save image size',

  // Translators: caption field under an attached image (it also serves as the image's
  // description for screen readers): placeholder, aria-label and failure toast.
  // #212 item 3 — captions / alt-text
  'imageCaption.placeholder': 'Add a caption…',
  'imageCaption.label': 'Image caption',
  'imageCaption.saveFailed': 'Could not save caption',

  // Translators: alignment buttons in the size toolbar over an attached image: the group's
  // aria-label, the buttons' aria-labels and a failure toast.
  // #212 item 4 — alignment
  'imageAlign.toolbar': 'Image alignment',
  'imageAlign.left': 'Align left',
  'imageAlign.center': 'Align center',
  'imageAlign.right': 'Align right',
  'imageAlign.saveFailed': 'Could not save image alignment',

  // Translators: emoji picker dialog, opened by the /emoji command and from a page title or tag
  // name. title is its heading; dialogDescription is screen-reader only; …Row, grid and
  // categories are aria-labels; frequentlyUsed is the heading over the most-used emoji;
  // loadFailed shows with a retry button.
  // #286 — emoji picker dialog (browse grid)
  'emojiPicker.title': 'Insert emoji',
  'emojiPicker.dialogDescription': 'Search and pick an emoji to insert.',
  // Translators: placeholder and aria-label of the search field.
  'emojiPicker.search': 'Search emoji',
  'emojiPicker.grid': 'Emoji',
  'emojiPicker.recents': 'Recents',
  'emojiPicker.recentsRow': 'Recently used emoji',
  'emojiPicker.frequentlyUsed': 'Frequently Used',
  'emojiPicker.frequentlyUsedRow': 'Frequently used emoji',
  'emojiPicker.categories': 'Emoji categories',
  'emojiPicker.frequentlyUsedCategory': 'Frequently used',
  'emojiPicker.noResults': 'No emoji found',
  // #2671 — the ~150 KB dataset now lazy-loads on first open; this covers the
  // brief window before it resolves.
  'emojiPicker.loading': 'Loading emoji…',
  // #4628 — that lazy import can reject (a chunk that fails to load); the grid
  // says so and offers a retry instead of sitting on the placeholder.
  'emojiPicker.loadFailed': 'Failed to load emoji',

  // Translators: emoji picker, skin-tone selector: its label, then each tone's name (the
  // swatches' aria-labels), from no tone (Default) through lightest to darkest.
  'emojiPicker.skinTone': 'Skin tone',
  'emojiPicker.skinTone.default': 'Default',
  'emojiPicker.skinTone.light': 'Light',
  'emojiPicker.skinTone.mediumLight': 'Medium-light',
  'emojiPicker.skinTone.medium': 'Medium',
  'emojiPicker.skinTone.mediumDark': 'Medium-dark',
  'emojiPicker.skinTone.dark': 'Dark',

  // Translators: emoji picker, the standard Unicode emoji category names: section headings and
  // the category tabs' tooltips. Use the usual names for these categories in your language.
  // #4555 — CLDR category names (section headers, tab aria-label/title,
  // sticky group label). Keys are the source of truth for the DISPLAYED
  // text; `EmojiPicker.tsx`'s `GROUP_ICONS`/`GROUP_LABEL_KEYS` keep using the
  // raw English CLDR strings as the lookup identity (`bucket.group`), since
  // that's what the generated dataset emits.
  'emojiPicker.group.smileysEmotion': 'Smileys & Emotion',
  'emojiPicker.group.peopleBody': 'People & Body',
  'emojiPicker.group.animalsNature': 'Animals & Nature',
  'emojiPicker.group.foodDrink': 'Food & Drink',
  'emojiPicker.group.travelPlaces': 'Travel & Places',
  'emojiPicker.group.activities': 'Activities',
  'emojiPicker.group.objects': 'Objects',
  'emojiPicker.group.symbols': 'Symbols',
  'emojiPicker.group.flags': 'Flags',
}
