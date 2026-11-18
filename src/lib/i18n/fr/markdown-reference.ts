/**
 * i18n namespace: markdown-reference — French (`fr`).
 *
 * Mirrors `src/lib/i18n/markdown-reference.ts` key for key, in the same order.
 */

export const markdownReference: Record<string, string> = {
  'markdownReference.group.text': 'Texte',
  'markdownReference.group.blocks': 'Blocs',
  'markdownReference.group.links': 'Liens, étiquettes et intégrations',
  'markdownReference.group.tasks': 'Tâches',
  'markdownReference.group.properties': 'Propriétés',
  'markdownReference.group.media': 'Images et formules',
  'markdownReference.group.commands': 'Menus et emojis',

  'markdownReference.bold.title': 'Gras',
  'markdownReference.bold.description': 'Met le texte en gras. __bold__ fonctionne aussi.',
  'markdownReference.italic.title': 'Italique',
  'markdownReference.italic.description': 'Met le texte en italique. _italic_ fonctionne aussi.',
  'markdownReference.highlight.title': 'Surlignage',
  'markdownReference.highlight.description': 'Surligne le texte.',
  'markdownReference.strike.title': 'Barré',
  'markdownReference.strike.description': 'Barre le texte.',
  'markdownReference.underline.title': 'Souligné',
  'markdownReference.underline.description':
    'Souligne le texte\u00A0: Ctrl+U dans l’éditeur, les balises dans Modifier en Markdown.',
  'markdownReference.inlineCode.title': 'Code en ligne',
  'markdownReference.inlineCode.description':
    'Affiche le texte comme du code, exactement tel qu’il a été saisi.',
  'markdownReference.lineBreak.title': 'Saut de ligne',
  'markdownReference.lineBreak.description':
    'Shift+Enter commence une nouvelle ligne dans le même bloc.',
  'markdownReference.escape.title': 'Échappement',
  'markdownReference.escape.description':
    'Dans Modifier en Markdown, une barre oblique inverse placée avant un symbole le conserve en texte brut.',

  'markdownReference.heading.title': 'Titre',
  'markdownReference.heading.description':
    'Transforme le bloc en titre. De ## à ###### pour des titres plus petits.',
  'markdownReference.bulletList.title': 'Liste à puces',
  'markdownReference.bulletList.description':
    'En début de bloc, le transforme en élément de liste à puces.',
  'markdownReference.numberedList.title': 'Liste numérotée',
  'markdownReference.numberedList.description':
    'En début de bloc, le transforme en élément de liste numérotée.',
  'markdownReference.quote.title': 'Citation',
  'markdownReference.quote.description': 'Affiche le texte comme une citation.',
  'markdownReference.callout.title': 'Encadré',
  'markdownReference.callout.description':
    'Dans Modifier en Markdown, un encadré NOTE, INFO, TIP, WARNING ou ERROR, dont le titre est le texte qui suit. Dans l’éditeur, utilisez /callout.',
  'markdownReference.codeBlock.title': 'Bloc de code',
  'markdownReference.codeBlock.description':
    'Trois accents graves suivis d’une espace ouvrent un bloc de code, qui conserve les lignes exactement telles qu’elles ont été saisies.',
  'markdownReference.codeLanguage.title': 'Langage du code',
  'markdownReference.codeLanguage.description':
    'Un nom de langage après les accents graves, avant l’espace, colore le code.',
  'markdownReference.diagram.title': 'Diagramme',
  'markdownReference.diagram.description':
    'Un bloc de code mermaid dessine un diagramme à partir du texte qu’il contient.',
  'markdownReference.table.title': 'Tableau',
  'markdownReference.table.description':
    'Dans Modifier en Markdown, crée un tableau dont la première ligne est l’en-tête. Dans l’éditeur, utilisez /table.',
  'markdownReference.divider.title': 'Séparateur',
  'markdownReference.divider.description': 'Trace une ligne horizontale.',
  'markdownReference.query.title': 'Requête',
  'markdownReference.query.description':
    'Liste les blocs portant l’étiquette project, ou une étiquette qui commence par celle-ci. La requête doit être le seul texte de son bloc.',

  'markdownReference.link.title': 'Lien',
  'markdownReference.link.description': 'Lie le texte à une adresse web.',
  'markdownReference.webAddress.title': 'Adresse web',
  'markdownReference.webAddress.description':
    'Une adresse web suivie d’une espace devient un lien.',
  'markdownReference.pageLink.title': 'Lien vers une page',
  'markdownReference.pageLink.description':
    'Crée un lien vers une page. Un nom qu’aucune page ne porte crée la page.',
  'markdownReference.pageLinkLabel.title': 'Lien vers une page avec votre propre texte',
  'markdownReference.pageLinkLabel.description':
    'Crée un lien vers une page, mais affiche le texte qui suit la barre verticale.',
  'markdownReference.blockRef.title': 'Référence de bloc',
  'markdownReference.blockRef.description':
    'Affiche le texte d’un autre bloc, choisi dans une liste.',
  'markdownReference.tag.title': 'Étiquette',
  'markdownReference.tag.description':
    'Ajoute une étiquette au bloc. Saisir @ ouvre aussi la liste des étiquettes.',
  'markdownReference.tagWithSpaces.title': 'Étiquette avec espaces',
  'markdownReference.tagWithSpaces.description':
    'Ajoute au bloc une étiquette dont le nom contient des espaces.',
  'markdownReference.pageEmbed.title': 'Intégration de page',
  'markdownReference.pageEmbed.description':
    'Affiche une page entière dans un bloc par ailleurs vide. ![[ permet aussi d’en commencer une.',
  'markdownReference.blockEmbed.title': 'Intégration de bloc',
  'markdownReference.blockEmbed.description':
    'Affiche un bloc et ses enfants dans un bloc par ailleurs vide.',
  'markdownReference.footnote.title': 'Note de bas de page',
  'markdownReference.footnote.description':
    'Affiche un numéro de note\u00A0: 1, 2, 3 dans l’ordre où les libellés apparaissent pour la première fois sur la page. Cliquer dessus mène à la note.',
  'markdownReference.footnoteDefinition.title': 'Texte de la note',
  'markdownReference.footnoteDefinition.description':
    'En début de bloc, fait du bloc le texte de la note, marqué de son numéro.',

  'markdownReference.taskTodo.title': 'À faire',
  'markdownReference.taskTodo.description': 'En début de bloc, en fait une tâche à faire.',
  'markdownReference.taskDoing.title': 'En cours',
  'markdownReference.taskDoing.description': 'Fait du bloc une tâche en cours.',
  'markdownReference.taskDone.title': 'Terminé',
  'markdownReference.taskDone.description': 'Fait du bloc une tâche terminée.',
  'markdownReference.taskCancelled.title': 'Annulé',
  'markdownReference.taskCancelled.description': 'Fait du bloc une tâche annulée.',
  'markdownReference.priority.title': 'Priorité',
  'markdownReference.priority.description':
    'Sur sa propre ligne, définit la priorité\u00A0: 1 est la plus haute, 3 la plus basse.',
  'markdownReference.dueDate.title': 'Date d’échéance',
  'markdownReference.dueDate.description':
    'Sur sa propre ligne, définit le jour d’échéance du bloc.',
  'markdownReference.scheduledDate.title': 'Date planifiée',
  'markdownReference.scheduledDate.description':
    'Sur sa propre ligne, définit le jour prévu pour le bloc.',

  'markdownReference.blockProperty.title': 'Propriété',
  'markdownReference.blockProperty.description':
    'Sur sa propre ligne, donne une propriété au bloc. Saisir :: ouvre la liste des noms.',
  'markdownReference.pageProperties.title': 'Propriétés de la page',
  'markdownReference.pageProperties.description':
    'Dans Modifier en Markdown, les lignes entre --- tout en haut définissent les propriétés de la page.',

  'markdownReference.image.title': 'Image',
  'markdownReference.image.description':
    'Affiche l’image située à cette adresse. Le texte entre crochets la décrit.',
  'markdownReference.imageWidth.title': 'Largeur de l’image',
  'markdownReference.imageWidth.description':
    'Un nombre après une barre verticale définit la largeur de l’image en pixels.',
  'markdownReference.pastedImage.title': 'Image collée',
  'markdownReference.pastedImage.description':
    'Une image collée ou déposée est enregistrée avec vos notes et écrite ainsi.',
  'markdownReference.mathInline.title': 'Formule',
  'markdownReference.mathInline.description': 'Affiche une formule dans le texte.',
  'markdownReference.mathBlock.title': 'Bloc de formule',
  'markdownReference.mathBlock.description':
    'Dans Modifier en Markdown, affiche une formule sur des lignes à part.',

  'markdownReference.commands.title': 'Commandes',
  'markdownReference.commands.description':
    'Ouvre le menu des commandes\u00A0: titres, tâches, dates, encadrés et plus encore.',
  'markdownReference.emoji.title': 'Emoji',
  'markdownReference.emoji.description':
    'Le nom d’un emoji entre deux-points devient l’emoji. Deux-points suivis de deux lettres ouvrent une liste.',
}
