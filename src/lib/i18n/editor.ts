/**
 * i18n namespace: editor
 *
 * Flat dotted keys merged into the `en.translation` resource
 * by `src/lib/i18n/index.ts`. Do not import this file directly
 * from app code; use `t('namespace.key')` via the index.
 */

export const editor: Record<string, string> = {
  'attachments.loading': 'Loading attachments…',
  'attachments.empty': 'No attachments yet.',
  'attachments.list': 'Attachments',
  'attachments.summary_one': '{{count}} file · {{total}}',
  'attachments.summary_other': '{{count}} files · {{total}}',
  'attachments.delete': 'Delete attachment {{name}}',
  'attachments.deleted': 'Deleted {{name}}',
  'attachments.confirmDelete': 'Delete "{{name}}"?',
  'attachments.clickAgain': 'Click the delete button again to confirm.',
  'attachment.openFile': 'Open file {{filename}}',
  'attachment.openImageFullscreen': 'Open image {{filename}} in full screen',
  'attachment.loadingImage': 'Loading image…',
  'attachment.imageLoadFailed': 'Failed to load image',
  // #1451 — inline rich-text preview for .md / text attachments.
  'attachment.loadingMarkdown': 'Loading preview…',
  'attachment.markdownLoadFailed': 'Failed to load preview',
  'attachment.collapsePreview': 'Collapse preview of {{filename}}',
  'attachment.expandPreview': 'Expand preview of {{filename}}',
  'attachment.downloadFile': 'Download {{filename}}',
  'attachment.previewTruncated': 'Preview truncated — download to view the full file.',
  // #1492 — external-image privacy placeholder (node view + static renderer).
  'editor.image.loadButton': 'Load',
  'editor.image.blockedNote': 'external image blocked',
  'editor.image.externalBlockedAria':
    'External image from {{domain}} (blocked by your privacy settings)',
  'slash.repeatSet': 'Set repeat to {{value}}',
  'slash.repeatFailed': 'Failed to set repeat',
  'slash.repeatRemoved': 'Repeat removed',
  'slash.repeatRemoveFailed': 'Failed to remove repeat',
  'slash.effortSet': 'Set effort to {{value}}',
  'slash.effortFailed': 'Failed to set effort',
  'slash.noTemplates':
    'No templates found. To create one: make a page, open its properties (click the page title area), and add a "template" property set to "true".',
  'slash.templateLoadFailed': 'Failed to load templates',
  'slash.templateInserted': 'Template inserted',
  'slash.templateInsertFailed': 'Failed to insert template',
  'slash.templatePicker': 'Select template',
  'slash.selectTemplate': 'Select a template',
  'slash.calloutFailed': 'Failed to insert callout',
  'slash.numberedListFailed': 'Failed to insert numbered list',
  'slash.dividerFailed': 'Failed to insert divider',
  'slashCommand.categories.tasks': 'Tasks',
  'slashCommand.categories.dates': 'Dates',
  'slashCommand.categories.references': 'References',
  'slashCommand.categories.formatting': 'Formatting',
  'slashCommand.categories.structure': 'Structure',
  'slashCommand.categories.properties': 'Properties',
  'slashCommand.categories.templates': 'Templates',
  'slashCommand.categories.queries': 'Queries',
  'slashCommand.categories.repeat': 'Repeat',
  // #1106 — split the flat 17-item Repeat group into three orthogonal
  // sub-groups so the picker renders a divider/header per family instead of
  // one undifferentiated list: cadence (plain daily/weekly/… + base), anchoring
  // (.+ from-completion / ++ catch-up variants + remove), and end-conditions
  // (until / limit). Dispatch is keyed off item.id, so the new category labels
  // are presentation-only.
  'slashCommand.categories.repeat.cadence': 'Repeat — Cadence',
  'slashCommand.categories.repeat.anchoring': 'Repeat — Anchoring',
  'slashCommand.categories.repeat.endCondition': 'Repeat — End condition',
  // #1105 — heading for the "Recent" band the slash menu prepends on an empty
  // query (mirrors the command palette's recents strip).
  'slashCommand.categories.recent': 'Recent',
  'editor.templatePlaceholder': 'Type /template to start from a template, or just start typing...',
  // Discoverability hint for the slash-command palette on empty blocks.
  // #217 D5: also surface the Shift+Enter soft-line-break shortcut, which has
  // no other UI affordance — the empty-block placeholder is the one moment the
  // user is looking at the block before typing, so it doubles as a teach-in.
  'editor.emptyBlockPlaceholder':
    'Type / for commands, [[ to link, @ to tag · Shift+Enter for a line break',
  // Label shown over the swipe-to-delete overlay on coarse-pointer
  // devices once the auto-delete threshold (200 px) is crossed mid-drag.
  'block.swipe.releaseToDelete': 'Release to delete',
  // #927 f7: Gmail-style undo affordance after a swipe-to-delete. The 200 px
  // swipe deletes immediately (no blocking confirm — worse on mobile), so the
  // toast's Undo action is the recoverability net. Its onClick replays the
  // same page-op undo the keyboard Ctrl+Z uses.
  'block.swipe.deleted': 'Block deleted',
  'editor.unknownNodeType':
    "Some content (type: {{type}}) couldn't be saved as Markdown and was dropped.",
  'editor.brokenLinkTooltip': 'Broken link or in another space — click to remove',
  'editor.brokenLinkRemoved': 'Broken link removed (undo with Ctrl+Z)',
  'editor.brokenRefTooltip': 'Broken ref — target block deleted',
  'attachments.loadFailed': 'Failed to load attachments',
  'attachments.addFailed': 'Failed to add attachment',
  'attachments.deleteFailed': 'Failed to delete attachment',
  'attachments.renameFailed': 'Failed to rename attachment',
  'attachments.rename': 'Rename attachment {{name}}',
  'attachments.openFileDialogFailed': 'Could not open file picker',
  'pdfViewer.previousPageLabel': 'Previous page',
  'pdfViewer.nextPageLabel': 'Next page',
  'pdfViewer.description': 'PDF viewer for {{filename}}',
  'pdfViewer.loading': 'Loading PDF...',
  'pdfViewer.error': 'Error: {{error}}',
  'pdfViewer.pageIndicator': 'Page {{current}} / {{total}}',
  // #1452 — annotation toolbar (highlight + pinned comments via pdf.js).
  'pdfViewer.highlight': 'Highlight',
  'pdfViewer.highlightLabel': 'Highlight selected text',
  'pdfViewer.comment': 'Comment',
  'pdfViewer.commentLabel': 'Add a pinned comment',
  'pdfViewer.save': 'Save',
  'pdfViewer.saveLabel': 'Save annotated copy',
  'pdfViewer.saving': 'Saving annotated PDF…',
  'pdfViewer.saved': 'Saved annotated copy',
  'pdfViewer.saveFailed': 'Failed to save annotated PDF',
  'suggestion.noResults': 'No results',
  'suggestion.noResults.atTag': 'No results — press Enter to create a new tag',
  'suggestion.noResults.blockLink': 'No results — press Enter to create a new page',
  'suggestion.noResults.blockRef':
    'No results — block references can only point at existing blocks',
  'suggestion.noResults.emoji': 'No emoji match',
  'suggestion.hint.minChars': 'Type at least 2 characters to search',
  // #1102 — live result-count announcement for the editable-combobox status
  // region. Announced on EVERY update (not just the empty branch) so screen
  // readers hear how many suggestions are available as the query changes.
  'suggestion.results.count_one': '{{count}} result available',
  'suggestion.results.count_other': '{{count}} results available',
  'suggestion.create': 'Create',
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
  'link.opensInNewTab': '(opens in new tab)',
  'lightbox.description': 'Fullscreen preview of {{filename}}',
  'lightbox.openExternal': 'Open externally',
  'lightbox.previous': 'Previous image',
  'lightbox.next': 'Next image',
  'lightbox.counter': '{{current}} of {{total}}',
  // #294 item 7 — zoom/pan readout badge (shown only while zoomed in).
  'lightbox.zoom': '{{percent}}% — +/− zoom, 0 reset, drag/arrows to pan',
  // #1104 — on-screen zoom control cluster (mirrors GraphView's tooltips).
  'lightbox.zoomIn': 'Zoom in',
  'lightbox.zoomOut': 'Zoom out',
  'lightbox.zoomReset': 'Reset zoom',
  'imageResize.toolbar': 'Image size',
  'imageResize.small': 'Small (25%)',
  'imageResize.medium': 'Medium (50%)',
  'imageResize.large': 'Large (75%)',
  'imageResize.full': 'Full (100%)',
  'mermaid.loading': 'Rendering diagram…',
  'mermaid.error': 'Diagram error',
  'mermaid.label': 'Mermaid diagram',
  'mermaid.editSource': 'Edit source',
  'mermaid.showDiagram': 'Show diagram',
  'mermaid.empty': 'Empty diagram — switch to source to add Mermaid code.',
  'math.editSource': 'Edit LaTeX',
  'math.empty': 'Empty math — click to add LaTeX.',
  'rename.title': 'Rename device',
  'rename.deviceName': 'Enter a name for this device.',
  'rename.placeholder': 'Device name',
  'rename.cancel': 'Cancel',
  'rename.save': 'Save',
  'rename.errorEmpty': 'Name cannot be empty.',
  'rename.errorTooLong': 'Name must be {{max}} characters or fewer.',
  'linkEdit.label': 'Link text',
  'linkEdit.labelPlaceholder': 'Display text (optional)',
  'linkEdit.url': 'URL',
  'linkEdit.invalidUrl': 'javascript: and data: URLs are not allowed',
  'linkEdit.apply': 'Apply',
  'linkEdit.update': 'Update',
  'linkEdit.remove': 'Remove',
  'linkEdit.urlPlaceholder': 'https://...',
  'attachment.toggleResizeToolbar': 'Toggle resize toolbar',
  // FIL-008 (#218 item 6) — discoverability hint that the image is resizable.
  'attachment.resizeHint': 'Resize image — hover or focus to open the toolbar',
  // #294 item 6 — inline drag-to-resize corner handle.
  'attachment.resizeHandle': 'Drag to resize image',
  'imageResize.saveFailed': 'Could not save image size',
  // #212 item 3 — captions / alt-text
  'imageCaption.placeholder': 'Add a caption…',
  'imageCaption.label': 'Image caption',
  'imageCaption.saveFailed': 'Could not save caption',
  // #212 item 4 — alignment
  'imageAlign.toolbar': 'Image alignment',
  'imageAlign.left': 'Align left',
  'imageAlign.center': 'Align center',
  'imageAlign.right': 'Align right',
  'imageAlign.saveFailed': 'Could not save image alignment',
  // #286 — emoji picker dialog (browse grid)
  'emojiPicker.title': 'Insert emoji',
  'emojiPicker.dialogDescription': 'Search and pick an emoji to insert.',
  'emojiPicker.search': 'Search emoji',
  'emojiPicker.grid': 'Emoji',
  'emojiPicker.recents': 'Recents',
  'emojiPicker.recentsRow': 'Recently used emoji',
  'emojiPicker.skinTone': 'Skin tone',
  'emojiPicker.skinTone.default': 'Default',
  'emojiPicker.skinTone.light': 'Light',
  'emojiPicker.skinTone.mediumLight': 'Medium-light',
  'emojiPicker.skinTone.medium': 'Medium',
  'emojiPicker.skinTone.mediumDark': 'Medium-dark',
  'emojiPicker.skinTone.dark': 'Dark',
}
