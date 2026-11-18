/**
 * i18n namespace: markdown-reference — German (`de`).
 *
 * Mirrors `src/lib/i18n/markdown-reference.ts` key for key, in the same order.
 */

export const markdownReference: Record<string, string> = {
  'markdownReference.group.text': 'Text',
  'markdownReference.group.blocks': 'Blöcke',
  'markdownReference.group.links': 'Links, Tags und Einbettungen',
  'markdownReference.group.tasks': 'Aufgaben',
  'markdownReference.group.properties': 'Eigenschaften',
  'markdownReference.group.media': 'Bilder und Formeln',
  'markdownReference.group.commands': 'Menüs und Emojis',

  'markdownReference.bold.title': 'Fett',
  'markdownReference.bold.description': 'Macht den Text fett. __bold__ funktioniert auch.',
  'markdownReference.italic.title': 'Kursiv',
  'markdownReference.italic.description': 'Macht den Text kursiv. _italic_ funktioniert auch.',
  'markdownReference.highlight.title': 'Hervorhebung',
  'markdownReference.highlight.description': 'Hebt den Text hervor.',
  'markdownReference.strike.title': 'Durchgestrichen',
  'markdownReference.strike.description': 'Streicht den Text durch.',
  'markdownReference.underline.title': 'Unterstrichen',
  'markdownReference.underline.description':
    'Unterstreicht den Text: Ctrl+U im Editor, die HTML-Tags im Modus "Als Markdown bearbeiten".',
  'markdownReference.inlineCode.title': 'Inline-Code',
  'markdownReference.inlineCode.description': 'Zeigt den Text als Code, genau wie eingegeben.',
  'markdownReference.lineBreak.title': 'Zeilenumbruch',
  'markdownReference.lineBreak.description': 'Shift+Enter beginnt eine neue Zeile im selben Block.',
  'markdownReference.escape.title': 'Maskierung',
  'markdownReference.escape.description':
    'Im Modus "Als Markdown bearbeiten" bleibt ein Symbol mit vorangestelltem Backslash normaler Text.',

  'markdownReference.heading.title': 'Überschrift',
  'markdownReference.heading.description':
    'Macht den Block zu einer Überschrift. ## bis ###### ergeben kleinere.',
  'markdownReference.bulletList.title': 'Aufzählung',
  'markdownReference.bulletList.description':
    'Am Anfang eines Blocks wird dieser zu einem Aufzählungspunkt.',
  'markdownReference.numberedList.title': 'Nummerierte Liste',
  'markdownReference.numberedList.description':
    'Am Anfang eines Blocks wird dieser zu einem nummerierten Listenpunkt.',
  'markdownReference.quote.title': 'Zitat',
  'markdownReference.quote.description': 'Zeigt den Text als Zitat.',
  'markdownReference.callout.title': 'Hinweisblock',
  'markdownReference.callout.description':
    'Im Modus "Als Markdown bearbeiten" ein NOTE-, INFO-, TIP-, WARNING- oder ERROR-Kasten mit dem nachfolgenden Text als Titel. Im Editor verwendest du /callout.',
  'markdownReference.codeBlock.title': 'Codeblock',
  'markdownReference.codeBlock.description':
    'Drei Backticks und ein Leerzeichen beginnen einen Codeblock, der die Zeilen genau so übernimmt, wie du sie eingibst.',
  'markdownReference.codeLanguage.title': 'Sprache des Codes',
  'markdownReference.codeLanguage.description':
    'Ein Sprachname nach den Backticks, vor dem Leerzeichen, färbt den Code ein.',
  'markdownReference.diagram.title': 'Diagramm',
  'markdownReference.diagram.description':
    'Ein mermaid-Codeblock zeichnet ein Diagramm aus dem Text darin.',
  'markdownReference.table.title': 'Tabelle',
  'markdownReference.table.description':
    'Erstellt im Modus "Als Markdown bearbeiten" eine Tabelle, deren erste Zeile die Kopfzeile ist. Im Editor verwendest du /table.',
  'markdownReference.divider.title': 'Trennlinie',
  'markdownReference.divider.description': 'Zeichnet eine waagerechte Linie.',
  'markdownReference.query.title': 'Abfrage',
  'markdownReference.query.description':
    'Listet die Blöcke mit dem Tag project oder einem Tag, das mit project beginnt. Die Abfrage muss der einzige Text in ihrem Block sein.',

  'markdownReference.link.title': 'Link',
  'markdownReference.link.description': 'Verknüpft den Text mit einer Webadresse.',
  'markdownReference.webAddress.title': 'Webadresse',
  'markdownReference.webAddress.description':
    'Eine Webadresse, auf die ein Leerzeichen folgt, wird zu einem Link.',
  'markdownReference.pageLink.title': 'Seitenlink',
  'markdownReference.pageLink.description':
    'Verknüpft mit einer Seite. Ein Name, den noch keine Seite trägt, legt die Seite an.',
  'markdownReference.pageLinkLabel.title': 'Seitenlink mit eigenem Text',
  'markdownReference.pageLinkLabel.description':
    'Verknüpft mit einer Seite, zeigt aber den Text nach dem senkrechten Strich.',
  'markdownReference.blockRef.title': 'Blockverweis',
  'markdownReference.blockRef.description':
    'Zeigt den Text eines anderen Blocks, ausgewählt aus einer Liste.',
  'markdownReference.tag.title': 'Tag',
  'markdownReference.tag.description':
    'Versieht den Block mit einem Tag. Wenn du @ tippst, öffnet sich ebenfalls die Liste der Tags.',
  'markdownReference.tagWithSpaces.title': 'Tag mit Leerzeichen',
  'markdownReference.tagWithSpaces.description':
    'Versieht den Block mit einem Tag, dessen Name Leerzeichen enthält.',
  'markdownReference.pageEmbed.title': 'Seiteneinbettung',
  'markdownReference.pageEmbed.description':
    'Zeigt eine ganze Seite in einem ansonsten leeren Block. Auch ![[ beginnt eine.',
  'markdownReference.blockEmbed.title': 'Blockeinbettung',
  'markdownReference.blockEmbed.description':
    'Zeigt einen Block samt seinen Unterblöcken in einem ansonsten leeren Block.',
  'markdownReference.footnote.title': 'Fußnote',
  'markdownReference.footnote.description':
    'Zeigt eine Fußnotennummer: 1, 2, 3 in der Reihenfolge, in der die Bezeichnungen zuerst auf der Seite erscheinen. Ein Klick darauf führt zur Fußnote.',
  'markdownReference.footnoteDefinition.title': 'Fußnotentext',
  'markdownReference.footnoteDefinition.description':
    'Am Anfang eines Blocks wird dieser zum Text der Fußnote, markiert mit ihrer Nummer.',

  'markdownReference.taskTodo.title': 'Zu erledigen',
  'markdownReference.taskTodo.description':
    'Am Anfang eines Blocks wird dieser zu einer offenen Aufgabe.',
  'markdownReference.taskDoing.title': 'In Bearbeitung',
  'markdownReference.taskDoing.description': 'Macht den Block zu einer Aufgabe in Bearbeitung.',
  'markdownReference.taskDone.title': 'Erledigt',
  'markdownReference.taskDone.description': 'Macht den Block zu einer erledigten Aufgabe.',
  'markdownReference.taskCancelled.title': 'Abgebrochen',
  'markdownReference.taskCancelled.description': 'Macht den Block zu einer abgebrochenen Aufgabe.',
  'markdownReference.priority.title': 'Priorität',
  'markdownReference.priority.description':
    'Legt in einer eigenen Zeile die Priorität fest: 1 ist die höchste, 3 die niedrigste.',
  'markdownReference.dueDate.title': 'Fälligkeitsdatum',
  'markdownReference.dueDate.description':
    'Legt in einer eigenen Zeile den Tag fest, an dem der Block fällig ist.',
  'markdownReference.scheduledDate.title': 'Geplantes Datum',
  'markdownReference.scheduledDate.description':
    'Legt in einer eigenen Zeile den Tag fest, für den der Block geplant ist.',

  'markdownReference.blockProperty.title': 'Eigenschaft',
  'markdownReference.blockProperty.description':
    'Gibt dem Block in einer eigenen Zeile eine Eigenschaft. Wenn du :: tippst, öffnet sich die Liste der Namen.',
  'markdownReference.pageProperties.title': 'Seiteneigenschaften',
  'markdownReference.pageProperties.description':
    'Im Modus "Als Markdown bearbeiten" legen Zeilen zwischen --- ganz oben die Eigenschaften der Seite fest.',

  'markdownReference.image.title': 'Bild',
  'markdownReference.image.description':
    'Zeigt das Bild unter dieser Adresse. Der Text in den eckigen Klammern beschreibt es.',
  'markdownReference.imageWidth.title': 'Bildbreite',
  'markdownReference.imageWidth.description':
    'Eine Zahl nach einem senkrechten Strich legt die Breite des Bildes in Pixeln fest.',
  'markdownReference.pastedImage.title': 'Eingefügtes Bild',
  'markdownReference.pastedImage.description':
    'Ein eingefügtes oder hineingezogenes Bild wird mit deinen Notizen gespeichert und so notiert.',
  'markdownReference.mathInline.title': 'Formel',
  'markdownReference.mathInline.description': 'Zeigt eine Formel im Text.',
  'markdownReference.mathBlock.title': 'Formelblock',
  'markdownReference.mathBlock.description':
    'Zeigt im Modus "Als Markdown bearbeiten" eine Formel in eigenen Zeilen.',

  'markdownReference.commands.title': 'Befehle',
  'markdownReference.commands.description':
    'Öffnet das Befehlsmenü: Überschriften, Aufgaben, Datumsangaben, Hinweisblöcke und mehr.',
  'markdownReference.emoji.title': 'Emoji',
  'markdownReference.emoji.description':
    'Der Name eines Emojis zwischen Doppelpunkten wird zum Emoji. Ein Doppelpunkt und zwei Buchstaben öffnen eine Liste.',
}
