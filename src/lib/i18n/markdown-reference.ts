/**
 * i18n namespace: markdownReference
 *
 * The Markdown reference's strings, part of the `editor` namespace
 * (`./editor.ts`). Do not import this file directly from app code; use
 * `t('namespace.key')` via the index.
 */

export const markdownReference: Record<string, string> = {
  'markdownReference.group.text': 'Text',
  'markdownReference.group.blocks': 'Blocks',
  'markdownReference.group.links': 'Links, tags and embeds',
  'markdownReference.group.tasks': 'Tasks',
  'markdownReference.group.properties': 'Properties',
  'markdownReference.group.media': 'Images and math',
  'markdownReference.group.commands': 'Menus and emoji',

  'markdownReference.bold.title': 'Bold',
  'markdownReference.bold.description': 'Makes the text bold.',
  'markdownReference.italic.title': 'Italic',
  'markdownReference.italic.description': 'Makes the text italic.',
  'markdownReference.highlight.title': 'Highlight',
  'markdownReference.highlight.description': 'Highlights the text.',
  'markdownReference.strike.title': 'Strikethrough',
  'markdownReference.strike.description': 'Crosses the text out.',
  'markdownReference.underline.title': 'Underline',
  'markdownReference.underline.description': 'Underlines the text.',
  'markdownReference.inlineCode.title': 'Inline code',
  'markdownReference.inlineCode.description': 'Shows the text as code, exactly as typed.',
  'markdownReference.lineBreak.title': 'Line break',
  'markdownReference.lineBreak.description': 'Shift+Enter starts a new line inside the same block.',
  'markdownReference.escape.title': 'Escape',
  'markdownReference.escape.description':
    'A backslash before a symbol keeps the symbol as plain text.',

  'markdownReference.heading.title': 'Heading',
  'markdownReference.heading.description':
    'Makes the block a heading. ## to ###### make smaller ones.',
  'markdownReference.bulletList.title': 'Bulleted list',
  'markdownReference.bulletList.description': 'At the start of a block, makes it a bulleted item.',
  'markdownReference.numberedList.title': 'Numbered list',
  'markdownReference.numberedList.description':
    'At the start of a block, makes it a numbered item.',
  'markdownReference.quote.title': 'Quote',
  'markdownReference.quote.description': 'Shows the text as a quotation.',
  'markdownReference.calloutNote.title': 'Note callout',
  'markdownReference.calloutNote.description':
    'Shows a note box. The text after the type is its title.',
  'markdownReference.calloutInfo.title': 'Info callout',
  'markdownReference.calloutInfo.description': 'Shows an info box.',
  'markdownReference.calloutTip.title': 'Tip callout',
  'markdownReference.calloutTip.description': 'Shows a tip box.',
  'markdownReference.calloutWarning.title': 'Warning callout',
  'markdownReference.calloutWarning.description': 'Shows a warning box.',
  'markdownReference.calloutError.title': 'Error callout',
  'markdownReference.calloutError.description': 'Shows an error box.',
  'markdownReference.codeBlock.title': 'Code block',
  'markdownReference.codeBlock.description': 'Keeps the lines as code, exactly as typed.',
  'markdownReference.codeLanguage.title': 'Code language',
  'markdownReference.codeLanguage.description':
    'A language name after the opening backticks colors the code.',
  'markdownReference.diagram.title': 'Diagram',
  'markdownReference.diagram.description': 'A mermaid code block draws a diagram from its text.',
  'markdownReference.table.title': 'Table',
  'markdownReference.table.description': 'Makes a table. The first row is the header.',
  'markdownReference.divider.title': 'Divider',
  'markdownReference.divider.description': 'Draws a horizontal line.',
  'markdownReference.query.title': 'Query',
  'markdownReference.query.description':
    'Lists the blocks tagged project. It must be the only text in its block.',

  'markdownReference.link.title': 'Link',
  'markdownReference.link.description': 'Links the text to a web address.',
  'markdownReference.webAddress.title': 'Web address',
  'markdownReference.webAddress.description': 'A web address becomes a link by itself.',
  'markdownReference.pageLink.title': 'Page link',
  'markdownReference.pageLink.description': 'Links to a page. A name no page has creates the page.',
  'markdownReference.pageLinkLabel.title': 'Page link with your own text',
  'markdownReference.pageLinkLabel.description':
    'Links to a page but shows the text after the bar.',
  'markdownReference.blockRef.title': 'Block reference',
  'markdownReference.blockRef.description': 'Shows the text of another block, picked from a list.',
  'markdownReference.tag.title': 'Tag',
  'markdownReference.tag.description': 'Tags the block. Typing @ also opens the list of tags.',
  'markdownReference.tagWithSpaces.title': 'Tag with spaces',
  'markdownReference.tagWithSpaces.description': 'Tags the block with a name that has spaces.',
  'markdownReference.pageEmbed.title': 'Page embed',
  'markdownReference.pageEmbed.description':
    'Shows a whole page inside an otherwise empty block. ![[ also starts one.',
  'markdownReference.blockEmbed.title': 'Block embed',
  'markdownReference.blockEmbed.description':
    'Shows a block and its children inside an otherwise empty block.',

  'markdownReference.taskTodo.title': 'To do',
  'markdownReference.taskTodo.description': 'At the start of a block, makes it a task to do.',
  'markdownReference.taskDoing.title': 'In progress',
  'markdownReference.taskDoing.description': 'Makes the block a task in progress.',
  'markdownReference.taskDone.title': 'Done',
  'markdownReference.taskDone.description': 'Makes the block a finished task.',
  'markdownReference.taskCancelled.title': 'Cancelled',
  'markdownReference.taskCancelled.description': 'Makes the block a cancelled task.',
  'markdownReference.priority.title': 'Priority',
  'markdownReference.priority.description':
    'On its own line, sets the priority: 1 is the highest, 3 the lowest.',
  'markdownReference.dueDate.title': 'Due date',
  'markdownReference.dueDate.description': 'On its own line, sets the day the block is due.',
  'markdownReference.scheduledDate.title': 'Scheduled date',
  'markdownReference.scheduledDate.description':
    'On its own line, sets the day the block is planned for.',

  'markdownReference.blockProperty.title': 'Property',
  'markdownReference.blockProperty.description':
    'On its own line, gives the block a property. Typing :: opens the list of names.',
  'markdownReference.pageProperties.title': 'Page properties',
  'markdownReference.pageProperties.description':
    'In Edit as Markdown, lines between --- at the very top set the page’s properties.',

  'markdownReference.image.title': 'Image',
  'markdownReference.image.description':
    'Shows the image at that address. The text in brackets describes it.',
  'markdownReference.imageWidth.title': 'Image width',
  'markdownReference.imageWidth.description':
    'A number after a bar sets the image’s width in pixels.',
  'markdownReference.pastedImage.title': 'Pasted image',
  'markdownReference.pastedImage.description':
    'A pasted or dropped image is saved with your notes and written like this.',
  'markdownReference.mathInline.title': 'Math',
  'markdownReference.mathInline.description': 'Shows a formula inside the text.',
  'markdownReference.mathBlock.title': 'Math block',
  'markdownReference.mathBlock.description': 'Shows a formula on lines of its own.',

  'markdownReference.commands.title': 'Commands',
  'markdownReference.commands.description':
    'Opens the menu of commands: headings, tasks, dates, callouts and more.',
  'markdownReference.emoji.title': 'Emoji',
  'markdownReference.emoji.description':
    'An emoji’s name between colons becomes the emoji. A colon and two letters open a list.',
}
