/**
 * i18n namespace: errors — French (`fr`).
 *
 * Mirrors `src/lib/i18n/errors.ts` key for key, in the same order.
 */

export const errors: Record<string, string> = {
  'empty.noBlocks':
    'Aucun bloc pour l’instant. Cliquez sur + Ajouter un bloc ci-dessous pour commencer à écrire.',
  'empty.noPages': 'Aucune page pour l’instant. Créez-en une pour commencer.',
  'loadMore.progress': '{{loaded}} sur {{total}} chargés',
  'error.generic': 'Un problème est survenu',
  'error.loadFailed': 'Échec du chargement des données',
  'error.spacesLoadFailed': 'Impossible d’actualiser les espaces',
  'error.saveFailed': 'Impossible d’enregistrer',
  'error.createBlockFailed': 'Impossible de créer le bloc',
  'error.blockNotFound': 'Impossible de trouver ce bloc sur la page',
  'error.sectionCrashed': '{{section}}\u00A0: une erreur s’est produite',
  'error.unexpected': 'Une erreur inattendue s’est produite',
  'storage.full':
    'Le disque est plein\u00A0: les modifications ne sont pas enregistrées. Libérez de l’espace, puis réessayez.',
  'storage.readOnly':
    'Agaric ne peut pas écrire dans son dossier de données\u00A0: les modifications ne sont pas enregistrées. Vérifiez que le dossier et son disque sont accessibles en écriture.',
  'storage.corrupt':
    'La base de données est endommagée\u00A0: certaines actions échouent. Exportez vos notes (Paramètres › Données) avant de modifier quoi que ce soit d’autre.',
  'errorBoundary.dataSafe': 'Vos données sont en sécurité — Réessayer recharge ce panneau.',
  'errorBoundary.section.pageEditor': 'Éditeur de page',
  'errorBoundary.section.tabBar': 'Barre d’onglets',
  'errorBoundary.section.quickAccess': 'Accès rapide',
  'errorBoundary.section.findInPage': 'Rechercher dans la page',
  'errorBoundary.section.commandPalette': 'Palette de commandes',
  'errorBoundary.section.searchSheet': 'Panneau de recherche',
  'errorBoundary.section.keyboardShortcuts': 'Raccourcis clavier',
  'errorBoundary.section.welcome': 'Bienvenue',
  'errorBoundary.section.gestureCoachMark': 'Aide aux gestes',
  'errorBoundary.section.bugReport': 'Rapport de bug',
  'errorBoundary.section.quickCaptureButton': 'Bouton de capture rapide',
  'errorBoundary.section.quickCapture': 'Capture rapide',
  'errorBoundary.section.newPage': 'Nouvelle page',
  'errorBoundary.section.newMeeting': 'Nouvelle réunion',
  'errorBoundary.section.syncSetup': 'Configuration de la synchronisation',
  'errorBoundary.section.notifications': 'Notifications',
  'error.loadBlocksFailed': 'Impossible de charger les blocs',
  'error.pageNotInCurrentSpace': 'Cette page a été déplacée vers un autre espace',
  'error.pageInTrash': 'Cette page est dans la corbeille',
  'error.deleteBlockFailed': 'Impossible de supprimer le bloc',
  'error.reorderBlockFailed': 'Impossible de réorganiser le bloc',
  'error.moveBlockFailed': 'Impossible de déplacer le bloc',
  'error.indentBlockFailed': 'Impossible d’augmenter le retrait du bloc',
  'error.maxNestingReached': 'Niveau d’imbrication maximal atteint',
  'error.dedentBlockFailed': 'Impossible de diminuer le retrait du bloc',
  'error.moveBlockUpFailed': 'Impossible de monter le bloc',
  'error.moveBlockDownFailed': 'Impossible de descendre le bloc',
  'error.createPageFailed': 'Impossible de créer la page',
  'error.pasteBlocksFailed': 'Impossible de coller les blocs',
  'error.settingsSaveFailed':
    'Impossible d’enregistrer vos modifications localement — le stockage local est peut-être plein',
  'error.internal': 'Un problème est survenu (err: {{id}})',
  'errorCode.invalidGlob': 'Ce motif de nom de page n’est pas valide.',
  'errorCode.invalidRegex': 'Cette expression régulière n’est pas valide.',
  'errorCode.invalidDateFilter':
    'Ce filtre de date n’est pas valide. Utilisez des dates au format YYYY-MM-DD, avec le début d’une plage avant sa fin.',
  'errorCode.requiresRefresh': 'Ceci a changé depuis son chargement. Rechargez-le, puis réessayez.',
  'errorCode.invalidRepeatRule':
    'Cette règle de répétition n’est pas valide. Utilisez `daily`, `weekly`, `monthly`, `yearly`, ou `+Nd` / `+Nw` / `+Nm` / `+Ny` avec N égal à 1 ou plus, éventuellement précédé de `.+` (compter à partir du moment où vous la terminez) ou `++` (rattraper jusqu’à aujourd’hui).',
  'errorCode.duplicateAgentName': 'Un autre agent porte déjà ce nom.',
  'errorCode.builtinPropertyLocked':
    'Cette propriété est intégrée, elle ne peut donc pas être modifiée.',
  'errorCode.unacknowledgedPropertyLoss':
    'Les valeurs ont changé depuis l’aperçu. Affichez de nouveau l’aperçu avant de confirmer.',
}
