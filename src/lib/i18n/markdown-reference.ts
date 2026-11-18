/**
 * i18n namespace: markdownReference
 *
 * The Markdown reference's strings, part of the `editor` namespace
 * (`./editor.ts`). Do not import this file directly from app code; use
 * `t('namespace.key')` via the index.
 */

export const markdownReference: Record<string, string> = {
  // Translators: Markdown reference, a side panel listing what you can type in the editor and
  // what it becomes (opened from "Supports Markdown" under a page). Its section headings.
  'markdownReference.group.text': 'Text',
  'markdownReference.group.blocks': 'Blocks',
  'markdownReference.group.links': 'Links, tags and embeds',
  'markdownReference.group.tasks': 'Tasks',
  'markdownReference.group.properties': 'Properties',
  'markdownReference.group.media': 'Images and math',
  'markdownReference.group.commands': 'Menus and emoji',

  // Translators: Markdown reference, "Text" section. Each entry has a short name (.title) and a
  // one-line description shown beside an untranslated syntax example. Markdown symbols and key
  // names stay as written; "Edit as Markdown" is the button that opens the page as plain
  // Markdown text: use the same translation as that button.
  // Translators: "__bold__" is literal Markdown; keep it as written.
  'markdownReference.bold.title': 'Bold',
  'markdownReference.bold.description': 'Makes the text bold. __bold__ works too.',
  // Translators: "_italic_" is literal Markdown; keep it as written.
  'markdownReference.italic.title': 'Italic',
  'markdownReference.italic.description': 'Makes the text italic. _italic_ works too.',
  'markdownReference.highlight.title': 'Highlight',
  'markdownReference.highlight.description': 'Highlights the text.',
  'markdownReference.strike.title': 'Strikethrough',
  'markdownReference.strike.description': 'Crosses the text out.',
  // Translators: "the tags" are the <u>…</u> HTML tags shown in the syntax example.
  'markdownReference.underline.title': 'Underline',
  'markdownReference.underline.description':
    'Underlines the text: Ctrl+U in the editor, the tags in Edit as Markdown.',
  'markdownReference.inlineCode.title': 'Inline code',
  'markdownReference.inlineCode.description': 'Shows the text as code, exactly as typed.',
  'markdownReference.lineBreak.title': 'Line break',
  'markdownReference.lineBreak.description': 'Shift+Enter starts a new line inside the same block.',
  // Translators: "Escape" means escaping a character (a backslash stops it from formatting the
  // text), not the Esc key.
  'markdownReference.escape.title': 'Escape',
  'markdownReference.escape.description':
    'In Edit as Markdown, a backslash before a symbol keeps the symbol as plain text.',

  // Translators: Markdown reference, "Blocks" section: name (.title) and one-line description
  // beside an untranslated syntax example. Symbols, "/callout" and "/table" (commands to type)
  // and "mermaid" (the diagram language's name) stay as written.
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
  // Translators: Callout = a colored box. NOTE, INFO, TIP, WARNING and ERROR are keywords typed
  // as in "> [!NOTE] Title": keep them in English.
  'markdownReference.callout.title': 'Callout',
  'markdownReference.callout.description':
    'In Edit as Markdown, a NOTE, INFO, TIP, WARNING or ERROR box, with the text after it as its title. In the editor, use /callout.',
  // Translators: backticks are the ` character.
  'markdownReference.codeBlock.title': 'Code block',
  'markdownReference.codeBlock.description':
    'Three backticks and a space start a code block, which keeps the lines exactly as typed.',
  // Translators: a programming language's name, such as "js", typed after the backticks.
  'markdownReference.codeLanguage.title': 'Code language',
  'markdownReference.codeLanguage.description':
    'A language name after the backticks, before the space, colors the code.',
  'markdownReference.diagram.title': 'Diagram',
  'markdownReference.diagram.description':
    'A mermaid code block draws a diagram from the text in it.',
  'markdownReference.table.title': 'Table',
  'markdownReference.table.description':
    'In Edit as Markdown, makes a table whose first row is the header. In the editor, use /table.',
  // Translators: Divider = a horizontal rule across the page.
  'markdownReference.divider.title': 'Divider',
  'markdownReference.divider.description': 'Draws a horizontal line.',
  // Translators: Query = a live list of the blocks that match a filter. "project" is the tag
  // name in the example {{query tag:project}}: keep it as written.
  'markdownReference.query.title': 'Query',
  'markdownReference.query.description':
    'Lists the blocks tagged project, or with a tag that starts with it. It must be the only text in its block.',

  // Translators: Markdown reference, "Links, tags and embeds" section: name (.title) and
  // one-line description beside an untranslated syntax example. Symbols stay as written.
  // "Embed" = showing another page or block inside this one.
  'markdownReference.link.title': 'Link',
  'markdownReference.link.description': 'Links the text to a web address.',
  'markdownReference.webAddress.title': 'Web address',
  'markdownReference.webAddress.description': 'A web address followed by a space becomes a link.',
  'markdownReference.pageLink.title': 'Page link',
  'markdownReference.pageLink.description': 'Links to a page. A name no page has creates the page.',
  // Translators: "the bar" is the | character in [[Page name|shown text]].
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
  // Translators: "labels" are the names after ^, as in [^source]; the page shows them as numbers.
  'markdownReference.footnote.title': 'Footnote',
  'markdownReference.footnote.description':
    'Shows a footnote number: 1, 2, 3 in the order the labels first appear on the page. Clicking it goes to the note.',
  'markdownReference.footnoteDefinition.title': 'Footnote text',
  'markdownReference.footnoteDefinition.description':
    'At the start of a block, makes the block the footnote’s text, marked with its number.',

  // Translators: Markdown reference, "Tasks" section: name (.title) and one-line description
  // beside an untranslated syntax example. The first four names are task states: use the same
  // words as the task states elsewhere in the app. "On its own line" = a separate line of the
  // block holding the "name:: value" shown in the example.
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

  // Translators: Markdown reference, "Properties" section: name (.title) and one-line
  // description beside an untranslated syntax example. A property is a named value attached to
  // a block or a page ("author:: Ana"). "::" and "---" are typed as written.
  'markdownReference.blockProperty.title': 'Property',
  'markdownReference.blockProperty.description':
    'On its own line, gives the block a property. Typing :: opens the list of names.',
  'markdownReference.pageProperties.title': 'Page properties',
  'markdownReference.pageProperties.description':
    'In Edit as Markdown, lines between --- at the very top set the page’s properties.',

  // Translators: Markdown reference, "Images and math" section: name (.title) and one-line
  // description beside an untranslated syntax example. "Math" = a formula written in LaTeX.
  // Translators: "The text in brackets" is "A cat" in ![A cat](https://…), the image's
  // description for screen readers.
  'markdownReference.image.title': 'Image',
  'markdownReference.image.description':
    'Shows the image at that address. The text in brackets describes it.',
  // Translators: "a bar" is the | character, as in ![A cat|300](…).
  'markdownReference.imageWidth.title': 'Image width',
  'markdownReference.imageWidth.description':
    'A number after a bar sets the image’s width in pixels.',
  // Translators: "like this" refers to the syntax example shown beside it.
  'markdownReference.pastedImage.title': 'Pasted image',
  'markdownReference.pastedImage.description':
    'A pasted or dropped image is saved with your notes and written like this.',
  'markdownReference.mathInline.title': 'Math',
  'markdownReference.mathInline.description': 'Shows a formula inside the text.',
  'markdownReference.mathBlock.title': 'Math block',
  'markdownReference.mathBlock.description':
    'In Edit as Markdown, shows a formula on lines of its own.',

  // Translators: Markdown reference, "Menus and emoji" section: name (.title) and one-line
  // description beside an untranslated syntax example ("/" and ":joy:").
  // Translators: "Commands" = the menu that typing / opens.
  'markdownReference.commands.title': 'Commands',
  'markdownReference.commands.description':
    'Opens the menu of commands: headings, tasks, dates, callouts and more.',
  // Translators: an emoji's name is its English code, as in :joy:.
  'markdownReference.emoji.title': 'Emoji',
  'markdownReference.emoji.description':
    'An emoji’s name between colons becomes the emoji. A colon and two letters open a list.',
}
